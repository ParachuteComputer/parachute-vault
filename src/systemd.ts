/**
 * Linux systemd service management for the vault daemon.
 *
 * Installs a user-level systemd service (~/.config/systemd/user/).
 * Uses EnvironmentFile to load ~/.parachute/.env.
 */

import { homedir } from "os";
import { join, resolve } from "path";
import { writeFile, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { $ } from "bun";
import { CONFIG_DIR, ENV_PATH, LOG_PATH, ERR_PATH } from "./config.ts";

const SERVICE_NAME = "parachute-vault";
const SERVICE_DIR = join(homedir(), ".config", "systemd", "user");
const SERVICE_PATH = join(SERVICE_DIR, `${SERVICE_NAME}.service`);

function generateUnit(serverPath: string, bunPath: string): string {
  return `[Unit]
Description=Parachute Vault
After=network.target

[Service]
Type=simple
WorkingDirectory=${resolve(serverPath, "..")}
ExecStart=${bunPath} ${serverPath}
Restart=on-failure
RestartSec=5
EnvironmentFile=${ENV_PATH}
StandardOutput=append:${LOG_PATH}
StandardError=append:${ERR_PATH}

[Install]
WantedBy=default.target
`;
}

export async function installSystemdService(): Promise<void> {
  const serverPath = resolve(import.meta.dir, "server.ts");
  const bunPath = (await $`which bun`.text()).trim();

  await mkdir(SERVICE_DIR, { recursive: true });
  await writeFile(SERVICE_PATH, generateUnit(serverPath, bunPath));

  // Enable lingering so user services run without login session
  try {
    await $`loginctl enable-linger ${process.env.USER}`.quiet();
  } catch {
    // May fail if not supported, that's ok
  }

  await $`systemctl --user daemon-reload`.quiet();
  await $`systemctl --user enable ${SERVICE_NAME}`.quiet();
  await $`systemctl --user start ${SERVICE_NAME}`.quiet();
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
