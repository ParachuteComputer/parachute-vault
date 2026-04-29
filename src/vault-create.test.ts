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
import { mkdtempSync, rmSync, existsSync } from "fs";
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
