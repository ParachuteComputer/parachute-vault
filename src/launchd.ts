/**
 * macOS launchd agent management for the vault daemon.
 *
 * The plist runs `~/.parachute/vault/start.sh` (the shared wrapper from
 * daemon.ts). The wrapper reads the pointer file at every boot, so
 * moving the repo only requires re-running `parachute-vault init`.
 */

import { homedir } from "os";
import { join } from "path";
import { writeFile, unlink } from "fs/promises";
import { $ } from "bun";
import { VAULT_HOME, LOG_PATH, ERR_PATH } from "./config.ts";
import { WRAPPER_PATH, writeDaemonWrapper } from "./daemon.ts";

const LABEL = "computer.parachute.vault";
const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

export function generatePlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${WRAPPER_PATH}</string>
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
  <string>${VAULT_HOME}</string>
</dict>
</plist>`;
}

/**
 * Install or re-install the launchd agent. Idempotent: if the agent is
 * already loaded, it's unloaded first so the new wrapper + pointer take
 * effect. This is what makes `parachute-vault init` safe to re-run after
 * a folder move — the incident that motivated this PR.
 */
export async function installAgent(): Promise<{ serverPath: string }> {
  if (process.platform !== "darwin") {
    throw new Error("launchd is only available on macOS. Use systemd on Linux.");
  }

  const { serverPath } = await writeDaemonWrapper();
  await writeFile(PLIST_PATH, generatePlist());

  // Bounce launchd so it picks up a refreshed wrapper + pointer. `load`
  // alone fails with "Operation already in progress" if we're already
  // registered, which used to silently leave stale config in place. If
  // two `vault init` calls race, the second `load` may also see the
  // service as still-loaded; swallow it so re-runs don't blow up.
  try {
    await $`launchctl unload ${PLIST_PATH}`.quiet();
  } catch {
    // Not loaded yet — fine.
  }
  try {
    await $`launchctl load ${PLIST_PATH}`.quiet();
  } catch {
    // A concurrent init already reloaded it — fine.
  }

  return { serverPath };
}

export async function uninstallAgent(): Promise<void> {
  try {
    await $`launchctl unload ${PLIST_PATH}`.quiet();
  } catch {}
  try {
    await unlink(PLIST_PATH);
  } catch {}
  // Wrapper + pointer removal lives in daemon.ts so it's shared with the
  // Linux uninstall path. Callers that want a fully-clean teardown must
  // also call `removeDaemonWrapper()` — the CLI's `uninstall` command in
  // PR 3 wires that up. Leaving them here programmatically would strand
  // orphaned files in `~/.parachute/vault/`.
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
