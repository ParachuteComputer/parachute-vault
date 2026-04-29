/**
 * Integration tests for `parachute-vault create <name> [--json]`.
 *
 * The `--json` mode is the contract the hub orchestrator parses: stdout
 * carries a single JSON object with name/token/paths/set_as_default. These
 * tests spawn the CLI in a temp `PARACHUTE_HOME` so the create lands on a
 * fresh, isolated vault tree and we can assert the on-disk artifacts the
 * payload claims to have written.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resolve } from "path";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = resolve(import.meta.dir, "cli.ts");

function runCli(
  args: string[],
  env: Record<string, string>,
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: ["bun", CLI, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "vault-create-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("vault create --json", () => {
  test("emits parseable JSON with name, token, paths, set_as_default=true on first vault", () => {
    const { exitCode, stdout, stderr } = runCli(
      ["create", "myvault", "--json"],
      { PARACHUTE_HOME: home },
    );
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");

    // stdout must be exactly one JSON object — single-line, parseable.
    // Asserting line count first so a regression that prints a banner above
    // the JSON fails with "expected 1 line, got 2" rather than the much
    // less actionable "JSON parse error".
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!);
    expect(payload.name).toBe("myvault");
    expect(payload.token).toMatch(/^pvt_/);
    expect(payload.set_as_default).toBe(true);
    expect(payload.paths.vault_dir).toBe(join(home, "vault", "data", "myvault"));
    expect(payload.paths.vault_db).toBe(join(home, "vault", "data", "myvault", "vault.db"));
    expect(payload.paths.vault_config).toBe(join(home, "vault", "data", "myvault", "vault.yaml"));

    // Sanity: the on-disk artifacts the payload describes actually exist.
    expect(existsSync(payload.paths.vault_dir)).toBe(true);
    expect(existsSync(payload.paths.vault_db)).toBe(true);
    expect(existsSync(payload.paths.vault_config)).toBe(true);
  });

  test("set_as_default=false when another vault already holds the default slot", () => {
    runCli(["create", "first", "--json"], { PARACHUTE_HOME: home });
    const { exitCode, stdout } = runCli(
      ["create", "second", "--json"],
      { PARACHUTE_HOME: home },
    );
    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.name).toBe("second");
    expect(payload.set_as_default).toBe(false);
  });

  test("--json works regardless of flag position (before or after name)", () => {
    const { exitCode, stdout } = runCli(
      ["create", "--json", "before"],
      { PARACHUTE_HOME: home },
    );
    expect(exitCode).toBe(0);
    const payload = JSON.parse(stdout.trim());
    expect(payload.name).toBe("before");
  });

  test("invalid name in --json mode still errors on stderr (not stdout) and exits non-zero", () => {
    const { exitCode, stdout, stderr } = runCli(
      ["create", "Bad Name", "--json"],
      { PARACHUTE_HOME: home },
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("letters, numbers");
  });

  test("duplicate name in --json mode errors on stderr and exits non-zero", () => {
    runCli(["create", "dup", "--json"], { PARACHUTE_HOME: home });
    const { exitCode, stdout, stderr } = runCli(
      ["create", "dup", "--json"],
      { PARACHUTE_HOME: home },
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("already exists");
  });
});

/**
 * Regression tests for #208: `vault create` was not updating
 * `~/.parachute/services.json`, so vaults created after init were invisible
 * to the hub well-known endpoint and to paraclaw's attach picker. cmdCreate
 * now re-registers the parachute-vault entry with the full vault list every
 * time. The default vault must sort first because the hub uses `paths[0]`
 * as the canonical mount for `.well-known/parachute.json`.
 */
describe("vault create — services.json registration (#208)", () => {
  function readServices(): { name: string; paths: string[]; port: number }[] {
    const raw = readFileSync(join(home, "services.json"), "utf-8");
    return JSON.parse(raw).services;
  }

  test("create-first-vault registers parachute-vault entry with /vault/<name>", () => {
    const { exitCode } = runCli(["create", "first", "--json"], {
      PARACHUTE_HOME: home,
    });
    expect(exitCode).toBe(0);

    const services = readServices();
    const vault = services.find((s) => s.name === "parachute-vault");
    expect(vault).toBeDefined();
    expect(vault!.paths).toEqual(["/vault/first"]);
  });

  test("create-additional-vault grows the paths array (default stays first)", () => {
    runCli(["create", "alpha", "--json"], { PARACHUTE_HOME: home });
    runCli(["create", "beta", "--json"], { PARACHUTE_HOME: home });

    const vault = readServices().find((s) => s.name === "parachute-vault");
    expect(vault).toBeDefined();
    // alpha is the default (created first), so it must lead. beta follows.
    expect(vault!.paths).toEqual(["/vault/alpha", "/vault/beta"]);
  });

  test("create-multiple preserves default-first ordering across N vaults", () => {
    runCli(["create", "one", "--json"], { PARACHUTE_HOME: home });
    runCli(["create", "two", "--json"], { PARACHUTE_HOME: home });
    runCli(["create", "three", "--json"], { PARACHUTE_HOME: home });

    const vault = readServices().find((s) => s.name === "parachute-vault");
    expect(vault).toBeDefined();
    expect(vault!.paths[0]).toBe("/vault/one");
    expect(vault!.paths.slice(1).sort()).toEqual([
      "/vault/three",
      "/vault/two",
    ]);
    expect(vault!.paths).toHaveLength(3);
  });

  test("--json mode keeps stdout parseable even when services.json is updated", () => {
    // Regression guard: warnings from upsertService must go to stderr, not
    // stdout — otherwise the hub orchestrator's JSON.parse(stdout) breaks.
    const { stdout } = runCli(["create", "clean", "--json"], {
      PARACHUTE_HOME: home,
    });
    expect(() => JSON.parse(stdout.trim())).not.toThrow();
  });
});

describe("vault create (human mode unchanged)", () => {
  test("prints multi-line human output without --json", () => {
    const { exitCode, stdout } = runCli(
      ["create", "human"],
      { PARACHUTE_HOME: home },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Vault "human" created.');
    expect(stdout).toContain("API token:");
    expect(stdout).toContain("Save this");
    // Human output should NOT be valid JSON.
    expect(() => JSON.parse(stdout.trim())).toThrow();
  });
});
