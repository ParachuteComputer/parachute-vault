/**
 * Integration test for `parachute-vault stop` — exercises the filesystem
 * sentinel handshake end-to-end: spawn server → write sentinel → confirm
 * the server exits cleanly. Closes #100.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, existsSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { stopSignalPath } from "./config.ts";
import { waitForHealthy, checkHealth } from "./health.ts";

const SERVER_PATH = resolve(import.meta.dir, "server.ts");

// Pick a port unlikely to clash with the developer's running daemon (1940)
// or the typical hub/scribe range.
const TEST_PORT = 19_404;

let tmpHome: string;
let originalHome: string | undefined;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "vault-stop-test-"));
  mkdirSync(join(tmpHome, "vault"), { recursive: true });
  originalHome = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = tmpHome;
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("graceful shutdown via stop.signal (#100)", () => {
  test("stopSignalPath resolves under PARACHUTE_HOME", () => {
    expect(stopSignalPath()).toBe(join(tmpHome, "vault", "stop.signal"));
  });

  test("server clears a stale sentinel at startup, then exits when one is written", async () => {
    // Pre-populate a stale sentinel — the server should clear it on boot
    // rather than treating it as a fresh shutdown request.
    writeFileSync(stopSignalPath(), "stale\n");
    expect(existsSync(stopSignalPath())).toBe(true);

    const proc = Bun.spawn({
      cmd: ["bun", SERVER_PATH],
      env: {
        ...process.env,
        PARACHUTE_HOME: tmpHome,
        PORT: String(TEST_PORT),
        // Avoid the transcription worker spinning up + adding shutdown latency.
        SCRIBE_URL: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const health = await waitForHealthy(TEST_PORT, { totalMs: 10_000 });
      expect(health.status).toBe("healthy");
      expect(existsSync(stopSignalPath())).toBe(false); // stale cleared

      writeFileSync(stopSignalPath(), `${new Date().toISOString()}\n`);

      const exitCode = await Promise.race([
        proc.exited,
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error("server did not exit within 5s")), 5_000),
        ),
      ]);
      expect(exitCode).toBe(0);

      // Server should also have removed the sentinel as it processed it.
      expect(existsSync(stopSignalPath())).toBe(false);

      // And the port is no longer accepting connections.
      const after = await checkHealth(TEST_PORT);
      expect(["not-listening", "error"]).toContain(after.status);
    } finally {
      if (!proc.killed) proc.kill();
    }
  }, 20_000);
});
