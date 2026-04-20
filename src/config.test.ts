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
      const vaultHome = path.join(${JSON.stringify(dir)}, "vault");
      fs.mkdirSync(vaultHome, { recursive: true });
      fs.writeFileSync(path.join(vaultHome, "config.yaml"),
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
      const vaultHome = path.join(${JSON.stringify(dir)}, "vault");
      fs.mkdirSync(vaultHome, { recursive: true });
      fs.writeFileSync(path.join(vaultHome, "config.yaml"),
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

// ---------------------------------------------------------------------------
// Legacy layout migration — pre-0.3 installs put vault files at the
// ecosystem root; on startup we move them into vault/.
// ---------------------------------------------------------------------------

describe2("migrateFromLegacyLayout", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "parachute-migrate-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test2("fresh install with no legacy files is a no-op and creates data/ + logs/", async () => {
    const script = `
      process.env.PARACHUTE_HOME = ${JSON.stringify(dir)};
      const fs = await import("fs");
      const path = await import("path");
      const { ensureConfigDirSync } = await import(${JSON.stringify(join(import.meta.dir, "config.ts"))});
      ensureConfigDirSync();
      const vaultHome = path.join(${JSON.stringify(dir)}, "vault");
      console.log(JSON.stringify({
        vaultHomeExists: fs.existsSync(vaultHome),
        dataExists: fs.existsSync(path.join(vaultHome, "data")),
        logsExists: fs.existsSync(path.join(vaultHome, "logs")),
        legacyVaultsDirExists: fs.existsSync(path.join(vaultHome, "vaults")),
        rootEnvExists: fs.existsSync(path.join(${JSON.stringify(dir)}, ".env")),
      }));
    `;
    const proc = Bun.spawnSync({ cmd: ["bun", "-e", script], stdout: "pipe", stderr: "pipe" });
    const stderr = new TextDecoder().decode(proc.stderr);
    expect2(proc.exitCode, stderr).toBe(0);
    const parsed = JSON.parse(new TextDecoder().decode(proc.stdout).trim());
    expect2(parsed.vaultHomeExists).toBe(true);
    expect2(parsed.dataExists).toBe(true);
    expect2(parsed.logsExists).toBe(true);
    expect2(parsed.legacyVaultsDirExists).toBe(false);
    expect2(parsed.rootEnvExists).toBe(false);
  });

  test2("moves legacy root files into vault/ (vaults → data/, logs → logs/)", async () => {
    const script = `
      process.env.PARACHUTE_HOME = ${JSON.stringify(dir)};
      const fs = await import("fs");
      const path = await import("path");
      const root = ${JSON.stringify(dir)};
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, ".env"), "PORT=1940\\n");
      fs.writeFileSync(path.join(root, "config.yaml"), "port: 1940\\n");
      fs.writeFileSync(path.join(root, "vault.log"), "log\\n");
      fs.writeFileSync(path.join(root, "vault.err"), "err\\n");
      fs.writeFileSync(path.join(root, "start.sh"), "#!/bin/bash\\n");
      fs.writeFileSync(path.join(root, "server-path"), "/repo/src/server.ts\\n");
      fs.mkdirSync(path.join(root, "vaults", "default"), { recursive: true });
      fs.writeFileSync(path.join(root, "vaults", "default", "vault.yaml"), "name: default\\napi_keys: []\\n");
      const { ensureConfigDirSync } = await import(${JSON.stringify(join(import.meta.dir, "config.ts"))});
      ensureConfigDirSync();
      const vaultHome = path.join(root, "vault");
      console.log(JSON.stringify({
        env: fs.readFileSync(path.join(vaultHome, ".env"), "utf-8"),
        config: fs.readFileSync(path.join(vaultHome, "config.yaml"), "utf-8"),
        start: fs.readFileSync(path.join(vaultHome, "start.sh"), "utf-8"),
        serverPath: fs.readFileSync(path.join(vaultHome, "server-path"), "utf-8"),
        vaultYaml: fs.readFileSync(path.join(vaultHome, "data", "default", "vault.yaml"), "utf-8"),
        log: fs.readFileSync(path.join(vaultHome, "logs", "vault.log"), "utf-8"),
        err: fs.readFileSync(path.join(vaultHome, "logs", "vault.err"), "utf-8"),
        legacyEnv: fs.existsSync(path.join(root, ".env")),
        legacyVaults: fs.existsSync(path.join(root, "vaults")),
        legacyVaultLog: fs.existsSync(path.join(root, "vault.log")),
        legacyVaultErr: fs.existsSync(path.join(root, "vault.err")),
      }));
    `;
    const proc = Bun.spawnSync({ cmd: ["bun", "-e", script], stdout: "pipe", stderr: "pipe" });
    const stderr = new TextDecoder().decode(proc.stderr);
    expect2(proc.exitCode, stderr).toBe(0);
    const parsed = JSON.parse(new TextDecoder().decode(proc.stdout).trim());
    expect2(parsed.env).toContain("PORT=1940");
    expect2(parsed.config).toContain("port: 1940");
    expect2(parsed.start).toContain("#!/bin/bash");
    expect2(parsed.serverPath).toContain("/repo/src/server.ts");
    expect2(parsed.vaultYaml).toContain("name: default");
    expect2(parsed.log).toContain("log");
    expect2(parsed.err).toContain("err");
    // Legacy paths should be gone after the move.
    expect2(parsed.legacyEnv).toBe(false);
    expect2(parsed.legacyVaults).toBe(false);
    expect2(parsed.legacyVaultLog).toBe(false);
    expect2(parsed.legacyVaultErr).toBe(false);
  });

  test2("double-migration is idempotent", async () => {
    const script = `
      process.env.PARACHUTE_HOME = ${JSON.stringify(dir)};
      const fs = await import("fs");
      const path = await import("path");
      const root = ${JSON.stringify(dir)};
      fs.writeFileSync(path.join(root, ".env"), "PORT=1940\\n");
      const { ensureConfigDirSync } = await import(${JSON.stringify(join(import.meta.dir, "config.ts"))});
      ensureConfigDirSync();
      // Second call: no legacy paths left, nothing to do.
      ensureConfigDirSync();
      console.log(JSON.stringify({
        envInVault: fs.readFileSync(path.join(root, "vault", ".env"), "utf-8"),
        rootEnv: fs.existsSync(path.join(root, ".env")),
      }));
    `;
    const proc = Bun.spawnSync({ cmd: ["bun", "-e", script], stdout: "pipe", stderr: "pipe" });
    const stderr = new TextDecoder().decode(proc.stderr);
    expect2(proc.exitCode, stderr).toBe(0);
    const parsed = JSON.parse(new TextDecoder().decode(proc.stdout).trim());
    expect2(parsed.envInVault).toContain("PORT=1940");
    expect2(parsed.rootEnv).toBe(false);
  });

  test2("0.3 install: vault/vaults/ → vault/data/, vault/{vault.log,vault.err} → vault/logs/", async () => {
    // Users who installed on 0.3 (post-PR-8 but pre-filesystem-hygiene)
    // have vault state under `vault/` with the old internal names.
    const script = `
      process.env.PARACHUTE_HOME = ${JSON.stringify(dir)};
      const fs = await import("fs");
      const path = await import("path");
      const vaultHome = path.join(${JSON.stringify(dir)}, "vault");
      fs.mkdirSync(path.join(vaultHome, "vaults", "work"), { recursive: true });
      fs.writeFileSync(path.join(vaultHome, "vaults", "work", "vault.yaml"), "name: work\\napi_keys: []\\n");
      fs.writeFileSync(path.join(vaultHome, "vault.log"), "daemon-stdout\\n");
      fs.writeFileSync(path.join(vaultHome, "vault.err"), "daemon-stderr\\n");
      const { ensureConfigDirSync } = await import(${JSON.stringify(join(import.meta.dir, "config.ts"))});
      ensureConfigDirSync();
      console.log(JSON.stringify({
        vaultYaml: fs.readFileSync(path.join(vaultHome, "data", "work", "vault.yaml"), "utf-8"),
        log: fs.readFileSync(path.join(vaultHome, "logs", "vault.log"), "utf-8"),
        err: fs.readFileSync(path.join(vaultHome, "logs", "vault.err"), "utf-8"),
        legacyVaultsDir: fs.existsSync(path.join(vaultHome, "vaults")),
        legacyLog: fs.existsSync(path.join(vaultHome, "vault.log")),
        legacyErr: fs.existsSync(path.join(vaultHome, "vault.err")),
      }));
    `;
    const proc = Bun.spawnSync({ cmd: ["bun", "-e", script], stdout: "pipe", stderr: "pipe" });
    const stderr = new TextDecoder().decode(proc.stderr);
    expect2(proc.exitCode, stderr).toBe(0);
    const parsed = JSON.parse(new TextDecoder().decode(proc.stdout).trim());
    expect2(parsed.vaultYaml).toContain("name: work");
    expect2(parsed.log).toContain("daemon-stdout");
    expect2(parsed.err).toContain("daemon-stderr");
    expect2(parsed.legacyVaultsDir).toBe(false);
    expect2(parsed.legacyLog).toBe(false);
    expect2(parsed.legacyErr).toBe(false);
  });

  test2("0.3 internal migration: both vault/vaults/ and vault/data/ exist — data/ wins, vaults/ preserved", async () => {
    const script = `
      process.env.PARACHUTE_HOME = ${JSON.stringify(dir)};
      const fs = await import("fs");
      const path = await import("path");
      const vaultHome = path.join(${JSON.stringify(dir)}, "vault");
      // Both layouts present with distinct marker content — migration
      // must NOT overwrite data/ (user may have manually staged it).
      fs.mkdirSync(path.join(vaultHome, "vaults"), { recursive: true });
      fs.writeFileSync(path.join(vaultHome, "vaults", "MARKER_LEGACY"), "legacy\\n");
      fs.mkdirSync(path.join(vaultHome, "data"), { recursive: true });
      fs.writeFileSync(path.join(vaultHome, "data", "MARKER_CURRENT"), "current\\n");
      const { ensureConfigDirSync } = await import(${JSON.stringify(join(import.meta.dir, "config.ts"))});
      ensureConfigDirSync();
      console.log(JSON.stringify({
        dataMarker: fs.existsSync(path.join(vaultHome, "data", "MARKER_CURRENT")),
        legacyMarker: fs.existsSync(path.join(vaultHome, "vaults", "MARKER_LEGACY")),
        dataOverwrittenByLegacy: fs.existsSync(path.join(vaultHome, "data", "MARKER_LEGACY")),
      }));
    `;
    const proc = Bun.spawnSync({ cmd: ["bun", "-e", script], stdout: "pipe", stderr: "pipe" });
    const stderr = new TextDecoder().decode(proc.stderr);
    expect2(proc.exitCode, stderr).toBe(0);
    const parsed = JSON.parse(new TextDecoder().decode(proc.stdout).trim());
    expect2(parsed.dataMarker).toBe(true); // data/ untouched
    expect2(parsed.legacyMarker).toBe(true); // vaults/ untouched, for user to inspect
    expect2(parsed.dataOverwrittenByLegacy).toBe(false);
    // Warning surfaces on stderr so the user sees it.
    expect2(stderr).toContain("both");
    expect2(stderr).toContain("vaults");
    expect2(stderr).toContain("data");
  });

  test2("0.3 internal migration: idempotent — second boot is a no-op", async () => {
    const script = `
      process.env.PARACHUTE_HOME = ${JSON.stringify(dir)};
      const fs = await import("fs");
      const path = await import("path");
      const vaultHome = path.join(${JSON.stringify(dir)}, "vault");
      fs.mkdirSync(path.join(vaultHome, "vaults", "journal"), { recursive: true });
      fs.writeFileSync(path.join(vaultHome, "vaults", "journal", "vault.yaml"), "name: journal\\n");
      const { ensureConfigDirSync } = await import(${JSON.stringify(join(import.meta.dir, "config.ts"))});
      ensureConfigDirSync();
      ensureConfigDirSync(); // second boot — no-op.
      console.log(JSON.stringify({
        vaultYaml: fs.readFileSync(path.join(vaultHome, "data", "journal", "vault.yaml"), "utf-8"),
        legacyVaultsDir: fs.existsSync(path.join(vaultHome, "vaults")),
      }));
    `;
    const proc = Bun.spawnSync({ cmd: ["bun", "-e", script], stdout: "pipe", stderr: "pipe" });
    const stderr = new TextDecoder().decode(proc.stderr);
    expect2(proc.exitCode, stderr).toBe(0);
    const parsed = JSON.parse(new TextDecoder().decode(proc.stdout).trim());
    expect2(parsed.vaultYaml).toContain("name: journal");
    expect2(parsed.legacyVaultsDir).toBe(false);
  });

  test2("leaves legacy in place when target already exists (no overwrite)", async () => {
    const script = `
      process.env.PARACHUTE_HOME = ${JSON.stringify(dir)};
      const fs = await import("fs");
      const path = await import("path");
      const root = ${JSON.stringify(dir)};
      const vaultHome = path.join(root, "vault");
      fs.mkdirSync(vaultHome, { recursive: true });
      fs.writeFileSync(path.join(root, ".env"), "LEGACY\\n");
      fs.writeFileSync(path.join(vaultHome, ".env"), "CURRENT\\n");
      const { ensureConfigDirSync } = await import(${JSON.stringify(join(import.meta.dir, "config.ts"))});
      ensureConfigDirSync();
      console.log(JSON.stringify({
        vaultEnv: fs.readFileSync(path.join(vaultHome, ".env"), "utf-8"),
        legacyEnv: fs.existsSync(path.join(root, ".env"))
          ? fs.readFileSync(path.join(root, ".env"), "utf-8")
          : null,
      }));
    `;
    const proc = Bun.spawnSync({ cmd: ["bun", "-e", script], stdout: "pipe", stderr: "pipe" });
    const stderr = new TextDecoder().decode(proc.stderr);
    expect2(proc.exitCode, stderr).toBe(0);
    const parsed = JSON.parse(new TextDecoder().decode(proc.stdout).trim());
    // Target wins; legacy file is left alone for the user to investigate.
    expect2(parsed.vaultEnv).toBe("CURRENT\n");
    expect2(parsed.legacyEnv).toBe("LEGACY\n");
  });
});
