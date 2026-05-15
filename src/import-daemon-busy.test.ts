/**
 * Integration test for vault#323: `parachute-vault import` refuses to run
 * when a daemon is bound to the configured port. The import opens its
 * own bun:sqlite connection; concurrent writers would otherwise trip
 * SQLITE_BUSY mid-replay and leave a partially-imported vault.
 *
 * Pre-flights checkHealth(port) before any DB write; "healthy" or
 * "unhealthy" (port bound, any HTTP response) means the daemon owns the
 * writer lock, so we exit 1 with a clear error pointing at
 * `parachute stop vault`.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resolve } from "path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = resolve(import.meta.dir, "cli.ts");

async function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Async spawn — the daemon-busy probe inside the CLI fetches the test
  // process's stub server, so the parent event loop must keep servicing
  // requests while the child runs. Bun.spawnSync blocks the event loop
  // and the in-test server can't answer, which makes every probe time
  // out into the "not listening" branch.
  const proc = Bun.spawn({
    cmd: ["bun", CLI, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode: exitCode ?? -1, stdout, stderr };
}

let home: string;
let srcDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "import-daemon-busy-"));
  srcDir = mkdtempSync(join(tmpdir(), "import-daemon-busy-src-"));
  // Minimal portable-md export shape so autodetect picks the portable path.
  mkdirSync(join(srcDir, ".parachute"), { recursive: true });
  writeFileSync(
    join(srcDir, ".parachute", "vault.yaml"),
    "name: default\nexport_format_version: 1\n",
  );
  // Minimal vault tree so the "vault not found" guard doesn't short-circuit.
  // PARACHUTE_HOME → <root>/vault/{config.yaml, data/<name>/vault.yaml}.
  mkdirSync(join(home, "vault", "data", "default"), { recursive: true });
  writeFileSync(
    join(home, "vault", "data", "default", "vault.yaml"),
    "name: default\n",
  );
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
});

describe("import daemon-busy guard (vault#323)", () => {
  test("refuses with clear error + exit 1 when a server is bound to the configured port", async () => {
    // Stand up a stub server that responds on /health so checkHealth
    // returns either `healthy` or `unhealthy` — both signal that the
    // port is owned by something. Either case triggers the guard.
    // Bind to 127.0.0.1 explicitly so the subprocess's checkHealth
    // (which probes 127.0.0.1:<port>) hits the same interface.
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(JSON.stringify({ status: "ok" })),
    });
    try {
      mkdirSync(join(home, "vault"), { recursive: true });
      writeFileSync(join(home, "vault", "config.yaml"), `port: ${server.port}\n`);
      const res = await runCli(
        ["import", srcDir, "--vault", "default", "--yes"],
        { PARACHUTE_HOME: home },
      );
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toMatch(/vault daemon is running on port/);
      expect(res.stderr).toMatch(/parachute stop vault/);
    } finally {
      server.stop(true);
    }
  });

  test("proceeds past the guard when nothing is listening on the configured port", async () => {
    // Pick a port nothing's bound to. The daemon-busy message must NOT
    // surface — that's the regression we're pinning.
    const freePort = 1; // privileged, nothing should be listening here from this process
    mkdirSync(join(home, "vault"), { recursive: true });
    writeFileSync(join(home, "vault", "config.yaml"), `port: ${freePort}\n`);
    const res = await runCli(
      ["import", srcDir, "--vault", "default", "--yes"],
      { PARACHUTE_HOME: home },
    );
    expect(res.stderr).not.toMatch(/vault daemon is running on port/);
  });
});
