import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVaultServicePaths, selfRegister } from "./self-register.ts";
import type { VaultModuleManifest } from "./module-manifest.ts";

/**
 * Spin up a fresh PARACHUTE_HOME tmpdir + restore the prior env on teardown.
 * The self-register pass writes through to `~/.parachute/services.json` via
 * the per-call path resolution in services-manifest.ts (which honors
 * PARACHUTE_HOME), so this is the canonical isolation seam.
 */
function withParachuteHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "pvault-self-register-"));
  const prior = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = home;
  // Also override HOME so readGlobalConfig + listVaults don't fall through
  // to the operator's real ~/.parachute.
  const priorHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // Seed the config dir with an empty config.yaml so readGlobalConfig
    // returns a clean state.
    mkdirSync(join(home, "vault"), { recursive: true });
    writeFileSync(join(home, "vault", "config.yaml"), "port: 1940\n");
    fn(home);
  } finally {
    if (prior === undefined) delete process.env.PARACHUTE_HOME;
    else process.env.PARACHUTE_HOME = prior;
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
  }
}

const TEST_MANIFEST: VaultModuleManifest = {
  name: "vault",
  manifestName: "parachute-vault",
  displayName: "Vault",
  tagline: "Test tagline",
  port: 1940,
  paths: ["/vault/default"],
  health: "/vault/default/health",
};

function captureLogs(): {
  log: (m: string) => void;
  warn: (m: string) => void;
  logs: string[];
  warnings: string[];
} {
  const logs: string[] = [];
  const warnings: string[] = [];
  return {
    log: (m: string) => logs.push(m),
    warn: (m: string) => warnings.push(m),
    logs,
    warnings,
  };
}

describe("self-register", () => {
  test("buildVaultServicePaths — no vaults yet → empty paths (no phantom /vault/default, #478)", () => {
    expect(buildVaultServicePaths(undefined, [], ["/vault/default"])).toEqual([]);
  });

  test("buildVaultServicePaths — default vault sorts first", () => {
    expect(
      buildVaultServicePaths("default", ["alpha", "default", "beta"], ["/"]),
    ).toEqual(["/vault/default", "/vault/alpha", "/vault/beta"]);
  });

  test("buildVaultServicePaths — no default → map by listed order", () => {
    expect(buildVaultServicePaths(undefined, ["alpha", "beta"], ["/"])).toEqual([
      "/vault/alpha",
      "/vault/beta",
    ]);
  });

  test("buildVaultServicePaths — default points to missing vault → ignore default", () => {
    expect(
      buildVaultServicePaths("missing", ["alpha", "beta"], ["/"]),
    ).toEqual(["/vault/alpha", "/vault/beta"]);
  });

  test("writes services.json with manifest-sourced fields + installDir", () => {
    withParachuteHome((home) => {
      const { log, warn, logs, warnings } = captureLogs();
      const result = selfRegister({
        version: "0.4.8-rc.3",
        log,
        warn,
        readManifest: () => TEST_MANIFEST,
        resolvePackageRoot: () => "/fake/install/dir",
        listVaults: () => [],
        readGlobalConfig: () => ({ port: 1940 }),
      });
      expect(result.status).toBe("registered");
      expect(warnings).toEqual([]);
      expect(logs[0]).toContain("registered parachute-vault");

      const raw = readFileSync(join(home, "services.json"), "utf8");
      const parsed = JSON.parse(raw) as { services: unknown[] };
      expect(parsed.services).toHaveLength(1);
      const row = parsed.services[0] as Record<string, unknown>;
      expect(row.name).toBe("parachute-vault");
      expect(row.port).toBe(1940);
      // Zero vaults → paths: [] (no phantom /vault/default, #478).
      // Health still well-formed: paths[0] ?? "/vault/default" fallback.
      expect(row.paths).toEqual([]);
      expect(row.health).toBe("/vault/default/health");
      expect(row.version).toBe("0.4.8-rc.3");
      expect(row.installDir).toBe("/fake/install/dir");
      expect(row.displayName).toBe("Vault");
      expect(row.tagline).toBe("Test tagline");
    });
  });

  test("health path follows the primary vault name (closes vault#369)", () => {
    // Regression: pre-fix self-register used `manifest.health` verbatim
    // (which is `/vault/default/health`) regardless of the actual vault
    // name. A hub-bundled wizard that lets the operator name their vault
    // `notes` produced a services.json entry with `paths: ["/vault/notes"]`
    // but `health: "/vault/default/health"`, so hub's per-module health
    // probe hit a 404 even on a healthy vault. The fix derives health from
    // paths[0]. Caught in the wild on a Render rebuild walkthrough.
    withParachuteHome((home) => {
      const { log, warn } = captureLogs();
      selfRegister({
        version: "0.4.8-rc.3",
        log,
        warn,
        readManifest: () => TEST_MANIFEST,
        resolvePackageRoot: () => "/fake/install/dir",
        // Vault named something other than "default" — the manifest fallback
        // path `/vault/default` should NOT leak into the health URL.
        listVaults: () => ["notes"],
        readGlobalConfig: () => ({ port: 1940, default_vault: "notes" }),
      });
      const parsed = JSON.parse(readFileSync(join(home, "services.json"), "utf8")) as {
        services: { paths: string[]; health: string }[];
      };
      const row = parsed.services[0];
      expect(row.paths).toEqual(["/vault/notes"]);
      expect(row.health).toBe("/vault/notes/health");
      // Sanity: health should never be the literal manifest template
      // when a real vault exists with a different name.
      expect(row.health).not.toBe("/vault/default/health");
    });
  });

  test("idempotent — re-running reports no changes", () => {
    withParachuteHome(() => {
      const { log, warn } = captureLogs();
      const deps = {
        version: "0.4.8-rc.3",
        log,
        warn,
        readManifest: () => TEST_MANIFEST,
        resolvePackageRoot: () => "/fake/install/dir",
        listVaults: () => [],
        readGlobalConfig: () => ({ port: 1940 }),
      };
      const first = selfRegister(deps);
      expect(first.status).toBe("registered");
      if (first.status === "registered") expect(first.changed).toBe(true);

      const second = selfRegister(deps);
      expect(second.status).toBe("registered");
      if (second.status === "registered") expect(second.changed).toBe(false);
    });
  });

  test("preserves hub-stamped fields on the row", () => {
    withParachuteHome((home) => {
      // Pre-existing row carries a hub-stamped field we don't write.
      const servicesPath = join(home, "services.json");
      writeFileSync(
        servicesPath,
        `${JSON.stringify(
          {
            services: [
              {
                name: "parachute-vault",
                port: 1940,
                paths: ["/vault/default"],
                health: "/vault/default/health",
                version: "0.4.7",
                // Pretend hub stamped some custom field — should survive.
                hubCustomField: "preserved",
                installDir: "/some/prior/path",
              },
            ],
          },
          null,
          2,
        )}\n`,
      );

      const { log, warn } = captureLogs();
      const result = selfRegister({
        version: "0.4.8-rc.3",
        log,
        warn,
        readManifest: () => TEST_MANIFEST,
        resolvePackageRoot: () => "/new/install/dir",
        listVaults: () => [],
        readGlobalConfig: () => ({ port: 1940 }),
      });
      expect(result.status).toBe("registered");

      const raw = readFileSync(servicesPath, "utf8");
      const parsed = JSON.parse(raw) as { services: Record<string, unknown>[] };
      const row = parsed.services[0]!;
      // Vault-owned fields win.
      expect(row.version).toBe("0.4.8-rc.3");
      expect(row.installDir).toBe("/new/install/dir");
      // Hub-stamped foreign field survives.
      expect(row.hubCustomField).toBe("preserved");
    });
  });

  test("preserves entries written by other modules", () => {
    withParachuteHome((home) => {
      const servicesPath = join(home, "services.json");
      writeFileSync(
        servicesPath,
        `${JSON.stringify(
          {
            services: [
              {
                name: "parachute-scribe",
                port: 1943,
                paths: ["/scribe"],
                health: "/scribe/health",
                version: "0.3.0",
              },
            ],
          },
          null,
          2,
        )}\n`,
      );

      const { log, warn } = captureLogs();
      selfRegister({
        version: "0.4.8-rc.3",
        log,
        warn,
        readManifest: () => TEST_MANIFEST,
        resolvePackageRoot: () => "/fake/install/dir",
        listVaults: () => [],
        readGlobalConfig: () => ({ port: 1940 }),
      });

      const raw = readFileSync(servicesPath, "utf8");
      const parsed = JSON.parse(raw) as { services: { name: string }[] };
      expect(parsed.services).toHaveLength(2);
      expect(parsed.services.find((s) => s.name === "parachute-scribe")).toBeDefined();
      expect(parsed.services.find((s) => s.name === "parachute-vault")).toBeDefined();
    });
  });

  test("skipped when manifest absent — never throws", () => {
    withParachuteHome(() => {
      const { log, warn, warnings } = captureLogs();
      const result = selfRegister({
        version: "0.4.8-rc.3",
        log,
        warn,
        readManifest: () => null,
        resolvePackageRoot: () => "/fake/install/dir",
        listVaults: () => [],
        readGlobalConfig: () => ({ port: 1940 }),
      });
      expect(result.status).toBe("skipped");
      if (result.status === "skipped") expect(result.reason).toMatch(/manifest absent/);
      expect(warnings).toEqual([]); // skipped is informational, not a warning
    });
  });

  test("failed when manifest read throws — does not propagate", () => {
    withParachuteHome(() => {
      const { log, warn, warnings } = captureLogs();
      const result = selfRegister({
        version: "0.4.8-rc.3",
        log,
        warn,
        readManifest: () => {
          throw new Error("corrupt JSON");
        },
        resolvePackageRoot: () => "/fake/install/dir",
        listVaults: () => [],
        readGlobalConfig: () => ({ port: 1940 }),
      });
      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(result.reason).toContain("corrupt JSON");
      expect(warnings.some((w) => w.includes("could not read"))).toBe(true);
    });
  });

  test("failed when upsert throws — does not propagate", () => {
    withParachuteHome(() => {
      const { log, warn, warnings } = captureLogs();
      const result = selfRegister({
        version: "0.4.8-rc.3",
        log,
        warn,
        readManifest: () => TEST_MANIFEST,
        resolvePackageRoot: () => "/fake/install/dir",
        listVaults: () => [],
        readGlobalConfig: () => ({ port: 1940 }),
        upsertService: () => {
          throw new Error("disk full");
        },
      });
      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(result.reason).toContain("disk full");
      expect(warnings.some((w) => w.includes("services.json write failed"))).toBe(true);
    });
  });

  test("multi-vault: default vault sorts first in paths", () => {
    withParachuteHome((home) => {
      const { log, warn } = captureLogs();
      selfRegister({
        version: "0.4.8-rc.3",
        log,
        warn,
        readManifest: () => TEST_MANIFEST,
        resolvePackageRoot: () => "/fake/install/dir",
        listVaults: () => ["alpha", "default", "beta"],
        readGlobalConfig: () => ({ port: 1940, default_vault: "default" }),
      });

      const raw = readFileSync(join(home, "services.json"), "utf8");
      const parsed = JSON.parse(raw) as { services: Record<string, unknown>[] };
      expect(parsed.services[0]!.paths).toEqual([
        "/vault/default",
        "/vault/alpha",
        "/vault/beta",
      ]);
    });
  });

  test("uses globalConfig.port over DEFAULT_PORT when set", () => {
    withParachuteHome((home) => {
      const { log, warn } = captureLogs();
      selfRegister({
        version: "0.4.8-rc.3",
        log,
        warn,
        readManifest: () => TEST_MANIFEST,
        resolvePackageRoot: () => "/fake/install/dir",
        listVaults: () => [],
        readGlobalConfig: () => ({ port: 19999 }),
      });

      const raw = readFileSync(join(home, "services.json"), "utf8");
      const parsed = JSON.parse(raw) as { services: Record<string, unknown>[] };
      expect(parsed.services[0]!.port).toBe(19999);
    });
  });

  test("stripPrefix flows from manifest to row when set", () => {
    withParachuteHome((home) => {
      const { log, warn } = captureLogs();
      selfRegister({
        version: "0.4.8-rc.3",
        log,
        warn,
        readManifest: () => ({ ...TEST_MANIFEST, stripPrefix: true }),
        resolvePackageRoot: () => "/fake/install/dir",
        listVaults: () => [],
        readGlobalConfig: () => ({ port: 1940 }),
      });

      const raw = readFileSync(join(home, "services.json"), "utf8");
      const parsed = JSON.parse(raw) as { services: Record<string, unknown>[] };
      expect(parsed.services[0]!.stripPrefix).toBe(true);
    });
  });

  test("changed=true when installDir differs from prior row", () => {
    withParachuteHome(() => {
      const { log, warn } = captureLogs();
      const baseDeps = {
        version: "0.4.8-rc.3",
        log,
        warn,
        readManifest: () => TEST_MANIFEST,
        listVaults: () => [],
        readGlobalConfig: () => ({ port: 1940 }),
      };
      const first = selfRegister({
        ...baseDeps,
        resolvePackageRoot: () => "/old/install/dir",
      });
      expect(first.status).toBe("registered");
      if (first.status === "registered") expect(first.changed).toBe(true);

      // Second call with a different installDir — should re-stamp.
      const second = selfRegister({
        ...baseDeps,
        resolvePackageRoot: () => "/new/install/dir",
      });
      expect(second.status).toBe("registered");
      if (second.status === "registered") expect(second.changed).toBe(true);
    });
  });
});
