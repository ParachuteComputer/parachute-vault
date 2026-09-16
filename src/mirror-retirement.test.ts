import { test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { historyMirrorStatePath, assertVaultNotPaused, assertMirrorActive, VaultImportPausedError, MirrorRetiredError } from "./mirror-config.ts";
import { getVaultStore } from "./vault-store.ts";
import { vaultDbPath } from "./config.ts";

test("paused and malformed markers refuse before a DB is created; retired serves but cannot export", () => {
  const name = `retirement-${crypto.randomUUID()}`;
  const marker = historyMirrorStatePath(name);
  mkdirSync(dirname(marker), { recursive: true });
  try {
    for (const raw of ['{"phase":"paused"}', '{', '{"phase":"other"}']) {
      writeFileSync(marker, raw);
      expect(() => getVaultStore(name)).toThrow(VaultImportPausedError);
      expect(existsSync(vaultDbPath(name))).toBe(false);
    }
    writeFileSync(marker, '{"phase":"retired"}');
    expect(() => assertVaultNotPaused(name)).not.toThrow();
    expect(() => assertMirrorActive(name)).toThrow(MirrorRetiredError);
    writeFileSync(marker, '{"phase":"active"}');
    expect(() => assertMirrorActive(name)).not.toThrow();
  } finally { rmSync(dirname(marker), { recursive: true, force: true }); }
});

import { mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { writeVaultConfig, writeGlobalConfig } from "./config.ts";
import { clearVaultStoreCache } from "./vault-store.ts";
import { waitForHealthy } from "./health.ts";

test("real four-vault boot isolates paused vault HTTP/MCP/subscribe before DB open", async () => {
  const saved = process.env.PARACHUTE_HOME, home = mkdtempSync(join(tmpdir(), "import-paused-host-"));
  process.env.PARACHUTE_HOME = home;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const reserve = Bun.serve({ port: 0, fetch: () => new Response() }); const port = reserve.port!; reserve.stop(true);
    writeGlobalConfig({ port, default_mirror: "off" });
    for (const name of ["paused", "normal1", "normal2", "normal3"]) writeVaultConfig({ name, api_keys: [], created_at: new Date().toISOString() });
    writeFileSync(historyMirrorStatePath("paused"), JSON.stringify({ phase: "paused" }));
    child = Bun.spawn({ cmd: [process.execPath, resolve(import.meta.dir, "server.ts")], env: { ...process.env, PARACHUTE_HOME: home, PORT: String(port), PARACHUTE_VAULT_NAME: "", SCRIBE_URL: "" }, stdout: "ignore", stderr: "ignore" });
    expect((await waitForHealthy(port, { totalMs: 15_000 })).status).toBe("healthy");
    for (const path of ["api/notes", "mcp", "subscribe"]) {
      const response = await fetch(`http://127.0.0.1:${port}/vault/paused/${path}`, { headers: path === "subscribe" ? { Upgrade: "websocket", Connection: "Upgrade" } : {} });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error_type: "history_import_paused", message: "Vault history import is paused" });
    }
    expect(existsSync(vaultDbPath("paused"))).toBe(false);
    for (const name of ["normal1", "normal2", "normal3"]) {
      expect(existsSync(vaultDbPath(name))).toBe(true);
      expect((await fetch(`http://127.0.0.1:${port}/vault/${name}/api/notes`)).status).not.toBe(503);
    }
  } finally {
    if (child) { child.kill(); await child.exited; }
    clearVaultStoreCache(); if (saved === undefined) delete process.env.PARACHUTE_HOME; else process.env.PARACHUTE_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
}, 25_000);

import { MirrorManager } from "./mirror-manager.ts";
import { defaultMirrorConfig } from "./mirror-config.ts";
import { handleMirrorPut, enableSyncToImportedRepo } from "./mirror-routes.ts";
test("retired manager refuses every export boundary and old-client enable without config writes", async () => {
  const name = `retired-${crypto.randomUUID()}`, marker = historyMirrorStatePath(name);
  mkdirSync(dirname(marker), { recursive: true }); writeFileSync(marker, '{"phase":"retired"}');
  let writes = 0, exports = 0;
  const config = { ...defaultMirrorConfig(), enabled: true };
  const manager = new MirrorManager({ vaultName: name, runExport: async () => { exports++; return { notes: 0 }; }, firstChangedNoteTitle: async () => "", readMirrorConfig: () => config, writeMirrorConfig: () => { writes++; } });
  try {
    for (const call of [() => manager.start(), () => manager.reload(config), () => manager.runNow(), () => manager.pushNow()]) await expect(call()).rejects.toThrow(MirrorRetiredError);
    const response = await handleMirrorPut(new Request("http://localhost/mirror", { method: "PUT", body: JSON.stringify(config) }), manager);
    expect(response.status).toBe(409);
    expect((await response.json() as any).error_type).toBe("mirror_retired");
    expect(writes).toBe(0); expect(exports).toBe(0);
    const sync = await enableSyncToImportedRepo({ vaultName: name, remoteUrl: "https://example.invalid/repo.git", auth: { kind: "none" }, manager });
    expect(sync.sync_enabled).toBe(false);
  } finally { manager.stop(); rmSync(dirname(marker), { recursive: true, force: true }); }
});
