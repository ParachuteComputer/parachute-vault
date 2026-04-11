/**
 * Generic webhook trigger system.
 *
 * Replaces the hardcoded tts-hook and transcription-hook with a declarative
 * config-driven approach. Each trigger defines a predicate (tags, content,
 * metadata) and an action (webhook URL). When a note mutation matches, the
 * trigger fires a webhook and applies the response to the note.
 *
 * ## Two-phase marker discipline (inherited from the old hooks)
 *
 *   1. On entry: write `metadata.<trigger_name>_pending_at = <now>`.
 *      The predicate checks `missing_metadata` which includes the pending
 *      and rendered markers, so a concurrent update cannot start a second run.
 *   2. On success: replace `_pending_at` with `_rendered_at` and apply the
 *      webhook response (content, metadata, attachments).
 *   3. On failure: leave `_pending_at` set. Manual recovery required.
 *
 * ## Webhook contract
 *
 *   Request: POST to action.webhook
 *     Content-Type: application/json
 *     Body: { trigger, event, note: { id, content, tags, metadata, attachments } }
 *
 *   Response: 200 with JSON body (fields are all optional):
 *     { content?, metadata?, attachments?: [{ path, mimeType, meta? }] }
 *
 *   Non-200 responses are treated as failures (note stays in pending state).
 *   Empty 200 response (or `{}`) means "success, no updates needed" — the
 *   note still gets marked as rendered.
 */

import type { Note, Store } from "../core/src/types.ts";
import type { HookRegistry, HookEvent } from "../core/src/hooks.ts";
import type { TriggerConfig, TriggerWhen } from "./config.ts";

const DEFAULT_TIMEOUT = 60_000;

export interface WebhookResponse {
  content?: string;
  metadata?: Record<string, unknown>;
  attachments?: Array<{
    path: string;
    mimeType: string;
    meta?: Record<string, unknown>;
  }>;
  /** If set, the trigger is considered skipped (not failed). */
  skipped_reason?: string;
}

/**
 * Build a HookRegistry predicate from a TriggerWhen config.
 */
export function buildPredicate(when: TriggerWhen, triggerName: string): (note: Note) => boolean {
  const pendingKey = `${triggerName}_pending_at`;
  const renderedKey = `${triggerName}_rendered_at`;

  return (note: Note) => {
    const meta = note.metadata as Record<string, unknown> | undefined;

    // Always check our own markers (two-phase discipline)
    if (meta?.[pendingKey] || meta?.[renderedKey]) return false;

    // Tag filter
    if (when.tags?.length) {
      if (!when.tags.every((t) => note.tags?.includes(t))) return false;
    }

    // Content filter
    if (when.has_content === true) {
      if (!note.content || !note.content.trim()) return false;
    }
    if (when.has_content === false) {
      if (note.content && note.content.trim().length > 0) return false;
    }

    // Missing metadata filter
    if (when.missing_metadata?.length) {
      for (const key of when.missing_metadata) {
        if (meta?.[key] != null) return false;
      }
    }

    // Has metadata filter
    if (when.has_metadata?.length) {
      for (const key of when.has_metadata) {
        if (meta?.[key] == null) return false;
      }
    }

    return true;
  };
}

/**
 * Register all triggers from config onto a HookRegistry.
 * Returns a cleanup function that unregisters all hooks.
 */
export function registerTriggers(
  hooks: HookRegistry,
  triggers: TriggerConfig[],
  logger: { error: (...args: unknown[]) => void; info?: (...args: unknown[]) => void } = console,
): () => void {
  const unregisters: Array<() => void> = [];

  for (const trigger of triggers) {
    // Validate webhook URL at registration time so typos fail fast
    try {
      const url = new URL(trigger.action.webhook);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        logger.error(`[triggers] skipping "${trigger.name}": webhook URL must use http or https (got ${url.protocol})`);
        continue;
      }
    } catch {
      logger.error(`[triggers] skipping "${trigger.name}": invalid webhook URL "${trigger.action.webhook}"`);
      continue;
    }

    const predicate = buildPredicate(trigger.when, trigger.name);
    const events = trigger.events ?? ["created", "updated"];
    const pendingKey = `${trigger.name}_pending_at`;
    const renderedKey = `${trigger.name}_rendered_at`;
    const timeout = trigger.action.timeout ?? DEFAULT_TIMEOUT;

    const unregister = hooks.onNote({
      name: trigger.name,
      event: events,
      when: predicate,
      handler: async (note: Note, store: Store, hookEvent?: HookEvent) => {
        const existingMeta = (note.metadata as Record<string, unknown> | undefined) ?? {};

        // Handler-side re-check (same race-window protection as the old hooks)
        if (existingMeta[pendingKey] || existingMeta[renderedKey]) return;

        const pendingAt = new Date().toISOString();

        // Phase 1: claim
        try {
          store.updateNote(note.id, {
            metadata: { ...existingMeta, [pendingKey]: pendingAt },
            skipUpdatedAt: true,
          });
        } catch (err) {
          logger.error(`[trigger:${trigger.name}] failed to claim note ${note.id}:`, err);
          throw err;
        }

        // Fire the webhook
        let webhookResult: WebhookResponse;
        try {
          const attachments = store.getAttachments(note.id);
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout);

          const resp = await fetch(trigger.action.webhook, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              trigger: trigger.name,
              event: hookEvent ?? "updated",
              note: {
                id: note.id,
                content: note.content,
                path: note.path,
                tags: note.tags,
                metadata: existingMeta,
                attachments,
                createdAt: note.createdAt,
                updatedAt: note.updatedAt,
              },
            }),
            signal: controller.signal,
          });
          clearTimeout(timer);

          if (!resp.ok) {
            throw new Error(`webhook returned ${resp.status}: ${await resp.text().catch(() => "")}`);
          }

          const text = await resp.text();
          webhookResult = text ? JSON.parse(text) : {};
        } catch (err) {
          logger.error(
            `[trigger:${trigger.name}] webhook failed for note ${note.id}; note left in ${pendingKey} state (manual recovery required):`,
            err,
          );
          throw err;
        }

        // Handle skipped result. We write `_rendered_at` even for skips so the
        // predicate won't re-fire on future note edits — a permanently-skippable
        // note (e.g. code-only content with no speakable text) would otherwise
        // trigger an infinite webhook loop on every update.
        if (webhookResult.skipped_reason) {
          try {
            store.updateNote(note.id, {
              metadata: {
                ...existingMeta,
                [pendingKey]: undefined,
                [renderedKey]: new Date().toISOString(),
                [`${trigger.name}_skipped_reason`]: webhookResult.skipped_reason,
              },
              skipUpdatedAt: true,
            });
          } catch (err) {
            logger.error(`[trigger:${trigger.name}] failed to mark note ${note.id} as skipped:`, err);
          }
          return;
        }

        // Phase 2: apply webhook response and mark as rendered
        try {
          // Add attachments first
          if (webhookResult.attachments?.length) {
            for (const att of webhookResult.attachments) {
              store.addAttachment(note.id, att.path, att.mimeType, att.meta);
            }
          }

          // Read fresh metadata to avoid clobbering concurrent edits
          const fresh = store.getNote(note.id);
          const freshMeta = (fresh?.metadata as Record<string, unknown> | undefined) ?? existingMeta;
          const { [pendingKey]: _drop, ...restMeta } = freshMeta;

          store.updateNote(note.id, {
            ...(webhookResult.content !== undefined ? { content: webhookResult.content } : {}),
            metadata: {
              ...restMeta,
              ...(webhookResult.metadata ?? {}),
              [renderedKey]: new Date().toISOString(),
            },
            skipUpdatedAt: true,
          });
        } catch (err) {
          logger.error(`[trigger:${trigger.name}] failed to apply webhook result for note ${note.id}:`, err);
          throw err;
        }
      },
    });

    unregisters.push(unregister);
    logger.info?.(`[triggers] registered: ${trigger.name} → ${trigger.action.webhook}`);
  }

  return () => unregisters.forEach((fn) => fn());
}
