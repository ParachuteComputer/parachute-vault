/**
 * Runtime trigger-registration REST API (frictionless-channel-setup PR 1).
 *
 * Mounts under `/vault/<v>/api/triggers`, ADMIN-scoped. Registering a webhook
 * trigger exfiltrates note data to an arbitrary URL — that's an admin
 * capability, not `write` — so every method here gates on `vault:admin`
 * (or the narrowed `vault:<v>:admin`). The gate is enforced in `handleTriggers`
 * itself rather than the method-based verb gate in routing.ts, because a GET
 * here must still require admin (read is too weak).
 *
 *   POST   /api/triggers        — upsert {name, events, when, action};
 *                                 validate webhook URL; persist; (re-)register
 *                                 live on the shared hook registry, vault-scoped.
 *   GET    /api/triggers        — list this vault's persisted triggers.
 *   DELETE /api/triggers/:name  — unregister the live hook + delete the row.
 *
 * A process-wide registry of unregister-fns keyed by (vault, name) lets
 * POST-replace and DELETE unwind the prior live hook before re-registering.
 */

import type { SqliteStore } from "../core/src/store.ts";
import { defaultHookRegistry } from "../core/src/hooks.ts";
import {
  upsertTrigger,
  listTriggers,
  getTrigger,
  deleteTrigger,
  loadAllTriggers,
  type StoredTrigger,
  type TriggerInput,
} from "../core/src/triggers-store.ts";
import { registerVaultTrigger } from "./triggers.ts";
import { SUPPORTED_OPS } from "../core/src/query-operators.ts";
import { hasScopeForVault, SCOPE_ADMIN } from "./scopes.ts";
import type { AuthResult } from "./auth.ts";

// ---------------------------------------------------------------------------
// Live registry of unregister-fns, keyed by `${vault}${name}` (SPACE
// separator). Neither vault names (validated on create) nor trigger names
// (NAME_RE below — [A-Za-z0-9][A-Za-z0-9_-]*) admit a space, so the composite
// key can't collide. Survives across requests in the long-lived server
// process; on boot it's repopulated by `loadVaultTriggers`.
// ---------------------------------------------------------------------------

const liveTriggers = new Map<string, () => void>();

function liveKey(vaultName: string, triggerName: string): string {
  return `${vaultName}${triggerName}`;
}

/** Unregister + forget any live hook for (vault, name). No-op if absent. */
function unwindLiveTrigger(vaultName: string, triggerName: string): void {
  const key = liveKey(vaultName, triggerName);
  const fn = liveTriggers.get(key);
  if (fn) {
    try {
      fn();
    } catch {
      // unregister is a pure array splice — failures shouldn't happen, but a
      // throw here must not block delete/replace. Swallow + drop the entry.
    }
    liveTriggers.delete(key);
  }
}

/**
 * Register a stored trigger live on the shared hook registry, vault-scoped,
 * replacing any prior same-(vault,name) hook. Exported for the boot path.
 */
export function registerLiveTrigger(vaultName: string, trigger: StoredTrigger): void {
  unwindLiveTrigger(vaultName, trigger.name);
  const unregister = registerVaultTrigger(defaultHookRegistry, trigger, vaultName);
  liveTriggers.set(liveKey(vaultName, trigger.name), unregister);
}

/**
 * Boot loader: register every persisted trigger for a vault, scoped to it.
 * Idempotent — replaces any existing live registration per (vault, name).
 * Called for each vault at server start (alongside config.yaml triggers).
 */
export function loadVaultTriggers(vaultName: string, store: SqliteStore): number {
  const triggers = loadAllTriggers(store.db);
  for (const t of triggers) {
    registerLiveTrigger(vaultName, t);
  }
  return triggers.length;
}

/** Test-only: clear the live registry (unregistering each hook). */
export function clearLiveTriggers(): void {
  for (const [, fn] of liveTriggers) {
    try {
      fn();
    } catch {
      /* swallow */
    }
  }
  liveTriggers.clear();
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function validateInput(body: unknown):
  | { ok: true; input: TriggerInput }
  | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, message: "request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.name !== "string" || !NAME_RE.test(b.name)) {
    return {
      ok: false,
      message:
        "`name` is required and must match [A-Za-z0-9][A-Za-z0-9_-]* (no whitespace, NUL, or leading punctuation)",
    };
  }

  // events — optional; default applied at the store. When present, must be a
  // subset of {created, updated}.
  let events: Array<"created" | "updated"> | undefined;
  if (b.events !== undefined) {
    if (
      !Array.isArray(b.events) ||
      !b.events.every((e) => e === "created" || e === "updated")
    ) {
      return { ok: false, message: "`events` must be an array of 'created'/'updated'" };
    }
    events = b.events as Array<"created" | "updated">;
  }

  if (typeof b.when !== "object" || b.when === null || Array.isArray(b.when)) {
    return { ok: false, message: "`when` is required and must be an object" };
  }
  // Value-matched metadata predicate (vault#299 Part B): when present, each
  // field must map to an operator-object whose keys are all supported
  // operators. Fail at registration so a typo'd operator (`{ state: { equals:
  // ... } }`) is a 400, not a silently-never-firing trigger.
  const whenMeta = (b.when as Record<string, unknown>).metadata;
  if (whenMeta !== undefined) {
    if (typeof whenMeta !== "object" || whenMeta === null || Array.isArray(whenMeta)) {
      return { ok: false, message: "`when.metadata` must be an object mapping field → operator-object" };
    }
    for (const [field, opObj] of Object.entries(whenMeta as Record<string, unknown>)) {
      if (typeof opObj !== "object" || opObj === null || Array.isArray(opObj)) {
        return { ok: false, message: `\`when.metadata.${field}\` must be an operator-object, e.g. { eq: "published" }` };
      }
      for (const op of Object.keys(opObj as Record<string, unknown>)) {
        if (!SUPPORTED_OPS.includes(op as (typeof SUPPORTED_OPS)[number])) {
          return {
            ok: false,
            message: `\`when.metadata.${field}\` has unknown operator "${op}". Supported: ${SUPPORTED_OPS.join(", ")}.`,
          };
        }
      }
    }
  }

  if (typeof b.action !== "object" || b.action === null || Array.isArray(b.action)) {
    return { ok: false, message: "`action` is required and must be an object" };
  }
  const action = b.action as Record<string, unknown>;
  if (typeof action.webhook !== "string" || action.webhook.length === 0) {
    return { ok: false, message: "`action.webhook` is required and must be a string URL" };
  }
  // Reuse the same http/https validation registerTriggers does, but fail the
  // request here (400) rather than silently skipping at registration time.
  try {
    const url = new URL(action.webhook);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return {
        ok: false,
        message: `\`action.webhook\` must use http or https (got ${url.protocol})`,
      };
    }
  } catch {
    return { ok: false, message: `\`action.webhook\` is not a valid URL: ${action.webhook}` };
  }
  if (action.auth !== undefined) {
    if (typeof action.auth !== "object" || action.auth === null || Array.isArray(action.auth)) {
      return { ok: false, message: "`action.auth` must be an object when present" };
    }
    // `bearer` is the only auth field today. When present it MUST be a
    // non-empty string — a non-string (number/object/false/null) would either
    // silently no-op or serialize as `[object Object]` into the Authorization
    // header at fire time. Reject at the door.
    const auth = action.auth as Record<string, unknown>;
    if (auth.bearer !== undefined && (typeof auth.bearer !== "string" || auth.bearer.length === 0)) {
      return {
        ok: false,
        message: "`action.auth.bearer` must be a non-empty string when present",
      };
    }
  }

  return {
    ok: true,
    input: {
      name: b.name,
      events,
      when: b.when as TriggerInput["when"],
      action: b.action as TriggerInput["action"],
    },
  };
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------

/**
 * Redact the webhook auth secret before serializing a trigger into ANY HTTP
 * response. A registration credential (`action.auth.bearer`, typically a hub
 * JWT) is a one-way input: the caller supplies it, but it must never be
 * readable back over GET (or echoed by POST). We keep the `bearer` KEY present
 * — set to the sentinel `"[REDACTED]"` — so clients can still see that auth IS
 * configured, just not its value.
 *
 * Response-only: the DB row and the live webhook-fire path keep the real
 * bearer (verified by the per-vault firing test, which asserts the fired
 * request still carries the real `Authorization: Bearer <token>`).
 */
const REDACTED = "[REDACTED]";

export function redactTrigger(t: StoredTrigger): StoredTrigger {
  const bearer = t.action.auth?.bearer;
  if (bearer === undefined) return t;
  return {
    ...t,
    action: {
      ...t.action,
      auth: { ...t.action.auth, bearer: REDACTED },
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

/**
 * Handle `/api/triggers` and `/api/triggers/:name`. `subPath` is the portion
 * AFTER `/triggers` (e.g. "" for the collection, "/my-trigger" for an item).
 * Admin-scoped — the gate lives here (not the routing.ts verb gate) so GET
 * also requires admin.
 */
export async function handleTriggers(
  req: Request,
  store: SqliteStore,
  subPath: string,
  vaultName: string,
  auth: AuthResult,
): Promise<Response> {
  // Admin gate — every method. A webhook trigger exfiltrates note data, so
  // even listing/reading is an admin capability here.
  if (!hasScopeForVault(auth.scopes, vaultName, "admin")) {
    return Response.json(
      {
        error: "Forbidden",
        error_type: "insufficient_scope",
        message: `This endpoint requires the '${SCOPE_ADMIN}' scope (or '${SCOPE_ADMIN.replace(
          "vault:",
          `vault:${vaultName}:`,
        )}').`,
        required_scope: SCOPE_ADMIN,
        granted_scopes: auth.scopes,
      },
      { status: 403 },
    );
  }

  const itemName = subPath.startsWith("/") ? decodeURIComponent(subPath.slice(1)) : "";

  // Collection: /api/triggers
  if (itemName === "") {
    if (req.method === "GET") {
      return Response.json({ triggers: listTriggers(store.db).map(redactTrigger) });
    }
    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      const validated = validateInput(body);
      if (!validated.ok) {
        return Response.json({ error: validated.message }, { status: 400 });
      }
      // Persist (upsert by name) then (re-)register live, vault-scoped. The
      // live registration replaces any prior same-name hook for this vault.
      const stored = upsertTrigger(store.db, validated.input);
      registerLiveTrigger(vaultName, stored);
      return Response.json({ trigger: redactTrigger(stored) }, { status: 200 });
    }
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  // Item: /api/triggers/:name
  if (req.method === "DELETE") {
    const existed = getTrigger(store.db, itemName) !== null;
    unwindLiveTrigger(vaultName, itemName);
    const removed = deleteTrigger(store.db, itemName);
    if (!existed && !removed) {
      return Response.json({ error: "Not found", name: itemName }, { status: 404 });
    }
    return Response.json({ deleted: itemName });
  }
  if (req.method === "GET") {
    const t = getTrigger(store.db, itemName);
    if (!t) return Response.json({ error: "Not found", name: itemName }, { status: 404 });
    return Response.json({ trigger: redactTrigger(t) });
  }
  return Response.json({ error: "Method not allowed" }, { status: 405 });
}
