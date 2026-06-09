/**
 * Integration tests for `parachute-vault remove <name> --yes` — the cmdRemove
 * hygiene from the 2026-06-09 hub-module-boundary migration (B1's CLI-side
 * improvements):
 *
 *   1. services.json refresh — remove re-runs `selfRegister` (the same
 *      refresh cmdCreate does, #208) so the deleted vault's `/vault/<name>`
 *      path drops out of the parachute-vault row immediately instead of
 *      going stale until the next server boot.
 *   2. last-vault marker — removing the LAST vault writes
 *      `auto_create: false` into the global config so the server boot's
 *      auto-create-default does NOT silently resurrect a fresh `default`
 *      (with fresh credentials). Fresh installs (no config.yaml at all)
 *      still auto-create — the Docker first-run path is preserved.
 *
 * Spawns the CLI in a temp PARACHUTE_HOME (never the operator's real
 * ~/.parachute). In-process `readGlobalConfig` reads resolve PARACHUTE_HOME
 * per call, so pointing the env var at the temp home inside a test is safe.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resolve } from "path";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bootAutoCreateAllowed, readGlobalConfig } from "./config.ts";
import type { GlobalConfig } from "./config.ts";

const CLI = resolve(import.meta.dir, "cli.ts");

function runCli(
  args: string[],
  env: Record<string, string>,
): { exitCode: number; stdout: string; stderr: string } {
  // Hermetic: don't inherit the dev/CI box's PARACHUTE_HUB_ORIGIN (same
  // posture as vault-create.test.ts — a leaked origin flips guidance copy).
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  delete baseEnv.PARACHUTE_HUB_ORIGIN;
  const proc = Bun.spawnSync({
    cmd: ["bun", CLI, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...baseEnv, ...env },
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

/** Read the global config from the test home via the real parser. The
 *  config path resolves `process.env.PARACHUTE_HOME` per call, so a scoped
 *  override + restore is all it takes — no module re-import dance. */
function readGlobalConfigFrom(home: string): GlobalConfig {
  const prior = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = home;
  try {
    return readGlobalConfig();
  } finally {
    if (prior === undefined) delete process.env.PARACHUTE_HOME;
    else process.env.PARACHUTE_HOME = prior;
  }
}

function readServices(home: string): { name: string; paths: string[] }[] {
  const raw = readFileSync(join(home, "services.json"), "utf-8");
  return JSON.parse(raw).services;
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "vault-remove-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("vault remove — services.json refresh", () => {
  test("removing a vault drops its /vault/<name> path immediately", () => {
    runCli(["create", "alpha", "--json"], { PARACHUTE_HOME: home });
    runCli(["create", "beta", "--json"], { PARACHUTE_HOME: home });
    expect(readServices(home).find((s) => s.name === "parachute-vault")!.paths).toEqual([
      "/vault/alpha",
      "/vault/beta",
    ]);

    const { exitCode, stdout } = runCli(["remove", "beta", "--yes"], {
      PARACHUTE_HOME: home,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Vault "beta" removed.');

    // The stale-until-next-boot path is gone NOW — the hub's well-known
    // fan-out stops advertising the deleted vault without a restart.
    const vault = readServices(home).find((s) => s.name === "parachute-vault");
    expect(vault).toBeDefined();
    expect(vault!.paths).toEqual(["/vault/alpha"]);
    // The vault data itself is gone too.
    expect(existsSync(join(home, "vault", "data", "beta"))).toBe(false);
  });

  test("removing the DEFAULT vault promotes the survivor and reorders paths", () => {
    runCli(["create", "alpha", "--json"], { PARACHUTE_HOME: home }); // default
    runCli(["create", "beta", "--json"], { PARACHUTE_HOME: home });

    const { exitCode, stdout } = runCli(["remove", "alpha", "--yes"], {
      PARACHUTE_HOME: home,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Default vault is now "beta".');

    const config = readGlobalConfigFrom(home);
    expect(config.default_vault).toBe("beta");
    // selfRegister ran AFTER the default promotion, so paths[0] is the new
    // default (the hub reads paths[0] as the canonical mount).
    const vault = readServices(home).find((s) => s.name === "parachute-vault");
    expect(vault!.paths).toEqual(["/vault/beta"]);
  });
});

describe("vault remove — last-vault auto_create marker", () => {
  test("removing the last vault writes auto_create: false + boot honors it", () => {
    runCli(["create", "solo", "--json"], { PARACHUTE_HOME: home });

    const { exitCode, stdout } = runCli(["remove", "solo", "--yes"], {
      PARACHUTE_HOME: home,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("auto_create: false");

    // The marker is in the YAML and the real parser reads it back.
    const yaml = readFileSync(join(home, "vault", "config.yaml"), "utf-8");
    expect(yaml).toMatch(/^auto_create: false$/m);
    const config = readGlobalConfigFrom(home);
    expect(config.auto_create).toBe(false);

    // The boot gate (server.ts auto-create branch) honors the marker — no
    // resurrection of a freshly-credentialed "default".
    expect(bootAutoCreateAllowed(config)).toBe(false);

    // services.json was still refreshed: with zero vaults the row falls back
    // to the manifest's canonical paths — the SAME row a subsequent boot's
    // selfRegister writes, so CLI-remove and boot agree on the zero-vault
    // registration shape (and the hub still sees the module as installed).
    const vault = readServices(home).find((s) => s.name === "parachute-vault");
    expect(vault).toBeDefined();
    expect(vault!.paths).toEqual(["/vault/default"]);
  });

  test("removing a NON-last vault does not write the marker", () => {
    runCli(["create", "alpha", "--json"], { PARACHUTE_HOME: home });
    runCli(["create", "beta", "--json"], { PARACHUTE_HOME: home });
    runCli(["remove", "beta", "--yes"], { PARACHUTE_HOME: home });

    const yaml = readFileSync(join(home, "vault", "config.yaml"), "utf-8");
    expect(yaml).not.toContain("auto_create");
    const config = readGlobalConfigFrom(home);
    expect(config.auto_create).toBeUndefined();
    expect(bootAutoCreateAllowed(config)).toBe(true);
  });

  test("fresh install (no config.yaml at all) still allows boot auto-create", () => {
    // Docker first-run: PARACHUTE_HOME exists but no vault/config.yaml has
    // ever been written. readGlobalConfig returns defaults — no marker —
    // and the boot auto-create proceeds.
    expect(existsSync(join(home, "vault", "config.yaml"))).toBe(false);
    const config = readGlobalConfigFrom(home);
    expect(config.auto_create).toBeUndefined();
    expect(bootAutoCreateAllowed(config)).toBe(true);
  });

  test("remove without --yes is a dry-run: no marker, no services change", () => {
    runCli(["create", "solo", "--json"], { PARACHUTE_HOME: home });
    const before = readServices(home).find((s) => s.name === "parachute-vault")!.paths;

    const { exitCode, stdout } = runCli(["remove", "solo"], { PARACHUTE_HOME: home });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("To confirm");

    expect(existsSync(join(home, "vault", "data", "solo"))).toBe(true);
    expect(readGlobalConfigFrom(home).auto_create).toBeUndefined();
    expect(readServices(home).find((s) => s.name === "parachute-vault")!.paths).toEqual(before);
  });
});
