/**
 * Integration tests for `parachute --version` and its aliases.
 *
 * Spawns the real CLI as a subprocess so the argv-dispatch path is exercised
 * end-to-end. Every accepted spelling must produce the exact version string
 * from package.json on stdout, with exit code 0, and nothing else.
 */

import { describe, test, expect } from "bun:test";
import { resolve } from "path";
import pkg from "../package.json" with { type: "json" };

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

describe("parachute version", () => {
  // Every spelling must print the package's version and nothing else.
  // `parachute-vault --version` works via the argv parser's existing
  // `args[0] === "vault"` branch, which shifts "vault" off and treats
  // `--version` as the command — so the same switch case handles both
  // root and vault-prefixed invocations.
  for (const form of [
    ["--version"],
    ["-v"],
    ["version"],
    ["vault", "--version"],
    ["vault", "-v"],
    ["vault", "version"],
  ]) {
    test(`parachute ${form.join(" ")} prints the package version`, () => {
      const { exitCode, stdout, stderr } = runCli(form);
      expect(exitCode).toBe(0);
      // Exact match — no banner, no trailing whitespace other than the single
      // trailing newline from console.log. Scripts will pipe this through
      // things like `$(parachute --version)`.
      expect(stdout).toBe(`${pkg.version}\n`);
      // Stderr must be empty. If the dispatcher drops into the default branch
      // it would print "Unknown command:" plus the full usage() block to
      // stderr, which is exactly the regression this test catches.
      expect(stderr).toBe("");
    });
  }

  test("version string looks like semver (sanity check)", () => {
    // Defense-in-depth: if someone ever replaces the JSON import with a
    // hardcoded string, a malformed value still won't slip through.
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/);
  });
});
