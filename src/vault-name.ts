/**
 * Validation for vault names.
 *
 * Vault names appear in URLs (`/vault/<name>/mcp`, `/vault/<name>/api/*`),
 * the SQLite filename, and the OAuth consent page — anything that breaks
 * URL routing or filesystem assumptions has to be rejected up front.
 *
 * Rule: lowercase alphanumeric + hyphens or underscores, 2–32 chars, with
 * `list` reserved. Used by the `init` prompt, the `--vault-name` flag, and
 * the `PARACHUTE_VAULT_NAME` env var at server first-boot. `cmdCreate`
 * keeps its own (slightly more permissive, legacy) regex for backward
 * compat — tightening it would reject names existing users may already
 * have minted.
 */

const VAULT_NAME_RE = /^[a-z0-9_-]+$/;
const VAULT_NAME_MIN_LEN = 2;
const VAULT_NAME_MAX_LEN = 32;

const RESERVED_NAMES = new Set([
  // Collides with the `/vaults/list` discovery endpoint historically; the
  // routes have since moved under `/vault/<name>/`, but `cmdCreate` still
  // rejects "list" and consistency is cheap.
  "list",
]);

export type VaultNameValidation =
  | { ok: true; name: string }
  | { ok: false; error: string };

/**
 * Validate a vault name. Accepts lowercase alphanumeric + hyphens or
 * underscores, 2–32 chars. Trims surrounding whitespace before checking.
 * `cmdCreate` keeps its own (legacy-permissive) regex; this validator is
 * the strict gate used by the env var, the `--vault-name` flag, and
 * hub's first-boot wizard.
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
  if (RESERVED_NAMES.has(name)) {
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
