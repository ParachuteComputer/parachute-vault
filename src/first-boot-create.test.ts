/**
 * Integration tests for the first-boot vault creation gate introduced in
 * vault#478 Part 2 — server creates a vault ONLY when PARACHUTE_VAULT_NAME
 * is explicitly set.
 *
 * Each test spawns a real server subprocess against a fresh PARACHUTE_HOME
 * tmpdir (the stop-signal.test.ts pattern) and probes over HTTP so the
 * actual Bun.serve boot path is exercised, not a mocked code path.
 *
 * Port assignments (chosen to avoid collisions with the running daemon on
 * 1940 and stop-signal.test.ts on 19404):
 *   19410 — test 1: PARACHUTE_VAULT_NAME unset → zero vaults
 *   19411 — test 2: PARACHUTE_VAULT_NAME=testvault → vault created
 *
 * NOTE: the unit-level assertions for resolveFirstBootVaultName (source:
 * "default" / "env" / "env-invalid") already live in vault-name.test.ts.
 * These tests cover the SERVER-LEVEL behaviour — whether a vault is actually
 * created on disk — so they are intentionally non-duplicative.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { waitForHealthy } from "./health.ts";
import { listVaults } from "./config.ts";

const SERVER_PATH = resolve(import.meta.dir, "server.ts");

// ---------------------------------------------------------------------------
// Test 1 — PARACHUTE_VAULT_NAME unset
// ---------------------------------------------------------------------------

const PORT_NO_ENV = 19_410;
let tmpHomeNoEnv: string;

beforeAll(() => {
  tmpHomeNoEnv = mkdtempSync(join(tmpdir(), "vault-first-boot-no-env-"));
  mkdirSync(join(tmpHomeNoEnv, "vault"), { recursive: true });
});

afterAll(() => {
  rmSync(tmpHomeNoEnv, { recursive: true, force: true });
});

describe("first-boot: PARACHUTE_VAULT_NAME unset → zero vaults", () => {
  test("server is healthy AND no vault was auto-created", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", SERVER_PATH],
      env: {
        ...process.env,
        PARACHUTE_HOME: tmpHomeNoEnv,
        PORT: String(PORT_NO_ENV),
        // Must be unset — do NOT inherit from the test runner's shell.
        PARACHUTE_VAULT_NAME: undefined as unknown as string,
        SCRIBE_URL: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const health = await waitForHealthy(PORT_NO_ENV, { totalMs: 15_000 });
      expect(health.status).toBe("healthy");

      // Verify zero vaults were created inside the tmp home.
      const originalHome = process.env.PARACHUTE_HOME;
      try {
        process.env.PARACHUTE_HOME = tmpHomeNoEnv;
        const vaults = listVaults();
        expect(vaults).toHaveLength(0);
        expect(vaults).not.toContain("default");
      } finally {
        if (originalHome === undefined) delete process.env.PARACHUTE_HOME;
        else process.env.PARACHUTE_HOME = originalHome;
      }

      // Also assert no vault.yaml was written (belt-and-suspenders).
      // Path structure: <PARACHUTE_HOME>/vault/data/<name>/vault.yaml
      const defaultVaultConfig = join(tmpHomeNoEnv, "vault", "data", "default", "vault.yaml");
      expect(existsSync(defaultVaultConfig)).toBe(false);
    } finally {
      if (!proc.killed) proc.kill();
      await proc.exited;
    }
  }, 25_000);
});

// ---------------------------------------------------------------------------
// Test 2 — PARACHUTE_VAULT_NAME=testvault → vault created
// ---------------------------------------------------------------------------

const PORT_WITH_ENV = 19_411;
let tmpHomeWithEnv: string;

// We need separate beforeAll/afterAll scopes for the two server lifetimes.
// Bun:test describe blocks share the outer beforeAll/afterAll, so we use
// module-level variables and a nested describe with its own lifecycle hooks.
describe("first-boot: PARACHUTE_VAULT_NAME=testvault → vault created", () => {
  let proc: ReturnType<typeof Bun.spawn>;

  beforeAll(async () => {
    tmpHomeWithEnv = mkdtempSync(join(tmpdir(), "vault-first-boot-with-env-"));
    mkdirSync(join(tmpHomeWithEnv, "vault"), { recursive: true });

    proc = Bun.spawn({
      cmd: ["bun", SERVER_PATH],
      env: {
        ...process.env,
        PARACHUTE_HOME: tmpHomeWithEnv,
        PORT: String(PORT_WITH_ENV),
        PARACHUTE_VAULT_NAME: "testvault",
        SCRIBE_URL: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const health = await waitForHealthy(PORT_WITH_ENV, { totalMs: 15_000 });
    if (health.status !== "healthy") {
      proc.kill();
      throw new Error(`server failed to become healthy: ${health.status} (${health.error ?? ""})`);
    }
  });

  afterAll(async () => {
    if (proc && !proc.killed) proc.kill();
    await proc?.exited;
    rmSync(tmpHomeWithEnv, { recursive: true, force: true });
  });

  test('vault "testvault" was created (not "default")', () => {
    const originalHome = process.env.PARACHUTE_HOME;
    try {
      process.env.PARACHUTE_HOME = tmpHomeWithEnv;
      const vaults = listVaults();
      expect(vaults).toContain("testvault");
      expect(vaults).not.toContain("default");
      expect(vaults).toHaveLength(1);
    } finally {
      if (originalHome === undefined) delete process.env.PARACHUTE_HOME;
      else process.env.PARACHUTE_HOME = originalHome;
    }
  });

  test("vault config dir exists at the correct path", () => {
    // Path structure: <PARACHUTE_HOME>/vault/data/<name>/vault.yaml
    const vaultConfigPath = join(tmpHomeWithEnv, "vault", "data", "testvault", "vault.yaml");
    expect(existsSync(vaultConfigPath)).toBe(true);

    // "default" must NOT have been created.
    const defaultConfigPath = join(tmpHomeWithEnv, "vault", "data", "default", "vault.yaml");
    expect(existsSync(defaultConfigPath)).toBe(false);
  });
});
