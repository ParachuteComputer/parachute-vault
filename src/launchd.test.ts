import { describe, test, expect } from "bun:test";
import { generateWrapper } from "./daemon.ts";
import { generatePlist } from "./launchd.ts";
import { WRAPPER_PATH } from "./daemon.ts";

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
    expect(wrapper).toMatch(/parachute vault init/);
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
