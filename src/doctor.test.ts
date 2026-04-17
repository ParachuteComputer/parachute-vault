/**
 * Integration tests for `parachute vault doctor` and `parachute vault url`.
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

function runCli(args: string[], parachuteHome: string): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: ["bun", CLI, ...args],
    env: { ...process.env, PARACHUTE_HOME: parachuteHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
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
    expect(res.stdout).toMatch(/parachute vault init/);
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
