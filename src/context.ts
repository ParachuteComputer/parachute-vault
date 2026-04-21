/**
 * Shared "vault-provided context" helpers for outbound webhook/worker calls.
 *
 * Triggers (`include_context`) and the transcription worker (`transcription.context`
 * in vault.yaml) both send vault context to an external caller so the caller
 * does not need to reach back into vault to fetch person/project/etc. notes
 * on its own. The shape is caller-agnostic — the receiver just gets a JSON
 * blob of `{ entries: [...] }` — so this module doesn't know anything about
 * scribe specifically.
 *
 * ## Predicate shape
 *
 *   include_context:
 *     - tag: person
 *       exclude_tag: archived
 *       include_metadata: [summary, aliases]
 *
 * Each predicate is a query (scoped by `tag`, optionally excluding `exclude_tag`)
 * plus a whitelist of metadata fields to surface on the resulting entries.
 * Fields not in `include_metadata` are dropped. `name` is always included and
 * is the note's path basename (or id, if no path).
 *
 * ## Output
 *
 *   {"entries": [{"name": "Aaron", "aliases": ["A"], "summary": "..."}, ...]}
 */

import type { Store } from "../core/src/types.ts";

export interface ContextPredicate {
  /** Tag the note must carry. Required — a predicate with no tag is a no-op. */
  tag: string;
  /** If set, notes with this tag are excluded. */
  exclude_tag?: string;
  /** Metadata keys to pass through on each entry. Unknown keys are ignored. */
  include_metadata?: string[];
}

export interface ContextEntry {
  /** Note path basename, or note id if no path. */
  name: string;
  /** Whitelisted metadata fields from the predicate. */
  [key: string]: unknown;
}

export interface ContextPayload {
  entries: ContextEntry[];
}

/**
 * Query the vault for notes matching each predicate, project to the whitelisted
 * metadata fields, and return a combined payload. Predicates are run in order;
 * duplicate notes (same id across predicates) are included once by first match.
 *
 * Errors on a single predicate are logged and skipped — a malformed predicate
 * should not take down a whole trigger or worker cycle.
 */
export async function fetchContextEntries(
  store: Store,
  predicates: ContextPredicate[],
  logger: { error: (...args: unknown[]) => void } = console,
): Promise<ContextPayload> {
  const seen = new Set<string>();
  const entries: ContextEntry[] = [];

  for (const pred of predicates) {
    if (!pred.tag) continue;
    let notes;
    try {
      notes = await store.queryNotes({
        tags: [pred.tag],
        excludeTags: pred.exclude_tag ? [pred.exclude_tag] : undefined,
      });
    } catch (err) {
      logger.error(`[context] query failed for tag="${pred.tag}":`, err);
      continue;
    }

    for (const note of notes) {
      if (seen.has(note.id)) continue;
      seen.add(note.id);

      const entry: ContextEntry = { name: nameForNote(note.path, note.id) };
      const meta = (note.metadata as Record<string, unknown> | undefined) ?? {};
      for (const key of pred.include_metadata ?? []) {
        if (key in meta) entry[key] = meta[key];
      }
      entries.push(entry);
    }
  }

  return { entries };
}

function nameForNote(path: string | undefined, id: string): string {
  if (!path) return id;
  const base = path.split("/").pop() ?? path;
  // Drop extension if present — same rule a UI would apply for display.
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Append a `context` multipart part to the given FormData. Does nothing if
 * the payload has no entries (avoids a zero-entries part that the receiver
 * would have to special-case).
 */
export function appendContextPart(form: FormData, payload: ContextPayload): void {
  if (!payload.entries.length) return;
  form.append(
    "context",
    new Blob([JSON.stringify(payload)], { type: "application/json" }),
    "context.json",
  );
}
