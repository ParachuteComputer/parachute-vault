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
import { readCredentials, type MirrorCredentials } from "./mirror-credentials.ts";

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
 * How the mirror stays current with vault state.
 *
 *   - `events` → in-process hooks fire on every note/tag/attachment
 *     mutation; the manager debounces them (~500ms) into a single export
 *     pass. A background safety-net poll (default 1h) catches anything
 *     missed (direct SQL writes, dropped hook dispatches, restart gaps).
 *     This is the default for new configs and the post-vault#382 shape.
 *   - `manual` → no event subscriptions, no polling. The operator runs
 *     "Run export now" (admin SPA button or POST `/.parachute/mirror/run-now`)
 *     or `parachute-vault export` from the CLI on their own cadence.
 *
 * The pre-vault#382 `interval_seconds`-driven watch loop has retired —
 * existing configs migrate to `events` (when `watch: true`) or `manual`
 * (when `watch: false`). The legacy field still parses, repurposed as
 * `safety_net_seconds` when explicit.
 */
export type MirrorSyncMode = "events" | "manual";

/** Default safety-net poll interval in seconds (1 hour). */
export const DEFAULT_SAFETY_NET_SECONDS = 3600;
/** Minimum safety-net poll interval. Anything tighter would defeat the point of "safety net" — that's what the event path is for. */
export const MIN_SAFETY_NET_SECONDS = 60;
/** Maximum safety-net poll interval (24 hours). */
export const MAX_SAFETY_NET_SECONDS = 86400;

/**
 * The persistent mirror configuration block. Lives under the `mirror:` key
 * in the global config.yaml (one mirror per vault server today — multi-vault
 * mirroring is a future ripple, see open question 2 in the design doc).
 *
 * Field semantics:
 *   - `enabled` — master switch. When false (the default for upgrading
 *     vaults), no mirror behavior runs at all. The other fields are
 *     preserved so the operator can flip enabled back on without losing
 *     their location/path/sync_mode settings.
 *   - `location` — "internal" or "external". Drives `resolveMirrorPath`.
 *   - `external_path` — required when location=external. Operator-picked
 *     absolute path. Must exist + be a git repo when first validated.
 *   - `sync_mode` — "events" (subscribe to in-process hooks; debounce ~500ms;
 *     safety-net poll on top) or "manual" (no auto-fire; operator triggers
 *     manually). Default "events".
 *   - `auto_commit` — after each export pass, `git add -A && git commit`.
 *     Reuses the existing `runGitCommitCycle` from vault#346.
 *   - `auto_push` — after commit, `git push`. Failures non-fatal.
 *   - `commit_template` — passed verbatim to `renderCommitMessage`. Same
 *     variable set as the CLI: `{{date}}`, `{{notes_changed}}`,
 *     `{{plural}}`, `{{first_note_title}}`, `{{vault_name}}`.
 *   - `safety_net_seconds` — `sync_mode: events` runs an hourly background
 *     sweep on top of the event-driven path. This field controls the
 *     interval (default 3600). Clamped to `[MIN_SAFETY_NET_SECONDS,
 *     MAX_SAFETY_NET_SECONDS]` at validation time.
 *
 * Legacy / migration:
 *   - `watch` (boolean) — pre-vault#382 field. `true` → `sync_mode: events`,
 *     `false` → `sync_mode: manual`. Parsed for back-compat; the canonical
 *     form on the wire is `sync_mode`.
 *   - `interval_seconds` (positive integer) — pre-vault#382 watch-loop
 *     poll interval. Reinterpreted as `safety_net_seconds` when no
 *     explicit `safety_net_seconds` is present AND the value lies in the
 *     valid range. Out-of-range / missing → default 3600. The field is
 *     no longer surfaced in the UI; the SPA stops emitting it but the
 *     parser keeps accepting it for hand-edited configs.
 */
export interface MirrorConfig {
  enabled: boolean;
  location: MirrorLocation;
  external_path: string | null;
  sync_mode: MirrorSyncMode;
  auto_commit: boolean;
  auto_push: boolean;
  commit_template: string;
  safety_net_seconds: number;
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
    sync_mode: "events",
    auto_commit: true,
    auto_push: false,
    commit_template: DEFAULT_COMMIT_TEMPLATE,
    safety_net_seconds: DEFAULT_SAFETY_NET_SECONDS,
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
  // Track legacy field state for migration: if `sync_mode` is absent and
  // `watch` is set, derive sync_mode from watch. If `safety_net_seconds`
  // is absent and `interval_seconds` is set (legacy field), repurpose it.
  let sawSyncMode = false;
  let sawSafetyNet = false;
  let legacyWatch: boolean | null = null;
  let legacyInterval: number | null = null;

  for (const line of lines) {
    // Stop at the next top-level key.
    if (line.match(/^\S/) && line.trim().length > 0) break;
    if (line.trim().length === 0) continue;

    const trimmed = line.trim();

    const boolField = (
      name: keyof Pick<
        MirrorConfig,
        "enabled" | "auto_commit" | "auto_push"
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
    if (boolField("auto_commit")) continue;
    if (boolField("auto_push")) continue;

    const watchMatch = trimmed.match(/^watch:\s*(true|false)\s*$/);
    if (watchMatch) {
      legacyWatch = watchMatch[1] === "true";
      continue;
    }

    const syncModeMatch = trimmed.match(/^sync_mode:\s*(events|manual)\s*$/);
    if (syncModeMatch) {
      config.sync_mode = syncModeMatch[1] as MirrorSyncMode;
      sawSyncMode = true;
      continue;
    }

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

    const safetyNetMatch = trimmed.match(/^safety_net_seconds:\s*(\d+)\s*$/);
    if (safetyNetMatch) {
      const n = parseInt(safetyNetMatch[1]!, 10);
      if (Number.isFinite(n) && n > 0) {
        config.safety_net_seconds = clampSafetyNet(n);
        sawSafetyNet = true;
      }
      continue;
    }

    const intervalMatch = trimmed.match(/^interval_seconds:\s*(\d+)\s*$/);
    if (intervalMatch) {
      const n = parseInt(intervalMatch[1]!, 10);
      if (Number.isFinite(n) && n > 0) legacyInterval = n;
      continue;
    }
  }

  // Migration: explicit `sync_mode` wins; otherwise derive from `watch`.
  // A config that carries neither falls through to defaults (events).
  if (!sawSyncMode && legacyWatch !== null) {
    config.sync_mode = legacyWatch ? "events" : "manual";
  }
  // Migration: explicit `safety_net_seconds` wins; otherwise upgrade
  // `interval_seconds` (legacy short-cadence values like 5 get clamped
  // up to MIN_SAFETY_NET_SECONDS — the safety-net path doesn't want
  // 5-second polls). Out-of-range values fall through to the default.
  if (!sawSafetyNet && legacyInterval !== null) {
    config.safety_net_seconds = clampSafetyNet(legacyInterval);
  }

  return config;
}

/** Clamp safety_net_seconds to the valid range. */
function clampSafetyNet(n: number): number {
  if (n < MIN_SAFETY_NET_SECONDS) return MIN_SAFETY_NET_SECONDS;
  if (n > MAX_SAFETY_NET_SECONDS) return MAX_SAFETY_NET_SECONDS;
  return n;
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
  lines.push(`  sync_mode: ${config.sync_mode}`);
  lines.push(`  auto_commit: ${config.auto_commit}`);
  lines.push(`  auto_push: ${config.auto_push}`);
  // Templates contain `{{ }}` and frequently `:` — always quote.
  lines.push(`  commit_template: "${config.commit_template.replace(/"/g, '\\"')}"`);
  lines.push(`  safety_net_seconds: ${config.safety_net_seconds}`);
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
 * Mostly pure: the one filesystem touch is reading
 * `.mirror-credentials.yaml` to decide whether `auto_push: true +
 * location: internal` is acceptable (credentials carry a remote URL, so
 * "internal mirrors have no remote" no longer holds). The credentials
 * read is injectable via `opts.readCredentials` so tests stay hermetic;
 * production callers omit it and pick up the canonical `readCredentials`
 * from `./mirror-credentials.ts`.
 *
 * Filesystem-level validation of `external_path` (exists, is a git repo)
 * still lives in `validateExternalPath` — that's I/O and stays out of
 * this function.
 */
export function validateMirrorConfigShape(
  input: unknown,
  opts: { readCredentials?: () => MirrorCredentials | null } = {},
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

  // Legacy back-compat: `watch: boolean` translates to sync_mode.
  // `sync_mode` takes priority if both are present.
  if ("watch" in blob) {
    if (typeof blob.watch !== "boolean") {
      return { ok: false, error: "`watch` must be boolean." };
    }
    out.sync_mode = blob.watch ? "events" : "manual";
  }

  if ("sync_mode" in blob) {
    if (blob.sync_mode !== "events" && blob.sync_mode !== "manual") {
      return {
        ok: false,
        field: "sync_mode",
        error: '`sync_mode` must be "events" or "manual".',
      };
    }
    out.sync_mode = blob.sync_mode;
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

  if ("safety_net_seconds" in blob) {
    if (
      typeof blob.safety_net_seconds !== "number" ||
      !Number.isFinite(blob.safety_net_seconds) ||
      blob.safety_net_seconds <= 0 ||
      !Number.isInteger(blob.safety_net_seconds)
    ) {
      return {
        ok: false,
        field: "safety_net_seconds",
        error: "`safety_net_seconds` must be a positive integer.",
      };
    }
    if (
      blob.safety_net_seconds < MIN_SAFETY_NET_SECONDS ||
      blob.safety_net_seconds > MAX_SAFETY_NET_SECONDS
    ) {
      return {
        ok: false,
        field: "safety_net_seconds",
        error: `\`safety_net_seconds\` must be between ${MIN_SAFETY_NET_SECONDS} and ${MAX_SAFETY_NET_SECONDS}.`,
      };
    }
    out.safety_net_seconds = blob.safety_net_seconds;
  } else if ("interval_seconds" in blob) {
    // Legacy field still accepted for hand-edited configs. Migrate by
    // clamping into the safety-net range.
    if (
      typeof blob.interval_seconds !== "number" ||
      !Number.isFinite(blob.interval_seconds) ||
      blob.interval_seconds <= 0 ||
      !Number.isInteger(blob.interval_seconds)
    ) {
      return {
        ok: false,
        error: "`interval_seconds` must be a positive integer.",
      };
    }
    const clamped = blob.interval_seconds < MIN_SAFETY_NET_SECONDS
      ? MIN_SAFETY_NET_SECONDS
      : blob.interval_seconds > MAX_SAFETY_NET_SECONDS
        ? MAX_SAFETY_NET_SECONDS
        : blob.interval_seconds;
    out.safety_net_seconds = clamped;
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

  // Cross-field rule: auto_push + internal location was historically
  // rejected outright — the assumption being "internal mirrors live under
  // vault's data dir with no configured remote, so push would always
  // fail." That assumption no longer holds once credentials are wired:
  // the credential save path (handleAuthPat / handleAuthGithubSelectRepo)
  // sets `origin` on the internal repo to the embedded-credential URL,
  // so `git push` to GitHub/GitLab/etc. is meaningful even when the
  // working tree lives under `~/.parachute/vault/data/<name>/mirror/`.
  //
  // New rule: auto_push + internal is rejected ONLY when no credentials
  // are configured. If credentials ARE wired (PAT or GitHub OAuth),
  // accept the combination — vault has a remote to push to. Operators
  // hitting Aaron's three-stacking-gaps bug (History preset + PAT saved,
  // pushes never fire) get unblocked.
  //
  // Asymmetry note (reviewer-flagged on vault#392): external + auto_push +
  // no vault-stored credentials is INTENTIONALLY not rejected here.
  // External mirrors are operator-managed paths — operators may have
  // configured push credentials via system-level git config (SSH agent,
  // ~/.git-credentials, GH_TOKEN env, `gh auth login`), none of which
  // vault can detect by reading `.mirror-credentials.yaml`. Rejecting on
  // "vault doesn't see credentials" would refuse legitimate
  // operator-managed setups. Push failures on missing credentials surface
  // via the non-fatal warning path in gitPush — operators see them in
  // `last_push_error` rather than being blocked at save time. Internal
  // location is different: internal mirrors live under vault's data
  // dir, so vault IS the only thing that can wire a remote, which is
  // why the gate below requires vault-stored credentials specifically.
  if (out.enabled && out.auto_push && out.location === "internal") {
    const readCreds = opts.readCredentials ?? readCredentials;
    let creds: MirrorCredentials | null = null;
    try {
      creds = readCreds();
    } catch {
      // If the credentials file is unreadable we conservatively fail
      // closed — same outcome as "no credentials." Better to surface the
      // actionable "configure credentials first" error than to accept a
      // config that won't actually push.
      creds = null;
    }
    const hasCredentials = !!(
      creds &&
      creds.active_method &&
      ((creds.active_method === "pat" && creds.pat) ||
        (creds.active_method === "github_oauth" && creds.github_oauth))
    );
    if (!hasCredentials) {
      return {
        ok: false,
        field: "auto_push",
        error:
          "Configure git credentials before enabling auto-push on an internal mirror — vault has no remote to push to without them. Connect GitHub or paste a Personal Access Token in the Git remote section, or set auto_push to false.",
      };
    }
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
