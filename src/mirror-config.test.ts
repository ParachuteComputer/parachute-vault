/**
 * Tests for the mirror config schema, parse/serialize, validation, and
 * path resolution helpers (vault-sync Phase A1).
 *
 * All pure unit tests except the path-validation ones, which spawn `git`
 * against tempdirs to exercise the real filesystem check.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_SAFETY_NET_SECONDS,
  MAX_SAFETY_NET_SECONDS,
  MIN_SAFETY_NET_SECONDS,
  commentOutMirrorBlock,
  defaultMirrorConfig,
  parseMirrorConfig,
  resolveMirrorPath,
  serializeMirrorConfig,
  validateExternalPath,
  validateMirrorConfigShape,
} from "./mirror-config.ts";
import { GitNotInstalledError } from "./git-preflight.ts";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initRepo(dir: string): void {
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.email", "t@p.computer"], { cwd: dir });
  Bun.spawnSync(["git", "config", "user.name", "T P"], { cwd: dir });
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe("defaultMirrorConfig", () => {
  test("defaults to enabled=false — upgrading vaults see zero behavior change", () => {
    const d = defaultMirrorConfig();
    expect(d.enabled).toBe(false);
    expect(d.location).toBe("internal");
    expect(d.external_path).toBeNull();
    // Post event-driven shift: sync_mode replaces watch. "events" is the
    // new default — when an operator flips enabled on, hooks subscribe
    // automatically.
    expect(d.sync_mode).toBe("events");
    expect(d.auto_commit).toBe(true);
    expect(d.auto_push).toBe(false);
    expect(d.commit_template).toContain("{{date}}");
    expect(d.safety_net_seconds).toBe(DEFAULT_SAFETY_NET_SECONDS);
  });
});

// ---------------------------------------------------------------------------
// Parse + serialize
// ---------------------------------------------------------------------------

describe("parseMirrorConfig", () => {
  test("returns undefined when no `mirror:` section is present", () => {
    expect(parseMirrorConfig("port: 1940\n")).toBeUndefined();
    expect(parseMirrorConfig("")).toBeUndefined();
  });

  test("parses a fully-specified mirror block (post-event-driven shape)", () => {
    const yaml = [
      "port: 1940",
      "mirror:",
      "  enabled: true",
      "  location: external",
      "  external_path: /home/aaron/mirrors/gitcoin",
      "  sync_mode: events",
      "  auto_commit: true",
      "  auto_push: true",
      '  commit_template: "vault: {{notes_changed}} note{{plural}}"',
      "  safety_net_seconds: 3600",
    ].join("\n");
    const m = parseMirrorConfig(yaml);
    expect(m).toEqual({
      enabled: true,
      location: "external",
      external_path: "/home/aaron/mirrors/gitcoin",
      sync_mode: "events",
      auto_commit: true,
      auto_push: true,
      commit_template: "vault: {{notes_changed}} note{{plural}}",
      safety_net_seconds: 3600,
    });
  });

  test("partial mirror block fills missing fields from defaults", () => {
    const yaml = "mirror:\n  enabled: true\n  sync_mode: manual\n";
    const m = parseMirrorConfig(yaml)!;
    expect(m.enabled).toBe(true);
    expect(m.sync_mode).toBe("manual");
    expect(m.location).toBe("internal");
    expect(m.auto_commit).toBe(true);
  });

  test("legacy `watch: true` translates to sync_mode: events", () => {
    const m = parseMirrorConfig("mirror:\n  enabled: true\n  watch: true\n")!;
    expect(m.sync_mode).toBe("events");
  });

  test("legacy `watch: false` translates to sync_mode: manual", () => {
    const m = parseMirrorConfig("mirror:\n  enabled: true\n  watch: false\n")!;
    expect(m.sync_mode).toBe("manual");
  });

  test("explicit sync_mode wins over legacy watch", () => {
    const yaml = "mirror:\n  enabled: true\n  watch: true\n  sync_mode: manual\n";
    const m = parseMirrorConfig(yaml)!;
    expect(m.sync_mode).toBe("manual");
  });

  test("legacy `interval_seconds: 5` clamps up to MIN_SAFETY_NET_SECONDS", () => {
    const m = parseMirrorConfig("mirror:\n  enabled: true\n  interval_seconds: 5\n")!;
    expect(m.safety_net_seconds).toBe(MIN_SAFETY_NET_SECONDS);
  });

  test("explicit safety_net_seconds wins over legacy interval_seconds", () => {
    const yaml = "mirror:\n  enabled: true\n  interval_seconds: 5\n  safety_net_seconds: 1800\n";
    const m = parseMirrorConfig(yaml)!;
    expect(m.safety_net_seconds).toBe(1800);
  });

  test("external_path: null is interpreted as null", () => {
    const m = parseMirrorConfig(
      "mirror:\n  enabled: true\n  external_path: null\n",
    )!;
    expect(m.external_path).toBeNull();
  });

  test("stops at next top-level key", () => {
    const yaml = [
      "mirror:",
      "  enabled: true",
      "  location: external",
      "  external_path: /a/b",
      "port: 1940",
    ].join("\n");
    const m = parseMirrorConfig(yaml)!;
    expect(m.external_path).toBe("/a/b");
    expect(m.enabled).toBe(true);
  });
});

describe("serializeMirrorConfig", () => {
  test("round-trips through parseMirrorConfig", () => {
    const original = {
      enabled: true,
      location: "external" as const,
      external_path: "/home/aaron/team-brain",
      sync_mode: "events" as const,
      auto_commit: true,
      auto_push: false,
      commit_template: "export: {{date}} ({{notes_changed}} note{{plural}})",
      safety_net_seconds: 3600,
    };
    const yaml = serializeMirrorConfig(original).join("\n") + "\n";
    const parsed = parseMirrorConfig(yaml);
    expect(parsed).toEqual(original);
  });

  test("serializes null external_path explicitly", () => {
    const lines = serializeMirrorConfig({
      ...defaultMirrorConfig(),
      enabled: true,
    });
    expect(lines.some((l) => l === "  external_path: null")).toBe(true);
  });

  test("quotes paths with colons or hashes", () => {
    const lines = serializeMirrorConfig({
      ...defaultMirrorConfig(),
      enabled: true,
      location: "external",
      external_path: "/path/with: colon",
    });
    expect(lines.some((l) => l.includes('"/path/with: colon"'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

describe("resolveMirrorPath", () => {
  test("internal resolves to <vaultDataDir>/mirror", () => {
    const p = resolveMirrorPath("/var/data/default", {
      ...defaultMirrorConfig(),
      enabled: true,
      location: "internal",
    });
    expect(p).toBe("/var/data/default/mirror");
  });

  test("external returns the operator path verbatim", () => {
    const p = resolveMirrorPath("/ignored", {
      ...defaultMirrorConfig(),
      enabled: true,
      location: "external",
      external_path: "/home/aaron/notes",
    });
    expect(p).toBe("/home/aaron/notes");
  });

  test("external + no path → null (manager treats as soft-disabled)", () => {
    const p = resolveMirrorPath("/ignored", {
      ...defaultMirrorConfig(),
      enabled: true,
      location: "external",
      external_path: null,
    });
    expect(p).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Shape validation
// ---------------------------------------------------------------------------

describe("validateMirrorConfigShape", () => {
  test("accepts the minimal shape (empty object → defaults)", () => {
    const r = validateMirrorConfigShape({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config).toEqual(defaultMirrorConfig());
    }
  });

  test("rejects non-objects", () => {
    expect(validateMirrorConfigShape(null).ok).toBe(false);
    expect(validateMirrorConfigShape("hi").ok).toBe(false);
    expect(validateMirrorConfigShape(42).ok).toBe(false);
  });

  test("rejects unknown location", () => {
    const r = validateMirrorConfigShape({ location: "wherever" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("location");
  });

  test("rejects external + missing external_path", () => {
    const r = validateMirrorConfigShape({
      enabled: true,
      location: "external",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("external_path");
  });

  test("accepts external + missing external_path when disabled (operator turning off a broken mirror)", () => {
    // Regression for the reviewer-flagged disable-only case: an operator
    // PUTting `{enabled: false, location: "external"}` (no path) must
    // succeed. Disable should never fail validation on path issues.
    const r = validateMirrorConfigShape({
      enabled: false,
      location: "external",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.enabled).toBe(false);
      expect(r.config.location).toBe("external");
      expect(r.config.external_path).toBeNull();
    }
  });

  test("accepts external + external_path", () => {
    const r = validateMirrorConfigShape({
      enabled: true,
      location: "external",
      external_path: "/tmp/foo",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.external_path).toBe("/tmp/foo");
  });

  test("rejects non-boolean enabled", () => {
    const r = validateMirrorConfigShape({ enabled: "yes" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("enabled");
  });

  test("rejects non-integer safety_net_seconds", () => {
    const r = validateMirrorConfigShape({ safety_net_seconds: 0.5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("safety_net_seconds");
  });

  test("rejects safety_net_seconds below MIN", () => {
    const r = validateMirrorConfigShape({ safety_net_seconds: MIN_SAFETY_NET_SECONDS - 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("safety_net_seconds");
  });

  test("rejects safety_net_seconds above MAX", () => {
    const r = validateMirrorConfigShape({ safety_net_seconds: MAX_SAFETY_NET_SECONDS + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("safety_net_seconds");
  });

  test("legacy interval_seconds field clamps + migrates to safety_net_seconds", () => {
    // Hand-edited config supplies the old field; we still accept it but
    // route it through the safety-net clamp range.
    const r = validateMirrorConfigShape({ interval_seconds: 5 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.safety_net_seconds).toBe(MIN_SAFETY_NET_SECONDS);
  });

  test("rejects unknown sync_mode", () => {
    const r = validateMirrorConfigShape({ sync_mode: "interval" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("sync_mode");
  });

  test("accepts sync_mode events / manual", () => {
    expect((validateMirrorConfigShape({ sync_mode: "events" }) as { config: { sync_mode: string } }).config.sync_mode).toBe("events");
    expect((validateMirrorConfigShape({ sync_mode: "manual" }) as { config: { sync_mode: string } }).config.sync_mode).toBe("manual");
  });

  test("legacy watch: true translates to sync_mode: events", () => {
    const r = validateMirrorConfigShape({ watch: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.sync_mode).toBe("events");
  });

  test("legacy watch: false translates to sync_mode: manual", () => {
    const r = validateMirrorConfigShape({ watch: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.sync_mode).toBe("manual");
  });

  test("rejects auto_push + internal location WHEN no credentials are configured", () => {
    // Pre-credentials shape: auto_push + internal was rejected outright
    // (internal mirror = no remote = push would silently fail). Once
    // credentials are wired (PAT or GitHub OAuth), the credential save
    // path sets `origin` on the internal repo too — so push IS
    // meaningful. We keep the rejection only on the no-credentials path,
    // with a clear error pointing the operator at the credential flow.
    const r = validateMirrorConfigShape(
      {
        enabled: true,
        location: "internal",
        auto_push: true,
      },
      { readCredentials: () => null },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.field).toBe("auto_push");
      expect(r.error).toContain("credentials");
    }
  });

  test("auto_push + internal IS accepted when PAT credentials are configured", () => {
    // The three-stacking-gaps bug Aaron hit: History preset (internal
    // location) + PAT saved → expected pushes to fire. validation was
    // the first blocker. Now the combination passes when credentials
    // are present.
    const r = validateMirrorConfigShape(
      {
        enabled: true,
        location: "internal",
        auto_push: true,
      },
      {
        readCredentials: () => ({
          active_method: "pat",
          github_oauth: null,
          pat: {
            token: "ghp_xxxxxxxxxxxxxxxx",
            remote_url: "https://x-access-token:ghp_xxxxxxxxxxxxxxxx@github.com/a/b.git",
            label: "test",
          },
        }),
      },
    );
    expect(r.ok).toBe(true);
  });

  test("auto_push + internal IS accepted when github_oauth credentials are configured", () => {
    const r = validateMirrorConfigShape(
      {
        enabled: true,
        location: "internal",
        auto_push: true,
      },
      {
        readCredentials: () => ({
          active_method: "github_oauth",
          github_oauth: {
            access_token: "gho_xxxxxxxxxxxx",
            scope: "repo",
            authorized_at: "2026-05-28T03:14:15.000Z",
            user_login: "aaron",
            user_id: 1,
          },
          pat: null,
        }),
      },
    );
    expect(r.ok).toBe(true);
  });

  test("auto_push + external location is fine", () => {
    const r = validateMirrorConfigShape({
      enabled: true,
      location: "external",
      external_path: "/tmp/foo",
      auto_push: true,
    });
    expect(r.ok).toBe(true);
  });

  test("auto_push + disabled never errors", () => {
    // Cross-field rule gates on `enabled`. A disabled config with stale
    // auto_push: true + internal is the upgrade-path shape; operators
    // shouldn't have to clear the field to disable.
    const r = validateMirrorConfigShape({
      enabled: false,
      location: "internal",
      auto_push: true,
    });
    expect(r.ok).toBe(true);
  });

  test("rejects empty commit_template", () => {
    const r = validateMirrorConfigShape({ commit_template: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("commit_template");
  });

  test("trims external_path whitespace; with internal location empty trim → null", () => {
    const r = validateMirrorConfigShape({
      enabled: false,
      location: "internal",
      external_path: "   ",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.external_path).toBeNull();
  });

  test("trims external_path whitespace on non-empty value", () => {
    const r = validateMirrorConfigShape({
      enabled: true,
      location: "external",
      external_path: "  /tmp/foo  ",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.external_path).toBe("/tmp/foo");
  });
});

// ---------------------------------------------------------------------------
// validateExternalPath — filesystem-touching
// ---------------------------------------------------------------------------

describe("validateExternalPath", () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("rejects missing path with actionable error", async () => {
    dir = tmp("mirror-validate-");
    const missing = path.join(dir, "nope");
    const r = await validateExternalPath(missing);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("doesn't exist");
  });

  test("rejects path-is-a-file", async () => {
    dir = tmp("mirror-validate-file-");
    const file = path.join(dir, "f.txt");
    fs.writeFileSync(file, "x");
    const r = await validateExternalPath(file);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("isn't a directory");
  });

  test("rejects existing-dir but not a git repo", async () => {
    dir = tmp("mirror-validate-nogit-");
    const r = await validateExternalPath(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("isn't a git repository");
  });

  test("accepts existing-dir git repo", async () => {
    dir = tmp("mirror-validate-git-");
    initRepo(dir);
    const r = await validateExternalPath(dir);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolved_path).toBe(dir);
  });

  test("git not installed → throws GitNotInstalledError (route maps to 503)", async () => {
    // vault#415 nit — the isGitRepo() check shells `git`. On a git-less
    // server, throw the friendly error (handleMirrorPut maps it to 503
    // git_not_installed) instead of a raw "Executable not found" crash.
    // Force the preflight via the `which` seam; a real, valid git repo is
    // used so the ONLY failure source is the preflight.
    dir = tmp("mirror-validate-nogit-installed-");
    initRepo(dir);
    await expect(validateExternalPath(dir, () => null)).rejects.toBeInstanceOf(
      GitNotInstalledError,
    );
  });
});

// ---------------------------------------------------------------------------
// commentOutMirrorBlock — vault#400 migration YAML rewrite (extracted from
// server.ts per vault#408 review N3). Runs against the operator's real
// config.yaml, so it gets direct coverage here.
// ---------------------------------------------------------------------------

describe("commentOutMirrorBlock", () => {
  test("comments out a real serializer-shaped mirror block; leaves other keys intact", () => {
    // Build the block exactly as serializeMirrorConfig emits it — pins the
    // real production shape rather than a hand-written approximation.
    const block = serializeMirrorConfig({
      ...defaultMirrorConfig(),
      enabled: true,
      location: "external",
      external_path: "/home/aaron/mirrors/brain",
      auto_push: true,
    }).join("\n");
    const yaml = `port: 1940
default_vault: brain
${block}
auto_transcribe:
  enabled: true
`;
    const out = commentOutMirrorBlock(yaml);

    // No LIVE mirror block survives (the parser anchor won't match).
    expect(parseMirrorConfig(out)).toBeUndefined();
    // Every mirror line is commented.
    expect(out).toContain("# mirror:");
    expect(out).toContain("#   enabled: true");
    expect(out).toContain("#   external_path: /home/aaron/mirrors/brain");
    expect(out).toContain("#   auto_push: true");
    // Provenance marker added.
    expect(out).toContain("# [vault#400] migrated to per-vault");
    // Non-mirror top-level keys untouched (byte-for-byte).
    expect(out).toContain("port: 1940");
    expect(out).toContain("default_vault: brain");
    expect(out).toContain("auto_transcribe:");
    expect(out).toContain("  enabled: true");
    // The mirror block must NOT have swallowed the auto_transcribe block —
    // its child line stays a live (uncommented) 2-space-indent field.
    expect(out).not.toContain("#   enabled: true\n# auto_transcribe");
    const at = out.indexOf("auto_transcribe:");
    expect(out.slice(at)).toContain("\n  enabled: true");
  });

  test("idempotent — running on already-commented output is a no-op", () => {
    const block = serializeMirrorConfig({
      ...defaultMirrorConfig(),
      enabled: true,
    }).join("\n");
    const yaml = `port: 1940\n${block}\ndiscovery: enabled\n`;
    const once = commentOutMirrorBlock(yaml);
    const twice = commentOutMirrorBlock(once);
    expect(twice).toBe(once); // second pass changes nothing
  });

  test("no mirror block → returns input unchanged", () => {
    const yaml = `port: 1940
default_vault: brain
discovery: enabled
`;
    expect(commentOutMirrorBlock(yaml)).toBe(yaml);
  });

  test("mirror block at EOF (no trailing key) is fully commented", () => {
    const block = serializeMirrorConfig({
      ...defaultMirrorConfig(),
      enabled: true,
      auto_commit: false,
    }).join("\n");
    const yaml = `port: 1940\n${block}\n`;
    const out = commentOutMirrorBlock(yaml);
    expect(parseMirrorConfig(out)).toBeUndefined();
    expect(out).toContain("#   auto_commit: false");
    expect(out).toContain("port: 1940"); // live, untouched
  });

  test("preserves a blank line between the mirror block and the next key", () => {
    const block = serializeMirrorConfig({
      ...defaultMirrorConfig(),
      enabled: true,
    }).join("\n");
    // Blank line separates the block from `discovery:` — must stay blank
    // (not commented) and `discovery:` must stay live.
    const yaml = `port: 1940\n${block}\n\ndiscovery: enabled\n`;
    const out = commentOutMirrorBlock(yaml);
    expect(out).toContain("\n\ndiscovery: enabled"); // blank line preserved, key live
    expect(parseMirrorConfig(out)).toBeUndefined();
  });
});
