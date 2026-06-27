/**
 * Scope primitives for vault enforcement.
 *
 * Tokens carry OAuth-standard whitespace-separated scopes. Two shapes coexist:
 *
 *   - **Broad** `vault:<verb>` — used by legacy YAML api_keys and the
 *     VAULT_AUTH_TOKEN operator bearer, which are vault-pinned by context
 *     (the YAML key lives under a specific vault; the operator bearer is
 *     server-wide full-admin). (The `pvt_*` vault-DB token that also used
 *     this shape was dropped at 0.5.0 — vault#282 Stage 2.)
 *   - **Narrowed** `vault:<name>:<verb>` — used by hub-issued JWTs, which are
 *     not pinned by storage and so MUST name the resource they grant access
 *     to. Hub JWTs carrying broad `vault:<verb>` are rejected at validation
 *     (see `authenticateHubJwt`).
 *
 * Inheritance is `admin ⊇ write ⊇ read` for both shapes. `hasScopeForVault`
 * resolves a (vault, verb) request: broad grants satisfy any vault (the
 * caller has already pinned the vault via DB lookup), narrowed grants
 * satisfy only the matching vault.
 *
 * Legacy back-compat: tokens without any `vault:*` scope — but with a
 * 0.2.x-era `permission = "full" | "read"` — are mapped to the appropriate
 * scope set on the fly. `legacyPermissionToScopes` is marked deprecated and
 * should be removed one release after enforcement lands.
 */

export const SCOPE_READ = "vault:read" as const;
export const SCOPE_WRITE = "vault:write" as const;
export const SCOPE_ADMIN = "vault:admin" as const;

/**
 * Migration-bypass scope (vault#299). A SEPARATE capability axis — NOT part
 * of the read ⊇ write ⊇ admin inheritance chain. A token holding
 * `vault:migrate` (broad) or `vault:<name>:migrate` (narrowed) may skip
 * `strict:true` schema enforcement so existing non-conforming notes can be
 * migrated/backfilled. It is deliberately orthogonal: an `admin` token does
 * NOT auto-bypass strict validation — bypass must be an explicit, audited
 * grant. A bypass write still needs `write` to actually mutate (migrate is an
 * ADD-ON flag, not a write grant on its own). Every bypassed write is logged
 * (see the write path) since #300 (the audit-log table) is deferred.
 */
export const SCOPE_MIGRATE = "vault:migrate" as const;

/** All first-class vault scopes in inheritance order (lowest → highest). */
export const VAULT_SCOPES = [SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN] as const;
export type VaultScope = (typeof VAULT_SCOPES)[number];

/** The verb component of a vault scope — `read`, `write`, or `admin`. */
export type VaultVerb = "read" | "write" | "admin";

const VERB_RANK: Record<VaultVerb, number> = { read: 0, write: 1, admin: 2 };

function isVerb(s: string): s is VaultVerb {
  return s === "read" || s === "write" || s === "admin";
}

/**
 * Decompose a scope string into `{ vault?, verb }` if it's a recognized vault
 * scope; return `null` otherwise. Recognizes both broad (`vault:<verb>`) and
 * narrowed (`vault:<name>:<verb>`) shapes. The empty-name case
 * (`vault::read`) is rejected — a hand-crafted DB row with that shape must
 * not satisfy any vault scope check.
 */
function decomposeVaultScope(scope: string): { vault: string | null; verb: VaultVerb } | null {
  const parts = scope.split(":");
  if (parts.length === 2 && parts[0] === "vault" && isVerb(parts[1]!)) {
    return { vault: null, verb: parts[1]! as VaultVerb };
  }
  if (parts.length === 3 && parts[0] === "vault" && parts[1]!.length > 0 && isVerb(parts[2]!)) {
    return { vault: parts[1]!, verb: parts[2]! as VaultVerb };
  }
  return null;
}

/**
 * Parse a whitespace-separated scope string into a scope list.
 *
 *   - Empty / null → []
 *   - Trim + split on any whitespace
 *   - Both `vault:<verb>` and `vault:<name>:<verb>` shapes are preserved
 *     verbatim; `hasScope` / `hasScopeForVault` decide what each satisfies.
 *   - Unrecognized scopes are preserved as-is (they just won't match anything)
 */
export function parseScopes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Broad-query check: does `granted` satisfy `required` (e.g. `vault:read`)?
 *
 * Used by code paths that don't have a specific vault in hand — JWT claim
 * inspection, MCP tool list filtering inside a session that's already pinned
 * to one vault, the legacy permission-derivation path. For per-request
 * routing where the URL names a vault, prefer `hasScopeForVault`.
 *
 * A `vault:<name>:<verb>` grant DOES satisfy a broad `vault:<verb>` query —
 * narrowed scopes are strictly more specific. The reverse is not true; broad
 * grants do not satisfy narrowed queries via this function.
 *
 * Inheritance `admin ⊇ write ⊇ read` applies in both forms. Non-vault scopes
 * require exact match.
 */
export function hasScope(granted: string[], required: string): boolean {
  if (granted.includes(required)) return true;

  const requiredDecomposed = decomposeVaultScope(required);
  if (!requiredDecomposed || requiredDecomposed.vault !== null) {
    // Non-vault scope or narrowed query — exact match only via hasScope.
    // (Narrowed queries belong on hasScopeForVault.)
    return false;
  }
  const reqRank = VERB_RANK[requiredDecomposed.verb];
  for (const s of granted) {
    const d = decomposeVaultScope(s);
    if (d && VERB_RANK[d.verb] >= reqRank) return true;
  }
  return false;
}

/**
 * Per-vault check: does `granted` satisfy a (vault, verb) request? Use this
 * at request-routing time — the URL names the vault and the method picks
 * the verb.
 *
 * Match rules:
 *   - Broad `vault:<verb>` in granted satisfies any vault (the broad scope
 *     has no resource constraint; the caller pins the vault upstream — a
 *     legacy YAML key lives under a specific vault, the VAULT_AUTH_TOKEN
 *     bearer is server-wide full-admin, and hub JWTs reject broad scopes at
 *     validation).
 *   - Narrowed `vault:<name>:<verb>` satisfies only the matching `vaultName`.
 *   - Verb inheritance `admin ⊇ write ⊇ read` applies in both forms.
 */
export function hasScopeForVault(
  granted: string[],
  vaultName: string,
  requiredVerb: VaultVerb,
): boolean {
  const reqRank = VERB_RANK[requiredVerb];
  for (const s of granted) {
    const d = decomposeVaultScope(s);
    if (!d) continue;
    if (d.vault !== null && d.vault !== vaultName) continue;
    if (VERB_RANK[d.verb] >= reqRank) return true;
  }
  return false;
}

/**
 * Migration-bypass check (vault#299): does `granted` hold the `migrate`
 * capability for `vaultName`? Accepts broad `vault:migrate` (any vault) or
 * narrowed `vault:<name>:migrate` (this vault only). Orthogonal to the
 * read/write/admin verbs — a plain admin token returns `false` here, by
 * design. The migrate scope does NOT live in `decomposeVaultScope` (it isn't a
 * read/write/admin verb), so it's matched by exact shape here.
 */
export function hasMigrateScopeForVault(granted: string[], vaultName: string): boolean {
  for (const s of granted) {
    if (s === SCOPE_MIGRATE) return true; // broad — any vault
    if (s === `vault:${vaultName}:migrate`) return true; // narrowed — this vault
  }
  return false;
}

/**
 * Structured log line for a migration-bypassed write (vault#299 settled lead
 * #2). Records WHO bypassed (actor/via from MW1 attribution), WHAT note, and
 * WHICH strict violations were waived — enough to reconstruct the bypass for
 * later audit without the #300 audit-log table (deferred). One JSON line so
 * it's grep/jq-able in the daemon log. Lives here (next to the migrate-scope
 * check) so both write transports — REST (routes.ts) and MCP (mcp-tools.ts) —
 * emit the identical line without importing each other.
 */
export function logStrictBypass(info: {
  actor: string | null;
  via: string | null;
  path?: string | null;
  tags?: string[];
  violations: { field: string; reason: string; schema: string }[];
}): void {
  console.warn(
    "[schema-bypass] " +
      JSON.stringify({
        event: "strict_schema_bypass",
        actor: info.actor,
        via: info.via,
        path: info.path ?? null,
        tags: info.tags ?? [],
        violations: info.violations.map((v) => ({
          field: v.field,
          reason: v.reason,
          schema: v.schema,
        })),
        at: new Date().toISOString(),
      }),
  );
}

/**
 * Pick the required scope for a given API request.
 *   - GET/HEAD/OPTIONS → read
 *   - POST/PATCH/PUT/DELETE → write
 *
 * Admin-gated endpoints (like `/.parachute/config`) don't go through this
 * helper — they call `hasScopeForVault(auth.scopes, vaultName, "admin")`
 * directly.
 */
export function scopeForMethod(method: string): VaultScope {
  return verbForMethod(method) === "read" ? SCOPE_READ : SCOPE_WRITE;
}

/** Verb-only variant of `scopeForMethod`, for use with `hasScopeForVault`. */
export function verbForMethod(method: string): VaultVerb {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return "read";
  return "write";
}

/**
 * Validate scopes requested for token minting on a specific vault.
 *
 * Each requested scope must be (a) a recognized vault scope shape, (b) not
 * naming a different vault (cross-vault rejected), and (c) within the
 * caller's verb power on `vaultName`. The third check is defense-in-depth:
 * the REST endpoint already gates on `vault:admin`, but enforcing subset
 * here means a future loosening of the gate (or a partially-trusted caller)
 * still cannot mint a token stronger than what they hold.
 *
 * Pass-through on success — we don't rewrite scopes, just decide yes/no.
 */
export function validateMintedScopes(
  requested: string[],
  vaultName: string,
  callerScopes: string[],
): { ok: true } | { ok: false; rejected: { scope: string; reason: string }[] } {
  const rejected: { scope: string; reason: string }[] = [];
  for (const s of requested) {
    const d = decomposeVaultScope(s);
    if (!d) {
      rejected.push({ scope: s, reason: "unknown or unsupported scope" });
      continue;
    }
    if (d.vault !== null && d.vault !== vaultName) {
      rejected.push({
        scope: s,
        reason: `cross-vault scope not allowed (this endpoint mints for vault '${vaultName}')`,
      });
      continue;
    }
    if (!hasScopeForVault(callerScopes, vaultName, d.verb)) {
      rejected.push({
        scope: s,
        reason: `caller lacks '${d.verb}' on vault '${vaultName}' — cannot grant a stronger scope than held`,
      });
      continue;
    }
  }
  if (rejected.length > 0) return { ok: false, rejected };
  return { ok: true };
}

/**
 * Detect a broad `vault:<verb>` scope in a granted list. Hub-issued JWTs
 * must NOT carry broad vault scopes — the hub mints `vault:<name>:<verb>` so
 * the resource is named on the wire. `authenticateHubJwt` calls this to
 * reject tokens that slipped through with the old shape.
 */
export function findBroadVaultScopes(granted: string[]): string[] {
  const out: string[] = [];
  for (const s of granted) {
    const d = decomposeVaultScope(s);
    if (d && d.vault === null) out.push(s);
  }
  return out;
}

/**
 * Map a 0.2.x legacy `permission` column value to scopes. Kept for back-compat
 * during the one-release-cycle deprecation window — after that, every token
 * row will carry an explicit `scopes` column and this can go.
 *
 * @deprecated Remove one release after v0.4 scope enforcement lands.
 */
export function legacyPermissionToScopes(permission: string): string[] {
  // "full", "admin", "write" all historically meant unrestricted access
  if (permission === "read") return [SCOPE_READ];
  return [SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN];
}

/** Serialize a scope list to an OAuth-standard whitespace-separated string. */
export function serializeScopes(scopes: string[]): string {
  return scopes.join(" ");
}

/**
 * Parse `--scope` flag values from an argv list into a validated scope list.
 *
 * Accepts repeatable `--scope vault:read --scope vault:write` and
 * comma-separated `--scope vault:read,vault:write` (and a mix of the two).
 * Scopes are validated against `VAULT_SCOPES` — we refuse to mint a token
 * with a scope the server has no way to enforce.
 *
 * Return shape: `{scopes}` is `null` when no `--scope` appears anywhere, so
 * the caller can distinguish "flag not set" from "flag set to empty." On
 * validation failure, `error` is a human-readable message suitable for
 * `console.error` + `process.exit(1)`.
 */
export function parseScopeFlags(
  args: string[],
): { scopes: string[] | null; error: string | null } {
  const validList = VAULT_SCOPES.join(", ");
  const raw: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--scope") continue;
    const val = args[i + 1];
    if (val === undefined || val.startsWith("--")) {
      return { scopes: null, error: `--scope requires a value. Valid scopes: ${validList}` };
    }
    raw.push(val);
    i++;
  }
  if (raw.length === 0) return { scopes: null, error: null };

  const expanded = raw
    .flatMap((v) => v.split(","))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (expanded.length === 0) {
    return { scopes: null, error: `--scope value was empty. Valid scopes: ${validList}` };
  }

  const validSet = new Set<string>(VAULT_SCOPES);
  const invalid = expanded.filter((s) => !validSet.has(s));
  if (invalid.length > 0) {
    return {
      scopes: null,
      error: `Unknown scope(s): ${invalid.join(", ")}. Valid scopes: ${validList}`,
    };
  }

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const s of expanded) {
    if (!seen.has(s)) {
      seen.add(s);
      deduped.push(s);
    }
  }
  return { scopes: deduped, error: null };
}
