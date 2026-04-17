/**
 * Linux systemd service management for the vault daemon.
 *
 * Installs a user-level systemd service (~/.config/systemd/user/).
 * Uses EnvironmentFile to load ~/.parachute/.env.
 */

import { homedir } from "os";
import { join } from "path";
import { writeFile, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { $ } from "bun";
import { CONFIG_DIR, LOG_PATH, ERR_PATH } from "./config.ts";
import { WRAPPER_PATH, writeDaemonWrapper } from "./daemon.ts";

const SERVICE_NAME = "parachute-vault";
const SERVICE_DIR = join(homedir(), ".config", "systemd", "user");
const SERVICE_PATH = join(SERVICE_DIR, `${SERVICE_NAME}.service`);

/**
 * systemd unit invokes the shared start.sh wrapper. Env + server path
 * resolution lives in the wrapper (see daemon.ts) — keeping systemd and
 * launchd aligned on a single source of truth.
 */
export function generateUnit(): string {
  return `[Unit]
Description=Parachute Vault
After=network.target

[Service]
Type=simple
WorkingDirectory=${CONFIG_DIR}
ExecStart=/bin/bash ${WRAPPER_PATH}
Restart=on-failure
RestartSec=5
StandardOutput=append:${LOG_PATH}
StandardError=append:${ERR_PATH}

[Install]
WantedBy=default.target
`;
}

export async function installSystemdService(): Promise<{ serverPath: string }> {
  const { serverPath } = await writeDaemonWrapper();

  await mkdir(SERVICE_DIR, { recursive: true });
  await writeFile(SERVICE_PATH, generateUnit());

  // Enable lingering so user services run without login session
  try {
    await $`loginctl enable-linger ${process.env.USER}`.quiet();
  } catch {
    // May fail if not supported, that's ok
  }

  await $`systemctl --user daemon-reload`.quiet();
  await $`systemctl --user enable ${SERVICE_NAME}`.quiet();
  // Idempotent: `restart` works whether or not the service was running.
  await $`systemctl --user restart ${SERVICE_NAME}`.quiet();

  return { serverPath };
}

export async function uninstallSystemdService(): Promise<void> {
  try {
    await $`systemctl --user stop ${SERVICE_NAME}`.quiet();
    await $`systemctl --user disable ${SERVICE_NAME}`.quiet();
  } catch {}
  try {
    await unlink(SERVICE_PATH);
    await $`systemctl --user daemon-reload`.quiet();
  } catch {}
}

export async function restartSystemdService(): Promise<void> {
  await $`systemctl --user restart ${SERVICE_NAME}`.quiet();
}

export function isSystemdAvailable(): boolean {
  return existsSync("/run/systemd/system") || existsSync("/sys/fs/cgroup/systemd");
}

export async function isServiceActive(): Promise<boolean> {
  try {
    const result = await $`systemctl --user is-active ${SERVICE_NAME}`.quiet().text();
    return result.trim() === "active";
  } catch {
    return false;
  }
}
