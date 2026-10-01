import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { SqliteStore } from "../core/src/store.ts";
import { assetsDir, readGlobalConfig, readVaultConfig, vaultDbPath, vaultDir, writeGlobalConfig, writeVaultConfig } from "./config.ts";
import { renameVault } from "./vault-rename.ts";
import { runSubprocess } from "./test-support/spawn.ts";
import { handleStorage } from "./routes.ts";

const suiteHome = process.env.PARACHUTE_HOME!;
let home: string;
const quiet = { log: () => {} };
beforeEach(() => {
  home = mkdtempSync(join(suiteHome, "rename-"));
  process.env.PARACHUTE_HOME = home;
});
afterEach(() => { process.env.PARACHUTE_HOME = suiteHome; rmSync(home, { recursive: true, force: true }); });
const cli = (...args: string[]) => runSubprocess({ cmd: [process.execPath, "src/cli.ts", "rename", ...args], env: { PARACHUTE_HOME: home } });
async function fixture() {
  writeVaultConfig({ name: "before", description: "Keep this", api_keys: [], created_at: "2026-01-01", private_tags: ["secret"] });
  const raw = readFileSync(join(vaultDir("before"), "vault.yaml"), "utf8") + 'future_field: {keep: true}\n';
  writeFileSync(join(vaultDir("before"), "vault.yaml"), raw);
  writeGlobalConfig({ port: 1940, default_vault: "before" });
  const db = new Database(vaultDbPath("before"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  const store = new SqliteStore(db);
  const target = await store.createNote("target", { path: "target", tags: ["topic"] });
  const note = await store.createNote("see [[target]]", { path: "note" });
  await store.addAttachment(note.id, "2026/file.txt", "text/plain");
  mkdirSync(join(assetsDir("before"), "2026"), { recursive: true });
  writeFileSync(join(assetsDir("before"), "2026/file.txt"), "attachment bytes");
  db.query("INSERT INTO tokens(token_hash,label,permission,created_at,vault_name,scopes) VALUES('hash','old','full','now','before','vault:before:read vault:read')").run();
  db.query("INSERT INTO mcp_mint_ledger(jti,parent_jti,vault_name,label,created_at,scopes) VALUES('jti','parent','before','mint','now','vault:before:admin')").run();
  db.query("INSERT INTO oauth_codes(code,client_id,code_challenge,redirect_uri,expires_at,created_at,vault_name) VALUES('code','client','challenge','url','later','now','before')").run();
  db.query(`INSERT INTO triggers(name,action,created_at,updated_at) VALUES('trigger',?,'now','now')`).run(JSON.stringify({ webhook: "http://localhost/vault/before/api/notes" }));
  const counts = () => ["notes", "attachments", "tags", "links"].map(t => (db.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n);
  return { db, note, target, raw, counts: counts() };
}

test("CLI moves notes, tags, links and attachment storage; preserves YAML and refreshes discovery", async () => {
  const f = await fixture(); f.db.close();
  const result = await cli("before", "after", "--yes");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Backup:");
  expect(existsSync(vaultDir("before"))).toBe(false);
  expect(readVaultConfig("after")!.name).toBe("after");
  expect(readFileSync(join(vaultDir("after"), "vault.yaml"), "utf8")).toBe(f.raw.replace("name: before", "name: after"));
  expect(readGlobalConfig().default_vault).toBe("after");
  const services = JSON.parse(readFileSync(join(home, "services.json"), "utf8"));
  expect(services.services.find((s: { name: string }) => s.name === "parachute-vault").paths).toEqual(["/vault/after"]);
  const db = new Database(vaultDbPath("after"));
  try {
    const store = new SqliteStore(db);
    expect((await store.getNote(f.note.id))!.content).toBe("see [[target]]");
    expect((await store.getAttachments(f.note.id))[0]!.path).toBe("2026/file.txt");
    expect(["notes", "attachments", "tags", "links"].map(t => (db.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n)).toEqual(f.counts);
    const response = await handleStorage(new Request("http://localhost/api/storage/2026/file.txt"), "/2026/file.txt", "after", store);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("attachment bytes");
    for (const table of ["tokens", "oauth_codes", "mcp_mint_ledger"]) expect(db.query(`SELECT vault_name FROM ${table}`).get()).toEqual({ vault_name: "after" });
    expect(db.query("SELECT scopes FROM tokens").get()).toEqual({ scopes: "vault:after:read vault:read" });
    expect(db.query("SELECT action FROM triggers").get()).toEqual({ action: JSON.stringify({ webhook: "http://localhost/vault/after/api/notes" }) });
  } finally { db.close(); }
});

test("VACUUM backup includes WAL commits and can be restored into a fresh vault", async () => {
  const f = await fixture();
  // Keep the connection open through the snapshot: these commits are in WAL.
  // Close it immediately before the actual move via the backup log seam.
  expect(existsSync(`${vaultDbPath("before")}-wal`)).toBe(true);
  const backup = renameVault("before", "after", true, { log: message => { if (message.startsWith("Backup:")) f.db.close(); } })!;
  expect(existsSync(join(backup, "assets"))).toBe(false);
  mkdirSync(vaultDir("restored"));
  copyFileSync(join(backup, "vault.db"), vaultDbPath("restored"));
  const restored = new Database(vaultDbPath("restored"));
  try {
    expect(restored.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(["notes", "attachments", "tags", "links"].map(t => (restored.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n)).toEqual(f.counts);
  } finally { restored.close(); }
});

for (const [old, name] of [["missing", "after"], ["before", "existing"], ["before", "admin"], ["before", "../escape"], ["before", "before"]]) {
  test(`refuses ${old} -> ${name}`, async () => {
    const f = await fixture(); f.db.close();
    mkdirSync(vaultDir("existing"));
    const result = await cli(old!, name!, "--yes");
    expect(result.exitCode).not.toBe(0);
    expect(existsSync(vaultDbPath("before"))).toBe(true);
    expect(existsSync(join(home, "vault/data/.rename-backups"))).toBe(false);
    expect(readGlobalConfig().default_vault).toBe("before");
  });
}

test("preview and help do not mutate state", async () => {
  const f = await fixture(); f.db.close();
  expect((await cli("before", "after")).exitCode).toBe(0);
  expect(existsSync(vaultDir("after"))).toBe(false);
  expect(existsSync(join(home, "vault/data/.rename-backups"))).toBe(false);
  expect(readGlobalConfig().default_vault).toBe("before");
  expect((await cli("--help")).stdout).toContain("Manual recovery");
});

for (const step of ["config", "registration"] as const) {
  test(`rolls back ${step} failure, including global config and database bindings`, async () => {
    const f = await fixture(); f.db.close();
    const original = readFileSync(join(home, "vault/config.yaml"), "utf8");
    expect(() => renameVault("before", "after", true, {
      ...quiet,
      ...(step === "config" ? { writeConfig: () => { throw new Error("injected write failure"); } } : {
        register: () => { writeFileSync(join(home, "services.json"), "partial"); throw new Error("injected registration failure"); },
      }),
    })).toThrow(/Rolled back.*Backup:/);
    expect(existsSync(vaultDir("after"))).toBe(false);
    expect(readFileSync(join(vaultDir("before"), "vault.yaml"), "utf8")).toBe(f.raw);
    expect(readFileSync(join(home, "vault/config.yaml"), "utf8")).toBe(original);
    expect(existsSync(join(home, "services.json"))).toBe(false);
    const db = new Database(vaultDbPath("before"));
    expect(db.query("SELECT vault_name FROM tokens").get()).toEqual({ vault_name: "before" });
    db.close();
    expect(readdirSync(join(home, "vault/data/.rename-backups"))).toHaveLength(1);
  });
}

test("rewrites moved absolute paths in mirror/history/.env/global config, preserving unrelated entries", async () => {
  const f = await fixture(); f.db.close();
  const from = vaultDir("before");
  writeFileSync(join(from, "mirror-config.yaml"), `mirror:\n  external_path: "${from}/mirror"\n`);
  writeFileSync(join(from, "history-mirror-state.json"), JSON.stringify({ phase: "retired", source: `${from}/mirror` }));
  writeFileSync(join(from, "history-import-recovery.json"), JSON.stringify({ backup: `${from}/history.db` }));
  writeFileSync(join(home, "vault/.env"), `ASSETS_DIR=${from}/assets\nPARACHUTE_VAULT_NAME="before"\nOTHER=/external/before\n`);
  const globalPath = join(home, "vault/config.yaml");
  writeFileSync(globalPath, readFileSync(globalPath, "utf8") + `future_key: keep\nbackup:\n  destinations:\n    - kind: local\n      path: ${from}/backups\n`);
  const backup = renameVault("before", "after", true, quiet)!;
  expect(readFileSync(join(backup, "mirror-config.yaml"), "utf8")).toContain(from);
  for (const file of ["mirror-config.yaml", "history-mirror-state.json", "history-import-recovery.json"]) expect(readFileSync(join(vaultDir("after"), file), "utf8")).toContain(vaultDir("after"));
  expect(readFileSync(join(home, "vault/.env"), "utf8")).toBe(`ASSETS_DIR=${vaultDir("after")}/assets\nPARACHUTE_VAULT_NAME="after"\nOTHER=/external/before\n`);
  expect(readFileSync(globalPath, "utf8")).toContain("future_key: keep");
  expect(readFileSync(globalPath, "utf8")).toContain(`${vaultDir("after")}/backups`);
});

test("refuses unfinished history import with its immutable external manifest", async () => {
  const f = await fixture(); f.db.close();
  writeFileSync(join(vaultDir("before"), "history-mirror-state.json"), '{"phase":"paused"}');
  expect(() => renameVault("before", "after", true, quiet)).toThrow("Finish or cancel");
  expect(existsSync(vaultDir("before"))).toBe(true);
});

test("CLI reports registration failure with backup path and rolls back", async () => {
  const f = await fixture(); f.db.close();
  writeFileSync(join(home, "services.json"), "invalid json");
  const result = await cli("before", "after", "--yes");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Backup:");
  expect(result.stderr).toContain("Rolled back");
  expect(readGlobalConfig().default_vault).toBe("before");
  expect(readFileSync(join(home, "services.json"), "utf8")).toBe("invalid json");
  expect(existsSync(vaultDir("after"))).toBe(false);
});

test("non-default rename leaves the default and external assets root intact", async () => {
  const f = await fixture(); f.db.close();
  writeGlobalConfig({ port: 1940, default_vault: "other" });
  const external = join(home, "external-assets");
  mkdirSync(external);
  writeFileSync(join(home, "vault/.env"), `ASSETS_DIR=${external}\n`);
  renameVault("before", "after", true, quiet);
  expect(readGlobalConfig().default_vault).toBe("other");
  expect(readFileSync(join(home, "vault/.env"), "utf8")).toBe(`ASSETS_DIR=${external}\n`);
});

test("repairs legacy absolute attachment paths without changing relative paths", async () => {
  const f = await fixture();
  f.db.query("UPDATE attachments SET path=?").run(join(assetsDir("before"), "2026/file.txt"));
  f.db.close();
  renameVault("before", "after", true, quiet);
  const db = new Database(vaultDbPath("after"));
  try { expect(db.query("SELECT path FROM attachments").get()).toEqual({ path: join(assetsDir("after"), "2026/file.txt") }); }
  finally { db.close(); }
});
