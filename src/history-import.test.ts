import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { stageArchive, runHistoryImport, type ImportManifest } from "./history-import.ts";
import { writeVaultConfig, writeGlobalConfig, vaultDbPath } from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { getImportedVersion } from "../core/src/history-import.ts";
import { historyMirrorStatePath, readHistoryMirrorPhase, mirrorConfigPath } from "./mirror-config.ts";
const noteId = "01M2KT1VQBHNZ99V5KSGXP6VSE";
function git(dir: string, ...args: string[]) {
  const p = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.test", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.test" } });
  if (p.status !== 0) throw new Error(p.stderr); return p.stdout.trim();
}
function repoAt(dir: string) { mkdirSync(dir); git(dir, "init", "-b", "main"); return dir; }
function commit(dir: string, content: string, id = noteId, path = "entry.md") {
  writeFileSync(join(dir, path), `---\nid: ${id}\npath: entry\ncreated_at: 2026-01-01T00:00:00Z\n---\n${content}`);
  git(dir, "add", "."); git(dir, "commit", "-m", "observation"); return git(dir, "rev-parse", "HEAD");
}
test("git staging preserves exported CRLF bodies and A-B-A while quarantining duplicate IDs", () => {
  const dir = mkdtempSync(join(tmpdir(), "import-stage-"));
  const db = new Database(":memory:");
  try {
    const repo = repoAt(join(dir, "repo"));
    commit(repo, "A\r\n"); commit(repo, "B\r\n"); const tip = commit(repo, "A\r\n");
    const result = stageArchive(repo, tip, db);
    expect(result.commits).toBe(3);
    const rows = db.query("SELECT row_json FROM observations ORDER BY seq").all() as { row_json: string }[];
    expect(rows.map(r => JSON.parse(r.row_json).content)).toEqual(["A\r\n", "B\r\n", "A\r\n"]);
    const duplicate = commit(repo, "different", noteId, "duplicate.md");
    const second = new Database(":memory:");
    try { stageArchive(repo, duplicate, second); expect(second.query("SELECT reason FROM quarantine").all()).toEqual([{ reason: "duplicate_id" }]); expect(second.query("SELECT * FROM observations").all()).toEqual([]); } finally { second.close(); }
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("offline prepare applies verified bundle, retries without resurrection, then retires", async () => {
  const dir = mkdtempSync(join(tmpdir(), "import-cutover-")), saved = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = join(dir, "home");
  try {
    // Reserve then release a random loopback port so the guard cannot hit production.
    const probe = Bun.serve({ port: 0, fetch: () => new Response() }); const port = probe.port!; probe.stop(true);
    writeGlobalConfig({ port });
    writeVaultConfig({ name: "test", api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore("test"); const note = await store.createNote("native"); clearVaultStoreCache();
    const repo = repoAt(join(dir, "repo")); commit(repo, "old", note.id); const tip = commit(repo, "recent", note.id);
    const diagnostic = join(dir, "plan.json"), manifest = join(dir, "final.json"), archive = join(dir, "archive.bundle");
    const oldSchema = new Database(vaultDbPath("test"));
    oldSchema.exec("DROP TABLE history_import_refs; DROP TABLE history_import_receipts; DROP TABLE history_import_runs; UPDATE schema_version SET version=30");
    oldSchema.close();
    const before = readFileSync(vaultDbPath("test"));
    await runHistoryImport(["plan", "--vault", "test", "--source", repo, "--through", tip, "--output", diagnostic]);
    expect(readFileSync(vaultDbPath("test"))).toEqual(before);
    await runHistoryImport(["prepare", "--vault", "test", "--source", repo, "--through", tip, "--archive", archive, "--output", manifest]);
    expect(readHistoryMirrorPhase("test")).toBe("paused");
    expect(() => getVaultStore("test")).toThrow("paused");
    expect(readFileSync(mirrorConfigPath("test"), "utf8")).toContain("enabled: false");
    const m = JSON.parse(readFileSync(manifest, "utf8")) as ImportManifest;
    expect(m.notes).toHaveLength(1);
    commit(repo, "changed after bundle", note.id);
    await runHistoryImport(["apply", "--vault", "test", "--manifest", manifest, "--archive", archive]);
    const db = new Database(vaultDbPath("test"));
    try {
      expect(getImportedVersion(db, note.id, 0)?.content).toBe("recent");
      expect(db.query("SELECT content FROM notes WHERE id=?").get(note.id)).toEqual({ content: "native" });
      db.exec("DELETE FROM note_versions");
    } finally { db.close(); }
    await runHistoryImport(["apply", "--vault", "test", "--manifest", manifest, "--archive", archive]);
    const check = new Database(vaultDbPath("test"), { readonly: true });
    try { expect(check.query("SELECT count(*) n FROM note_versions").get()).toEqual({ n: 0 }); } finally { check.close(); }
    await expect(runHistoryImport(["cancel", "--vault", "test"])).rejects.toThrow("Receipts exist");
    await runHistoryImport(["retire", "--vault", "test", "--manifest", manifest]);
    expect(readHistoryMirrorPhase("test")).toBe("retired");
    expect(getVaultStore("test")).toBeDefined();
  } finally { clearVaultStoreCache(); if (saved === undefined) delete process.env.PARACHUTE_HOME; else process.env.PARACHUTE_HOME = saved; rmSync(dir, { recursive: true, force: true }); }
});

for (const priorConfig of [null, "mirror:\n  enabled: true\n  location: internal\n"]) test(`prepare cancellation restores ${priorConfig === null ? "absent" : "present"} config and explicit active marker`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "import-cancel-")), saved = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = join(dir, "home");
  try {
    const probe = Bun.serve({ port: 0, fetch: () => new Response() }); const port = probe.port!; probe.stop(true); writeGlobalConfig({ port });
    writeVaultConfig({ name: "test", api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore("test"), note = await store.createNote("native"); clearVaultStoreCache();
    if (priorConfig !== null) writeFileSync(mirrorConfigPath("test"), priorConfig);
    const repo = repoAt(join(dir, "repo")), tip = commit(repo, "old", note.id);
    await runHistoryImport(["prepare", "--vault", "test", "--source", repo, "--through", tip, "--archive", join(dir, "archive.bundle"), "--output", join(dir, "final.json")]);
    await runHistoryImport(["cancel", "--vault", "test"]);
    if (priorConfig === null) expect(() => readFileSync(mirrorConfigPath("test"))).toThrow();
    else expect(readFileSync(mirrorConfigPath("test"), "utf8")).toBe(priorConfig);
    expect(JSON.parse(readFileSync(historyMirrorStatePath("test"), "utf8"))).toEqual({ phase: "active" });
  } finally { clearVaultStoreCache(); if (saved === undefined) delete process.env.PARACHUTE_HOME; else process.env.PARACHUTE_HOME = saved; rmSync(dir, { recursive: true, force: true }); }
});

test("ambiguous sidecars quarantine both identities; malformed YAML diagnostics contain no source text", () => {
  const dir = mkdtempSync(join(tmpdir(), "import-sidecar-")), stage = new Database(":memory:");
  try {
    const repo = repoAt(join(dir, "repo"));
    mkdirSync(join(repo, ".parachute/notes-meta"), { recursive: true });
    const other = "01M2KT4GXMQDNB8ZFXY05MHT6B";
    for (const id of [noteId, other]) writeFileSync(join(repo, `.parachute/notes-meta/${id}.yaml`), `id: ${id}\npath: shared\nextension: json\n`);
    writeFileSync(join(repo, "shared.json"), '{"value":1}');
    writeFileSync(join(repo, "bad.md"), '---\nid: [PRIVATE_SENTINEL\n---\nbody');
    git(repo, "add", "."); git(repo, "commit", "-m", "ambiguous");
    stageArchive(repo, git(repo, "rev-parse", "HEAD"), stage);
    expect(stage.query("SELECT note_id FROM quarantine ORDER BY note_id").all()).toEqual([noteId, other].sort().map(note_id => ({ note_id })));
    expect(stage.query("SELECT * FROM observations").all()).toEqual([]);
    expect(JSON.stringify(stage.query("SELECT * FROM issues").all())).not.toContain("PRIVATE_SENTINEL");
  } finally { stage.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("running daemon refuses prepare before creating a pause marker or backup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "import-busy-")), saved = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = dir;
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ status: "ok" }) });
  try {
    writeGlobalConfig({ port: server.port! });
    writeVaultConfig({ name: "test", api_keys: [], created_at: new Date().toISOString() });
    await expect(runHistoryImport(["prepare", "--vault", "test"])).rejects.toThrow("Stop the vault daemon");
    expect(() => readFileSync(historyMirrorStatePath("test"))).toThrow();
  } finally { server.stop(true); if (saved === undefined) delete process.env.PARACHUTE_HOME; else process.env.PARACHUTE_HOME = saved; rmSync(dir, { recursive: true, force: true }); }
});

test("oversized revision quarantines its whole note while other identities remain staged", () => {
  const dir = mkdtempSync(join(tmpdir(), "import-overflow-")), db = new Database(":memory:");
  try {
    const repo = repoAt(join(dir, "repo")); commit(repo, "small");
    commit(repo, "x".repeat(2_000_001));
    const other = "01M2KT4GXMQDNB8ZFXY05MHT6B", tip = commit(repo, "healthy", other, "healthy.md");
    stageArchive(repo, tip, db);
    expect(db.query("SELECT * FROM quarantine").all()).toEqual([{ note_id: noteId, reason: "oversized_body" }]);
    expect(db.query("SELECT DISTINCT note_id FROM observations").all()).toEqual([{ note_id: other }]);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("first-parent import sees side-branch notes only in the merge tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "import-merge-")), db = new Database(":memory:");
  try {
    const repo = repoAt(join(dir, "repo")); commit(repo, "base");
    git(repo, "checkout", "-b", "side");
    const other = "01M2KT4GXMQDNB8ZFXY05MHT6B"; commit(repo, "side", other, "side.md");
    git(repo, "checkout", "main"); commit(repo, "main");
    git(repo, "merge", "--no-ff", "side", "-m", "merge result"); const tip = git(repo, "rev-parse", "HEAD");
    expect(stageArchive(repo, tip, db).commits).toBe(3);
    const side = db.query("SELECT row_json FROM observations WHERE note_id=?").get(other) as { row_json: string };
    expect(JSON.parse(side.row_json).commit).toBe(tip);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
