// Isolate PARACHUTE_HOME so tests never touch the real ~/.parachute directory.
// This must run before any `./config.ts` import resolves CONFIG_DIR.
//
// The override is UNCONDITIONAL, and that is the entire point. This file used
// to read `if (!process.env.PARACHUTE_HOME)` — polite, and exactly backwards:
// the dangerous case is an *inherited* PARACHUTE_HOME, because on a developer
// box the inherited value is the live install. A machine whose shell profile
// carries `export PARACHUTE_HOME="$HOME/.parachute"` (a normal thing to have —
// it is also how parachute-hub launches the daemon) handed `bun test` a
// pointer straight at the real vault data dir, and this guard stepped politely
// aside. On 2026-08-22 two runs wrote ~158 real vault directories into a live
// install — `tagscope-*`, `mint-*`, `retier-*`, `ledger-*`, plus a `solo`
// vault from the mirror-routes tests.
//
// Nothing legitimate depends on the ambient value surviving. `config.ts`
// re-reads `process.env.PARACHUTE_HOME` on every call (see the "Historical
// note" above `configDirPath`), and every test that needs a particular home
// either assigns it at run time or passes it explicitly to the child it
// spawns. Docker and CI set PARACHUTE_HOME for the *server*, never for
// `bun test`.
import { mkdtempSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

const TEST_HOME = mkdtempSync(join(tmpdir(), "parachute-test-home-"));
process.env.PARACHUTE_HOME = TEST_HOME;

// Tripwire — cheap, and it fires before a single test module loads. Mirrors
// the rule in `configDirPath()`: `process.env.PARACHUTE_HOME ?? join(homedir(),
// ".parachute")`. If the override above ever stops landing somewhere
// disposable, fail the run loudly instead of quietly writing into a vault
// somebody actually uses.
const REAL_HOME = join(homedir(), ".parachute");
const resolved = process.env.PARACHUTE_HOME || REAL_HOME;
if (resolved === REAL_HOME) {
  throw new Error(
    `[test-preload] refusing to run the test suite: PARACHUTE_HOME resolves to the live ` +
      `install at ${REAL_HOME}. Tests would create real vaults there — this happened on ` +
      `2026-08-22. Fix the preload; do not work around it.`,
  );
}

// Best-effort cleanup. A leftover directory under tmpdir() is a rounding
// error; a leftover directory in the live install is the bug this file exists
// to prevent. `exit` only fires on a clean exit — a killed run leaves the temp
// dir behind, which is an acceptable trade.
process.on("exit", () => {
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    // ignore — never let cleanup fail a green run
  }
});
