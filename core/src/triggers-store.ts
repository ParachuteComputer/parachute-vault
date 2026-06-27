/**
 * Persisted runtime triggers — per-vault CRUD over the `triggers` table
 * (schema v21).
 *
 * Complements the static `config.yaml` trigger system: config.yaml triggers
 * are loaded at boot and fire globally (all vaults); rows in this table live
 * in a single vault's SQLite DB and are re-registered at boot scoped to that
 * vault (they fire ONLY for events on the vault they were stored under).
 *
 * The structured columns (`events`, `when`, `action`) are JSON-encoded on
 * write and parsed on read. `name` is the primary key, so `upsertTrigger`
 * is a true upsert (insert-or-replace by name). The shape here is kept
 * structurally compatible with `src/config.ts`'s `TriggerConfig` /
 * `TriggerWhen` / `TriggerAction` without importing from `src/` — core stays
 * dependency-free of the server layer.
 *
 * `action.auth.bearer`, when present, becomes an `Authorization: Bearer`
 * header on the webhook POST (the JWT webhook-auth path that retires the
 * old `?secret=` query param). It is stored verbatim in the JSON column.
 */

import type { Database } from "bun:sqlite";

/** Predicate shape — mirrors src/config.ts:TriggerWhen. */
export interface StoredTriggerWhen {
  tags?: string[];
  has_content?: boolean;
  missing_metadata?: string[];
  has_metadata?: string[];
  /**
   * Value-matched metadata predicate (vault#299 Part B). field →
   * operator-object, evaluated with the shared query-operators engine. See
   * src/config.ts:TriggerWhen.metadata.
   */
  metadata?: Record<string, Record<string, unknown>>;
}

/** Webhook auth — only the bearer-JWT path for now. */
export interface StoredTriggerAuth {
  bearer?: string;
}

/** Action shape — mirrors src/config.ts:TriggerAction plus `auth`. */
export interface StoredTriggerAction {
  webhook: string;
  timeout?: number;
  send?: "json" | "attachment" | "content";
  auth?: StoredTriggerAuth;
  // Forward-compat: include_context and any other action fields round-trip
  // through the JSON column verbatim even though core doesn't interpret them.
  [key: string]: unknown;
}

/** A persisted trigger row, decoded. */
export interface StoredTrigger {
  name: string;
  events: Array<"created" | "updated">;
  when: StoredTriggerWhen;
  action: StoredTriggerAction;
  created_at: string;
  updated_at: string;
}

/** The writable subset callers pass to upsert. */
export interface TriggerInput {
  name: string;
  events?: Array<"created" | "updated">;
  when: StoredTriggerWhen;
  action: StoredTriggerAction;
}

interface TriggerRow {
  name: string;
  events: string;
  when: string;
  action: string;
  created_at: string;
  updated_at: string;
}

function decodeRow(row: TriggerRow): StoredTrigger {
  return {
    name: row.name,
    events: safeParse(row.events, ["created", "updated"]) as Array<"created" | "updated">,
    when: safeParse(row.when, {}) as StoredTriggerWhen,
    action: safeParse(row.action, { webhook: "" }) as StoredTriggerAction,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function safeParse(json: string, fallback: unknown): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

/**
 * Insert or replace a trigger by name. Preserves `created_at` on update
 * (re-fetches the existing row's timestamp) and stamps a fresh `updated_at`.
 * Returns the stored shape.
 */
export function upsertTrigger(db: Database, input: TriggerInput): StoredTrigger {
  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT created_at FROM triggers WHERE name = ?")
    .get(input.name) as { created_at: string } | null;
  const createdAt = existing?.created_at ?? now;
  const events = input.events ?? ["created", "updated"];

  db.prepare(
    `INSERT INTO triggers (name, events, "when", action, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       events = excluded.events,
       "when" = excluded."when",
       action = excluded.action,
       updated_at = excluded.updated_at`,
  ).run(
    input.name,
    JSON.stringify(events),
    JSON.stringify(input.when),
    JSON.stringify(input.action),
    createdAt,
    now,
  );

  return {
    name: input.name,
    events,
    when: input.when,
    action: input.action,
    created_at: createdAt,
    updated_at: now,
  };
}

/** List all persisted triggers for this vault, ordered by name. */
export function listTriggers(db: Database): StoredTrigger[] {
  const rows = db
    .prepare(
      `SELECT name, events, "when", action, created_at, updated_at
       FROM triggers ORDER BY name`,
    )
    .all() as TriggerRow[];
  return rows.map(decodeRow);
}

/** Fetch a single trigger by name, or null. */
export function getTrigger(db: Database, name: string): StoredTrigger | null {
  const row = db
    .prepare(
      `SELECT name, events, "when", action, created_at, updated_at
       FROM triggers WHERE name = ?`,
    )
    .get(name) as TriggerRow | null;
  return row ? decodeRow(row) : null;
}

/** Delete a trigger by name. Returns true if a row was removed. */
export function deleteTrigger(db: Database, name: string): boolean {
  const res = db.prepare("DELETE FROM triggers WHERE name = ?").run(name);
  return res.changes > 0;
}

/** Load all persisted triggers (boot path). Alias of listTriggers for clarity. */
export function loadAllTriggers(db: Database): StoredTrigger[] {
  return listTriggers(db);
}
