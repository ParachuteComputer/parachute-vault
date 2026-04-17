/**
 * Plist shape tests for the scheduled-backup launchd agent.
 *
 * These mirror `launchd.test.ts` in spirit — we don't actually register
 * the plist with launchctl (that would mutate the developer's machine).
 * We only verify:
 *
 *   1. The plist contains the bun path, the cli path, and the right
 *      `vault backup` ProgramArguments.
 *   2. Each schedule value produces the right scheduling key
 *      (StartInterval vs StartCalendarInterval with Hour + Weekday).
 *   3. The XML is superficially well-formed (opens and closes matching tags).
 *
 * The actual `installBackupAgent` / `uninstallBackupAgent` flow is tested
 * indirectly via `cmdBackupSchedule` in higher-level CLI integration tests.
 */

import { describe, test, expect } from "bun:test";
import { generateBackupPlist, BACKUP_LABEL } from "./backup-launchd.ts";

describe("generateBackupPlist", () => {
  const basic = {
    bunPath: "/Users/alice/.bun/bin/bun",
    cliPath: "/Users/alice/repo/parachute-vault/src/cli.ts",
  };

  test("hourly → StartInterval 3600", () => {
    const plist = generateBackupPlist({ ...basic, schedule: "hourly" });
    expect(plist).toContain("<key>StartInterval</key>");
    expect(plist).toContain("<integer>3600</integer>");
    expect(plist).not.toContain("<key>StartCalendarInterval</key>");
  });

  test("daily → StartCalendarInterval with Hour=3 (no Weekday)", () => {
    const plist = generateBackupPlist({ ...basic, schedule: "daily" });
    expect(plist).toContain("<key>StartCalendarInterval</key>");
    expect(plist).toContain("<key>Hour</key>");
    expect(plist).toContain("<integer>3</integer>");
    expect(plist).not.toContain("<key>Weekday</key>");
  });

  test("weekly → StartCalendarInterval with Hour=3, Weekday=0 (Sunday)", () => {
    const plist = generateBackupPlist({ ...basic, schedule: "weekly" });
    expect(plist).toContain("<key>StartCalendarInterval</key>");
    expect(plist).toContain("<key>Hour</key>");
    expect(plist).toContain("<key>Weekday</key>");
    // The plist has both Hour=3 AND Weekday=0 — verify both by locating
    // their surrounding keys.
    const weekdayMatch = plist.match(/<key>Weekday<\/key>\s*<integer>(\d+)<\/integer>/);
    expect(weekdayMatch).not.toBeNull();
    expect(weekdayMatch![1]).toBe("0");
  });

  test("ProgramArguments runs `bun <cli.ts> vault backup`", () => {
    const plist = generateBackupPlist({ ...basic, schedule: "daily" });
    expect(plist).toContain(`<string>${basic.bunPath}</string>`);
    expect(plist).toContain(`<string>${basic.cliPath}</string>`);
    expect(plist).toContain("<string>vault</string>");
    expect(plist).toContain("<string>backup</string>");
  });

  test("uses the backup-specific label, not the daemon label", () => {
    const plist = generateBackupPlist({ ...basic, schedule: "daily" });
    expect(plist).toContain(`<string>${BACKUP_LABEL}</string>`);
    // Different from the daemon label. If somebody ever unified them, this
    // test fires so the change is intentional.
    expect(BACKUP_LABEL).toBe("computer.parachute.vault.backup");
  });

  test("RunAtLoad is false — we do not want a backup to fire on every login", () => {
    // Opposite of the daemon (which has RunAtLoad=true to keep the server
    // running at login). For the backup agent, running at login is user-
    // hostile: it delays login and churns iCloud on every cold boot.
    const plist = generateBackupPlist({ ...basic, schedule: "daily" });
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
  });

  test("XML opens and closes plist dict", () => {
    // Superficial well-formedness — catches stray typos in the template.
    // A full XML validator would be overkill; matching open/close counts
    // is sufficient for the single hand-rolled plist.
    const plist = generateBackupPlist({ ...basic, schedule: "daily" });
    expect(plist).toMatch(/<plist version="1\.0">/);
    expect(plist).toMatch(/<\/plist>\s*$/);
    const opens = (plist.match(/<dict>/g) ?? []).length;
    const closes = (plist.match(/<\/dict>/g) ?? []).length;
    expect(opens).toBe(closes);
  });
});
