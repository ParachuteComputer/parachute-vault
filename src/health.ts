/**
 * Healthcheck + error-log helpers for the CLI.
 *
 * Used by `vault status`, `vault restart`, and `vault doctor` to distinguish
 * three distinct failure modes that production wedged us on once already:
 *
 *   1. Launchd says the agent is loaded, but nothing is bound to the port.
 *   2. Something is bound to the port, but /health doesn't return 200.
 *   3. Everything is fine.
 *
 * The original CLI conflated these and reported "running" in cases where
 * start.sh was failing and the daemon was respawning in a crash loop.
 */

import { readFileSync, existsSync } from "fs";

export type HealthStatus =
  | "healthy"         // port bound + /health 200
  | "unhealthy"       // port bound but /health not 200
  | "not-listening"   // port closed (nothing accepting connections)
  | "error";          // other fetch failure

export interface HealthResult {
  status: HealthStatus;
  statusCode?: number;
  error?: string;
  latencyMs?: number;
}

/**
 * Probe http://127.0.0.1:<port>/health once. Short timeout so callers can
 * poll without hanging. Treats ECONNREFUSED as "not listening" explicitly so
 * the CLI can tell "daemon crashed" apart from "daemon running but wedged."
 */
export async function checkHealth(port: number, timeoutMs = 2000): Promise<HealthResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    const latencyMs = Date.now() - start;
    if (resp.ok) {
      return { status: "healthy", statusCode: resp.status, latencyMs };
    }
    return { status: "unhealthy", statusCode: resp.status, latencyMs };
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    const msg = String(err?.message ?? err);
    // Bun surfaces ECONNREFUSED as "Unable to connect" / error code
    // "ConnectionRefused" depending on the version. Also catch DNS failures.
    if (
      /ECONNREFUSED|ConnectionRefused|Unable to connect|refused/i.test(msg) ||
      err?.code === "ECONNREFUSED"
    ) {
      return { status: "not-listening", error: msg, latencyMs };
    }
    if (err?.name === "AbortError" || /aborted|timeout/i.test(msg)) {
      return { status: "error", error: `timeout after ${timeoutMs}ms`, latencyMs };
    }
    return { status: "error", error: msg, latencyMs };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll /health until it returns healthy or the overall budget expires.
 * Used by `vault restart` to turn a fire-and-forget launchctl bounce into a
 * blocking operation with a clear success/failure signal.
 */
export async function waitForHealthy(
  port: number,
  opts: { totalMs?: number; intervalMs?: number; perProbeTimeoutMs?: number } = {},
): Promise<HealthResult> {
  const totalMs = opts.totalMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 500;
  const perProbeTimeoutMs = opts.perProbeTimeoutMs ?? 1_500;
  const deadline = Date.now() + totalMs;

  let last: HealthResult = { status: "error", error: "never probed" };
  while (Date.now() < deadline) {
    // Never let a single probe's timeout push us past the total budget —
    // otherwise the worst case is totalMs + perProbeTimeoutMs, and the
    // "10s" the user sees from the CLI wouldn't match reality.
    const remainingBeforeProbe = deadline - Date.now();
    const probeBudget = Math.min(perProbeTimeoutMs, remainingBeforeProbe);
    if (probeBudget <= 0) break;
    last = await checkHealth(port, probeBudget);
    if (last.status === "healthy") return last;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
  }
  return last;
}

/**
 * Return the last `n` lines of a file. Safe on missing files (returns null
 * so callers can render "no log file" rather than propagating ENOENT).
 */
export function tailFile(path: string, n: number): string | null {
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf8");
    if (!content) return "";
    const lines = content.split("\n");
    // Drop trailing empty line from a terminating \n so the tail isn't blank.
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-n).join("\n");
  } catch (err) {
    return null;
  }
}
