/** Offline git-history import. Git objects are data; no working tree is checked out. */
import { Database, SQLiteError } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { applyImportedNote, beginImportRun, canonicalJson, importObservationDigest, importTargetDigest, readImportReceipt, type ImportedObservation, type ImportRun } from "../core/src/history-import.ts";
import { hashContent, resolveHistoryPolicy, VERSION_MAX_BYTES, type HistoryPolicy } from "../core/src/history.ts";
import { applyConnectionPragmas, initSchema } from "../core/src/schema.ts";
import { DEFAULT_PORT, readGlobalConfig, readVaultConfig, vaultDbPath, vaultDir } from "./config.ts";
import { checkHealth } from "./health.ts";
import { defaultMirrorConfig, historyImportRecoveryPath, historyMirrorStatePath, mirrorConfigPath, readHistoryMirrorPhase, readMirrorConfigForVault, serializeMirrorConfig } from "./mirror-config.ts";

const MAX_OUTPUT = 32 * 1024 * 1024;
const MAX_COMMITS = 100_000;
const MAX_OBJECTS = 10_000_000;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });
class GitArchiveError extends Error {}
function git(repo: string, args: string[]): Buffer {
  const environment = { ...process.env };
  // A caller's GIT_DIR/object/config variables must not redirect the private bundle reader.
  for (const key of Object.keys(environment)) if (key.startsWith("GIT_")) delete environment[key];
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", "-C", repo, ...args], {
    encoding: "buffer", maxBuffer: MAX_OUTPUT,
    env: { ...environment, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (result.error || result.status !== 0) throw new GitArchiveError(`Git ${args[0]} failed; verify complete local archive (${result.error?.message ?? result.status})`);
  return result.stdout;
}
function text(bytes: Uint8Array): string { return decoder.decode(bytes); }
function object(repo: string, hash: string): string {
  const size = Number(text(git(repo, ["cat-file", "-s", hash])).trim());
  if (!Number.isSafeInteger(size) || size > VERSION_MAX_BYTES + 256_000) throw new Error("oversized_object");
  return text(git(repo, ["cat-file", "blob", hash]));
}
function mapping(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_metadata");
  return value as Record<string, unknown>;
}
function yaml(raw: string): Record<string, unknown> { return mapping(Bun.YAML.parse(raw)); }
function inline(raw: string): { meta: Record<string, unknown>; content: string } {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)^---(?:\r?\n|$)/m.exec(raw);
  if (!match || match.index !== 0) throw new Error("missing_frontmatter");
  return { meta: yaml(match[1]!), content: raw.slice(match[0].length) };
}
function observation(meta: Record<string, unknown>, content: string, commit: string, blob: string, time: string): { id: string; row: ImportedObservation } {
  if (typeof meta.id !== "string" || !ID.test(meta.id)) throw new Error("invalid_id");
  if (Buffer.byteLength(content) > VERSION_MAX_BYTES) throw new Error("oversized_body");
  const path = meta.path ?? null, extension = meta.extension ?? "md", created = meta.created_at ?? null;
  if (path !== null && (typeof path !== "string" || path.includes("\0") || path.split("/").includes(".."))) throw new Error("invalid_path");
  if (typeof extension !== "string" || !/^[a-z0-9]+$/.test(extension)) throw new Error("invalid_extension");
  if (created !== null && (typeof created !== "string" || !Number.isFinite(Date.parse(created)))) throw new Error("invalid_created_at");
  return { id: meta.id, row: { content, path, extension, created_at: created, metadata: meta.metadata === undefined ? {} : mapping(meta.metadata), observed_at: time, commit, blob } };
}
export interface HistoryCandidateRef { git_path: string; blob: string; sidecar?: { git_path: string; blob: string }; }
export interface HistorySelection {
  note_id: string; commit: string; selected: HistoryCandidateRef;
  rejected: (HistoryCandidateRef & { reason: string })[]; reason: string;
}
export interface HistorySelections { format: 1; tip: string; source_fingerprint: string; selections: HistorySelection[]; }
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function selectionObject(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k))) throw new Error("Invalid selections object");
  return input as Record<string, unknown>;
}
function selectionReason(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) throw new Error("Selections require audit reasons");
  return input;
}
function candidateRef(input: unknown, rejected = false): HistoryCandidateRef {
  const value = selectionObject(input, rejected ? ["git_path", "blob", "sidecar", "reason"] : ["git_path", "blob", "sidecar"]);
  if (typeof value.git_path !== "string" || !value.git_path || value.git_path.startsWith("/") || value.git_path.includes("\0") || value.git_path.split("/").some(p => p === ".." || p === "." || !p) || typeof value.blob !== "string" || !OBJECT_ID.test(value.blob)) throw new Error("Invalid selection candidate reference");
  const ref: HistoryCandidateRef = { git_path: value.git_path, blob: value.blob };
  if (value.sidecar !== undefined) {
    selectionObject(value.sidecar, ["git_path", "blob"]);
    ref.sidecar = candidateRef(value.sidecar);
  }
  return ref;
}
/** Canonical ordering makes options independent of selector/rejected array order. */
export function normalizeHistorySelections(input: unknown): HistorySelections {
  const value = selectionObject(input, ["format", "tip", "source_fingerprint", "selections"]);
  if (value.format !== 1 || typeof value.tip !== "string" || !OBJECT_ID.test(value.tip) || typeof value.source_fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.source_fingerprint) || !Array.isArray(value.selections) || value.selections.length > 100_000) throw new Error("Invalid selections header or entry limit (100,000)");
  const seen = new Set<string>();
  const selections = value.selections.map(raw => {
    const entry = selectionObject(raw, ["note_id", "commit", "selected", "rejected", "reason"]);
    if (typeof entry.note_id !== "string" || !ID.test(entry.note_id) || typeof entry.commit !== "string" || !OBJECT_ID.test(entry.commit) || !Array.isArray(entry.rejected) || !entry.rejected.length) throw new Error("Invalid selection entry");
    const key = `${entry.note_id}:${entry.commit}`;
    if (seen.has(key)) throw new Error("Duplicate selection note/commit");
    seen.add(key);
    const selected = candidateRef(entry.selected), paths = new Set([selected.git_path]);
    const rejected = entry.rejected.map(raw => {
      const ref = candidateRef(raw, true);
      if (paths.has(ref.git_path)) throw new Error("Duplicate selection candidate path");
      paths.add(ref.git_path);
      return { ...ref, reason: selectionReason((raw as Record<string, unknown>).reason) };
    }).sort((a, b) => compareText(canonicalJson(candidateRef(a, true)), canonicalJson(candidateRef(b, true))));
    return { note_id: entry.note_id, commit: entry.commit, selected, rejected, reason: selectionReason(entry.reason) };
  }).sort((a, b) => compareText(`${a.note_id}:${a.commit}`, `${b.note_id}:${b.commit}`));
  const result: HistorySelections = { format: 1, tip: value.tip, source_fingerprint: value.source_fingerprint, selections };
  if (Buffer.byteLength(canonicalJson(result)) > MAX_OUTPUT) throw new Error("Selections exceed 32 MiB");
  return result;
}
function selectionsDigest(selections: HistorySelections | null): string | null { return selections ? hashContent(canonicalJson(selections)) : null; }
function optionsDigest(policy: HistoryPolicy, waivers: Record<string, string>, selections: HistorySelections | null): string {
  return hashContent(canonicalJson({ parser: 1, policy, waivers, ...(selections ? { selections_digest: selectionsDigest(selections) } : {}) }));
}

export interface StagedArchive { source_fingerprint: string; tip: string; commits: number; objects: number; bytes: number; }
/** Disk-backed staging bounds memory to one git tree and one note body. */
export function stageArchive(repo: string, tip: string, stage: Database, inputSelections?: HistorySelections | null): StagedArchive {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tip)) throw new Error("through must be a full commit hash");
  if (text(git(repo, ["rev-parse", "--is-shallow-repository"])).trim() !== "false") throw new Error("Shallow archives are not supported");
  if (text(git(repo, ["rev-parse", `${tip}^{commit}`])).trim() !== tip) throw new Error("Tip is not a commit");
  git(repo, ["rev-list", "--objects", "--missing=error", tip]);
  const commits = text(git(repo, ["log", "--first-parent", "--reverse", "--format=%H %T %cI", tip])).trim().split("\n");
  if (commits.length > MAX_COMMITS) throw new Error("Archive commit limit exceeded");
  const selections = inputSelections == null ? null : normalizeHistorySelections(inputSelections);
  if (selections && selections.tip !== tip) throw new Error("Selections tip differs from archive");
  const commitIds = new Set(commits.map(c => c.split(" ")[0]!));
  const byCommit = new Map<string, Map<string, HistorySelection>>();
  for (const selection of selections?.selections ?? []) {
    if (!commitIds.has(selection.commit)) throw new Error("Selection commit is not on the first-parent walk");
    let entries = byCommit.get(selection.commit);
    if (!entries) byCommit.set(selection.commit, entries = new Map());
    entries.set(selection.note_id, selection);
  }
  stage.exec("CREATE TABLE selection_failures(note_id TEXT, commit_id TEXT, reason TEXT); CREATE TABLE observations(note_id TEXT NOT NULL, seq INTEGER NOT NULL, state TEXT NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY(note_id,seq)); CREATE TABLE quarantine(note_id TEXT PRIMARY KEY, reason TEXT NOT NULL); CREATE TABLE issues(commit_id TEXT, path TEXT, reason TEXT); CREATE TABLE tip_ids(note_id TEXT PRIMARY KEY); CREATE TABLE object_cache(hash TEXT PRIMARY KEY, content TEXT NOT NULL); CREATE TABLE parsed_cache(hash TEXT PRIMARY KEY, note_id TEXT NOT NULL, state TEXT NOT NULL, row_json TEXT NOT NULL)");
  const fingerprint = createHash("sha256");
  let objects = 0, bytes = 0;
  const lastStates = new Map<string, string>();
  const identities = new Set<string>();
  const parsedGet = stage.prepare("SELECT note_id,state FROM parsed_cache WHERE hash=?");
  const parsedBody = stage.prepare("SELECT row_json FROM parsed_cache WHERE hash=?");
  const parsedPut = stage.prepare("INSERT OR IGNORE INTO parsed_cache VALUES(?,?,?,?)");
  const insertObservation = stage.prepare("INSERT INTO observations VALUES(?,?,?,?)");
  const markQuarantine = stage.prepare("INSERT OR IGNORE INTO quarantine VALUES(?,?)");
  const markTip = stage.prepare("INSERT OR IGNORE INTO tip_ids VALUES(?)");
  for (let seq = 0; seq < commits.length; seq++) {
    const [commit, tree, time] = commits[seq]!.split(" ");
    if (!commit || !tree || !time || !Number.isFinite(Date.parse(time))) throw new Error("Invalid commit record");
    fingerprint.update(`${commit} ${tree}\n`);
    const entries = text(git(repo, ["ls-tree", "-rz", "--full-tree", commit])).split("\0").filter(Boolean).map(record => {
      const tab = record.indexOf("\t"), [mode, type, hash] = record.slice(0, tab).split(" ");
      if (tab < 0 || !hash) throw new Error("Invalid tree record");
      return { mode, type, hash, path: record.slice(tab + 1) };
    });
    objects += entries.length;
    if (objects > MAX_OBJECTS) throw new Error("Archive object limit exceeded");
    const files = new Map(entries.map(e => [e.path, e]));
    const used = new Set<string>(), sidecarOwners = new Map<string, string>();
    const candidates = new Map<string, { ref: HistoryCandidateRef; state: string; row: () => ImportedObservation }[]>();
    const read = (entry: typeof entries[number]) => {
      if (entry.mode !== "100644" && entry.mode !== "100755") throw new Error("unsupported_tree_entry");
      const cached = stage.prepare("SELECT content FROM object_cache WHERE hash=?").get(entry.hash) as { content: string } | null;
      if (cached) return cached.content;
      const value = object(repo, entry.hash); bytes += Buffer.byteLength(value);
      if (bytes > MAX_BYTES) throw new Error("Archive byte limit exceeded");
      stage.prepare("INSERT INTO object_cache VALUES(?,?)").run(entry.hash, value);
      return value;
    };
    const collect = (id: string, state: string, row: () => ImportedObservation, ref: HistoryCandidateRef) => {
      if (!identities.has(id) && identities.size >= 100_000) throw new Error("Archive note limit exceeded");
      identities.add(id);
      let group = candidates.get(id);
      if (!group) candidates.set(id, group = []);
      group.push({ ref, state, row });
    };
    const parseObservation = (meta: Record<string, unknown>, body: string, entry: typeof entries[number]) => {
      const { id, row } = observation(meta, body, commit, entry.hash, time);
      const state = hashContent(canonicalJson({ content: row.content, path: row.path, metadata: row.metadata, extension: row.extension, created_at: row.created_at }));
      return { id, row, state };
    };
    const accept = (meta: Record<string, unknown>, body: string, entry: typeof entries[number], sidecar: { git_path: string; blob: string }) => {
      const { id, row, state } = parseObservation(meta, body, entry);
      const cacheKey = `${entry.hash}:${sidecar.blob}`;
      parsedPut.run(cacheKey, id, state, JSON.stringify(row));
      collect(id, state, () => JSON.parse((parsedBody.get(cacheKey) as { row_json: string }).row_json), { git_path: entry.path, blob: entry.hash, sidecar });
    };
    const failure = (entry: typeof entries[number], error: unknown, id?: unknown) => {
      // Staging/cache failures are operational, not evidence of malformed source.
      // Abort so no diagnostic manifest can bless an incomplete archive walk.
      if (error instanceof SQLiteError) throw error;
      const message = error instanceof Error ? error.message : "invalid_observation";
      const reason = /^[a-z_]+$/.test(message) ? message : "invalid_metadata_or_utf8";
      if (error instanceof GitArchiveError || message === "Archive byte limit exceeded" || message === "Archive note limit exceeded") throw error;
      if (typeof id === "string" && ID.test(id)) stage.prepare("INSERT OR REPLACE INTO quarantine VALUES(?,?)").run(id, reason);
      else stage.prepare("INSERT INTO issues VALUES(?,?,?)").run(commit, entry.path, reason);
    };
    const format = files.get(".parachute/vault.yaml");
    if (format && yaml(read(format)).export_format_version !== 1) throw new Error("Unsupported portable export format");
    for (const entry of entries.filter(e => /^\.parachute\/notes-meta\/[^/]+\.yaml$/.test(e.path))) {
      let meta: Record<string, unknown> | undefined;
      try {
        meta = yaml(read(entry));
        const extension = meta.extension;
        if (typeof meta.id !== "string" || !ID.test(meta.id) || typeof extension !== "string") throw new Error("invalid_sidecar");
        const contentPath = `${meta.path ?? `_unpathed/${meta.id}`}.${extension}`;
        const body = files.get(contentPath);
        if (!body) throw new Error("missing_sidecar_body");
        if (extension === "md" || extension === "mdx") throw new Error("unexpected_inline_sidecar");
        const priorOwner = sidecarOwners.get(contentPath);
        if (priorOwner) {
          stage.prepare("INSERT OR REPLACE INTO quarantine VALUES(?,?)").run(priorOwner, "ambiguous_sidecar");
          throw new Error("ambiguous_sidecar");
        }
        sidecarOwners.set(contentPath, meta.id);
        used.add(contentPath);
        accept(meta, read(body), body, { git_path: entry.path, blob: entry.hash });
      } catch (error) { failure(entry, error, meta?.id ?? entry.path.split("/").pop()?.slice(0, -5)); }
    }
    for (const entry of entries) {
      if (entry.path.startsWith(".parachute/") || entry.path.startsWith(".doctor/") || entry.path === ".gitkeep" || used.has(entry.path)) continue;
      if (!/\.(md|mdx)$/.test(entry.path)) { stage.prepare("INSERT INTO issues VALUES(?,?,?)").run(commit, entry.path, "unclassified_file"); continue; }
      let meta: Record<string, unknown> | undefined;
      try {
        const cached = parsedGet.get(entry.hash) as { note_id: string; state: string } | null;
        if (cached) {
          collect(cached.note_id, cached.state, () => JSON.parse((parsedBody.get(entry.hash) as { row_json: string }).row_json), { git_path: entry.path, blob: entry.hash });
        } else {
          const parsed = inline(read(entry)); meta = parsed.meta;
          const { id, row, state } = parseObservation(meta, parsed.content, entry);
          parsedPut.run(entry.hash, id, state, JSON.stringify(row));
          collect(id, state, () => JSON.parse((parsedBody.get(entry.hash) as { row_json: string }).row_json), { git_path: entry.path, blob: entry.hash });
        }
      } catch (error) { failure(entry, error, meta?.id); }
    }
    const requested = byCommit.get(commit);
    for (const id of [...new Set([...candidates.keys(), ...(requested?.keys() ?? [])])].sort()) {
      const group = candidates.get(id) ?? [], selection = requested?.get(id);
      if (group.length && seq === commits.length - 1) markTip.run(id);
      let selected = group.length === 1 && !selection ? group[0] : undefined;
      let refusal = selection ? "stale_selection" : "missing_selection";
      if (group.length >= 2 && selection) {
        const actual = group.map(c => canonicalJson(c.ref)).sort();
        const expected = [selection.selected, ...selection.rejected.map(r => candidateRef(r, true))].map(c => canonicalJson(c)).sort();
        if (canonicalJson(actual) === canonicalJson(expected)) selected = group.find(c => canonicalJson(c.ref) === canonicalJson(selection.selected));
        else refusal = "candidate_set_mismatch";
      }
      if (!selected) {
        markQuarantine.run(id, "duplicate_id");
        if (selections) stage.prepare("INSERT INTO selection_failures VALUES(?,?,?)").run(id, commit, refusal);
        continue;
      }
      if (lastStates.get(id) === selected.state) continue;
      if (!lastStates.has(id) && lastStates.size >= 100_000) throw new Error("Archive note limit exceeded");
      lastStates.set(id, selected.state);
      insertObservation.run(id, seq, selected.state, JSON.stringify({ ...selected.row(), commit, observed_at: time }));
    }
  }
  const sourceFingerprint = fingerprint.digest("hex");
  if (selections && selections.source_fingerprint !== sourceFingerprint) throw new Error("Selections source fingerprint differs from archive");
  stage.exec("DELETE FROM observations WHERE note_id IN (SELECT note_id FROM quarantine)");
  return { source_fingerprint: sourceFingerprint, tip, commits: commits.length, objects, bytes };
}

interface PlannedNote { id: string; target_digest: string; state_digest: string; native_drops: number[]; imported: number; retained: number; pruned_imported: number; pruned_native: number; }
export interface ImportManifest extends StagedArchive {
  format: 1; kind: "diagnostic" | "final"; vault: string; evaluated_at: number; policy: HistoryPolicy;
  archive: string | null; archive_hash: string | null; backup: string | null;
  options_digest: string; target_ids_digest: string; notes: PlannedNote[]; skipped: string[];
  quarantined: { note_id: string; reason: string }[]; issues: { commit_id: string; path: string; reason: string }[];
  selections?: HistorySelections | null; selections_digest?: string | null;
  selection_failures?: { note_id: string; commit_id: string; reason: string }[];
  missing_at_tip: string[]; waivers: Record<string, string>; run_id: string;
}
function digestManifest(manifest: Omit<ImportManifest, "run_id"> | ImportManifest): string {
  const { run_id: _, ...body } = manifest as ImportManifest;
  return hashContent(canonicalJson(body));
}
function atomic(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
function readOptional(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export function copyDatabase(source: string, target: string): void {
  const db = new Database(source, { readonly: true });
  try { db.prepare("VACUUM INTO ?").run(target); } finally { db.close(); }
  chmodSync(target, 0o600);
}
function fileHash(path: string): string {
  const fd = openSync(path, "r"), hash = createHash("sha256"), chunk = Buffer.alloc(64 * 1024);
  try {
    for (;;) { const count = readSync(fd, chunk, 0, chunk.length, null); if (!count) break; hash.update(chunk.subarray(0, count)); }
    return hash.digest("hex");
  } finally { closeSync(fd); }
}

function rowsFor(stage: Database, id: string): ImportedObservation[] {
  const size = stage.prepare("SELECT COALESCE(SUM(length(CAST(row_json AS BLOB))),0) AS bytes FROM observations WHERE note_id=?").get(id) as { bytes: number };
  if (size.bytes > 64 * 1024 * 1024) throw new Error("Per-note staging limit exceeded (64 MiB); no manifest can be applied");
  const rows = stage.prepare("SELECT row_json FROM observations WHERE note_id=? ORDER BY seq").all(id) as { row_json: string }[];
  return rows.map(r => JSON.parse(r.row_json));
}
/** Staging is disposable and rebuilt from the immutable bundle after interruption. */
function openStage(path: string): Database {
  const stage = new Database(path);
  stage.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF");
  return stage;
}
function project(vault: string, repo: string, tip: string, dir: string, opts: { archive?: string; backup?: string; waivers?: Record<string, string>; selections?: HistorySelections | null }): ImportManifest {
  const config = readVaultConfig(vault);
  if (!config) throw new Error("Vault does not exist");
  const stage = openStage(join(dir, "stage.db"));
  const copy = join(dir, "projection.db");
  copyDatabase(vaultDbPath(vault), copy);
  const db = new Database(copy);
  try {
    applyConnectionPragmas(db); initSchema(db);
    const selections = opts.selections ?? null;
    const source = stageArchive(repo, tip, stage, selections), policy = resolveHistoryPolicy(config.history);
    const waivers = opts.waivers ?? {};
    for (const [id, reason] of Object.entries(waivers)) if (!ID.test(id) || typeof reason !== "string" || !reason.trim()) throw new Error("Waivers require note IDs and reasons");
    const options_digest = optionsDigest(policy, waivers, selections);
    const run = { run_id: "projection", source_fingerprint: source.source_fingerprint, tip, options_digest };
    beginImportRun(db, run);
    const evaluated_at = Date.now(), notes: PlannedNote[] = [], skipped: string[] = [];
    const ids = stage.prepare("SELECT DISTINCT note_id FROM observations ORDER BY note_id").all() as { note_id: string }[];
    for (const { note_id: id } of ids) {
      if (!db.prepare("SELECT 1 FROM notes WHERE id=?").get(id)) { skipped.push(id); continue; }
      if (waivers[id]) continue;
      const rows = rowsFor(stage, id), target_digest = importTargetDigest(db, id);
      const result = applyImportedNote(db, { run, noteId: id, observations: rows, policy, now: evaluated_at, targetDigest: target_digest });
      notes.push({ id, target_digest, state_digest: importObservationDigest(rows), native_drops: result.nativeDrops, imported: rows.length, retained: result.receipt.retained_count, pruned_imported: result.receipt.pruned_imported, pruned_native: result.receipt.pruned_native });
    }
    const live = db.prepare("SELECT id FROM notes ORDER BY id").all() as { id: string }[];
    const missing_at_tip = live.filter(({ id }) => !stage.prepare("SELECT 1 FROM tip_ids WHERE note_id=?").get(id)).map(r => r.id);
    const body: Omit<ImportManifest, "run_id"> = {
      ...source, format: 1, kind: opts.archive ? "final" : "diagnostic", vault, evaluated_at, policy,
      archive: opts.archive ?? null, archive_hash: opts.archive ? fileHash(opts.archive) : null, backup: opts.backup ?? null,
      selections, selections_digest: selectionsDigest(selections),
      selection_failures: stage.prepare("SELECT * FROM selection_failures ORDER BY note_id,commit_id").all() as NonNullable<ImportManifest["selection_failures"]>,
      options_digest, target_ids_digest: hashContent(canonicalJson(live.map(r => r.id))), notes, skipped, missing_at_tip, waivers,
      quarantined: stage.prepare("SELECT * FROM quarantine ORDER BY note_id").all() as ImportManifest["quarantined"],
      issues: stage.prepare("SELECT * FROM issues ORDER BY commit_id,path,reason").all() as ImportManifest["issues"],
    };
    return { ...body, run_id: digestManifest(body) };
  } finally { db.close(); stage.close(); }
}
interface Recovery { prior_config: string | null; prior_marker: string | null; backup: string; backup_hash: string; phase: "preparing" | "prepared"; run_id?: string; }
async function offline(): Promise<void> {
  const health = await checkHealth(readGlobalConfig().port || DEFAULT_PORT);
  if (health.status !== "not-listening") throw new Error("Stop the vault daemon before history import; keep it stopped through retire");
}
function privateBundle(archive: string, expected: string, dir: string): string {
  if (fileHash(archive) !== expected) throw new Error("Archive hash mismatch");
  const copy = join(dir, "archive.bundle"); copyFileSync(archive, copy); chmodSync(copy, 0o600);
  if (fileHash(copy) !== expected) throw new Error("Archive changed during copy");
  const repo = join(dir, "objects.git"); mkdirSync(repo);
  git(repo, ["init", "--bare"]);
  git(repo, ["bundle", "verify", copy]);
  git(repo, ["fetch", "--no-tags", copy, "+refs/*:refs/*"]);
  return repo;
}
function readManifest(vault: string, path: string): ImportManifest {
  const m = JSON.parse(readFileSync(path, "utf8")) as ImportManifest;
  if (m.format !== 1 || m.kind !== "final" || m.vault !== vault || m.run_id !== digestManifest(m) || !m.archive || !m.archive_hash || !m.backup) throw new Error("A matching final manifest is required");
  if (canonicalJson(resolveHistoryPolicy(readVaultConfig(vault)?.history)) !== canonicalJson(m.policy)) throw new Error("History policy differs from final manifest");
  const selections = m.selections == null ? null : normalizeHistorySelections(m.selections);
  if ((m.selections_digest ?? null) !== selectionsDigest(selections) || m.options_digest !== optionsDigest(m.policy, m.waivers, selections)) throw new Error("Manifest selection/options digest mismatch");
  return m;
}
function retirementReady(m: ImportManifest): void {
  if (m.issues.length) throw new Error("Unidentified source issues block retirement; resolve the archive before prepare");
  if ([...m.quarantined.map(q => q.note_id), ...m.missing_at_tip].some(id => !m.waivers[id])) throw new Error("Quarantined or uncovered IDs require explicit waivers before prepare");
}
/** Commands are exported to exercise the same offline/raw-DB path as the CLI. */
export async function runHistoryImport(args: string[]): Promise<unknown> {
  const [command, ...rest] = args;
  if (!command || !["plan", "prepare", "apply", "retire", "cancel"].includes(command)) throw new Error("history-import plan|prepare|apply|retire|cancel --vault NAME (see UPGRADING.md)");
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i], value = rest[i + 1];
    if (!key || !["--vault", "--source", "--through", "--output", "--archive", "--manifest", "--waivers", "--selections"].includes(key) || !value || flags.has(key)) throw new Error("Invalid history-import arguments");
    flags.set(key, value);
  }
  if (flags.has("--selections") && command !== "plan" && command !== "prepare") throw new Error("--selections is only valid for plan/prepare; apply uses the embedded manifest");
  const required = (key: string) => { const value = flags.get(key); if (!value) throw new Error(`Required ${key}`); return value; };
  const vault = required("--vault");
  if (!/^[a-zA-Z0-9_-]+$/.test(vault) || !readVaultConfig(vault)) throw new Error("Unknown vault");
  if (command !== "plan") await offline();
  const dir = mkdtempSync(join(tmpdir(), "history-import-"));
  const lock = join(vaultDir(vault), "history-import.lock");
  let locked = false;
  try {
    if (command !== "plan") {
      if (existsSync(lock)) throw new Error(`Importer lock exists at ${lock}; verify no importer is running before removing only this lock directory, then resume the same manifest`);
      mkdirSync(lock); locked = true; atomic(join(lock, "pid"), String(process.pid));
    }
    if (command === "plan" || command === "prepare") {
      const repo = realpathSync(required("--source")), tip = required("--through"), output = resolve(required("--output"));
      if (existsSync(output)) throw new Error("Manifest output already exists");
      const waivers = flags.has("--waivers") ? mapping(JSON.parse(readFileSync(required("--waivers"), "utf8"))) as Record<string, string> : {};
      let selections: HistorySelections | null = null;
      if (flags.has("--selections")) {
        const path = required("--selections");
        if (statSync(path).size > MAX_OUTPUT) throw new Error("Selections exceed 32 MiB");
        selections = normalizeHistorySelections(JSON.parse(readFileSync(path, "utf8")));
      }
      if (command === "plan") {
        const m = project(vault, repo, tip, dir, { waivers, selections }); atomic(output, JSON.stringify(m, null, 2)); return m;
      }
      if (readHistoryMirrorPhase(vault) !== "active" || existsSync(historyImportRecoveryPath(vault))) throw new Error("Existing cutover: resume or cancel using its recovery journal");
      if (text(git(repo, ["rev-parse", "--is-bare-repository"])).trim() !== "true" && text(git(repo, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=all"])).length) throw new Error("Source working tree is dirty");
      const archive = resolve(required("--archive"));
      if (existsSync(archive)) throw new Error("Archive output already exists");
      const backup = join(vaultDir(vault), `history-before-import-${crypto.randomUUID()}.db`);
      copyDatabase(vaultDbPath(vault), backup);
      const journal: Recovery = { prior_config: readOptional(mirrorConfigPath(vault)), prior_marker: readOptional(historyMirrorStatePath(vault)), backup, backup_hash: fileHash(backup), phase: "preparing" };
      atomic(historyImportRecoveryPath(vault), JSON.stringify(journal));
      atomic(historyMirrorStatePath(vault), JSON.stringify({ phase: "paused", source: repo, tip }));
      const config = readMirrorConfigForVault(vault) ?? defaultMirrorConfig();
      atomic(mirrorConfigPath(vault), serializeMirrorConfig({ ...config, enabled: false }).join("\n") + "\n");
      mkdirSync(dirname(archive), { recursive: true });
      git(repo, ["bundle", "create", archive, "--all"]); chmodSync(archive, 0o600);
      const objects = privateBundle(archive, fileHash(archive), dir);
      const m = project(vault, objects, tip, dir, { archive, backup, waivers, selections });
      atomic(output, JSON.stringify(m, null, 2));
      atomic(historyImportRecoveryPath(vault), JSON.stringify({ ...journal, phase: "prepared", run_id: m.run_id }));
      atomic(historyMirrorStatePath(vault), JSON.stringify({ phase: "paused", run_id: m.run_id, source: repo, tip }));
      return m;
    }
    const phase = readHistoryMirrorPhase(vault);
    if (command !== "cancel" && phase !== "paused" && !(command === "retire" && phase === "retired")) throw new Error("Vault must be paused for this command");
    const journal = JSON.parse(readFileSync(historyImportRecoveryPath(vault), "utf8")) as Recovery;
    if (command === "cancel") {
      const phase = readHistoryMirrorPhase(vault);
      if (phase === "retired") throw new Error("Only an unfinished preparation can be cancelled");
      const db = new Database(vaultDbPath(vault), { readonly: true });
      try {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='history_import_receipts'").get() && db.prepare("SELECT 1 FROM history_import_receipts LIMIT 1").get()) throw new Error("Receipts exist: resume the same run; cancellation is unavailable");
      } finally { db.close(); }
      if (journal.prior_config === null) {
        if (existsSync(mirrorConfigPath(vault))) renameSync(mirrorConfigPath(vault), `${historyImportRecoveryPath(vault)}.cancelled-config-${crypto.randomUUID()}`);
      } else atomic(mirrorConfigPath(vault), journal.prior_config);
      atomic(historyMirrorStatePath(vault), journal.prior_marker ?? JSON.stringify({ phase: "active" }));
      renameSync(historyImportRecoveryPath(vault), `${historyImportRecoveryPath(vault)}.cancelled-${crypto.randomUUID()}`);
      return { cancelled: true };
    }
    const m = readManifest(vault, required("--manifest"));
    const marker = JSON.parse(readFileSync(historyMirrorStatePath(vault), "utf8"));
    if (marker.run_id !== m.run_id || journal.run_id !== m.run_id) throw new Error("Paused marker/run mismatch");
    const repo = privateBundle(command === "apply" ? resolve(required("--archive")) : m.archive!, m.archive_hash!, dir);
    retirementReady(m);
    const db = new Database(vaultDbPath(vault));
    try {
      applyConnectionPragmas(db); initSchema(db);
      const liveIds = (db.prepare("SELECT id FROM notes ORDER BY id").all() as { id: string }[]).map(r => r.id);
      if (hashContent(canonicalJson(liveIds)) !== m.target_ids_digest) throw new Error(`Live note identities changed; reconcile against ${journal.backup}`);
      const run: ImportRun = { run_id: m.run_id, tip: m.tip, options_digest: m.options_digest, source_fingerprint: m.source_fingerprint };
      if (command === "apply") {
        const stage = openStage(join(dir, "apply-stage.db"));
        try {
          const source = stageArchive(repo, m.tip, stage, m.selections);
          if (source.source_fingerprint !== m.source_fingerprint) throw new Error("Bundle lineage differs from manifest");
          beginImportRun(db, run);
          for (const note of m.notes) {
            const rows = rowsFor(stage, note.id);
            if (importObservationDigest(rows) !== note.state_digest) throw new Error("Staged state differs from manifest");
            try { applyImportedNote(db, { run, noteId: note.id, observations: rows, policy: m.policy, now: m.evaluated_at, targetDigest: note.target_digest, expectedNativeDrops: note.native_drops }); }
            catch (error) { throw new Error(`${(error as Error).message}; resume the same manifest. Pre-import backup: ${journal.backup}`); }
          }
          if (m.notes.some(n => readImportReceipt(db, n.id)?.run_id !== m.run_id)) throw new Error("Incomplete receipt set");
          db.prepare("UPDATE history_import_runs SET status='complete' WHERE run_id=?").run(m.run_id);
          return { run_id: m.run_id, complete: true, notes: m.notes.length };
        } finally { stage.close(); }
      }
      const status = db.prepare("SELECT status FROM history_import_runs WHERE run_id=?").get(m.run_id) as { status: string } | null;
      if (status?.status !== "complete" || m.notes.some(n => readImportReceipt(db, n.id)?.run_id !== m.run_id)) throw new Error("Import is incomplete; resume apply");
      atomic(historyMirrorStatePath(vault), JSON.stringify({ phase: "retired", run_id: m.run_id, archive_hash: m.archive_hash }));
      return { retired: true, run_id: m.run_id };
    } finally { db.close(); }
  } finally { if (locked) rmSync(lock, { recursive: true }); rmSync(dir, { recursive: true, force: true }); }
}
