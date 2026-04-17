/**
 * macOS launchd agent for the scheduled backup job.
 *
 * Parallels `launchd.ts` (which manages the vault daemon). Differences:
 *
 *   - StartInterval / StartCalendarInterval instead of KeepAlive — this is
 *     a one-shot-on-a-schedule job, not a long-running daemon.
 *   - Separate label + plist path so the two agents don't collide in
 *     launchctl.
 *   - The program executes `bun <cli.ts> vault backup` against the same
 *     server-path pointer the daemon uses, which keeps "which bun, which
 *     repo" in sync across both agents automatically.
 *
 * Linux systemd-timer variant is deliberately out-of-scope for the MVP; see
 * the scoping note in the PR description.
 */

import { homedir } from "os";
import { join } from "path";
import { writeFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { $ } from "bun";
import {
  CONFIG_DIR,
  LOG_PATH,
  ERR_PATH,
} from "./config.ts";
import type { BackupSchedule } from "./config.ts";
import { resolveServerPath } from "./daemon.ts";

export const BACKUP_LABEL = "computer.parachute.vault.backup";
export const BACKUP_PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${BACKUP_LABEL}.plist`);

/**
 * Resolve the CLI path the backup job should invoke. Sibling-to-server.ts
 * — we reuse `resolveServerPath()`'s dirname-of-module approach so a move
 * of the repo updates both the daemon and the backup agent on the next
 * `parachute vault backup --schedule <f>` run.
 */
export function resolveCliPath(): string {
  const serverPath = resolveServerPath(); // <repo>/src/server.ts
  return serverPath.replace(/server\.ts$/, "cli.ts");
}

/**
 * Build plist XML for a given schedule. Pure string builder for test-ability
 * — `backup-launchd.test.ts` locks the schedule → plist shape contract.
 */
export function generateBackupPlist(opts: {
  schedule: Exclude<BackupSchedule, "manual">;
  bunPath: string;
  cliPath: string;
  label?: string;
  logPath?: string;
  errPath?: string;
  workingDir?: string;
}): string {
  const label = opts.label ?? BACKUP_LABEL;
  const logPath = opts.logPath ?? LOG_PATH;
  const errPath = opts.errPath ?? ERR_PATH;
  const workingDir = opts.workingDir ?? CONFIG_DIR;

  const intervalXml = scheduleToPlistXml(opts.schedule);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${opts.bunPath}</string>
    <string>${opts.cliPath}</string>
    <string>vault</string>
    <string>backup</string>
  </array>
${intervalXml}
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${errPath}</string>
  <key>WorkingDirectory</key>
  <string>${workingDir}</string>
</dict>
</plist>`;
}

/**
 * Map a schedule string to the appropriate launchd key.
 *
 *   hourly → StartInterval 3600 (seconds)
 *   daily  → StartCalendarInterval at 03:00 local
 *   weekly → StartCalendarInterval at 03:00 Sunday
 *
 * Why 03:00: the classic "everybody's asleep, iCloud Drive isn't fighting
 * the active user for bandwidth" slot. If the machine is asleep at that
 * time, launchd fires the job on the next wake — so a laptop user who
 * sleeps at midnight still gets their backup.
 */
function scheduleToPlistXml(schedule: "hourly" | "daily" | "weekly"): string {
  if (schedule === "hourly") {
    return `  <key>StartInterval</key>
  <integer>3600</integer>`;
  }
  // daily + weekly: StartCalendarInterval dict.
  const hour = 3;
  const minute = 0;
  const lines: string[] = [];
  lines.push(`  <key>StartCalendarInterval</key>`);
  lines.push(`  <dict>`);
  lines.push(`    <key>Hour</key>`);
  lines.push(`    <integer>${hour}</integer>`);
  lines.push(`    <key>Minute</key>`);
  lines.push(`    <integer>${minute}</integer>`);
  if (schedule === "weekly") {
    // 0 = Sunday per Apple's docs.
    lines.push(`    <key>Weekday</key>`);
    lines.push(`    <integer>0</integer>`);
  }
  lines.push(`  </dict>`);
  return lines.join("\n");
}

/**
 * Install (or re-install) the backup agent for the given schedule. Idempotent
 * — same pattern as `installAgent()` in `launchd.ts`: unload first so a
 * re-registration takes effect even if the prior plist is loaded.
 *
 * `schedule: "manual"` uninstalls the agent — no plist means no scheduled
 * runs. This is what the spec asks for: `manual` is the off-switch.
 */
export async function installBackupAgent(schedule: BackupSchedule): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("launchd backup agent is only available on macOS. systemd timer variant is a follow-up PR.");
  }

  if (schedule === "manual") {
    await uninstallBackupAgent();
    return;
  }

  const bunPath = Bun.which("bun") || join(homedir(), ".bun", "bin", "bun");
  const cliPath = resolveCliPath();
  const plist = generateBackupPlist({ schedule, bunPath, cliPath });
  await writeFile(BACKUP_PLIST_PATH, plist);

  // Bounce in the same pattern as the daemon agent.
  try { await $`launchctl unload ${BACKUP_PLIST_PATH}`.quiet(); } catch {}
  try { await $`launchctl load ${BACKUP_PLIST_PATH}`.quiet(); } catch {}
}

export async function uninstallBackupAgent(): Promise<void> {
  try { await $`launchctl unload ${BACKUP_PLIST_PATH}`.quiet(); } catch {}
  try {
    if (existsSync(BACKUP_PLIST_PATH)) await unlink(BACKUP_PLIST_PATH);
  } catch {}
}

export async function isBackupAgentLoaded(): Promise<boolean> {
  try {
    const result = await $`launchctl list ${BACKUP_LABEL}`.quiet();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
