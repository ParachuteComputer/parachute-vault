/**
 * Mirror configuration — the "vault knows about its git projection" surface.
 *
 * Builds on the manual export primitives from vault#346 (`parachute-vault
 * export --watch --git-commit`). This module owns the *persistent* form:
 *
 *   - Schema for the `mirror:` block in `~/.parachute/vault/config.yaml`.
 *   - Parse + serialize that block alongside the existing global config.
 *   - Resolve the on-disk mirror path (internal vs external).
 *   - Validate the operator-supplied shape (location enum, external_path
 *     existence + git-repo-ness).
 *
 * The lifecycle wiring (boot-time bootstrap, watch loop start/stop/reload)
 * lives in `./mirror-manager.ts`; the HTTP surface lives in
 * `./mirror-routes.ts`. This file is intentionally I/O-light: pure parsing,
 * pure validation, plus the path-resolution helper that needs `path.join`.
 *
 * Phase A1 of the vault-sync arc — see
 * `parachute.computer/design/2026-05-20-vault-as-git-projection.md`.
 */

import { existsSync, statSync } from "fs";
import { join } from "path";

import { DEFAULT_COMMIT_TEMPLATE, isGitRepo } from "./export-watch.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The two axes of operator choice. See the design doc:
 *   - `internal` → vault-managed at `~/.parachute/vault/data/<name>/mirror/`.
 *     Hidden under vault's own data dir; recreated on next boot if missing.
 *   - `external` → operator-picked path. Visible to the operator; designed
 *     for Obsidian / GitHub / shared backups.
 */
export type MirrorLocation = "internal" | "external";

/**
 * The persistent mirror configuration block. Lives under the `mirror:` key
 * in the global config.yaml (one mirror per vault server today — multi-vault
 * mirroring is a future ripple, see open question 2 in the design doc).
 *
 * Field semantics:
 *   - `enabled` — master switch. When false (the default for upgrading
 *     vaults), no mirror behavior runs at all. The other fields are
 *     preserved so the operator can flip enabled back on without losing
 *     their location/path/watch settings.
 *   - `location` — "internal" or "external". Drives `resolveMirrorPath`.
 *   - `external_path` — required when location=external. Operator-picked
 *     absolute path. Must exist + be a git repo when first validated.
 *   - `watch` — when true, the manager runs the export-watch loop in the
 *     vault server process. When false, the mirror gets a one-shot export
 *     on boot/config-change only; subsequent updates need an explicit
 *     manual export.
 *   - `auto_commit` — after each export pass, `git add -A && git commit`.
 *     Reuses the existing `runGitCommitCycle` from vault#346.
 *   - `auto_push` — after commit, `git push`. Failures non-fatal.
 *   - `commit_template` — passed verbatim to `renderCommitMessage`. Same
 *     variable set as the CLI: `{{date}}`, `{{notes_changed}}`,
 *     `{{plural}}`, `{{first_note_title}}`, `{{vault_name}}`.
 *   - `interval_seconds` — watch-loop poll interval. Default 5, matching
 *     the CLI flag's default.
 */
export interface MirrorConfig {
  enabled: boolean;
  location: MirrorLocation;
  external_path: string | null;
  watch: boolean;
  auto_commit: boolean;
  auto_push: boolean;
  commit_template: string;
  interval_seconds: number;
}

/**
 * Default mirror config — what callers see when no `mirror:` block has
 * been written yet. `enabled: false` is the load-bearing default: vaults
 * upgrading across this PR boundary see zero behavior change until they
 * explicitly opt in.
 */
export function defaultMirrorConfig(): MirrorConfig {
  return {
    enabled: false,
    location: "internal",
    external_path: null,
    watch: false,
    auto_commit: true,
    auto_push: false,
    commit_template: DEFAULT_COMMIT_TEMPLATE,
    interval_seconds: 5,
  };
}

// ---------------------------------------------------------------------------
// YAML parsing — mirrors the hand-rolled style in config.ts.
//
// Format under config.yaml:
//
//   mirror:
//     enabled: true
//     location: internal
//     external_path: /home/aaron/mirrors/team-brain
//     watch: true
//     auto_commit: true
//     auto_push: false
//     commit_template: "export: {{date}} ({{notes_changed}} note{{plural}})"
//     interval_seconds: 5
//
// The block sits next to existing top-level keys (port, default_vault, …).
// All fields optional; missing fields fall back to defaultMirrorConfig().
// Parser stops at the next 0-indent line (mirroring the trigger/backup
// section parsers — same shape, same stop rule).
// ---------------------------------------------------------------------------

/**
 * Parse the `mirror:` section from a config.yaml string. Returns
 * `undefined` if no section is present — distinct from "section present
 * with defaults" so callers can tell "operator has never touched mirror"
 * apart from "operator set enabled: false explicitly." Phase A1 doesn't
 * yet use that distinction, but it's cheap to preserve.
 */
export function parseMirrorConfig(yaml: string): MirrorConfig | undefined {
  const startMatch = yaml.match(/^mirror:\s*$/m);
  if (!startMatch) return undefined;

  const startIdx = (startMatch.index ?? 0) + startMatch[0].length;
  const lines = yaml.slice(startIdx).split("\n");

  const config = defaultMirrorConfig();

  for (const line of lines) {
    // Stop at the next top-level key.
    if (line.match(/^\S/) && line.trim().length > 0) break;
    if (line.trim().length === 0) continue;

    const trimmed = line.trim();

    const boolField = (
      name: keyof Pick<
        MirrorConfig,
        "enabled" | "watch" | "auto_commit" | "auto_push"
      >,
    ): boolean => {
      const m = trimmed.match(new RegExp(`^${name}:\\s*(true|false)\\s*$`));
      if (m) {
        config[name] = m[1] === "true";
        return true;
      }
      return false;
    };
    if (boolField("enabled")) continue;
    if (boolField("watch")) continue;
    if (boolField("auto_commit")) continue;
    if (boolField("auto_push")) continue;

    const locationMatch = trimmed.match(/^location:\s*(internal|external)\s*$/);
    if (locationMatch) {
      config.location = locationMatch[1] as MirrorLocation;
      continue;
    }

    const pathMatch = trimmed.match(/^external_path:\s*(.*)$/);
    if (pathMatch) {
      const raw = pathMatch[1]!.trim();
      if (raw === "" || raw === "null" || raw === "~") {
        config.external_path = null;
      } else {
        // Strip optional surrounding quotes (matches the path-quoting in
        // serializeMirrorConfig defensively for paths with `:` or `#`).
        config.external_path = raw.replace(/^"(.*)"$/, "$1");
      }
      continue;
    }

    const templateMatch = trimmed.match(/^commit_template:\s*(.*)$/);
    if (templateMatch) {
      const raw = templateMatch[1]!.trim();
      config.commit_template = raw.replace(/^"(.*)"$/, "$1");
      continue;
    }

    const intervalMatch = trimmed.match(/^interval_seconds:\s*(\d+)\s*$/);
    if (intervalMatch) {
      const n = parseInt(intervalMatch[1]!, 10);
      if (Number.isFinite(n) && n > 0) config.interval_seconds = n;
      continue;
    }
  }

  return config;
}

/**
 * Serialize a MirrorConfig as YAML lines suitable for appending under the
 * top-level keys of `config.yaml`. Returns the lines without a trailing
 * newline — the caller joins with `\n` and adds its own terminator, same
 * convention as the existing `writeGlobalConfig`.
 */
export function serializeMirrorConfig(config: MirrorConfig): string[] {
  const lines: string[] = ["mirror:"];
  lines.push(`  enabled: ${config.enabled}`);
  lines.push(`  location: ${config.location}`);
  // Serialize external_path even when null — keeps the slot visible to
  // operators editing the file by hand. Null renders as the YAML literal,
  // which round-trips back through parseMirrorConfig as `null`.
  if (config.external_path === null) {
    lines.push("  external_path: null");
  } else {
    // Defensive quoting for paths containing `:` or `#` (YAML special
    // characters that would confuse a less-forgiving parser).
    const needsQuote = /[:#]/.test(config.external_path);
    lines.push(
      `  external_path: ${needsQuote ? `"${config.external_path}"` : config.external_path}`,
    );
  }
  lines.push(`  watch: ${config.watch}`);
  lines.push(`  auto_commit: ${config.auto_commit}`);
  lines.push(`  auto_push: ${config.auto_push}`);
  // Templates contain `{{ }}` and frequently `:` — always quote.
  lines.push(`  commit_template: "${config.commit_template.replace(/"/g, '\\"')}"`);
  lines.push(`  interval_seconds: ${config.interval_seconds}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve where this vault's mirror lives on disk.
 *
 *   - `internal` → `<vaultDataDir>/mirror/` — under the vault's own data
 *     dir, the same hierarchy the SQLite DB + assets live in. Hidden by
 *     convention; the operator never has to think about where it lives.
 *   - `external` → `config.external_path` verbatim. Caller is responsible
 *     for having validated the path before this point — `resolveMirrorPath`
 *     trusts the config.
 *
 * `vaultDataDir` is injected (rather than computed from `vaultDir()`) so
 * this module doesn't depend on `./config.ts` — that file imports our
 * types reflexively, and breaking the cycle keeps the boot path clean.
 *
 * Returns `null` for external + no path set; the manager treats that as
 * "mirror disabled in effect" rather than crashing.
 */
export function resolveMirrorPath(
  vaultDataDir: string,
  config: MirrorConfig,
): string | null {
  if (config.location === "internal") {
    return join(vaultDataDir, "mirror");
  }
  if (!config.external_path) return null;
  return config.external_path;
}

// ---------------------------------------------------------------------------
// Validation
//
// Two surfaces:
//   - `validateMirrorConfigShape` — pure, no I/O. Sanity-checks the JSON
//     shape (location enum, external_path required when external, etc.).
//     The HTTP PUT handler uses this for fast-fail validation before
//     touching the filesystem.
//   - `validateExternalPath` — async, hits the filesystem. Verifies the
//     external path exists + is a git working tree. Reused by the PUT
//     handler when location=external.
// ---------------------------------------------------------------------------

export interface ShapeValidationOk { ok: true; config: MirrorConfig; }
export interface ShapeValidationError {
  ok: false;
  /** Human-readable, actionable error message. Surfaced verbatim in 400s. */
  error: string;
  /** Field that triggered the rejection (when localized to one). */
  field?: keyof MirrorConfig;
}
export type ShapeValidation = ShapeValidationOk | ShapeValidationError;

/**
 * Validate + normalize an operator-supplied mirror config blob (e.g. from
 * a `PUT /admin/mirror` JSON body). Fills missing fields from
 * `defaultMirrorConfig()`; rejects values that don't conform to the
 * declared types.
 *
 * Does NOT touch the filesystem — operators get a fast 400 on shape
 * errors before vault attempts any filesystem work. Filesystem-level
 * validation (path exists, is a git repo) lives in `validateExternalPath`.
 */
export function validateMirrorConfigShape(
  input: unknown,
): ShapeValidation {
  if (input === null || typeof input !== "object") {
    return {
      ok: false,
      error: "Mirror config must be a JSON object.",
    };
  }
  const blob = input as Record<string, unknown>;
  const out = defaultMirrorConfig();

  if ("enabled" in blob) {
    if (typeof blob.enabled !== "boolean") {
      return { ok: false, field: "enabled", error: "`enabled` must be boolean." };
    }
    out.enabled = blob.enabled;
  }

  if ("location" in blob) {
    if (blob.location !== "internal" && blob.location !== "external") {
      return {
        ok: false,
        field: "location",
        error: '`location` must be "internal" or "external".',
      };
    }
    out.location = blob.location;
  }

  if ("external_path" in blob) {
    if (blob.external_path === null) {
      out.external_path = null;
    } else if (typeof blob.external_path === "string") {
      const trimmed = blob.external_path.trim();
      out.external_path = trimmed.length === 0 ? null : trimmed;
    } else {
      return {
        ok: false,
        field: "external_path",
        error: "`external_path` must be a string or null.",
      };
    }
  }

  if ("watch" in blob) {
    if (typeof blob.watch !== "boolean") {
      return { ok: false, field: "watch", error: "`watch` must be boolean." };
    }
    out.watch = blob.watch;
  }

  if ("auto_commit" in blob) {
    if (typeof blob.auto_commit !== "boolean") {
      return {
        ok: false,
        field: "auto_commit",
        error: "`auto_commit` must be boolean.",
      };
    }
    out.auto_commit = blob.auto_commit;
  }

  if ("auto_push" in blob) {
    if (typeof blob.auto_push !== "boolean") {
      return {
        ok: false,
        field: "auto_push",
        error: "`auto_push` must be boolean.",
      };
    }
    out.auto_push = blob.auto_push;
  }

  if ("commit_template" in blob) {
    if (typeof blob.commit_template !== "string") {
      return {
        ok: false,
        field: "commit_template",
        error: "`commit_template` must be a string.",
      };
    }
    const trimmed = blob.commit_template.trim();
    if (trimmed.length === 0) {
      return {
        ok: false,
        field: "commit_template",
        error: "`commit_template` cannot be empty.",
      };
    }
    out.commit_template = blob.commit_template;
  }

  if ("interval_seconds" in blob) {
    if (
      typeof blob.interval_seconds !== "number" ||
      !Number.isFinite(blob.interval_seconds) ||
      blob.interval_seconds <= 0 ||
      !Number.isInteger(blob.interval_seconds)
    ) {
      return {
        ok: false,
        field: "interval_seconds",
        error: "`interval_seconds` must be a positive integer.",
      };
    }
    out.interval_seconds = blob.interval_seconds;
  }

  // Cross-field rule: external requires external_path — but ONLY when
  // the mirror is enabled. Disable-only PUTs (and disabled persisted
  // configs in general) shouldn't fail validation on path-related
  // issues; the operator might be turning off a mirror whose external
  // path went missing without first fixing the path. The filesystem
  // check in `validateExternalPath` is also gated on enabled at the
  // route layer for the same reason.
  if (out.enabled && out.location === "external" && !out.external_path) {
    return {
      ok: false,
      field: "external_path",
      error:
        '`external_path` is required when `location` is "external" and `enabled` is true. Provide an absolute path to an existing git repository.',
    };
  }

  return { ok: true, config: out };
}

export interface PathValidationOk { ok: true; resolved_path: string; }
export interface PathValidationError {
  ok: false;
  /** Human-readable, actionable. Suggests the next step where possible. */
  error: string;
}
export type PathValidation = PathValidationOk | PathValidationError;

/**
 * Validate an external mirror path. Checks:
 *   - Path exists on the filesystem.
 *   - Path resolves to a directory (not a file or symlink-to-file).
 *   - Path is a git working tree (`git rev-parse --is-inside-work-tree`).
 *
 * Returns actionable error messages — the operator gets enough to fix the
 * problem without reading vault logs. Use case: `PUT /admin/mirror` when
 * `location: external`.
 */
export async function validateExternalPath(
  externalPath: string,
): Promise<PathValidation> {
  if (!existsSync(externalPath)) {
    return {
      ok: false,
      error: `Path "${externalPath}" doesn't exist. Create the directory and \`git init\` it first, then re-submit.`,
    };
  }
  let stat;
  try {
    stat = statSync(externalPath);
  } catch (err) {
    return {
      ok: false,
      error: `Could not stat "${externalPath}": ${(err as Error).message ?? err}`,
    };
  }
  if (!stat.isDirectory()) {
    return {
      ok: false,
      error: `Path "${externalPath}" exists but isn't a directory. Pick a directory path.`,
    };
  }
  const inGitRepo = await isGitRepo(externalPath);
  if (!inGitRepo) {
    return {
      ok: false,
      error: `Path "${externalPath}" exists but isn't a git repository. Run \`git init\` inside it (or pick a path under an existing repo) and re-submit.`,
    };
  }
  return { ok: true, resolved_path: externalPath };
}
