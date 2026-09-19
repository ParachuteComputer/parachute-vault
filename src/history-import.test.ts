import { test, expect, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { Database, SQLiteError } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { stageArchive, runHistoryImport, type ImportManifest, normalizeHistorySelections, type HistorySelections } from "./history-import.ts";
import { writeVaultConfig, writeGlobalConfig, vaultDbPath } from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { getImportedVersion } from "../core/src/history-import.ts";
import { historyMirrorStatePath, readHistoryMirrorPhase, mirrorConfigPath } from "./mirror-config.ts";
const noteId = "01M2KT1VQBHNZ99V5KSGXP6VSE";
for (const id of ["legacy:abc123", "2020-01-02-03-04-05", "shortid"]) {
  for (const sidecar of [false, true]) test(`legacy ID staging: ${id}, sidecar=${sidecar}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-stage-")), db = new Database(":memory:");
    try {
      const repo = repoAt(join(dir, "repo"));
      if (sidecar) {
        mkdirSync(join(repo, ".parachute/notes-meta"), { recursive: true });
        writeFileSync(join(repo, ".parachute/notes-meta/entry.yaml"), `id: ${id}\npath: entry\nextension: json\n`);
        writeFileSync(join(repo, "entry.json"), '{}');
        git(repo, "add", "."); git(repo, "commit", "-m", "sidecar");
      } else commit(repo, "legacy body", id);
      stageArchive(repo, git(repo, "rev-parse", "HEAD"), db);
      expect(db.query("SELECT note_id FROM observations").all()).toEqual([{ note_id: id }]);
      expect(db.query("SELECT * FROM issues").all()).toEqual([]);
      expect(db.query("SELECT * FROM quarantine").all()).toEqual([]);
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}
for (const id of ["a b", "a/b", "a.b", "a".repeat(65), "", "-leading"]) {
  for (const sidecar of [false, true]) test(`invalid ID staging: ${JSON.stringify(id)}, sidecar=${sidecar}`, () => {
    const dir = mkdtempSync(join(tmpdir(), "invalid-stage-")), db = new Database(":memory:");
    try {
      const repo = repoAt(join(dir, "repo"));
      const meta = `id: ${JSON.stringify(id)}\npath: entry\n`;
      if (sidecar) {
        mkdirSync(join(repo, ".parachute/notes-meta"), { recursive: true });
        writeFileSync(join(repo, ".parachute/notes-meta/entry.yaml"), meta + "extension: json\n");
        writeFileSync(join(repo, "entry.json"), '{}');
      } else writeFileSync(join(repo, "entry.md"), `---\n${meta}---\nbody`);
      git(repo, "add", "."); git(repo, "commit", "-m", "invalid");
      stageArchive(repo, git(repo, "rev-parse", "HEAD"), db);
      expect(db.query("SELECT * FROM observations").all()).toEqual([]);
      expect(db.query("SELECT reason FROM issues").all()).toContainEqual({ reason: sidecar ? "invalid_sidecar" : "invalid_id" });
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}
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
test("legacy duplicate IDs still quarantine and selection entries preserve exact identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "legacy-duplicate-")), db = new Database(":memory:");
  try {
    const repo = repoAt(join(dir, "repo")), id = "legacy:duplicate";
    commit(repo, "first", id); const tip = commit(repo, "second", id, "duplicate.md");
    stageArchive(repo, tip, db);
    expect(db.query("SELECT * FROM quarantine").all()).toEqual([{ note_id: id, reason: "duplicate_id" }]);
    expect(db.query("SELECT * FROM observations").all()).toEqual([]);
    const selections = normalizeHistorySelections({ format: 1, tip, source_fingerprint: "a".repeat(64), selections: [{
      note_id: id, commit: tip, selected: { git_path: "entry.md", blob: git(repo, "rev-parse", `${tip}:entry.md`) },
      rejected: [{ git_path: "duplicate.md", blob: git(repo, "rev-parse", `${tip}:duplicate.md`), reason: "explicit choice" }], reason: "explicit choice",
    }] });
    expect(selections.selections[0]!.note_id).toBe(id);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
test("legacy imports preserve exact IDs, receipts and idempotency; case mismatch never merges", async () => {
  const dir = mkdtempSync(join(tmpdir(), "legacy-import-")), saved = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = join(dir, "home");
  try {
    const probe = Bun.serve({ port: 0, fetch: () => new Response() }); const port = probe.port!; probe.stop(true);
    writeGlobalConfig({ port });
    writeVaultConfig({ name: "test", api_keys: [], created_at: new Date().toISOString() });
    const ids = ["legacy:abc123", "2020-01-02-03-04-05", "shortid"];
    const store = getVaultStore("test");
    for (const id of [...ids, "CaseId"]) await store.createNote("native", { id });
    clearVaultStoreCache();
    const repo = repoAt(join(dir, "repo"));
    for (const [i, id] of [...ids, "caseid"].entries()) commit(repo, "archive", id, `entry${i}.md`);
    let tip = git(repo, "rev-parse", "HEAD");
    const output = join(dir, "plan.json");
    await runHistoryImport(["plan", "--vault", "test", "--source", repo, "--through", tip, "--output", output]);
    const plan = JSON.parse(readFileSync(output, "utf8"));
    expect(plan.skipped).toEqual(["caseid"]);
    expect(plan.missing_at_tip).toEqual(["CaseId"]);
    expect(plan.notes.map((n: any) => n.id).sort()).toEqual([...ids].sort());
    // Resolve the fixture mismatch explicitly before prepare, never via coercion.
    commit(repo, "archive", "CaseId", "entry3.md"); tip = git(repo, "rev-parse", "HEAD");
    const manifest = join(dir, "final.json"), archive = join(dir, "archive.bundle");
    await runHistoryImport(["prepare", "--vault", "test", "--source", repo, "--through", tip, "--archive", archive, "--output", manifest]);
    await runHistoryImport(["apply", "--vault", "test", "--manifest", manifest, "--archive", archive]);
    const db = new Database(vaultDbPath("test"));
    try {
      const before = db.query("SELECT * FROM history_import_receipts ORDER BY note_id").all();
      expect(before).toHaveLength(4);
      for (const id of ids) expect(getImportedVersion(db, id, 0)?.content).toBe("archive");
      await runHistoryImport(["apply", "--vault", "test", "--manifest", manifest, "--archive", archive]);
      expect(db.query("SELECT * FROM history_import_receipts ORDER BY note_id").all()).toEqual(before);
      expect(db.query("SELECT id FROM notes ORDER BY id").all()).toEqual([...ids, "CaseId"].sort().map(id => ({ id })));
    } finally { db.close(); }
  } finally { clearVaultStoreCache(); if (saved === undefined) delete process.env.PARACHUTE_HOME; else process.env.PARACHUTE_HOME = saved; rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
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
    const savedGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = join(dir, "not-the-archive");
    try { await runHistoryImport(["apply", "--vault", "test", "--manifest", manifest, "--archive", archive]); }
    finally { if (savedGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = savedGitDir; }
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
    expect(await runHistoryImport(["retire", "--vault", "test", "--manifest", manifest])).toMatchObject({ retired: true });
    expect(getVaultStore("test")).toBeDefined();
  } finally { clearVaultStoreCache(); if (saved === undefined) delete process.env.PARACHUTE_HOME; else process.env.PARACHUTE_HOME = saved; rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

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
    if (priorConfig === null) {
      // Interrupted cancellation after restoring config/marker but before archiving its journal.
      rmSync(mirrorConfigPath("test"));
      writeFileSync(historyMirrorStatePath("test"), JSON.stringify({ phase: "active" }));
    }
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

for (const format of ["inline", "sidecar"] as const) for (const cache of ["object_cache", "parsed_cache"] as const) {
  test(`staging SQLite failure in ${format} ${cache} aborts without blaming source notes`, () => {
    const dir = mkdtempSync(join(tmpdir(), "import-stage-failure-")), stage = new Database(":memory:");
    const exec = stage.exec.bind(stage);
    const setup = spyOn(stage, "exec").mockImplementation((sql) => {
      const result = exec(sql);
      if (sql.startsWith("CREATE TABLE selection_failures")) {
        exec(`CREATE TRIGGER fail_cache BEFORE INSERT ON ${cache} BEGIN SELECT RAISE(ABORT, 'staging write failed'); END`);
      }
      return result;
    });
    try {
      const repo = repoAt(join(dir, "repo"));
      if (format === "inline") commit(repo, "valid body");
      else {
        mkdirSync(join(repo, ".parachute/notes-meta"), { recursive: true });
        writeFileSync(join(repo, `.parachute/notes-meta/${noteId}.yaml`), `id: ${noteId}\npath: entry\nextension: json\n`);
        writeFileSync(join(repo, "entry.json"), '{"valid":true}');
        git(repo, "add", "."); git(repo, "commit", "-m", "valid sidecar");
      }
      let failure: unknown;
      try { stageArchive(repo, git(repo, "rev-parse", "HEAD"), stage); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(SQLiteError);
      expect((failure as Error).message).toContain("staging write failed");
      expect(stage.query("SELECT * FROM issues").all()).toEqual([]);
      expect(stage.query("SELECT * FROM quarantine").all()).toEqual([]);
      expect(stage.query("SELECT * FROM observations").all()).toEqual([]);
    } finally { setup.mockRestore(); stage.close(); rmSync(dir, { recursive: true, force: true }); }
  });
}

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

function selectionFile(repo: string, tip: string, entries: HistorySelections["selections"]): HistorySelections {
  const walk = git(repo, "log", "--first-parent", "--reverse", "--format=%H %T", tip) + "\n";
  return { format: 1, tip, source_fingerprint: createHash("sha256").update(walk).digest("hex"), selections: entries };
}
function pin(repo: string, commitId: string, path: string) { return { git_path: path, blob: git(repo, "rev-parse", `${commitId}:${path}`) }; }
function selection(repo: string, commitId: string, selected: string, rejected: string, id = noteId): HistorySelections["selections"][number] {
  return { note_id: id, commit: commitId, selected: pin(repo, commitId, selected), rejected: [{ ...pin(repo, commitId, rejected), reason: "Retained stale export" }], reason: "Reviewed explicit fixture path" };
}
function selectedStage(repo: string, tip: string, selectors?: HistorySelections) {
  const db = new Database(":memory:");
  try {
    stageArchive(repo, tip, db, selectors);
    return {
      rows: (db.query("SELECT row_json FROM observations ORDER BY note_id,seq").all() as { row_json: string }[]).map(r => JSON.parse(r.row_json)),
      quarantine: db.query("SELECT * FROM quarantine ORDER BY note_id").all(),
      failures: db.query("SELECT * FROM selection_failures ORDER BY note_id,commit_id").all(),
    };
  } finally { db.close(); }
}

test("exact selections resolve duplicate trees regardless of Git path order; same bodies still require a selection", () => {
  const dir = mkdtempSync(join(tmpdir(), "selection-order-"));
  try {
    for (const selectedFirst of [true, false]) {
      const repo = repoAt(join(dir, String(selectedFirst))), oldPath = selectedFirst ? "z-old.md" : "a-old.md", newPath = selectedFirst ? "a-new.md" : "z-new.md";
      commit(repo, "old", noteId, oldPath); const tip = commit(repo, "selected", noteId, newPath);
      const selectors = selectionFile(repo, tip, [selection(repo, tip, newPath, oldPath)]);
      expect(selectedStage(repo, tip).quarantine).toEqual([{ note_id: noteId, reason: "duplicate_id" }]);
      const result = selectedStage(repo, tip, selectors);
      expect(result.quarantine).toEqual([]); expect(result.rows.map(r => r.content)).toEqual(["old", "selected"]);
      expect(result.rows[1].path).toBe("entry"); // Comes from frontmatter, not the Git path.
    }
    const repo = repoAt(join(dir, "same"));
    commit(repo, "same", noteId, "old.md");
    writeFileSync(join(repo, "new.md"), `---\nid: ${noteId}\npath: renamed\n---\nsame`);
    git(repo, "add", "."); git(repo, "commit", "-m", "same body, new path"); const tip = git(repo, "rev-parse", "HEAD");
    expect(selectedStage(repo, tip).quarantine).toHaveLength(1);
    const result = selectedStage(repo, tip, selectionFile(repo, tip, [selection(repo, tip, "new.md", "old.md")]));
    expect(result.rows.map(r => r.path)).toEqual(["entry", "renamed"]); expect(result.quarantine).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("stale selectors, candidate mismatches, rejected divergence and unlisted duplicate trees quarantine the whole note", () => {
  const dir = mkdtempSync(join(tmpdir(), "selection-refusal-"));
  try {
    const repo = repoAt(join(dir, "repo")); const first = commit(repo, "old", noteId, "old.md"), tip = commit(repo, "new", noteId, "new.md");
    const good = selectionFile(repo, tip, [selection(repo, tip, "new.md", "old.md")]);
    const bad: HistorySelections[] = [];
    for (const field of ["blob", "git_path"] as const) {
      const copy = structuredClone(good); copy.selections[0]!.selected[field] = field === "blob" ? "0".repeat(40) : "absent.md"; bad.push(copy);
      const rejected = structuredClone(good); rejected.selections[0]!.rejected[0]![field] = field === "blob" ? "0".repeat(40) : "absent.md"; bad.push(rejected);
    }
    const extra = structuredClone(good); extra.selections[0]!.rejected.push({ git_path: "third.md", blob: good.selections[0]!.selected.blob, reason: "Not present" }); bad.push(extra);
    const singleton = structuredClone(good); singleton.selections.push({ ...selection(repo, tip, "old.md", "new.md"), commit: first }); bad.push(singleton);
    const missing = structuredClone(good); missing.selections = []; bad.push(missing);
    const absent = structuredClone(good); absent.selections[0]!.note_id = "01M2KT4GXMQDNB8ZFXY05MHT6B"; bad.push(absent);
    for (const selectors of bad) {
      const result = selectedStage(repo, tip, selectors);
      expect(result.rows).toEqual([]); expect(result.quarantine).toContainEqual({ note_id: noteId, reason: "duplicate_id" }); expect(result.failures.length).toBeGreaterThan(0);
    }
    const changed = commit(repo, "rejected diverged", noteId, "old.md");
    const divergent = selectionFile(repo, changed, [...good.selections, { ...good.selections[0]!, commit: changed }]);
    expect(selectedStage(repo, changed, divergent).failures).toContainEqual({ note_id: noteId, commit_id: changed, reason: "candidate_set_mismatch" });
    const third = commit(repo, "third candidate", noteId, "third.md");
    const unlisted = selectionFile(repo, third, [...good.selections, selection(repo, changed, "new.md", "old.md")]);
    expect(selectedStage(repo, third, unlisted).rows).toEqual([]);
    expect(selectedStage(repo, third, { ...unlisted, selections: [...unlisted.selections, selection(repo, third, "new.md", "old.md")] }).failures).toContainEqual({ note_id: noteId, commit_id: third, reason: "candidate_set_mismatch" });
    expect(() => selectedStage(repo, tip, { ...good, source_fingerprint: "0".repeat(64) })).toThrow("fingerprint");
    expect(() => selectedStage(repo, tip, { ...good, tip: first })).toThrow("tip");
    const foreign = structuredClone(good); foreign.selections[0]!.commit = "0".repeat(40);
    expect(() => selectedStage(repo, tip, foreign)).toThrow("first-parent");
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("selections cannot clear ambiguous sidecars or oversized observations", () => {
  const dir = mkdtempSync(join(tmpdir(), "selection-causes-"));
  try {
    const repo = repoAt(join(dir, "sidecars")), other = "01M2KT4GXMQDNB8ZFXY05MHT6B";
    mkdirSync(join(repo, ".parachute/notes-meta"), { recursive: true });
    for (const id of [noteId, other]) writeFileSync(join(repo, `.parachute/notes-meta/${id}.yaml`), `id: ${id}\npath: shared\nextension: json\n`);
    writeFileSync(join(repo, "shared.json"), "{}"); const tip = commit(repo, "inline selected", noteId, "inline.md");
    const item = selection(repo, tip, "inline.md", "shared.json");
    item.rejected[0]!.sidecar = pin(repo, tip, `.parachute/notes-meta/${noteId}.yaml`);
    const result = selectedStage(repo, tip, selectionFile(repo, tip, [item]));
    expect(result.failures).toEqual([]); // The exact successful set matches; another cause remains authoritative.
    expect(result.quarantine).toContainEqual({ note_id: noteId, reason: "ambiguous_sidecar" }); expect(result.rows).toEqual([]);
    const large = repoAt(join(dir, "large")); commit(large, "x".repeat(2_000_001), noteId, "bad.md");
    commit(large, "old", noteId, "old.md"); const end = commit(large, "new", noteId, "new.md");
    const kept = selectedStage(large, end, selectionFile(large, end, [selection(large, end, "new.md", "old.md")]));
    expect(kept.failures).toEqual([]); expect(kept.quarantine).toEqual([{ note_id: noteId, reason: "oversized_body" }]); expect(kept.rows).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

test("selection normalization rejects malformed pins and canonicalizes array order", () => {
  const ref = { git_path: "a.md", blob: "a".repeat(40) }, other = { git_path: "b.md", blob: "b".repeat(40), reason: "kept" };
  const input: HistorySelections = { format: 1, tip: "c".repeat(40), source_fingerprint: "d".repeat(64), selections: [{ note_id: noteId, commit: "c".repeat(40), selected: ref, rejected: [other, { ...other, git_path: "c.md" }], reason: "audit" }, { note_id: noteId, commit: "e".repeat(40), selected: ref, rejected: [other], reason: "audit" }] };
  const reversed = structuredClone(input); reversed.selections.reverse(); for (const s of reversed.selections) s.rejected.reverse();
  expect(normalizeHistorySelections(input)).toEqual(normalizeHistorySelections(reversed));
  expect(() => normalizeHistorySelections({ ...input, body: "not permitted" })).toThrow();
  expect(() => normalizeHistorySelections({ ...input, selections: [input.selections[0], input.selections[0]] })).toThrow("Duplicate selection");
  expect(() => normalizeHistorySelections({ ...input, selections: [{ ...input.selections[0], reason: "" }] })).toThrow("reasons");
  expect(() => normalizeHistorySelections({ ...input, selections: [{ ...input.selections[0], selected: { ...ref, git_path: "../a.md" } }] })).toThrow("reference");
});

test("partial selections block apply; complete selections are embedded and restage to the projected digest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "selection-cutover-")), saved = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = join(dir, "home");
  try {
    const probe = Bun.serve({ port: 0, fetch: () => new Response() }); const port = probe.port!; probe.stop(true); writeGlobalConfig({ port });
    writeVaultConfig({ name: "test", api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore("test"), a = await store.createNote("native A"), b = await store.createNote("native B"); clearVaultStoreCache();
    const repo = repoAt(join(dir, "repo")); commit(repo, "a old", a.id, "a-old.md"); const t1 = commit(repo, "a new", a.id, "a-new.md");
    const t2 = commit(repo, "b old", b.id, "b-old.md"), tip = commit(repo, "b new", b.id, "b-new.md");
    const partial = selectionFile(repo, tip, [t1,t2,tip].map(c => selection(repo, c, "a-new.md", "a-old.md", a.id)));
    const complete = selectionFile(repo, tip, [...partial.selections, selection(repo, tip, "b-new.md", "b-old.md", b.id)]);
    const file = join(dir, "selections.json"); writeFileSync(file, JSON.stringify(partial));
    for (const command of ["apply", "retire", "cancel"]) await expect(runHistoryImport([command, "--selections", file])).rejects.toThrow("only valid for plan/prepare");
    const prepared = join(dir, "partial.json"), archive = join(dir, "partial.bundle");
    const p = await runHistoryImport(["prepare", "--vault", "test", "--source", repo, "--through", tip, "--selections", file, "--archive", archive, "--output", prepared]) as ImportManifest;
    expect(p.quarantined).toEqual([{ note_id: b.id, reason: "duplicate_id" }]);
    await expect(runHistoryImport(["apply", "--vault", "test", "--manifest", prepared, "--archive", archive])).rejects.toThrow("Quarantined");
    await runHistoryImport(["cancel", "--vault", "test"]);
    writeFileSync(file, JSON.stringify(complete));
    const finalPath = join(dir, "final.json"), bundle = join(dir, "final.bundle");
    const final = await runHistoryImport(["prepare", "--vault", "test", "--source", repo, "--through", tip, "--selections", file, "--archive", bundle, "--output", finalPath]) as ImportManifest;
    expect(final.quarantined).toEqual([]); expect(final.options_digest).not.toBe(p.options_digest); expect(final.selections_digest).not.toBe(p.selections_digest);
    expect(final.selections).toEqual(normalizeHistorySelections(complete)); expect(final.notes).toHaveLength(2);
    expect(final.notes.every(n => n.native_drops.length === 0)).toBe(true);
    rmSync(file); // Apply cannot consult the original selectors file.
    await runHistoryImport(["apply", "--vault", "test", "--manifest", finalPath, "--archive", bundle]);
    const db = new Database(vaultDbPath("test"), { readonly: true });
    try {
      expect(getImportedVersion(db, a.id, 0)?.content).toBe("a new"); expect(getImportedVersion(db, b.id, 0)?.content).toBe("b new");
      for (const note of final.notes) expect(db.query("SELECT state_digest FROM history_import_receipts WHERE note_id=?").get(note.id)).toEqual({ state_digest: note.state_digest });
      expect(db.query("SELECT content FROM notes ORDER BY content").all()).toEqual([{ content: "native A" }, { content: "native B" }]);
    } finally { db.close(); }
  } finally { clearVaultStoreCache(); if (saved === undefined) delete process.env.PARACHUTE_HOME; else process.env.PARACHUTE_HOME = saved; rmSync(dir, { recursive: true, force: true }); }
}, 30_000);


test("valid sidecar candidate selection binds both content and metadata blobs", () => {
  const dir = mkdtempSync(join(tmpdir(), "selection-sidecar-valid-"));
  try {
    const repo = repoAt(join(dir, "repo")); mkdirSync(join(repo, ".parachute/notes-meta"), { recursive: true });
    for (const path of ["old", "new"]) {
      writeFileSync(join(repo, `${path}.json`), JSON.stringify({ value: path }));
      writeFileSync(join(repo, `.parachute/notes-meta/${path}.yaml`), `id: ${noteId}\npath: ${path}\nextension: json\n`);
    }
    git(repo, "add", "."); git(repo, "commit", "-m", "sidecar duplicates"); const tip = git(repo, "rev-parse", "HEAD");
    const item = selection(repo, tip, "new.json", "old.json");
    item.selected.sidecar = pin(repo, tip, ".parachute/notes-meta/new.yaml");
    item.rejected[0]!.sidecar = pin(repo, tip, ".parachute/notes-meta/old.yaml");
    const selectors = selectionFile(repo, tip, [item]), result = selectedStage(repo, tip, selectors);
    expect(result.quarantine).toEqual([]); expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ path: "new", extension: "json", content: '{"value":"new"}' });
    const stale = structuredClone(selectors); stale.selections[0]!.selected.sidecar!.blob = "0".repeat(40);
    expect(selectedStage(repo, tip, stale).quarantine).toEqual([{ note_id: noteId, reason: "duplicate_id" }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30_000);
