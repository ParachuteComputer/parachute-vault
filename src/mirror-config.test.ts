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
  defaultMirrorConfig,
  parseMirrorConfig,
  resolveMirrorPath,
  serializeMirrorConfig,
  validateExternalPath,
  validateMirrorConfigShape,
} from "./mirror-config.ts";

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
    expect(d.watch).toBe(false);
    expect(d.auto_commit).toBe(true);
    expect(d.auto_push).toBe(false);
    expect(d.commit_template).toContain("{{date}}");
    expect(d.interval_seconds).toBe(5);
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

  test("parses a fully-specified mirror block", () => {
    const yaml = [
      "port: 1940",
      "mirror:",
      "  enabled: true",
      "  location: external",
      "  external_path: /home/aaron/mirrors/gitcoin",
      "  watch: true",
      "  auto_commit: true",
      "  auto_push: true",
      '  commit_template: "vault: {{notes_changed}} note{{plural}}"',
      "  interval_seconds: 10",
    ].join("\n");
    const m = parseMirrorConfig(yaml);
    expect(m).toEqual({
      enabled: true,
      location: "external",
      external_path: "/home/aaron/mirrors/gitcoin",
      watch: true,
      auto_commit: true,
      auto_push: true,
      commit_template: "vault: {{notes_changed}} note{{plural}}",
      interval_seconds: 10,
    });
  });

  test("partial mirror block fills missing fields from defaults", () => {
    const yaml = "mirror:\n  enabled: true\n  watch: true\n";
    const m = parseMirrorConfig(yaml)!;
    expect(m.enabled).toBe(true);
    expect(m.watch).toBe(true);
    expect(m.location).toBe("internal");
    expect(m.auto_commit).toBe(true);
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
      watch: true,
      auto_commit: true,
      auto_push: false,
      commit_template: "export: {{date}} ({{notes_changed}} note{{plural}})",
      interval_seconds: 5,
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

  test("rejects non-integer interval_seconds", () => {
    const r = validateMirrorConfigShape({ interval_seconds: 0.5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe("interval_seconds");
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
});
