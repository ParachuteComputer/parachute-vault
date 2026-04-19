import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { $ } from "bun";
import { generateWrapper, WRAPPER_PATH } from "./daemon.ts";
import { generatePlist } from "./launchd.ts";

describe("generateWrapper", () => {
  // The incident that triggered this module: start.sh had the server path
  // baked in and went stale when the repo moved. These tests assert the new
  // contract — NO absolute server.ts path in the wrapper, pointer read at
  // runtime, env override respected, and graceful failure when missing.

  test("does not hardcode an absolute server.ts path", () => {
    const wrapper = generateWrapper({
      bunPath: "/Users/alice/.bun/bin/bun",
      serverPathFile: "/Users/alice/.parachute/server-path",
      envPath: "/Users/alice/.parachute/.env",
    });
    // No absolute path ending in server.ts — the whole point. Error messages
    // may legitimately mention "server.ts" in text; we only forbid baked-in
    // absolute paths that would go stale when the repo moves.
    expect(wrapper).not.toMatch(/\/[^\s"]+\/server\.ts/);
  });

  test("reads the pointer file at boot, with PARACHUTE_VAULT_SERVER_PATH override", () => {
    const wrapper = generateWrapper({
      bunPath: "/bin/bun",
      serverPathFile: "/x/.parachute/server-path",
    });
    // Env override precedes the pointer fallback.
    expect(wrapper).toContain('SERVER_PATH="${PARACHUTE_VAULT_SERVER_PATH:-}"');
    expect(wrapper).toContain('[ -f "/x/.parachute/server-path" ]');
    expect(wrapper).toContain('cat "/x/.parachute/server-path"');
  });

  test("fails loudly (non-zero exit) when neither env nor pointer supplies a path", () => {
    const wrapper = generateWrapper({ bunPath: "/bin/bun" });
    expect(wrapper).toContain('if [ -z "$SERVER_PATH" ]; then');
    expect(wrapper).toContain("exit 1");
    // Actionable message — user needs to know what to run.
    expect(wrapper).toMatch(/parachute-vault init/);
  });

  test("fails loudly when pointer target no longer exists (moved repo)", () => {
    const wrapper = generateWrapper({ bunPath: "/bin/bun" });
    expect(wrapper).toContain('if [ ! -f "$SERVER_PATH" ]; then');
    expect(wrapper).toMatch(/repo may have moved/);
  });

  test("sources .env at the configured path", () => {
    const wrapper = generateWrapper({
      bunPath: "/bin/bun",
      envPath: "/custom/.env",
    });
    expect(wrapper).toContain('[ -f "/custom/.env" ]');
    expect(wrapper).toContain('source "/custom/.env"');
  });

  test("execs bun with the resolved path (not a literal server path)", () => {
    const wrapper = generateWrapper({ bunPath: "/Users/alice/.bun/bin/bun" });
    // The exec line uses $SERVER_PATH (dereferenced at boot), not a literal.
    expect(wrapper).toMatch(/exec "\/Users\/alice\/\.bun\/bin\/bun" "\$SERVER_PATH"/);
  });

  test("output is syntactically valid bash (bash -n passes)", async () => {
    // Catch any shell-quoting regressions before they become crash-looping
    // daemons in production. `bash -n` parses without executing.
    const wrapper = generateWrapper({ bunPath: "/bin/bun" });
    const dir = mkdtempSync(join(tmpdir(), "vault-wrapper-"));
    const path = join(dir, "start.sh");
    try {
      writeFileSync(path, wrapper);
      const result = await $`bash -n ${path}`.quiet().nothrow();
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // The incident this guards against (0.2.2): sourcing the user's ~/.zshrc or
  // ~/.zprofile under `set -u` crashes the wrapper if any line in the rc file
  // references an unbound variable — which is routine in zsh plugin frameworks
  // and half-configured setups. The 2>/dev/null redirect swallowed the error
  // so vault.err stayed empty and launchd silently gave up after repeated
  // exit 1s. The fix brackets the profile-source lines with `set +u` / `set -u`
  // so strict-unset-vars only applies to code the wrapper itself owns.
  // ---------------------------------------------------------------------------

  test("brackets profile sourcing with set +u / set -u to survive user rc files", () => {
    const wrapper = generateWrapper({ bunPath: "/bin/bun" });
    // Textual shape check — quickest canary.
    const lines = wrapper.split("\n");
    const zprofileIdx = lines.findIndex((l) => l.includes(".zprofile"));
    const zshrcIdx = lines.findIndex((l) => l.includes(".zshrc"));
    expect(zprofileIdx).toBeGreaterThan(-1);
    expect(zshrcIdx).toBeGreaterThan(-1);
    // Both source lines must be sandwiched between a `set +u` and a `set -u`.
    // Walk back for `set +u` and forward for `set -u` from whichever source
    // line comes first / last so ordering stays flexible.
    const firstIdx = Math.min(zprofileIdx, zshrcIdx);
    const lastIdx = Math.max(zprofileIdx, zshrcIdx);
    const preceding = lines.slice(0, firstIdx).reverse().find((l) => l.trim().startsWith("set "));
    const following = lines.slice(lastIdx + 1).find((l) => l.trim().startsWith("set "));
    expect(preceding?.trim()).toBe("set +u");
    expect(following?.trim()).toBe("set -u");
  });

  test("surviving profile source under set -u: running the generated wrapper with a rc file that trips set -u does not abort before reaching the pointer-file logic", async () => {
    // The integration proof. Build a fake HOME where ~/.zshrc expands an
    // unbound variable ($UNSET_IN_TEST), point the wrapper at it via HOME,
    // and expect the wrapper to exit on the "server path not configured"
    // path (exit 1 from the explicit check) rather than on the zshrc crash
    // (exit 1 from set -u). The signal we compare on is the stderr message:
    // the pointer-missing branch prints a specific error; a set-u crash
    // prints zsh's own "parameter not set" message and no vault-branded
    // text at all.
    //
    // Skipping stderr here would let a regressed wrapper silently exit 1
    // and still pass the test, so we assert on the presence of the
    // pointer-missing message.
    const dir = mkdtempSync(join(tmpdir(), "vault-wrapper-setu-"));
    try {
      const fakeHome = join(dir, "home");
      writeFileSync(join(dir, "mkdir.marker"), ""); // ensure dir exists
      await $`mkdir -p ${fakeHome}`.quiet();
      // A ~/.zshrc that blows up under set -u.
      writeFileSync(join(fakeHome, ".zshrc"), 'echo "$UNSET_IN_TEST"\n');
      // Wrapper with explicit env/pointer paths that do NOT exist. We do not
      // pass PARACHUTE_VAULT_SERVER_PATH either. So the wrapper should take
      // the "no server path configured" branch and exit 1 with the branded
      // message — but only if it survives the zshrc source.
      const wrapper = generateWrapper({
        bunPath: "/bin/echo", // won't be reached; a safe no-op if it is
        serverPathFile: join(dir, "nonexistent-pointer"),
        envPath: join(dir, "nonexistent.env"),
      });
      const path = join(dir, "start.sh");
      writeFileSync(path, wrapper);
      // Override HOME so the wrapper sources our crafted zshrc.
      // Clear PARACHUTE_VAULT_SERVER_PATH in case the test runner has it set.
      const result = await $`HOME=${fakeHome} PARACHUTE_VAULT_SERVER_PATH= bash ${path}`
        .quiet()
        .nothrow();
      const stderr = result.stderr.toString();
      // Positive: we reached the branded pointer-missing branch.
      expect(stderr).toMatch(/parachute-vault: server path not configured/);
      // Negative: we did NOT crash in zshrc with a zsh/bash unbound-variable
      // message. Catches a future regression where someone drops the
      // `set +u` bracket.
      expect(stderr).not.toMatch(/UNSET_IN_TEST: unbound variable/);
      expect(result.exitCode).toBe(1); // the branded branch
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("generatePlist", () => {
  test("references the shared wrapper script, not server.ts directly", () => {
    const plist = generatePlist();
    // The plist launches /bin/bash with the wrapper — it must not name
    // server.ts so the plist stays valid across repo moves.
    expect(plist).toContain(`<string>${WRAPPER_PATH}</string>`);
    expect(plist).not.toMatch(/server\.ts/);
  });
});
