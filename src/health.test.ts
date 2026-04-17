import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { checkHealth, waitForHealthy, tailFile } from "./health.ts";

// ---------------------------------------------------------------------------
// checkHealth — uses a real Bun.serve on a free port so we exercise the
// fetch + abort plumbing rather than mocking it. The three reachable status
// codes (200, non-200, closed) are what the CLI needs to distinguish.
// ---------------------------------------------------------------------------

describe("checkHealth", () => {
  test("returns healthy when /health returns 200", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(JSON.stringify({ status: "ok" })),
    });
    try {
      const res = await checkHealth(server.port);
      expect(res.status).toBe("healthy");
      expect(res.statusCode).toBe(200);
      expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      server.stop(true);
    }
  });

  test("returns unhealthy when /health returns non-2xx", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("bad", { status: 503 }),
    });
    try {
      const res = await checkHealth(server.port);
      expect(res.status).toBe("unhealthy");
      expect(res.statusCode).toBe(503);
    } finally {
      server.stop(true);
    }
  });

  test("returns not-listening when no server is bound", async () => {
    // Bind, capture port, stop — then probe. The OS won't hand the port to
    // another process instantly, so this reliably produces ECONNREFUSED.
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = server.port;
    server.stop(true);
    const res = await checkHealth(port, 500);
    expect(res.status).toBe("not-listening");
  });

  test("returns error with timeout message when the server hangs longer than timeoutMs", async () => {
    const server = Bun.serve({
      port: 0,
      // Never respond — force the probe to abort.
      fetch: () => new Promise<Response>(() => {}),
    });
    try {
      const res = await checkHealth(server.port, 150);
      expect(res.status).toBe("error");
      expect(res.error).toMatch(/timeout/i);
    } finally {
      server.stop(true);
    }
  });
});

// ---------------------------------------------------------------------------
// waitForHealthy — the thing the CLI's `restart` polling depends on.
// ---------------------------------------------------------------------------

describe("waitForHealthy", () => {
  test("resolves on first-try healthy response", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      const res = await waitForHealthy(server.port, { totalMs: 500, intervalMs: 50 });
      expect(res.status).toBe("healthy");
    } finally {
      server.stop(true);
    }
  });

  test("gives up after totalMs budget when nothing listens", async () => {
    // Grab a port, close it, then wait — should return not-listening promptly
    // after the budget expires.
    const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = s.port;
    s.stop(true);

    const start = Date.now();
    const res = await waitForHealthy(port, { totalMs: 400, intervalMs: 100, perProbeTimeoutMs: 100 });
    const elapsed = Date.now() - start;
    expect(res.status).not.toBe("healthy");
    // Polling should respect the total budget — allow slack for scheduling.
    expect(elapsed).toBeLessThan(2000);
  });

  test("eventually succeeds when server comes up mid-poll", async () => {
    // Pick an OS-assigned port, free it so probes start as ECONNREFUSED,
    // then bring a server up on the SAME port partway through the budget.
    // That's the scenario cmdRestart depends on: launchctl has bounced the
    // daemon, early probes hit a closed port, a later probe succeeds.
    const first = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = first.port;
    first.stop(true);

    let second: ReturnType<typeof Bun.serve> | null = null;
    const serverPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        // Small retry loop — OSes sometimes need a beat to release the port.
        for (let i = 0; i < 10; i++) {
          try {
            second = Bun.serve({ port, fetch: () => new Response("ok") });
            break;
          } catch {
            Bun.sleepSync(20);
          }
        }
        resolve();
      }, 250);
    });

    try {
      const pollPromise = waitForHealthy(port, {
        totalMs: 2000,
        intervalMs: 100,
        perProbeTimeoutMs: 200,
      });
      await serverPromise;
      const res = await pollPromise;
      expect(res.status).toBe("healthy");
    } finally {
      (second as any)?.stop?.(true);
    }
  });

  test("caps per-probe timeout at remaining budget (total wait stays under totalMs + slack)", async () => {
    // Probe against a closed port with an intentionally oversized per-probe
    // timeout. Without the cap, the loop could blow past totalMs waiting
    // for one probe's timeout to fire. With the cap, the total wall time
    // stays close to totalMs.
    const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    const port = s.port;
    s.stop(true);

    const start = Date.now();
    const res = await waitForHealthy(port, {
      totalMs: 300,
      intervalMs: 1000,
      perProbeTimeoutMs: 5000,
    });
    const elapsed = Date.now() - start;
    expect(res.status).not.toBe("healthy");
    expect(elapsed).toBeLessThan(1500);
  });
});

// ---------------------------------------------------------------------------
// tailFile
// ---------------------------------------------------------------------------

describe("tailFile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-tail-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns last n lines of a multi-line file", () => {
    const p = join(dir, "err.log");
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    writeFileSync(p, lines.join("\n") + "\n");
    const tail = tailFile(p, 5);
    expect(tail).toBe("line 46\nline 47\nline 48\nline 49\nline 50");
  });

  test("returns all lines when n exceeds file length", () => {
    const p = join(dir, "err.log");
    writeFileSync(p, "one\ntwo\nthree\n");
    expect(tailFile(p, 100)).toBe("one\ntwo\nthree");
  });

  test("returns null when file doesn't exist", () => {
    expect(tailFile(join(dir, "nope.log"), 10)).toBeNull();
  });

  test("returns empty string for empty file", () => {
    const p = join(dir, "empty.log");
    writeFileSync(p, "");
    expect(tailFile(p, 10)).toBe("");
  });

  test("handles file without trailing newline", () => {
    const p = join(dir, "no-trailing.log");
    writeFileSync(p, "a\nb\nc");
    expect(tailFile(p, 2)).toBe("b\nc");
  });
});
