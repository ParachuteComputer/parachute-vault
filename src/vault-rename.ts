import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { readGlobalConfig, readVaultConfig, vaultDir, vaultDbPath, writeVaultConfig } from "./config.ts";
import { validateVaultName } from "./vault-name.ts";
import { historyImportRecoveryPath, readHistoryMirrorPhase } from "./mirror-config.ts";
import { selfRegister } from "./self-register.ts";
import pkg from "../package.json";

export const RENAME_HELP = `Usage: parachute-vault rename <old> <new> [--yes] [--json]
Without --yes, preview only. Stop the vault server before confirming; the hub
stops/restarts the vault module around this call, just as for remove.
Finish or cancel an unfinished history import before renaming.
Manual recovery (server stopped): move the renamed directory back to <old>,
remove vault.db-wal and vault.db-shm, then copy backup-dir/vault.db and
backup-dir/vault.yaml (plus mirror-config.yaml and history-*.json if present)
into that directory.
Assets are NOT backed up: keep the moved assets/ directory. Restore any saved
config.yaml, .env and services.json from backup-dir/global/ to their original
locations under PARACHUTE_HOME; restart the server to refresh registration.`;

/** Like cmdRemove, this does not probe/control the daemon. The hub must stop
 * and restart the vault module around this call; standalone callers stop it.
 * Runtime store/mirror/trigger maps are rebuilt on that restart.
 */
export function renameVault(old: string, requested: string, yes: boolean, deps: {
  log?: (message: string) => void;
  writeConfig?: typeof writeVaultConfig;
  register?: typeof selfRegister;
} = {}): string | undefined {
  const log = deps.log ?? console.log;
  const validation = validateVaultName(requested);
  if (!validation.ok) throw new Error(validation.error);
  const name = validation.name;
  // Allow historical reserved names as sources, but never traversal.
  if (!/^[a-zA-Z0-9_-]+$/.test(old)) throw new Error("Invalid old vault name");
  if (old === name) throw new Error("Old and new vault names must differ");
  const config = readVaultConfig(old);
  if (!config || !existsSync(vaultDbPath(old))) throw new Error(`Vault "${old}" not found`);
  if (existsSync(vaultDir(name))) throw new Error(`Vault "${name}" already exists`);
  if (readHistoryMirrorPhase(old) === "paused" || existsSync(join(vaultDir(old), "history-import.lock"))) {
    throw new Error("Finish or cancel the history import before renaming this vault");
  }
  if (existsSync(historyImportRecoveryPath(old)) && readHistoryMirrorPhase(old) !== "retired") {
    throw new Error("Finish or cancel the history import recovery before renaming this vault");
  }
  if (!yes) {
    log(`This will back up vault "${old}", move ${vaultDir(old)} to ${vaultDir(name)}, and update its name and registration.`);
    log(`Stop the vault server first. To confirm: parachute-vault rename ${old} ${name} --yes`);
    return;
  }

  const from = vaultDir(old), to = vaultDir(name);
  const home = dirname(dirname(from));
  const globals = [join(home, "config.yaml"), join(home, ".env"), join(dirname(home), "services.json")];
  const snapshots = new Map<string, Buffer | null>();
  for (const path of globals) snapshots.set(path, existsSync(path) ? readFileSync(path) : null);
  const localFiles = ["vault.yaml", "mirror-config.yaml", "history-mirror-state.json", "history-import-recovery.json"];
  const originals = new Map<string, Buffer>();
  for (const file of localFiles) if (existsSync(join(from, file))) originals.set(file, readFileSync(join(from, file)));
  const backupRoot = join(dirname(from), ".rename-backups");
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const backup = mkdtempSync(join(backupRoot, `${old}-${new Date().toISOString().replace(/[:.]/g, "-")}-`));
  let moved = false;
  let db: Database | undefined;
  const changedGlobals = new Set<string>();
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rewritePath = (value: string) => value.replace(new RegExp(`^${escape(from)}(?=/|$)`), to);
  const hubOrigins = new Set<string>();
  for (const origin of [process.env.PARACHUTE_HUB_ORIGIN, ...(process.env.PARACHUTE_HUB_ORIGINS ?? "").split(",")]) {
    try { if (origin?.trim()) hubOrigins.add(new URL(origin.trim()).origin); } catch { /* Ignore invalid origins. */ }
  }
  const rewriteUrl = (value: string) => value.replace(
    new RegExp(`^(https?://[^/\\s\"'?#]+)/vault/${escape(old)}(?=/|[\"'\\s?#]|$)`),
    (match, authority: string) => {
      try {
        const url = new URL(authority);
        return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || hubOrigins.has(url.origin)
          ? `${authority}/vault/${name}` : match;
      } catch { return match; }
    },
  );
  // Rewrite scalar values, not arbitrary substrings of serialized files. Keep
  // comments, unknown keys, and line endings instead of reserializing the file.
  const rewriteValues = (text: string, routes = false) => {
    const rewrite = (value: string) => routes ? rewriteUrl(rewritePath(value)) : rewritePath(value);
    return text.replace(
      /"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|(^[ \t]*(?:[A-Za-z_][\w.-]*[=:][ \t]*|-[ \t]+(?:[A-Za-z_][\w.-]*:[ \t]*)?))([^"' \t\r\n][^\r\n]*)/gm,
      (token, prefix: string | undefined, plain: string | undefined) => {
        if (prefix !== undefined && plain !== undefined) {
          const [, value, suffix] = /^(.*?)([ \t]+#.*|[ \t]*)$/.exec(plain)!;
          return prefix + rewrite(value!) + suffix;
        }
        if (token.startsWith('"')) {
          try {
            const value = JSON.parse(token) as string;
            const updated = rewrite(value);
            return updated === value ? token : JSON.stringify(updated);
          } catch { return token; }
        }
        const value = token.slice(1, -1).replace(/''/g, "'");
        const updated = rewrite(value);
        return updated === value ? token : `'${updated.replace(/'/g, "''")}'`;
      },
    );
  };
  const rewriteAction = (text: string) => {
    try {
      const action = JSON.parse(text);
      if (typeof action?.webhook !== "string") return text;
      const webhook = rewriteUrl(action.webhook);
      if (webhook === action.webhook) return text;
      action.webhook = webhook;
      return JSON.stringify(action);
    } catch { return text; }
  };
  try {
    db = new Database(vaultDbPath(old), { readonly: true });
    db.prepare("VACUUM INTO ?").run(join(backup, "vault.db"));
    db.close(); db = undefined;
    for (const [file, body] of originals) writeFileSync(join(backup, file), body, { mode: 0o600 });
    mkdirSync(join(backup, "global"), { mode: 0o700 });
    for (const [path, body] of snapshots) if (body) writeFileSync(join(backup, "global", path.split("/").pop()!), body, { mode: 0o600 });
    log(`Backup: ${backup}`);
    renameSync(from, to); moved = true;
    (deps.writeConfig ?? writeVaultConfig)({ ...config, name }, originals.get("vault.yaml")!.toString());
    for (const [file, body] of originals) {
      if (file !== "vault.yaml") writeFileSync(join(to, file), rewriteValues(body.toString()));
    }
    db = new Database(vaultDbPath(name));
    db.exec("BEGIN IMMEDIATE");
    // Older databases may not yet have these tables/columns. Do not migrate
    // schemas merely to rename; update every binding that actually exists.
    for (const table of ["tokens", "oauth_codes", "mcp_mint_ledger"]) {
      const columns = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (columns.some(c => c.name === "vault_name")) db.query(`UPDATE ${table} SET vault_name=? WHERE vault_name=?`).run(name, old);
      // oauth_codes.scope (singular, vestigial) is intentionally not rewritten.
      if (columns.some(c => c.name === "scopes")) {
        const rows = db.query(`SELECT rowid, scopes FROM ${table} WHERE scopes IS NOT NULL`).all() as { rowid: number; scopes: string }[];
        for (const row of rows) {
          const scopes = row.scopes.split(" ").map(s => s.startsWith(`vault:${old}:`) ? `vault:${name}:${s.slice(old.length + 7)}` : s).join(" ");
          if (scopes !== row.scopes) db.query(`UPDATE ${table} SET scopes=? WHERE rowid=?`).run(scopes, row.rowid);
        }
      }
    }
    for (const [table, column] of [["attachments", "path"], ["triggers", "action"]] as const) {
      if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      const rows = db.query(`SELECT rowid, ${column} AS value FROM ${table}`).all() as { rowid: number; value: string }[];
      for (const row of rows) {
        const updated = table === "attachments" ? rewritePath(row.value) : rewriteAction(row.value);
        if (updated !== row.value) db.query(`UPDATE ${table} SET ${column}=? WHERE rowid=?`).run(updated, row.rowid);
      }
    }
    const global = readGlobalConfig();
    for (const path of globals.slice(0, 2)) {
      const body = snapshots.get(path);
      if (!body) continue;
      let updated = rewriteValues(body.toString(), true);
      // No other global config fields are maps keyed by vault name. Retain
      // unknown keys and legacy mirror config by editing the original YAML.
      if (path === globals[0] && global.default_vault === old) updated = updated.replace(/^default_vault:.*$/m, `default_vault: ${name}`);
      if (path === globals[1]) updated = updated.replace(
        new RegExp(`^(PARACHUTE_VAULT_NAME=)(["']?)${escape(old)}\\2([ \t]*(?:#.*)?)$`, "m"),
        `$1$2${name}$2$3`,
      );
      if (updated !== body.toString()) { changedGlobals.add(path); writeFileSync(path, updated); }
    }
    changedGlobals.add(globals[2]!);
    const result = (deps.register ?? selfRegister)({ version: pkg.version, log: () => {}, warn: () => {} });
    if (result.status === "failed") throw new Error(`Service registration ${result.status}: ${result.reason}`);
    if (result.status === "skipped") log(`Warning: service registration skipped: ${result.reason}`);
    db.exec("COMMIT");
    db.close(); db = undefined;
  } catch (error) {
    const failures: string[] = [];
    const recover = (fn: () => void) => { try { fn(); } catch (e) { failures.push(String(e)); } };
    if (db) recover(() => { db!.close(); db = undefined; });
    if (moved) {
      recover(() => renameSync(to, from));
      if (existsSync(from) && !existsSync(to)) {
        for (const [file, body] of originals) recover(() => writeFileSync(join(from, file), body));
        recover(() => {
          rmSync(`${vaultDbPath(old)}-wal`, { force: true });
          rmSync(`${vaultDbPath(old)}-shm`, { force: true });
          copyFileSync(join(backup, "vault.db"), vaultDbPath(old));
        });
      }
    }
    for (const path of changedGlobals) recover(() => {
      const body = snapshots.get(path);
      if (body) writeFileSync(path, body); else rmSync(path, { force: true });
    });
    throw new Error(`Rename failed: ${error}. ${failures.length ? `Rollback incomplete: ${failures.join("; ")}` : moved ? "Rolled back." : "Vault not moved."} Backup: ${backup}`);
  }
  log(`Vault "${old}" renamed to "${name}".`);
  log(`Once the rename is verified, you can delete the backup under .rename-backups/: ${backup}`);
  return backup;
}
