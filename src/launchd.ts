/**
 * macOS launchd agent management for the vault daemon.
 */

import { homedir } from "os";
import { join, resolve, dirname } from "path";
import { writeFile, unlink } from "fs/promises";
import { $ } from "bun";
import { CONFIG_DIR, LOG_PATH, ERR_PATH } from "./config.ts";

const LABEL = "computer.parachute.vault";
const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

export function generatePlist(serverPath: string, bunPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>${serverPath}</string>
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${ERR_PATH}</string>
  <key>WorkingDirectory</key>
  <string>${CONFIG_DIR}</string>
</dict>
</plist>`;
}

export async function installAgent(): Promise<void> {
  const serverPath = resolve(dirname(import.meta.path), "server.ts");
  const bunPath = Bun.which("bun") || join(homedir(), ".bun", "bin", "bun");
  const plist = generatePlist(serverPath, bunPath);
  await writeFile(PLIST_PATH, plist);
  await $`launchctl load ${PLIST_PATH}`.quiet();
}

export async function uninstallAgent(): Promise<void> {
  try {
    await $`launchctl unload ${PLIST_PATH}`.quiet();
  } catch {}
  try {
    await unlink(PLIST_PATH);
  } catch {}
}

export async function isAgentLoaded(): Promise<boolean> {
  try {
    const result = await $`launchctl list ${LABEL}`.quiet();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export async function restartAgent(): Promise<void> {
  try {
    await $`launchctl unload ${PLIST_PATH}`.quiet();
  } catch {}
  await $`launchctl load ${PLIST_PATH}`.quiet();
}
