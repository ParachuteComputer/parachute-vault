import { describe, test, expect } from "bun:test";
import {
  writeVaultConfig,
  readVaultConfig,
  writeGlobalConfig,
  readGlobalConfig,
  generateApiKey,
  hashKey,
  verifyKey,
} from "./config.ts";
import type { VaultConfig } from "./config.ts";

describe("config", () => {
  test("generates and verifies API keys", () => {
    const { fullKey, keyId } = generateApiKey();
    expect(fullKey).toMatch(/^pvk_/);
    expect(keyId).toMatch(/^k_/);

    const hash = hashKey(fullKey);
    expect(hash).toMatch(/^sha256:/);
    expect(verifyKey(fullKey, hash)).toBe(true);
    expect(verifyKey("wrong_key_here_1234567890123456", hash)).toBe(false);
  });

  test("round-trips vault config", () => {
    const config: VaultConfig = {
      name: "testvault",
      description: "A test vault for testing",
      api_keys: [
        {
          id: "k_abc123",
          label: "default",
          scope: "write",
          key_hash: "sha256:fakehash",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      created_at: "2026-01-01T00:00:00.000Z",
    };

    writeVaultConfig(config);

    const loaded = readVaultConfig("testvault");
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("testvault");
    expect(loaded!.description).toBe("A test vault for testing");
    expect(loaded!.api_keys.length).toBe(1);
    expect(loaded!.api_keys[0].id).toBe("k_abc123");
  });

  test("round-trips tag_schemas in vault config", () => {
    const config: VaultConfig = {
      name: "testvault",
      api_keys: [
        {
          id: "k_abc123",
          label: "default",
          scope: "write",
          key_hash: "sha256:fakehash",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      created_at: "2026-01-01T00:00:00.000Z",
      tag_schemas: {
        person: {
          description: "A person in Aaron's life",
          fields: {
            first_appeared: {
              type: "string",
              description: "When this person first appeared",
            },
            relationship: {
              type: "string",
              description: "How they relate to Aaron",
            },
          },
        },
        project: {
          description: "A project",
          fields: {
            status: {
              type: "string",
              enum: ["active", "completed", "abandoned"],
              description: "Current project status",
            },
          },
        },
        "summary/monthly": {
          description: "Monthly summary note",
        },
      },
    };

    writeVaultConfig(config);

    const loaded = readVaultConfig("testvault");
    expect(loaded).not.toBeNull();
    expect(loaded!.tag_schemas).toBeDefined();

    const person = loaded!.tag_schemas!.person;
    expect(person.description).toBe("A person in Aaron's life");
    expect(person.fields!.first_appeared.type).toBe("string");
    expect(person.fields!.first_appeared.description).toBe("When this person first appeared");
    expect(person.fields!.relationship.type).toBe("string");

    const project = loaded!.tag_schemas!.project;
    expect(project.fields!.status.enum).toEqual(["active", "completed", "abandoned"]);

    const monthly = loaded!.tag_schemas!["summary/monthly"];
    expect(monthly.description).toBe("Monthly summary note");
    expect(monthly.fields).toBeUndefined();
  });

  test("vault config without tag_schemas loads cleanly", () => {
    const config: VaultConfig = {
      name: "testvault",
      api_keys: [],
      created_at: "2026-01-01T00:00:00.000Z",
    };

    writeVaultConfig(config);

    const loaded = readVaultConfig("testvault");
    expect(loaded).not.toBeNull();
    expect(loaded!.tag_schemas).toBeUndefined();
  });

  test("round-trips discovery: enabled|disabled", () => {
    // Default: absent means enabled (endpoint serves names).
    writeGlobalConfig({ port: 1940 });
    expect(readGlobalConfig().discovery).toBeUndefined();

    // Explicit enabled.
    writeGlobalConfig({ port: 1940, discovery: "enabled" });
    expect(readGlobalConfig().discovery).toBe("enabled");

    // Explicit disabled — this is the opt-out flag operators set when they
    // don't want /vaults/list to reveal vault names publicly.
    writeGlobalConfig({ port: 1940, discovery: "disabled" });
    expect(readGlobalConfig().discovery).toBe("disabled");
  });
});

// ---------------------------------------------------------------------------
// Backup config — round-trip through writeGlobalConfig + readGlobalConfig
// ---------------------------------------------------------------------------

import { describe as describe2, test as test2, expect as expect2, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe2("backup config round-trip", () => {
  // We can't just call writeGlobalConfig / readGlobalConfig like above: they
  // write into CONFIG_DIR, which is derived from PARACHUTE_HOME at import
  // time. So we spawn a child process with an isolated PARACHUTE_HOME to
  // test the full read/write cycle, matching the pattern in doctor.test.ts.
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "backup-cfg-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test2("writes and reads a backup section with tiered retention + local dest", async () => {
    // Child script writes a config, re-reads it, and prints the normalized
    // result. This exercises the full YAML round-trip without mocking.
    const script = `
      process.env.PARACHUTE_HOME = ${JSON.stringify(dir)};
      const { writeGlobalConfig, readGlobalConfig } = await import(${JSON.stringify(join(import.meta.dir, "config.ts"))});
      writeGlobalConfig({
        port: 1940,
        default_vault: "default",
        backup: {
          schedule: "daily",
          retention: { daily: 7, weekly: 4, monthly: 12, yearly: null },
          destinations: [{ kind: "local", path: "~/parachute-backups" }],
        },
      });
      const read = readGlobalConfig();
      console.log(JSON.stringify(read.backup));
    `;
    const proc = Bun.spawnSync({
      cmd: ["bun", "-e", script],
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new TextDecoder().decode(proc.stdout);
    const stderr = new TextDecoder().decode(proc.stderr);
    expect2(proc.exitCode, stderr).toBe(0);

    const parsed = JSON.parse(stdout.trim());
    expect2(parsed.schedule).toBe("daily");
    expect2(parsed.retention).toEqual({ daily: 7, weekly: 4, monthly: 12, yearly: null });
    expect2(parsed.destinations.length).toBe(1);
    expect2(parsed.destinations[0].kind).toBe("local");
    expect2(parsed.destinations[0].path).toBe("~/parachute-backups");
  });

  test2("retention defaults when the user omits the retention block entirely", async () => {
    // A backup: with schedule only (no retention block) should pick up the
    // shipped defaults: 7/4/12/null.
    const script = `
      process.env.PARACHUTE_HOME = ${JSON.stringify(dir)};
      const fs = await import("fs");
      const path = await import("path");
      fs.writeFileSync(path.join(${JSON.stringify(dir)}, "config.yaml"),
        "port: 1940\\nbackup:\\n  schedule: daily\\n  destinations: []\\n");
      const { readGlobalConfig } = await import(${JSON.stringify(join(import.meta.dir, "config.ts"))});
      console.log(JSON.stringify(readGlobalConfig().backup));
    `;
    const proc = Bun.spawnSync({ cmd: ["bun", "-e", script], stdout: "pipe", stderr: "pipe" });
    const out = new TextDecoder().decode(proc.stdout);
    expect2(proc.exitCode, new TextDecoder().decode(proc.stderr)).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect2(parsed.retention).toEqual({ daily: 7, weekly: 4, monthly: 12, yearly: null });
  });

  test2("partial retention block: unspecified tiers default to 0 (explicit > merged)", async () => {
    // If the user supplies a retention block with only `daily: 3`, the
    // remaining tiers read as 0 rather than merging with shipped defaults.
    // Predictable: what you write is what you get.
    const script = `
      process.env.PARACHUTE_HOME = ${JSON.stringify(dir)};
      const fs = await import("fs");
      const path = await import("path");
      fs.writeFileSync(path.join(${JSON.stringify(dir)}, "config.yaml"),
        "port: 1940\\nbackup:\\n  schedule: daily\\n  retention:\\n    daily: 3\\n  destinations: []\\n");
      const { readGlobalConfig } = await import(${JSON.stringify(join(import.meta.dir, "config.ts"))});
      console.log(JSON.stringify(readGlobalConfig().backup));
    `;
    const proc = Bun.spawnSync({ cmd: ["bun", "-e", script], stdout: "pipe", stderr: "pipe" });
    const out = new TextDecoder().decode(proc.stdout);
    expect2(proc.exitCode, new TextDecoder().decode(proc.stderr)).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect2(parsed.retention.daily).toBe(3);
    expect2(parsed.retention.weekly).toBe(0);
    expect2(parsed.retention.monthly).toBe(0);
    // yearly stays at 0 because the user didn't say null.
    expect2(parsed.retention.yearly).toBe(0);
  });

  test2("yearly: null round-trips through write/read as JSON null", async () => {
    const script = `
      process.env.PARACHUTE_HOME = ${JSON.stringify(dir)};
      const { writeGlobalConfig, readGlobalConfig } = await import(${JSON.stringify(join(import.meta.dir, "config.ts"))});
      writeGlobalConfig({
        port: 1940,
        backup: {
          schedule: "manual",
          retention: { daily: 0, weekly: 0, monthly: 0, yearly: null },
          destinations: [],
        },
      });
      console.log(JSON.stringify(readGlobalConfig().backup));
    `;
    const proc = Bun.spawnSync({ cmd: ["bun", "-e", script], stdout: "pipe", stderr: "pipe" });
    const out = new TextDecoder().decode(proc.stdout);
    expect2(proc.exitCode).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect2(parsed.retention.yearly).toBeNull();
  });

  test2("config without a backup section reads back with backup === undefined", async () => {
    const script = `
      process.env.PARACHUTE_HOME = ${JSON.stringify(dir)};
      const { writeGlobalConfig, readGlobalConfig } = await import(${JSON.stringify(join(import.meta.dir, "config.ts"))});
      writeGlobalConfig({ port: 1940, default_vault: "default" });
      const read = readGlobalConfig();
      console.log(JSON.stringify({ backup: read.backup ?? null }));
    `;
    const proc = Bun.spawnSync({ cmd: ["bun", "-e", script], stdout: "pipe", stderr: "pipe" });
    const out = new TextDecoder().decode(proc.stdout);
    expect2(proc.exitCode).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect2(parsed.backup).toBeNull();
  });

  test2("empty destinations round-trips as empty list (not missing key)", async () => {
    const script = `
      process.env.PARACHUTE_HOME = ${JSON.stringify(dir)};
      const { writeGlobalConfig, readGlobalConfig } = await import(${JSON.stringify(join(import.meta.dir, "config.ts"))});
      writeGlobalConfig({
        port: 1940,
        backup: {
          schedule: "manual",
          retention: { daily: 7, weekly: 4, monthly: 12, yearly: null },
          destinations: [],
        },
      });
      const read = readGlobalConfig();
      console.log(JSON.stringify(read.backup));
    `;
    const proc = Bun.spawnSync({ cmd: ["bun", "-e", script], stdout: "pipe", stderr: "pipe" });
    const out = new TextDecoder().decode(proc.stdout);
    expect2(proc.exitCode).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect2(parsed.schedule).toBe("manual");
    expect2(parsed.destinations).toEqual([]);
  });
});
