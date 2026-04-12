// Isolate PARACHUTE_HOME so tests never touch the real ~/.parachute directory.
// This must run before any `./config.ts` import resolves CONFIG_DIR.
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
if (!process.env.PARACHUTE_HOME) {
  process.env.PARACHUTE_HOME = mkdtempSync(join(tmpdir(), "parachute-test-home-"));
}
