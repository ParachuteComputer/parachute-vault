/**
 * Generic webhook trigger system.
 *
 * Replaces the hardcoded tts-hook and transcription-hook with a declarative
 * config-driven approach. Each trigger defines a predicate (tags, content,
 * metadata) and an action (webhook URL + send/response modes). When a note
 * mutation matches, the trigger fires a webhook and applies the response.
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
 * ## Send modes
 *
 *   - `json` (default): POST `{ trigger, event, note }` as JSON.
 *     Response: `{ content?, metadata?, attachments? }`.
 *   - `attachment`: Read the first audio attachment, POST as multipart/form-data.
 *     Response: `{ text }` (Whisper API shape). Written to note.content.
 *   - `content`: POST `{ input: note.content }` as JSON (OpenAI TTS shape).
 *     Response: binary audio bytes. Saved to assets + attachment.
 */

import { join, normalize } from "path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import crypto from "node:crypto";
import type { Note, Store, Attachment } from "../core/src/types.ts";
import type { HookRegistry, HookEvent } from "../core/src/hooks.ts";
import type { TriggerConfig, TriggerWhen } from "./config.ts";
import { getVaultNameForStore } from "./vault-store.ts";
import { assetsDir } from "./routes.ts";
import { appendContextPart, fetchContextEntries, type ContextPayload } from "./context.ts";

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

// ---------------------------------------------------------------------------
// Dispatch helpers — one per send mode
// ---------------------------------------------------------------------------

const AUDIO_MIME_TYPES = new Set(["audio/wav", "audio/mpeg", "audio/mp4", "audio/ogg", "audio/webm"]);

/** Resolve the assets directory for a store. */
function resolveAssetsDir(store: Store): string {
  const vaultName = getVaultNameForStore(store as never);
  return assetsDir(vaultName ?? "default");
}

/** Find the first audio attachment for a note and return its absolute path. */
function findAudioAttachment(
  attachments: Attachment[],
  assetsRoot: string,
): { attachment: Attachment; filePath: string } | null {
  for (const att of attachments) {
    if (!AUDIO_MIME_TYPES.has(att.mimeType)) continue;
    const filePath = normalize(join(assetsRoot, att.path));
    if (filePath.startsWith(normalize(assetsRoot)) && existsSync(filePath)) {
      return { attachment: att, filePath };
    }
  }
  return null;
}

/** Save binary audio to the assets dir, return relative path + MIME. */
function saveAudioToAssets(
  assetsRoot: string,
  audio: Buffer,
  contentType: string,
): { relativePath: string; mimeType: string } {
  const ext = contentType.includes("ogg") ? ".ogg"
    : contentType.includes("mpeg") ? ".mp3"
    : contentType.includes("wav") ? ".wav"
    : contentType.includes("mp4") ? ".m4a"
    : ".ogg"; // default to ogg

  const date = new Date().toISOString().split("T")[0];
  const dir = join(assetsRoot, date);
  mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${crypto.randomUUID()}${ext}`;
  const filePath = join(dir, filename);
  writeFileSync(filePath, audio);

  return {
    relativePath: `${date}/${filename}`,
    mimeType: contentType || "audio/ogg",
  };
}

interface DispatchResult {
  webhookResult: WebhookResponse;
}

/** send=json (default): POST the note as JSON, expect standard webhook response. */
async function dispatchJson(
  url: string,
  trigger: TriggerConfig,
  note: Note,
  attachments: Attachment[],
  existingMeta: Record<string, unknown>,
  hookEvent: HookEvent | undefined,
  context: ContextPayload | null,
  signal: AbortSignal,
): Promise<DispatchResult> {
  const resp = await fetch(url, {
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
      // Inline when include_context is configured and matched anything; the
      // receiver can key off a top-level `context` field without having to
      // parse multipart.
      ...(context && context.entries.length ? { context } : {}),
    }),
    signal,
  });

  if (!resp.ok) {
    throw new Error(`webhook returned ${resp.status}: ${await resp.text().catch(() => "")}`);
  }

  const text = await resp.text();
  return { webhookResult: text ? JSON.parse(text) : {} };
}

/**
 * send=attachment: Read the first audio attachment from the vault assets dir,
 * POST it as multipart/form-data. Expects `{ text }` response (Whisper shape).
 */
async function dispatchAttachment(
  url: string,
  note: Note,
  attachments: Attachment[],
  store: Store,
  context: ContextPayload | null,
  signal: AbortSignal,
): Promise<DispatchResult> {
  const assetsRoot = resolveAssetsDir(store);
  const audio = findAudioAttachment(attachments, assetsRoot);
  if (!audio) {
    return { webhookResult: { skipped_reason: "no audio attachment found" } };
  }

  const fileBuffer = readFileSync(audio.filePath);
  const filename = audio.attachment.path.split("/").pop() ?? "audio";
  const file = new File([fileBuffer], filename, { type: audio.attachment.mimeType });

  const form = new FormData();
  form.append("file", file);
  if (context) appendContextPart(form, context);

  const resp = await fetch(url, { method: "POST", body: form, signal });
  if (!resp.ok) {
    throw new Error(`webhook returned ${resp.status}: ${await resp.text().catch(() => "")}`);
  }

  const result = await resp.json() as { text?: string };
  const webhookResult: WebhookResponse = {};
  if (result.text) {
    webhookResult.content = result.text;
  }
  return { webhookResult };
}

/**
 * send=content: POST `{ input: note.content, model?, voice? }` as JSON
 * (OpenAI TTS shape). Response is binary audio bytes. Saved as attachment.
 */
async function dispatchContent(
  url: string,
  note: Note,
  store: Store,
  signal: AbortSignal,
): Promise<DispatchResult> {
  if (!note.content || !note.content.trim()) {
    return { webhookResult: { skipped_reason: "note has no content to synthesize" } };
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: note.content }),
    signal,
  });

  if (!resp.ok) {
    throw new Error(`webhook returned ${resp.status}: ${await resp.text().catch(() => "")}`);
  }

  const contentType = resp.headers.get("Content-Type") ?? "audio/ogg";
  const audioBuffer = Buffer.from(await resp.arrayBuffer());
  const assetsRoot = resolveAssetsDir(store);
  const { relativePath, mimeType } = saveAudioToAssets(assetsRoot, audioBuffer, contentType);

  const webhookResult: WebhookResponse = {
    attachments: [{ path: relativePath, mimeType }],
    metadata: {
      ...(resp.headers.get("X-TTS-Provider") ? { tts_provider: resp.headers.get("X-TTS-Provider") } : {}),
      ...(resp.headers.get("X-TTS-Voice") ? { tts_voice: resp.headers.get("X-TTS-Voice") } : {}),
    },
  };
  return { webhookResult };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

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
    const sendMode = trigger.action.send ?? "json";

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
          await store.updateNote(note.id, {
            metadata: { ...existingMeta, [pendingKey]: pendingAt },
            skipUpdatedAt: true,
          });
        } catch (err) {
          logger.error(`[trigger:${trigger.name}] failed to claim note ${note.id}:`, err);
          throw err;
        }

        // Fire the webhook using the configured send mode
        let webhookResult: WebhookResponse;
        const attachments = await store.getAttachments(note.id);
        // Pre-fetch context once per fire. Predicate errors are logged and
        // the fire continues — context is additive, never blocking.
        const context = trigger.action.include_context?.length
          ? await fetchContextEntries(store, trigger.action.include_context, logger)
          : null;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
          let result: DispatchResult;
          switch (sendMode) {
            case "attachment":
              result = await dispatchAttachment(trigger.action.webhook, note, attachments, store, context, controller.signal);
              break;
            case "content":
              // send=content is pure TTS (audio out); vault context makes no
              // sense here and would confuse the server contract.
              result = await dispatchContent(trigger.action.webhook, note, store, controller.signal);
              break;
            case "json":
            default:
              result = await dispatchJson(trigger.action.webhook, trigger, note, attachments, existingMeta, hookEvent, context, controller.signal);
              break;
          }
          webhookResult = result.webhookResult;
        } catch (err) {
          logger.error(
            `[trigger:${trigger.name}] webhook failed for note ${note.id}; note left in ${pendingKey} state (manual recovery required):`,
            err,
          );
          throw err;
        } finally {
          clearTimeout(timer);
        }

        // Handle skipped result. We write `_rendered_at` even for skips so the
        // predicate won't re-fire on future note edits — a permanently-skippable
        // note (e.g. code-only content with no speakable text) would otherwise
        // trigger an infinite webhook loop on every update.
        if (webhookResult.skipped_reason) {
          try {
            await store.updateNote(note.id, {
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
              await store.addAttachment(note.id, att.path, att.mimeType, att.meta);
            }
          }

          // Read fresh metadata to avoid clobbering concurrent edits
          const fresh = await store.getNote(note.id);
          const freshMeta = (fresh?.metadata as Record<string, unknown> | undefined) ?? existingMeta;
          const { [pendingKey]: _drop, ...restMeta } = freshMeta;

          await store.updateNote(note.id, {
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
    const modeStr = sendMode !== "json" ? ` (send=${sendMode})` : "";
    logger.info?.(`[triggers] registered: ${trigger.name} → ${trigger.action.webhook}${modeStr}`);
  }

  return () => unregisters.forEach((fn) => fn());
}
