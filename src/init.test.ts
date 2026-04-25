/**
 * Integration tests for `parachute-vault init` flag plumbing — the cases
 * where init exits early without touching the daemon, ~/.claude.json, or
 * the vault filesystem. The full happy-path of init isn't run here because
 * it would install a launchd agent on macOS and write into the developer's
 * real ~/Library/LaunchAgents — out of scope for unit tests. The vault-name
 * decision logic is fully covered by `vault-name.test.ts`.
 */

import { describe, test, expect } from "bun:test";
import { resolve } from "path";

const CLI = resolve(import.meta.dir, "cli.ts");

function runCli(args: string[]): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const proc = Bun.spawnSync({
    cmd: ["bun", CLI, ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

describe("vault init — --vault-name validation", () => {
  test("rejects --vault-name with uppercase + space and exits non-zero", () => {
    const { exitCode, stderr } = runCli(["init", "--vault-name", "My Vault"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("--vault-name:");
    expect(stderr).toContain("lowercase alphanumeric");
  });

  test("rejects --vault-name with a slash and exits non-zero", () => {
    const { exitCode, stderr } = runCli(["init", "--vault-name", "team/work"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("lowercase alphanumeric");
  });

  test("rejects --vault-name with no value and exits non-zero", () => {
    // `--vault-name` is the last arg → no value follows.
    const { exitCode, stderr } = runCli(["init", "--vault-name"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("requires a value");
  });

  test("rejects reserved name 'list' and exits non-zero", () => {
    const { exitCode, stderr } = runCli(["init", "--vault-name", "list"]);
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("reserved");
  });
});

describe("vault init — --help mentions --vault-name", () => {
  test("usage text documents the new flag", () => {
    const { exitCode, stdout } = runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("--vault-name");
  });
});
