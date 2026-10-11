/** External packs contain data shapes: tags, fields and starter notes.
 * `connector` and `views` are accepted as inert data belonging to a hub module;
 * the vault never executes connectors or installs interfaces.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, statSync, rmdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Store, TagRecord } from "../core/src/types.ts";
import type { SeedPack, SeedPackTag } from "../core/src/seed-packs.ts";
import { normalizePath } from "../core/src/paths.ts";
import { validatePath } from "../core/src/notes.ts";
import { validateFieldName } from "../core/src/indexed-fields.ts";
import { collectOwnFieldDefaultAndTypeViolations } from "../core/src/tag-schemas.ts";

export interface PackManifest extends SeedPack {
  id: string;
  version: string;
  requires?: string[];
  views?: { kind: string; [key: string]: unknown }[];
  connector?: { run: string; scope: { tags: string[]; verbs: string[] }; publishes: string[] };
}
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function object(v: unknown): v is Record<string, any> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function strings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === "string" && x.length > 0);
}
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`Invalid pack: ${message}`);
}
function keys(v: Record<string, any>, allowed: string[]) {
  check(Object.keys(v).every(k => allowed.includes(k)), `unknown keys: ${Object.keys(v).filter(k => !allowed.includes(k)).join(", ")}`);
}
export function validateManifest(v: unknown): PackManifest {
  check(object(v), "manifest must be an object");
  keys(v, ["id", "name", "version", "description", "requires", "tags", "notes", "views", "connector"]);
  check(typeof v.id === "string" && ID.test(v.id), "id must be a lowercase slug");
  check(typeof v.version === "string" && VERSION.test(v.version), "version must be stable MAJOR.MINOR.PATCH");
  check(typeof v.name === "string" && v.name.length > 0 && typeof v.description === "string", "name/description required");
  check(Array.isArray(v.tags) && Array.isArray(v.notes), "tags/notes must be arrays");
  check(v.requires === undefined || (strings(v.requires) && v.requires.every(x => ID.test(x) && x !== v.id)), "requires must be pack ids (no self dependency)");
  const names = new Set<string>(), paths = new Set<string>();
  for (const tag of v.tags) {
    check(object(tag), "tag must be an object");
    keys(tag, ["name", "description", "fields", "parent_names"]);
    check(typeof tag.name === "string" && tag.name.trim() === tag.name && tag.name.length > 0 && !tag.name.startsWith("#") && !["__proto__", "constructor", "prototype"].includes(tag.name) && typeof tag.description === "string", "tag name/description required");
    check(!names.has(tag.name), "duplicate tag"); names.add(tag.name);
    check(tag.parent_names === undefined || strings(tag.parent_names), "parent_names must be strings");
    if (tag.fields !== undefined) {
      check(object(tag.fields), "fields must be an object");
      for (const [name, spec] of Object.entries(tag.fields)) {
        validateFieldName(name);
        check(object(spec) && typeof spec.type === "string", "field type required");
        keys(spec, ["type", "description", "enum", "indexed", "strict", "required", "cardinality", "default", "target_tags"]);
        for (const flag of ["indexed", "strict", "required"]) check(spec[flag] === undefined || typeof spec[flag] === "boolean", `${flag} must be boolean`);
        check(spec.description === undefined || typeof spec.description === "string", "field description must be text");
        check(spec.enum === undefined || strings(spec.enum), "enum must be strings");
        check(spec.cardinality === undefined || ["one", "many"].includes(spec.cardinality), "invalid cardinality");
        check(spec.target_tags === undefined || (strings(spec.target_tags) && spec.target_tags.length > 0 && spec.type === "reference"), "target_tags must be a non-empty string array on a reference field");
      }
      check(collectOwnFieldDefaultAndTypeViolations(tag.fields).length === 0, "invalid field type/default");
    }
  }
  for (const note of v.notes) {
    check(object(note), "note must be an object");
    keys(note, ["path", "content", "tags", "metadata"]);
    check(typeof note.path === "string" && note.path.length > 0 && normalizePath(note.path) === note.path, "note path must be nonempty and canonical");
    validatePath(note.path);
    check(!paths.has(note.path), "duplicate note path"); paths.add(note.path);
    check(!note.path.startsWith(".parachute/"), "reserved note path");
    check(typeof note.content === "string", "note content required");
    check(note.tags === undefined || strings(note.tags), "note tags must be strings");
    check(note.metadata === undefined || object(note.metadata), "metadata must be an object");
  }
  check(v.views === undefined || (Array.isArray(v.views) && v.views.every(x => object(x) && typeof x.kind === "string")), "views require a kind");
  if (v.connector !== undefined) {
    const c = v.connector;
    check(object(c), "connector must be an object"); keys(c, ["run", "scope", "publishes"]);
    check(typeof c.run === "string" && c.run.length > 0 && object(c.scope), "connector run/scope required");
    keys(c.scope, ["tags", "verbs"]);
    check(strings(c.scope.tags) && c.scope.tags.length > 0 && strings(c.scope.verbs) && c.scope.verbs.length > 0 && c.scope.verbs.every(x => ["read", "write"].includes(x)), "connector requires explicit tags and read/write verbs");
    check(strings(c.publishes), "connector publishes must be strings");
  }
  return v as PackManifest;
}
const MAX_BYTES = 1024 * 1024;
/** Migrate legacy registrations once. Conflicting files are never overwritten.
 * A partial migration is safe to retry; refuse an active legacy operation. */
export function migratePackState(vaultDir: string): string {
  const dir = join(vaultDir, "packs"), legacy = join(vaultDir, "modules");
  if (!existsSync(legacy)) return dir;
  if (existsSync(join(legacy, ".lock"))) throw new Error("Legacy pack operation locked; retry after it finishes");
  if (!existsSync(dir)) { renameSync(legacy, dir); return dir; }
  if (existsSync(join(dir, ".lock"))) throw new Error("Pack operation locked; retry migration after it finishes");
  const entries = readdirSync(legacy);
  for (const name of entries) {
    if (existsSync(join(dir, name))) throw new Error(`Pack migration conflict: ${name}; both registrations preserved`);
  }
  for (const name of entries) renameSync(join(legacy, name), join(dir, name));
  rmdirSync(legacy);
  return dir;
}

export async function loadManifest(source: string): Promise<PackManifest> {
  let body: string;
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
    if (!response.body) throw new Error("Empty manifest response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > MAX_BYTES) throw new Error("Manifest exceeds 1 MiB"); chunks.push(value); }
    } finally { await reader.cancel(); }
    body = Buffer.concat(chunks).toString("utf8");
  } else {
    let path = resolve(source);
    if (statSync(path).isDirectory()) {
      const found = ["pack.yaml", "pack.json", "module.yaml", "module.json"].map(n => join(path, n)).find(existsSync);
      if (!found) throw new Error(`No pack.yaml or pack.json (or legacy module.yaml/module.json) in ${path}`);
      path = found;
    }
    if (statSync(path).size > MAX_BYTES) throw new Error("Manifest exceeds 1 MiB");
    body = readFileSync(path, "utf8");
  }
  const parsed = Bun.YAML.parse(body); // JSON is a YAML subset; also accepts YAML flow maps.
  JSON.stringify(parsed); // Reject cyclic aliases before validation/comparison.
  return validateManifest(parsed);
}
// Canonical comparison ignores JSON key order and absent optional schema axes.
function canonical(v: any): any {
  if (Array.isArray(v)) return v.map(canonical);
  if (object(v)) return Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, canonical(v[k])]));
  return v;
}
function equal(a: unknown, b: unknown) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
function shape(t: SeedPackTag | TagRecord) {
  return { description: t.description ?? "", fields: t.fields ?? {}, parent_names: t.parent_names ?? [] };
}
interface State { format: 1; manifest: PackManifest; active: boolean; complete: boolean; owned: Record<string, ReturnType<typeof shape>> }
function statePath(dir: string, id: string) { check(ID.test(id), "invalid pack id"); return join(dir, `${id}.json`); }
function readState(dir: string, id: string): State | null {
  const file = statePath(dir, id);
  if (!existsSync(file)) return null;
  const s = JSON.parse(readFileSync(file, "utf8"));
  check(s.format === 1 && typeof s.active === "boolean" && typeof s.complete === "boolean" && object(s.owned), "invalid installed state");
  validateManifest(s.manifest); check(s.manifest.id === id, "state id mismatch");
  return s;
}
function save(dir: string, s: State) {
  mkdirSync(dir, { recursive: true }); const file = statePath(dir, s.manifest.id);
  const content = JSON.stringify(s, null, 2) + "\n";
  if (existsSync(file) && readFileSync(file, "utf8") === content) return;
  writeFileSync(`${file}.tmp`, content, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
function packStates(dir: string): State[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => n.endsWith(".json")).map(n => readState(dir, n.slice(0, -5))!);
}
export function listPacks(dir: string) {
  return packStates(dir).filter(s => s.active && s.complete).map(s => ({ id: s.manifest.id, version: s.manifest.version }));
}
function compareVersion(a: string, b: string) {
  const aa = a.split(".").map(BigInt), bb = b.split(".").map(BigInt);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i]! > bb[i]! ? 1 : -1;
  return 0;
}
export async function installPack(store: Store, dir: string, manifest: PackManifest): Promise<string[]> {
  validateManifest(manifest);
  const old = readState(dir, manifest.id);
  if (old?.active) {
    const version = compareVersion(manifest.version, old.manifest.version);
    if (version < 0) throw new Error("Downgrade refused");
    if (version === 0 && !equal(manifest, old.manifest)) throw new Error("Manifest changed without a version bump");
  }
  for (const dep of manifest.requires ?? []) if (!readState(dir, dep)?.complete || !readState(dir, dep)?.active) throw new Error(`Missing required pack: ${dep}`);
  const state: State = { format: 1, manifest, active: true, complete: !!(old?.active && old.complete && equal(old.manifest, manifest)), owned: { ...(old?.owned ?? {}) } };
  const log: string[] = [];
  // Save progress after each item: retries preserve ownership of completed writes.
  // Store schema/index checks still apply; installation is resumable, not atomic.
  save(dir, state);
  for (const tag of manifest.tags) {
    const current = await store.getTagRecord(tag.name), desired = shape(tag);
    if (current && equal(shape(current), desired)) { log.push(`= tag ${tag.name}`); continue; }
    if (current && !equal(shape(current), (Object.hasOwn(state.owned, tag.name) ? state.owned[tag.name] : undefined))) {
      log.push(`DIFF tag ${tag.name}: kept existing ${JSON.stringify(shape(current))}; requested ${JSON.stringify(desired)}`); continue;
    }
    await store.upsertTagRecord(tag.name, { description: desired.description, fields: tag.fields ?? null, parent_names: tag.parent_names ?? null });
    state.owned[tag.name] = desired; save(dir, state); log.push(`+ schema ${tag.name}`);
  }
  for (const note of manifest.notes) {
    const existing = await store.getNoteByPath(note.path);
    if (existing) {
      const changed = [
        existing.content !== note.content ? "content" : "",
        !equal(existing.metadata ?? {}, note.metadata ?? {}) ? "metadata" : "",
        !equal([...(existing.tags ?? [])].sort(), [...(note.tags ?? [])].sort()) ? "tags" : "",
      ].filter(Boolean);
      log.push(`${changed.length ? "DIFF" : "="} note ${note.path} (untouched${changed.length ? `; changed: ${changed.join(", ")}` : ""})`);
    } else {
      await store.createNote(note.content, { path: note.path, tags: note.tags, metadata: note.metadata }); log.push(`+ note ${note.path}`);
    }
  }
  state.complete = true; save(dir, state);
  return log;
}
export async function removePack(store: Store, dir: string, id: string): Promise<string[]> {
  const state = readState(dir, id);
  if (!state?.active) return [`= pack ${id} absent`];
  for (const other of packStates(dir).filter(s => s.active)) {
    if (other.manifest.id !== id && other.manifest.requires?.includes(id)) throw new Error(`Required by ${other.manifest.id}`);
  }
  const log: string[] = [];
  for (const [tag, snapshot] of Object.entries(state.owned)) {
    const current = await store.getTagRecord(tag);
    const shared = packStates(dir).some(s => s.active && s.manifest.id !== id && s.manifest.tags.some(t => t.name === tag));
    if (current && equal(shape(current), snapshot) && !shared) {
      // Keep tag identity and assignments. Clear only schema/hierarchy we own.
      await store.upsertTagRecord(tag, { fields: null, parent_names: null }); state.owned[tag] = shape((await store.getTagRecord(tag))!); save(dir, state); log.push(`- schema ${tag}`);
    } else log.push(`DIFF tag ${tag}: kept edited/shared schema`);
  }
  state.active = false; state.complete = false; save(dir, state);
  log.push(`- registration ${id}; all notes and tag assignments survive`);
  return log;
}
