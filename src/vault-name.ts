/**
 * Validation for vault names.
 *
 * Vault names appear in URLs (`/vault/<name>/mcp`, `/vault/<name>/api/*`),
 * the SQLite filename, and the OAuth consent page — anything that breaks
 * URL routing or filesystem assumptions has to be rejected up front.
 *
 * Used by the `init` prompt and the `--vault-name` flag. `cmdCreate` keeps
 * its own (slightly more permissive, legacy) regex for backward compat —
 * tightening it would reject names existing users may already have minted.
 */

const VAULT_NAME_RE = /^[a-z0-9_-]+$/;

const RESERVED_NAMES = new Set([
  // Collides with the `/vaults/list` discovery endpoint historically; the
  // routes have since moved under `/vault/<name>/`, but `cmdCreate` still
  // rejects "list" and consistency is cheap.
  "list",
]);

export type VaultNameValidation =
  | { ok: true; name: string }
  | { ok: false; error: string };

export function validateVaultName(raw: string): VaultNameValidation {
  const name = raw.trim();
  if (!name) {
    return { ok: false, error: "vault name cannot be empty." };
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
