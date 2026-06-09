/**
 * Validation for vault names.
 *
 * Vault names appear in URLs (`/vault/<name>/mcp`, `/vault/<name>/api/*`),
 * the SQLite filename, and the JWT audience claim (`aud: vault.<name>`) —
 * anything that breaks URL routing or filesystem assumptions has to be
 * rejected up front.
 *
 * Rule: lowercase alphanumeric + hyphens or underscores, 2–32 chars, with
 * `list` / `new` / `assets` / `admin` reserved. Used by the `init` prompt,
 * the `--vault-name` flag, the `PARACHUTE_VAULT_NAME` env var at server
 * first-boot, and (since the 2026-06-09 hub-module-boundary migration B2)
 * `cmdCreate` — every name-minting edge shares this one validator.
 */

const VAULT_NAME_RE = /^[a-z0-9_-]+$/;
const VAULT_NAME_MIN_LEN = 2;
const VAULT_NAME_MAX_LEN = 32;

/**
 * THE reserved vault-name set — kept in lockstep with hub's
 * `RESERVED_VAULT_NAMES` (parachute-hub/src/vault-name.ts, B2h of the
 * 2026-06-09 hub-module-boundary migration). A vault under any of these
 * names would have its URL surface captured by a reserved route:
 *
 *   - `list`   — legacy `/vaults/list` discovery-endpoint collision; the
 *     routes have since moved under `/vault/<name>/`, but consistency with
 *     the historical reservation is cheap.
 *   - `new`    — collides with `/vault/new`, the hub SPA's create route.
 *   - `assets` — collides with `/vault/assets/*`, the hub SPA's bundle.
 *   - `admin`  — collides with `/vault/admin`, the daemon-level mount for
 *     vault's own multi-vault admin surface (B3). Both the hub's route and
 *     this daemon's own routing dispatch `/vault/admin/*` before the
 *     per-vault branch, so a vault named `admin` would be fully shadowed.
 */
export const RESERVED_VAULT_NAMES: ReadonlySet<string> = new Set([
  "list",
  "new",
  "assets",
  "admin",
]);

/**
 * The subset of reserved names whose data plane is SHADOWED by reserved
 * routes when a vault squats them (created before the reservation landed).
 * `list` is reserved for historical consistency only — `/vault/list/*`
 * still routes per-vault — so it's excluded here.
 */
const SHADOWED_RESERVED_NAMES = ["admin", "new", "assets"] as const;

/**
 * Build boot-time warnings for vaults squatting a shadowed reserved name.
 * Pure (takes the vault list, returns warning strings) so server boot can
 * `console.warn` each and tests can pin the copy without booting a server.
 *
 * Recovery procedure is spelled out because no rename command exists:
 * export → create under a new name → import → remove the squatter.
 */
export function reservedNameSquatWarnings(vaults: readonly string[]): string[] {
  const warnings: string[] = [];
  for (const reserved of SHADOWED_RESERVED_NAMES) {
    if (!vaults.includes(reserved)) continue;
    warnings.push(
      `[reserved-name] vault "${reserved}" exists but "${reserved}" is a reserved name — ` +
        `its data plane (/vault/${reserved}/*) is shadowed by reserved hub/daemon routes, so its ` +
        `MCP, REST, and admin surfaces are unreachable. Recover by renaming it (no rename ` +
        `command exists): parachute-vault export <dir> --vault ${reserved} → ` +
        `parachute-vault create <newname> → parachute-vault import <dir> --vault <newname> → ` +
        `parachute-vault remove ${reserved} --yes`,
    );
  }
  return warnings;
}

export type VaultNameValidation =
  | { ok: true; name: string }
  | { ok: false; error: string };

/**
 * Validate a vault name. Accepts lowercase alphanumeric + hyphens or
 * underscores, 2–32 chars, none of `RESERVED_VAULT_NAMES`. Trims
 * surrounding whitespace before checking. The one gate used by the env
 * var, the `--vault-name` flag, hub's first-boot wizard, AND `cmdCreate`
 * (consolidated 2026-06-09 — cmdCreate previously carried its own inline
 * charset + `"list"` check that had drifted from this set).
 */
export function validateVaultName(raw: string): VaultNameValidation {
  const name = raw.trim();
  if (!name) {
    return { ok: false, error: "vault name cannot be empty." };
  }
  if (name.length < VAULT_NAME_MIN_LEN || name.length > VAULT_NAME_MAX_LEN) {
    return {
      ok: false,
      error: `vault names must be ${VAULT_NAME_MIN_LEN}–${VAULT_NAME_MAX_LEN} characters long.`,
    };
  }
  if (!VAULT_NAME_RE.test(name)) {
    return {
      ok: false,
      error:
        "vault names must be lowercase alphanumeric with hyphens or underscores. Try again.",
    };
  }
  if (RESERVED_VAULT_NAMES.has(name)) {
    return { ok: false, error: `"${name}" is a reserved vault name.` };
  }
  return { ok: true, name };
}

/**
 * Decide what vault name `init` should use, based on `--vault-name` and
 * whether we're attached to a TTY. Pure: extracted so the flag/TTY matrix
 * can be unit-tested without spawning the CLI or touching the filesystem.
 *
 *   - flag present + valid → `{ kind: "name", name }`
 *   - flag present + invalid (or missing value) → `{ kind: "error", message }`
 *   - no flag, non-TTY → `{ kind: "name", name: "default" }` (piped install)
 *   - no flag, TTY → `{ kind: "prompt" }` (caller runs an interactive prompt)
 */
export type VaultNameDecision =
  | { kind: "name"; name: string }
  | { kind: "prompt" }
  | { kind: "error"; message: string };

export function decideInitVaultName(
  args: string[],
  opts: { isTTY: boolean },
): VaultNameDecision {
  const idx = args.indexOf("--vault-name");
  if (idx !== -1) {
    const raw = args[idx + 1];
    if (raw === undefined) {
      return {
        kind: "error",
        message: "--vault-name requires a value, e.g. --vault-name aaron",
      };
    }
    const v = validateVaultName(raw);
    if (!v.ok) return { kind: "error", message: `--vault-name: ${v.error}` };
    return { kind: "name", name: v.name };
  }
  if (!opts.isTTY) {
    return { kind: "name", name: "default" };
  }
  return { kind: "prompt" };
}

/**
 * Pick the first-boot vault name based on `PARACHUTE_VAULT_NAME`. Used by
 * `server.ts` when the server starts with zero vaults on disk (Docker
 * first-boot, hub-driven self-host install).
 *
 *   - env var unset / empty / whitespace-only → `{ source: "default", name: "default" }`
 *   - env var present + valid → `{ source: "env", name: <validated> }`
 *   - env var present + invalid → `{ source: "env-invalid", name: "default",
 *     rawValue: <original>, reason: <validator message> }` (caller logs a
 *     warning and proceeds with the default name; we never abort first-boot
 *     over a misconfigured env var)
 *
 * Validation uses the same `validateVaultName` rule as the `--vault-name`
 * flag — lowercase alphanumeric + hyphens or underscores, 2–32 chars, with
 * the `list` reserved-name carveout — so hub's wizard, the CLI flag, and
 * the env var all share one truth.
 */
export type FirstBootVaultName =
  | { source: "default"; name: "default" }
  | { source: "env"; name: string }
  | { source: "env-invalid"; name: "default"; rawValue: string; reason: string };

export function resolveFirstBootVaultName(
  rawEnvValue: string | undefined,
): FirstBootVaultName {
  if (rawEnvValue === undefined || rawEnvValue.trim() === "") {
    return { source: "default", name: "default" };
  }
  const v = validateVaultName(rawEnvValue);
  if (v.ok) {
    return { source: "env", name: v.name };
  }
  return {
    source: "env-invalid",
    name: "default",
    rawValue: rawEnvValue,
    reason: v.error,
  };
}
