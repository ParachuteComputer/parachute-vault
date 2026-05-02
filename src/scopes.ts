/**
 * Scope primitives for vault enforcement.
 *
 * Tokens carry OAuth-standard whitespace-separated scopes. Two shapes coexist:
 *
 *   - **Broad** `vault:<verb>` — used by `pvt_*` tokens, which are vault-pinned
 *     by storage (each vault has its own tokens DB; a token only resolves
 *     against the vault that minted it).
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
 *     has no resource constraint; the caller pins the vault upstream — pvt_*
 *     resolves only against its issuing vault's DB, hub JWTs reject broad
 *     scopes at validation).
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

/**
 * Resolve `parachute vault tokens create` argv into a concrete scope set +
 * legacy `permission` column value, or an actionable error.
 *
 * Precedence is **exclusive**: `--scope`, `--read`, and `--permission` all
 * narrow the token, but combining them is always an error — a user who
 * writes `--scope vault:write --read` almost certainly expects one of the
 * two to win, and silently picking would mint the opposite of what at
 * least one reading intended. Fail loud for anything token-minting.
 *
 * With no narrowing flag, falls back to a full-scope token for back-compat.
 */
export function resolveCreateTokenFlags(args: string[]): {
  scopes: string[] | undefined;
  permission: "full" | "read";
  error: string | null;
} {
  const scopeResult = parseScopeFlags(args);
  if (scopeResult.error) {
    return { scopes: undefined, permission: "full", error: scopeResult.error };
  }
  const hasScopeFlag = scopeResult.scopes !== null;
  const hasReadFlag = args.includes("--read");
  const permIdx = args.indexOf("--permission");
  const hasPermFlag = permIdx !== -1;

  if (hasScopeFlag && hasReadFlag) {
    return {
      scopes: undefined,
      permission: "full",
      error:
        "--scope and --read cannot be combined. Pick one:\n" +
        "  --read                     # shorthand for --scope vault:read\n" +
        "  --scope vault:read         # equivalent, explicit\n" +
        "  --scope vault:write        # write scope",
    };
  }
  if (hasScopeFlag && hasPermFlag) {
    return {
      scopes: undefined,
      permission: "full",
      error:
        "--scope and --permission cannot be combined. --scope is the canonical way to narrow a token; --permission is legacy.",
    };
  }
  if (hasReadFlag && hasPermFlag) {
    return {
      scopes: undefined,
      permission: "full",
      error: "--read and --permission cannot be combined. --read is a shorthand for --permission read.",
    };
  }

  if (hasPermFlag) {
    const rawPerm = args[permIdx + 1];
    if (!rawPerm || rawPerm.startsWith("--")) {
      return {
        scopes: undefined,
        permission: "full",
        error: `--permission requires a value ("full" or "read"). Prefer --scope for new scripts.`,
      };
    }
    if (!["full", "read"].includes(rawPerm)) {
      return {
        scopes: undefined,
        permission: "full",
        error: `Invalid --permission: ${rawPerm}. Must be "full" or "read". Prefer --scope for new scripts.`,
      };
    }
  }

  if (scopeResult.scopes) {
    const scopes = scopeResult.scopes;
    const permission: "full" | "read" =
      scopes.includes(SCOPE_WRITE) || scopes.includes(SCOPE_ADMIN) ? "full" : "read";
    return { scopes, permission, error: null };
  }
  if (hasReadFlag) {
    return { scopes: [SCOPE_READ], permission: "read", error: null };
  }
  if (hasPermFlag) {
    const rawPerm = args[permIdx + 1];
    return {
      scopes: undefined,
      permission: rawPerm === "read" ? "read" : "full",
      error: null,
    };
  }
  return { scopes: undefined, permission: "full", error: null };
}
