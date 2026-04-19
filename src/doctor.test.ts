/**
 * Integration tests for `parachute-vault doctor` and `parachute-vault url`.
 *
 * We spawn the CLI as a subprocess with `PARACHUTE_HOME` pointed at a
 * fresh tempdir — so each test exercises the real code path (config +
 * daemon path resolution + exit codes) against a known filesystem state.
 * This catches wiring bugs that pure-function tests can't (e.g., a
 * missing import or a broken switch case).
 *
 * We deliberately avoid asserting on daemon-manager check output — that
 * depends on the host machine's live launchctl/systemd state and isn't
 * part of the PR's contract.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";

const CLI = resolve(import.meta.dir, "cli.ts");

/**
 * Run the CLI as a subprocess. `parachuteHome` is always passed as the
 * isolated config dir; `extraEnv` is merged last so tests can override
 * `HOME` (for the `~/.claude.json` MCP-entry checks) or unset `PATH`
 * (for the bun-on-PATH check) without affecting unrelated tests.
 */
function runCli(
  args: string[],
  parachuteHome: string,
  extraEnv: Record<string, string | undefined> = {},
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: ["bun", CLI, ...args],
    env: { ...process.env, PARACHUTE_HOME: parachuteHome, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

/**
 * Write a minimal ~/.claude.json with the given vault MCP URL. Returns the
 * full path. Used by the MCP-entry-present tests.
 */
function writeClaudeJson(home: string, url: string): string {
  const path = join(home, ".claude.json");
  writeFileSync(
    path,
    JSON.stringify(
      { mcpServers: { "parachute-vault": { type: "http", url } } },
      null,
      2,
    ),
  );
  return path;
}

describe("vault doctor", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-doctor-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("fails with a clear message when the pointer file is missing", () => {
    const res = runCli(["doctor"], dir);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toMatch(/server-path pointer/);
    expect(res.stdout).toMatch(/missing/);
    expect(res.stdout).toMatch(/parachute-vault init/);
  });

  test("fails when the pointer targets a non-existent file (moved repo)", () => {
    writeFileSync(join(dir, "server-path"), "/does/not/exist/server.ts\n");
    writeFileSync(join(dir, "start.sh"), "#!/bin/bash\n");
    const res = runCli(["doctor"], dir);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toMatch(/points to/);
    expect(res.stdout).toMatch(/repo location|init/i);
  });

  test("passes the pointer check when the target exists", () => {
    // Use the CLI file itself as a stand-in existing target — it is
    // guaranteed to exist since we just spawned bun with it.
    writeFileSync(join(dir, "server-path"), CLI + "\n");
    writeFileSync(join(dir, "start.sh"), "#!/bin/bash\n");
    const res = runCli(["doctor"], dir);
    expect(res.stdout).toMatch(/✓ server-path pointer/);
    expect(res.stdout).toMatch(/✓ wrapper script/);
  });
});

/**
 * Extended doctor checks: bun-on-PATH, MCP entry presence + port match +
 * reachability, and port-collision detection. All tests use an isolated
 * HOME (so the user's real ~/.claude.json isn't consulted) and an isolated
 * PARACHUTE_HOME, so they're reproducible on any machine.
 *
 * We intentionally do NOT test the "held by our daemon" (ours) branch of
 * the port-collision check: it requires running a process whose cmdline
 * contains our server.ts path, and we have no hook to fake that without
 * spawning the real server. The foreign branch exercises the collision
 * detection path end-to-end, which is what actually matters for warning
 * OSS users; the ours branch is covered by the unit-level fact that
 * `describeProcess` runs `ps` against the PID lsof returns.
 */
describe("vault doctor — extended checks", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-doctor-ext-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("reports bun on PATH when `bun` is resolvable", () => {
    // The test harness itself runs under bun, so bun is guaranteed to be
    // on PATH here. This confirms the happy path renders correctly.
    const res = runCli(["doctor"], dir, { HOME: dir });
    expect(res.stdout).toMatch(/✓ bun on PATH/);
  });

  test("warns when `bun` is not on PATH", () => {
    // We need two things at once:
    //   a) the child's PATH must NOT resolve `bun` (so the doctor check fails)
    //   b) we still need to launch the child under bun (so the test runs)
    // Solution: launch the child via bun's absolute path directly, and set
    // its PATH to an empty tempdir. `Bun.spawnSync`'s cmd[0] with an
    // absolute path bypasses PATH lookup entirely.
    const bunAbs = process.execPath; // the bun executable running this test
    const emptyPathDir = mkdtempSync(join(tmpdir(), "empty-path-"));
    try {
      const proc = Bun.spawnSync({
        cmd: [bunAbs, CLI, "doctor"],
        env: { ...process.env, PARACHUTE_HOME: dir, HOME: dir, PATH: emptyPathDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = new TextDecoder().decode(proc.stdout);
      expect(stdout).toMatch(/! bun on PATH/);
      expect(stdout).toMatch(/not resolvable/);
      expect(stdout).toMatch(/bun\.sh\/install/);
    } finally {
      rmSync(emptyPathDir, { recursive: true, force: true });
    }
  });

  test("warns when ~/.claude.json has no parachute-vault MCP entry", () => {
    // Isolated HOME with no ~/.claude.json at all — the most common
    // pre-`mcp-install` state for new users.
    const res = runCli(["doctor"], dir, { HOME: dir });
    expect(res.stdout).toMatch(/! MCP entry in ~\/\.claude\.json/);
    expect(res.stdout).toMatch(/does not exist|no mcpServers/);
    expect(res.stdout).toMatch(/mcp-install/);
  });

  test("warns when ~/.claude.json exists but has no parachute-vault entry", () => {
    writeFileSync(join(dir, ".claude.json"), JSON.stringify({ mcpServers: {} }));
    const res = runCli(["doctor"], dir, { HOME: dir });
    expect(res.stdout).toMatch(/! MCP entry in ~\/\.claude\.json/);
    expect(res.stdout).toMatch(/no mcpServers\["parachute-vault"\] entry/);
  });

  test("passes MCP entry + port-match checks when URL points at the configured port", () => {
    // Use a non-default port to prove we're actually reading config.yaml,
    // not just matching against DEFAULT_PORT.
    writeFileSync(join(dir, "config.yaml"), "port: 4321\n");
    writeClaudeJson(dir, "http://127.0.0.1:4321/vaults/default/mcp");
    const res = runCli(["doctor"], dir, { HOME: dir });
    expect(res.stdout).toMatch(/✓ MCP entry in ~\/\.claude\.json/);
    expect(res.stdout).toMatch(/✓ MCP URL port matches vault\s+\(port 4321\)/);
    // Reachability will warn because nothing is bound to 4321 in the test
    // env — this is the "entry present, port matches, daemon unreachable"
    // state the handoff explicitly called out as useful to surface.
    expect(res.stdout).toMatch(/! MCP URL reachable/);
  });

  test("warns when MCP URL port does not match the vault's configured port", () => {
    writeFileSync(join(dir, "config.yaml"), "port: 4321\n");
    writeClaudeJson(dir, "http://127.0.0.1:9999/vaults/default/mcp");
    const res = runCli(["doctor"], dir, { HOME: dir });
    expect(res.stdout).toMatch(/✓ MCP entry in ~\/\.claude\.json/);
    expect(res.stdout).toMatch(/! MCP URL port matches vault/);
    expect(res.stdout).toMatch(/MCP URL port 9999 ≠ vault port 4321/);
  });

  test("warns when the configured port is held by an unrelated process", async () => {
    // Find a free port, bind to it with a plain Bun.serve that has nothing
    // to do with our server.ts — so the collision check will classify it
    // as foreign. Using port 0 gets the OS to pick; we then write that
    // port into config.yaml and let doctor discover the clash.
    const server = Bun.serve({ port: 0, fetch: () => new Response("other") });
    try {
      const port = server.port;
      writeFileSync(join(dir, "config.yaml"), `port: ${port}\n`);
      const res = runCli(["doctor"], dir, { HOME: dir });
      // The rendered name includes the port number, so match loosely.
      expect(res.stdout).toMatch(new RegExp(`! port ${port} availability`));
      expect(res.stdout).toMatch(/port in use by non-vault process/);
    } finally {
      server.stop(true);
    }
  });

  test("reports port as free when nothing is bound to it", () => {
    // Hardcoded ports are a portability trap — e.g. OrbStack grabs 54321
    // on macOS, which would spuriously trip the foreign branch. Instead,
    // ask the OS for a free port (bind to 0, then release) and point
    // doctor at that port. The race window between stop() and doctor's
    // lsof is tiny; for the stability of this test we accept it as the
    // best available cross-platform "free-ish port" signal.
    const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = probe.port;
    probe.stop(true);
    writeFileSync(join(dir, "config.yaml"), `port: ${port}\n`);
    const res = runCli(["doctor"], dir, { HOME: dir });
    expect(res.stdout).toMatch(new RegExp(`✓ port ${port} availability`));
    expect(res.stdout).toMatch(/no listener \(ready to bind\)/);
  });
});

describe("vault uninstall", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-uninstall-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("--yes --wipe removes user data non-interactively", async () => {
    // Scripted uninstall contract. --yes is an explicit opt-in to the
    // destructive path — skipping the interactive guard is the whole
    // point. We keep this behavior, but the help text warns.
    // Note: this test exercises filesystem wipe only. It still invokes
    // uninstallAgent(), which is safe because launchd.ts wraps each
    // step in try/catch and we're on a tempdir that was never registered.
    const vaultsDir = join(dir, "vaults");
    const envFile = join(dir, ".env");
    mkdirSync(vaultsDir, { recursive: true });
    writeFileSync(join(vaultsDir, "marker"), "doomed");
    writeFileSync(envFile, "PORT=1940\n");

    const res = runCli(["uninstall", "--yes", "--wipe"], dir);
    expect(res.exitCode).toBe(0);

    const { existsSync } = await import("fs");
    expect(existsSync(vaultsDir)).toBe(false);
    expect(existsSync(envFile)).toBe(false);
  });

  test("--yes --wipe removes config.yaml and daemon logs alongside vaults + .env", async () => {
    // Regression: the help text advertised "vaults + .env" but config.yaml,
    // vault.log, and vault.err were being left behind. `uninstall --wipe`
    // should fully reset ~/.parachute, or the next `init` picks up stale
    // state (in particular a stale config.yaml port). Keep this test in
    // sync with the path list in cmdUninstall and the usage help.
    const vaultsDir = join(dir, "vaults");
    const envFile = join(dir, ".env");
    const configYaml = join(dir, "config.yaml");
    const logFile = join(dir, "vault.log");
    const errFile = join(dir, "vault.err");
    mkdirSync(vaultsDir, { recursive: true });
    writeFileSync(join(vaultsDir, "marker"), "doomed");
    writeFileSync(envFile, "PORT=1940\n");
    writeFileSync(configYaml, "port: 1940\n");
    writeFileSync(logFile, "some log\n");
    writeFileSync(errFile, "some err\n");

    const res = runCli(["uninstall", "--yes", "--wipe"], dir);
    expect(res.exitCode).toBe(0);

    const { existsSync } = await import("fs");
    expect(existsSync(vaultsDir)).toBe(false);
    expect(existsSync(envFile)).toBe(false);
    expect(existsSync(configYaml)).toBe(false);
    expect(existsSync(logFile)).toBe(false);
    expect(existsSync(errFile)).toBe(false);
  });

  test("--yes --wipe prints a destructive-wipe audit line before acting", async () => {
    // `--yes --wipe` bypasses both interactive confirms. It must not be
    // silent: a scripted uninstaller should leave one grep-able line in
    // stdout documenting the destructive run (ISO timestamp + target paths).
    writeFileSync(join(dir, ".env"), "PORT=1940\n");

    const res = runCli(["uninstall", "--yes", "--wipe"], dir);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/scripted destructive wipe/);
    // ISO-8601 timestamp shape (year-month-dayTtime). Loose enough to
    // avoid flaking on sub-second precision differences.
    expect(res.stdout).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // Targets should be enumerated by path.
    expect(res.stdout).toMatch(/vaults/);
    expect(res.stdout).toMatch(/\.env/);
    expect(res.stdout).toMatch(/config\.yaml/);
  });

  test("answering 'no' at the prompt does not touch daemon/filesystem", async () => {
    // Set up a fake install: wrapper + pointer in the temp PARACHUTE_HOME.
    const wrapper = join(dir, "start.sh");
    const pointer = join(dir, "server-path");
    writeFileSync(wrapper, "#!/bin/bash\n");
    writeFileSync(pointer, "/tmp/fake.ts\n");

    const proc = Bun.spawn({
      cmd: ["bun", CLI, "uninstall"],
      env: { ...process.env, PARACHUTE_HOME: dir },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write("n\n");
    await proc.stdin.end();
    const exitCode = await proc.exited;
    const out = await new Response(proc.stdout).text();

    expect(exitCode).toBe(0);
    expect(out).toMatch(/Cancelled/);
    // Files should still exist — the bail-out must happen before any
    // destructive op.
    const { existsSync } = await import("fs");
    expect(existsSync(wrapper)).toBe(true);
    expect(existsSync(pointer)).toBe(true);
  });
});

describe("vault url", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-url-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("prints the default URL when no port is configured", () => {
    const res = runCli(["url"], dir);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("http://127.0.0.1:1940");
  });

  test("reflects a custom port from config.yaml", () => {
    writeFileSync(join(dir, "config.yaml"), "port: 9999\n");
    const res = runCli(["url"], dir);
    expect(res.exitCode).toBe(0);
    expect(res.stdout.trim()).toBe("http://127.0.0.1:9999");
  });
});
