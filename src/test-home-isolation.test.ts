/**
 * The suite must never write into a live Parachute install.
 *
 * On 2026-08-22 it did: two `bun test` runs created ~158 real vault
 * directories under `~/.parachute/vault/data/` on a developer box —
 * `tagscope-*`, `mint-*`, `retier-*`, `ledger-*`, and a `solo` vault from the
 * mirror-routes tests. `core/src/test-preload.ts` existed and was loaded; it
 * simply declined to act, because it only assigned PARACHUTE_HOME when the
 * variable was *unset*, and the box's shell profile exported
 * `PARACHUTE_HOME="$HOME/.parachute"`. The isolation was conditional on the
 * one condition that mattered being false.
 *
 * These tests pin both layers of the fix:
 *   1. the preload overrides an inherited PARACHUTE_HOME unconditionally
 *   2. `configDirPath()` refuses the `~/.parachute` fallback under
 *      NODE_ENV=test, so a run that never loaded the preload (wrong cwd →
 *      bunfig.toml not found) fails loudly instead of writing real vaults
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";

import { runSubprocess } from "./test-support/spawn.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");

describe("test-home isolation", () => {
  test("this very process is not pointed at the real ~/.parachute", () => {
    // The in-process invariant. If the preload stops loading, or stops
    // overriding, this is the first thing that fails.
    const real = join(homedir(), ".parachute");
    expect(process.env.PARACHUTE_HOME).toBeTruthy();
    expect(process.env.PARACHUTE_HOME).not.toBe(real);
  });

  test("the preload overrides an inherited PARACHUTE_HOME rather than deferring to it", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "test-home-isolation-"));
    try {
      // Stand in for the live install: a HOME whose `.parachute` we watch, and
      // the exported PARACHUTE_HOME a login shell would hand `bun test`. This
      // is the exact shape of the 2026-08-22 environment.
      const inherited = join(sandbox, ".parachute");
      const probe = join(sandbox, "probe.test.ts");
      await Bun.write(
        probe,
        [
          `import { test } from "bun:test";`,
          `import { writeVaultConfig } from ${JSON.stringify(join(REPO_ROOT, "src/config.ts"))};`,
          `import { getVaultStore, closeAllStores } from ${JSON.stringify(join(REPO_ROOT, "src/vault-store.ts"))};`,
          `test("writes a vault wherever config.ts points", async () => {`,
          `  console.log("RESOLVED_HOME=" + process.env.PARACHUTE_HOME);`,
          `  writeVaultConfig({ name: "isolation-probe", api_keys: [], created_at: new Date().toISOString() });`,
          `  getVaultStore("isolation-probe");`,
          `  closeAllStores();`,
          `});`,
        ].join("\n"),
      );

      // cwd = repo root so bunfig.toml's `[test] preload` applies, which is
      // the normal way the suite runs.
      const res = await runSubprocess({
        cmd: ["bun", "test", probe],
        cwd: REPO_ROOT,
        env: { HOME: sandbox, PARACHUTE_HOME: inherited },
      });

      const out = res.stdout + res.stderr;
      // Assert the child actually got as far as writing a vault — without
      // this, a child that crashed on startup would satisfy every "nothing
      // landed in the live install" assertion below for the wrong reason.
      expect(res.exitCode).toBe(0);
      expect(out).not.toContain(`RESOLVED_HOME=${inherited}`);
      expect(out).toContain("RESOLVED_HOME=");
      // The load-bearing assertion: nothing landed in the "live" install.
      expect(existsSync(join(inherited, "vault", "data", "isolation-probe"))).toBe(false);
      expect(existsSync(inherited)).toBe(false);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  test("runSubprocess propagates the live PARACHUTE_HOME to the child", async () => {
    // Bun gives a child the environ the parent *started* with, not the live
    // `process.env` — so the preload's runtime assignment is invisible to any
    // child spawned without an explicit env, and that child resolves its home
    // to the real ~/.parachute. `runSubprocess` spreads `process.env`, which
    // is the only reason CLI tests are safe; pin it.
    const res = await runSubprocess({
      cmd: ["bun", "-e", `console.log("CHILD_PH=" + process.env.PARACHUTE_HOME)`],
      cwd: REPO_ROOT,
    });
    expect(res.stdout.trim()).toBe(`CHILD_PH=${process.env.PARACHUTE_HOME}`);
    expect(res.stdout).not.toContain(`CHILD_PH=${join(homedir(), ".parachute")}`);
    expect(res.stdout).not.toContain("CHILD_PH=undefined");
  });

  test("configDirPath() refuses the ~/.parachute fallback under NODE_ENV=test", async () => {
    // Simulates the other way the isolation can be lost: the preload never
    // loads (bunfig.toml is resolved from the cwd, so running the suite by
    // path from a parent directory skips it) and PARACHUTE_HOME is unset.
    const res = await runSubprocess({
      cmd: [
        "bun",
        "-e",
        `const { vaultDir } = await import(${JSON.stringify(join(REPO_ROOT, "src/config.ts"))}); console.log(vaultDir("x"));`,
      ],
      cwd: REPO_ROOT,
      env: { PARACHUTE_HOME: undefined, NODE_ENV: "test" },
    });

    const out = res.stdout + res.stderr;
    expect(res.exitCode).not.toBe(0);
    expect(out).toContain("refusing to default to the live install");
    // The message has to be actionable for an npm consumer whose test runner
    // set NODE_ENV=test, not just for a contributor in this repo.
    expect(out).toContain("Set PARACHUTE_HOME explicitly");
  });

  test("configDirPath() still falls back to ~/.parachute outside tests", async () => {
    // The guard is test-only: real installs resolve the home the way they
    // always have.
    const res = await runSubprocess({
      cmd: [
        "bun",
        "-e",
        `const { vaultDir } = await import(${JSON.stringify(join(REPO_ROOT, "src/config.ts"))}); console.log(vaultDir("x"));`,
      ],
      cwd: REPO_ROOT,
      env: { PARACHUTE_HOME: undefined, NODE_ENV: undefined, HOME: "/tmp/not-a-real-home" },
    });

    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe(join("/tmp/not-a-real-home", ".parachute", "vault", "data", "x"));
  });
});
