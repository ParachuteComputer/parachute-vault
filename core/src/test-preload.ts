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
import { mkdtempSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

const TEST_HOME = mkdtempSync(join(tmpdir(), "parachute-test-home-"));
process.env.PARACHUTE_HOME = TEST_HOME;

// Tripwire, and a live one: `mkdtempSync` builds on `tmpdir()`, which honors
// TMPDIR. An operator or CI that points TMPDIR inside the parachute home
// (`TMPDIR=~/.parachute/tmp` is not exotic) would have this file dutifully
// create the suite's "isolated" home *inside the live install*, which is the
// failure this preload exists to prevent, arrived at by another road. Assert
// the temp home is neither the real home nor nested under it.
//
// The check on `process.env.PARACHUTE_HOME` itself is deliberately NOT here:
// it was just assigned two lines up, so any such comparison is dead code that
// reads as live defense. `configDirPath()` in `src/config.ts` carries the real
// runtime tripwire, at the one function that resolves the root.
const REAL_HOME = join(homedir(), ".parachute");
if (TEST_HOME === REAL_HOME || TEST_HOME.startsWith(REAL_HOME + "/")) {
  throw new Error(
    `[test-preload] refusing to run the test suite: the temp home ${TEST_HOME} is inside ` +
      `the live install at ${REAL_HOME} — check TMPDIR. Tests would create real vaults ` +
      `there; that happened on 2026-08-22.`,
  );
}

// No cleanup handler on purpose. `bun test` dispatches neither `exit` nor
// `beforeExit` (verified on Bun 1.3.14 — a handler registered here never runs,
// even on a clean green exit), so a cleanup hook would be a comment promising
// something that does not happen. Each run therefore leaves one empty-ish
// `parachute-test-home-*` under tmpdir(); the OS reaps them, and a dropping in
// tmpdir is a rounding error next to a dropping in someone's real vault.
