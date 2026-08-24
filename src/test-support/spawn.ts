/**
 * Shared subprocess helper for tests (vault#325 Part 1).
 *
 * THE RULE — never `Bun.spawnSync` in a test that keeps an in-process
 * `Bun.serve` listening for the child to probe.
 *
 * `Bun.spawnSync` blocks the parent's event loop until the child exits.
 * If the child makes an HTTP request back to a server the *same test
 * process* is hosting (e.g. the CLI's daemon-busy pre-flight fetching a
 * stub `/health`), the parent can't answer — the child's request times
 * out into the "nothing listening" branch and the assertion silently
 * tests the wrong path (the guard never fires, or fails for a non-obvious
 * reason). This bit the daemon-busy import guard; the fix landed in
 * vault#324 (`src/import-daemon-busy.test.ts`) and this helper is the
 * institutional-memory follow-up so future subprocess tests reach for the
 * safe primitive by default.
 *
 * `runSubprocess` uses async `Bun.spawn` + `await proc.exited`, so the
 * parent's event loop keeps servicing requests while the child runs.
 *
 * THE OTHER RULE — always give a spawned child an explicit `env`.
 *
 * Bun hands a child the environ the parent process *started* with, not the
 * live `process.env`: assignments made at runtime are invisible to it. That
 * includes the temp `PARACHUTE_HOME` that `core/src/test-preload.ts` sets for
 * the whole suite, so a child spawned with no `env` resolves its parachute
 * home to the developer's real `~/.parachute` (verified with Bun 1.3.14).
 * `runSubprocess` handles this for you — it spreads the live `process.env`
 * below and merges `opts.env` over it. Hand-rolled `Bun.spawnSync` calls must
 * do the same; `src/version.test.ts` was silently pointing its CLI child at
 * the real install until the config.ts NODE_ENV=test guard caught it.
 *
 * NOTE on what's *fine*: `Bun.spawnSync` is safe in tests that don't run
 * an in-test server the child talks to over HTTP — e.g. shelling out to
 * `git` to build a fixture repo (`mirror-*.test.ts`), or a `Bun.serve`
 * that merely *holds a port* so the child's `lsof`/availability probe
 * sees it occupied (`doctor.test.ts`). The deadlock is specifically
 * "child fetches the parent test process's server." When in doubt, use
 * this helper — it's never wrong, only sometimes unnecessary.
 */

export interface RunSubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunSubprocessOptions {
  cmd: string[];
  cwd?: string;
  /** Extra env merged over `process.env`. `undefined` values delete the key. */
  env?: Record<string, string | undefined>;
  /** Optional bytes piped to the child's stdin. */
  stdin?: string;
}

/**
 * Run a subprocess WITHOUT blocking the event loop.
 *
 * Drop-in for the `Bun.spawnSync({ cmd, env, stdout, stderr })` pattern
 * that recurs across the CLI integration tests, but built on async
 * `Bun.spawn` so an in-process `Bun.serve` the child probes can still
 * answer. Returns once the child has exited, with decoded stdout/stderr.
 */
export async function runSubprocess(
  opts: RunSubprocessOptions,
): Promise<RunSubprocessResult> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }

  const proc = Bun.spawn({
    cmd: opts.cmd,
    cwd: opts.cwd,
    env,
    stdin: opts.stdin === undefined ? undefined : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (opts.stdin !== undefined) {
    proc.stdin!.write(opts.stdin);
    await proc.stdin!.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode: exitCode ?? -1, stdout, stderr };
}
