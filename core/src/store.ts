import { Database } from "bun:sqlite";
import type { Store, Note, Link, Attachment, QueryOpts, QueryNotesPage } from "./types.js";
import { initSchema } from "./schema.js";
import * as noteOps from "./notes.js";
import * as linkOps from "./links.js";
import * as tagSchemaOps from "./tag-schemas.js";
import * as indexedFieldOps from "./indexed-fields.js";
import {
  pruneOrphanedIndexedFields,
  reconcileDeclaredIndexes,
  type PrunedField,
} from "./indexed-fields.js";
import { syncWikilinks, resolveUnresolvedWikilinks } from "./wikilinks.js";
import { pathTitle } from "./paths.js";
import { HookRegistry } from "./hooks.js";
import {
  loadTagHierarchy,
  getTagExpansion,
  TAG_CONFIG_PREFIX,
  DEFAULT_TAG_NAME,
  DEFAULT_TAG_EXPAND_MODE,
  type TagHierarchy,
  type TagExpandMode,
} from "./tag-hierarchy.js";
import {
  loadSchemaConfig,
  validateNote as runValidateNote,
  type ResolvedSchemas,
  type ValidationStatus,
} from "./schema-defaults.js";

/**
 * bun:sqlite-backed Store implementation. Internally everything is
 * synchronous; the public Store API is async so the same interface
 * can back an async runtime (e.g. Cloudflare Durable Objects SQLite).
 */
export class BunSqliteStore implements Store {
  public readonly hooks: HookRegistry;

  // Lazy-built caches over the post-v14 `tags` table — hierarchy via
  // parent_names, schema validation via `fields`. Null means "not yet
  // loaded or invalidated"; the next read rebuilds. We invalidate
  // synchronously inside the writers that mutate the source rows so reads
  // after writes always see the post-write state.
  private _tagHierarchy: TagHierarchy | null = null;
  private _schemaConfig: ResolvedSchemas | null = null;

  constructor(public readonly db: Database, opts?: { hooks?: HookRegistry }) {
    initSchema(db);
    this.hooks = opts?.hooks ?? new HookRegistry();
  }

  /**
   * Lazy accessor for the `_tags/*` config-note hierarchy. First call after
   * boot or after an invalidation does the scan; subsequent calls hit the
   * cache. Returns the same object until invalidated, so callers can rely
   * on identity for memoizing per-tag descendant sets.
   */
  private getTagHierarchy(): TagHierarchy {
    if (!this._tagHierarchy) this._tagHierarchy = loadTagHierarchy(this.db);
    return this._tagHierarchy;
  }

  /**
   * Lazy accessor for the per-tag `fields` resolution. Same lifecycle as
   * the tag hierarchy cache.
   */
  private getSchemaConfig(): ResolvedSchemas {
    if (!this._schemaConfig) this._schemaConfig = loadSchemaConfig(this.db);
    return this._schemaConfig;
  }

  /**
   * Run the resolved schemas against a note and return the resulting
   * validation status, or null when no schema applies. Public so the MCP
   * layer can surface `validation_status` on create/update responses
   * without re-importing the config loader.
   */
  validateNoteAgainstSchemas(note: { path?: string | null; tags?: string[]; metadata?: Record<string, unknown> }): ValidationStatus | null {
    return runValidateNote(this.getSchemaConfig(), note);
  }

  /**
   * Drop the tag-hierarchy cache if the mutated path is in the `_tags/*`
   * namespace. Called from create/update/delete — old path is passed
   * alongside new for rename cases (a note moved out of `_tags/` should
   * still invalidate).
   *
   * Post-v17 the schema-config cache is purely tag-driven — its
   * invalidation hook is on `upsertTagSchema` / `upsertTagRecord` /
   * `deleteTagSchema` / `deleteTag` (mutations of `tags.fields`).
   */
  private invalidateConfigCachesForPath(path: string | null | undefined, oldPath?: string | null): void {
    const isTagConfig = (p: string | null | undefined): boolean =>
      typeof p === "string" && p.startsWith(TAG_CONFIG_PREFIX);
    if (isTagConfig(path) || isTagConfig(oldPath)) {
      this._tagHierarchy = null;
    }
  }

  // ---- Notes ----

  async createNote(content: string, opts?: { id?: string; path?: string; tags?: string[]; metadata?: Record<string, unknown>; created_at?: string; extension?: string }): Promise<Note> {
    const note = noteOps.createNote(this.db, content, opts);

    if (content) {
      syncWikilinks(this.db, note.id, content);
    }

    if (note.path) {
      resolveUnresolvedWikilinks(this.db, note.path, note.id);
    }

    this.invalidateConfigCachesForPath(note.path);
    this.hooks.dispatch("created", note, this);

    return note;
  }

  async getNote(id: string): Promise<Note | null> {
    return noteOps.getNote(this.db, id);
  }

  async getNoteByPath(path: string, extension?: string): Promise<Note | null> {
    return noteOps.getNoteByPath(this.db, path, extension);
  }

  async getNotes(ids: string[]): Promise<Note[]> {
    return noteOps.getNotes(this.db, ids);
  }

  async updateNote(
    id: string,
    updates: {
      content?: string;
      append?: string;
      prepend?: string;
      path?: string;
      extension?: string;
      metadata?: Record<string, unknown>;
      created_at?: string;
      skipUpdatedAt?: boolean;
      if_updated_at?: string;
    },
  ): Promise<Note> {
    let oldPath: string | undefined;
    if (updates.path !== undefined) {
      const existing = noteOps.getNote(this.db, id);
      oldPath = existing?.path;
    }

    const note = noteOps.updateNote(this.db, id, updates);

    // Wikilink sync runs against the *resulting* content. For append/prepend
    // we don't have the new value pre-write — read it back off the returned
    // note so a `[[Foo]]` introduced via append still creates the link.
    if (updates.content !== undefined || updates.append !== undefined || updates.prepend !== undefined) {
      syncWikilinks(this.db, id, note.content);
    }

    if (updates.path !== undefined && note.path) {
      if (oldPath && oldPath !== note.path) {
        this.cascadeRename(oldPath, note.path);
      }
      resolveUnresolvedWikilinks(this.db, note.path, id);
    }

    // Invalidate before the hook dispatch so any handler that re-queries
    // the hierarchy from inside its own logic sees post-write state.
    // `metadata` updates can change the `parents` field on a config note
    // even when the path didn't change, so always invalidate when the
    // current path is in a config namespace.
    this.invalidateConfigCachesForPath(note.path, oldPath);
    this.hooks.dispatch("updated", note, this);

    return note;
  }

  /**
   * When a note is renamed, update [[wikilinks]] in other notes that referenced the old path.
   * Matches both full path and basename references.
   */
  private cascadeRename(oldPath: string, newPath: string): void {
    const oldTitle = pathTitle(oldPath);
    const newTitle = pathTitle(newPath);

    const candidates = this.db.prepare(`
      SELECT id, content FROM notes
      WHERE content LIKE ? OR content LIKE ?
    `).all(`%[[${oldPath}%`, `%[[${oldTitle}%`) as { id: string; content: string }[];

    for (const row of candidates) {
      let updated = row.content;

      updated = updated.replace(
        new RegExp(`\\[\\[${escapeRegex(oldPath)}([#|\\]])`, "g"),
        `[[${newPath}$1`,
      );

      if (oldTitle !== newTitle && oldTitle !== oldPath) {
        updated = updated.replace(
          new RegExp(`\\[\\[${escapeRegex(oldTitle)}([#|\\]])`, "g"),
          `[[${newTitle}$1`,
        );
      }

      if (updated !== row.content) {
        noteOps.updateNote(this.db, row.id, { content: updated });
        syncWikilinks(this.db, row.id, updated);
      }
    }
  }

  async restoreNoteTimestamps(id: string, createdAt: string, updatedAt: string): Promise<void> {
    // Import-only: direct UPDATE so the importer can restore a note's
    // historical `created_at`/`updated_at` from the portable-md export
    // bytes. `updateNote` either bumps `updated_at` to wall-clock-now or
    // (with `skipUpdatedAt: true`) leaves it untouched — neither lets
    // the importer write a specific historical timestamp. Skips hooks
    // by design: this isn't a user-edit, it's a state restoration.
    // See vault#308 PR 2.
    this.db
      .prepare("UPDATE notes SET created_at = ?, updated_at = ? WHERE id = ?")
      .run(createdAt, updatedAt, id);
  }

  async deleteNote(id: string): Promise<void> {
    // Read before delete so we can invalidate config caches on the way out
    // AND so the post-delete hook dispatch carries the minimum payload
    // ({ id, path }). The full note can't be reconstructed post-delete —
    // by design, hooks subscribing to "deleted" receive a DeletedNoteRef,
    // not a Note.
    const existing = noteOps.getNote(this.db, id);
    noteOps.deleteNote(this.db, id);
    if (existing?.path) this.invalidateConfigCachesForPath(existing.path);
    // Dispatch even when `existing` was null — the caller asked for a
    // deletion, and downstream consumers (e.g. the mirror) reconcile via
    // id. Path is undefined in that case; the mirror sweep will catch
    // any orphans missed by the targeted-removal fast path.
    this.hooks.dispatch(
      "deleted",
      { id, ...(existing?.path ? { path: existing.path } : {}) },
      this,
    );
  }

  async queryNotes(opts: QueryOpts): Promise<Note[]> {
    return noteOps.queryNotes(this.db, this.expandQueryTags(opts));
  }

  async queryNotesPaged(opts: QueryOpts): Promise<QueryNotesPage> {
    // Hierarchy expansion happens internally — but importantly the cursor's
    // query_hash is computed from the CALLER'S opts (pre-expansion), so a
    // tag hierarchy edit between calls invalidates the cursor (different
    // descendant set → different rows match → caller should restart). The
    // alternative — hash the expanded set — would silently keep returning
    // stale results from a hierarchy snapshot the caller never saw.
    return noteOps.queryNotesPaged(this.db, this.expandQueryTags(opts));
  }

  /**
   * If `tags` are present, attach a parallel `_tagsExpanded` array where
   * each input tag is replaced with `{tag} ∪ descendants(tag)`. The SQL
   * builder uses this to widen the tag join from `name = ?` to
   * `name IN (...)`, so a query for `#manual` matches notes tagged with
   * any descendant declared via `tags.parent_names`.
   *
   * `_default` magic (vault#270): when a `_default` tag row exists in the
   * vault, it's the implicit parent of every note (tagged or not). A query
   * filter that names `_default` is therefore equivalent to "no tag filter
   * at all" — but the precise treatment depends on `tagMatch`:
   *
   * - `all` (default, AND-semantics): `_default` is universally satisfied,
   *   so it can be dropped from the tag list. Other tags' AND-semantics
   *   still apply. If `_default` was the only entry, drop the filter
   *   entirely so untagged notes match.
   * - `any` (OR-semantics): `_default` matches every note, so the disjunction
   *   collapses to "every note." Drop the filter entirely regardless of
   *   what else was in the list (otherwise we'd narrow to the union of
   *   the other tags' notes — wrong).
   *
   * Other filters (path, metadata, dates) still apply in both cases.
   *
   * `expand` axis (vault tag `expand` axis): `opts.expand` selects WHICH axis
   * each tag expands along — `"subtypes"` (default, the parent_names path
   * documented above, with the `_default` magic), `"namespace"` (lexical
   * `tag/*`), `"both"` (union), or `"exact"` (no expansion). The `_default`
   * universal-parent magic is a SUBTYPES-axis concept, so it fires only when
   * the resolved mode includes subtypes (`"subtypes"`/`"both"`); under
   * `"namespace"`/`"exact"` a literal `_default` tag is treated like any other.
   */
  private expandQueryTags(opts: QueryOpts): QueryOpts {
    if (!opts.tags || opts.tags.length === 0) return opts;
    const hierarchy = this.getTagHierarchy();
    const mode: TagExpandMode = opts.expand ?? DEFAULT_TAG_EXPAND_MODE;
    const subtypeAxis = mode === "subtypes" || mode === "both";

    let tags = opts.tags;
    // `_default` collapse only applies on the subtypes axis — it's the
    // universal *parent* (an is-a relationship), not a namespace prefix.
    if (subtypeAxis && hierarchy.allTags.has(DEFAULT_TAG_NAME) && tags.includes(DEFAULT_TAG_NAME)) {
      const match = opts.tagMatch ?? "all";
      if (match === "any") {
        const { tags: _drop, ..._rest } = opts;
        return _rest as QueryOpts;
      }
      tags = tags.filter((t) => t !== DEFAULT_TAG_NAME);
      if (tags.length === 0) {
        const { tags: _drop, ..._rest } = opts;
        return _rest as QueryOpts;
      }
      opts = { ...opts, tags };
    }

    // Subtypes fast-path: with no declared hierarchy there are no descendants,
    // so the engine's `[tag]` fallback already produces the literal-tag join —
    // skip attaching `_tagsExpanded` to stay byte-identical to pre-axis
    // behavior. `exact` likewise needs no expansion. Namespace/both must still
    // run (lexical expansion is independent of `parent_names`).
    if (mode === "exact") return opts;
    if (mode === "subtypes" && hierarchy.childrenOf.size === 0) return opts;

    const expanded = tags.map((t) => Array.from(getTagExpansion(hierarchy, t, mode)));
    return { ...opts, _tagsExpanded: expanded } as QueryOpts;
  }

  async searchNotes(query: string, opts?: { tags?: string[]; limit?: number; expand?: TagExpandMode }): Promise<Note[]> {
    // Same tag-expansion treatment as queryNotes, along the SAME `expand` axis
    // (vault tag `expand` axis) — searching `#manual` should match notes
    // tagged with any descendant under "subtypes", any `manual/*` under
    // "namespace", etc. The underlying FTS path already uses `IN (...)` for
    // tags, so we flatten the per-input expansions into a single union (search
    // semantics are "any tag matches").
    //
    // `_default` collapse is a SUBTYPES-axis concept (the universal *parent*):
    // when `_default` is among the requested tags and a `_default` row exists,
    // the OR collapses to "every note" — drop the tag filter entirely so the
    // search hits the full corpus and untagged notes are reachable. It fires
    // only on the subtypes/both axes (mirrors `expandQueryTags`).
    if (opts?.tags && opts.tags.length > 0) {
      const mode: TagExpandMode = opts.expand ?? DEFAULT_TAG_EXPAND_MODE;
      const subtypeAxis = mode === "subtypes" || mode === "both";
      const hierarchy = this.getTagHierarchy();
      if (subtypeAxis && hierarchy.allTags.has(DEFAULT_TAG_NAME) && opts.tags.includes(DEFAULT_TAG_NAME)) {
        const { tags: _drop, expand: _e, ..._rest } = opts;
        return noteOps.searchNotes(this.db, query, _rest);
      }
      // Subtypes fast-path: with no declared hierarchy there are no
      // descendants, so the tags pass through unchanged (byte-identical to
      // pre-axis behavior). `exact` likewise needs no expansion.
      // Namespace/both must still run (lexical expansion is independent of
      // `parent_names`).
      const skipExpansion =
        mode === "exact" || (mode === "subtypes" && hierarchy.childrenOf.size === 0);
      if (!skipExpansion) {
        const expanded = new Set<string>();
        for (const t of opts.tags) {
          for (const x of getTagExpansion(hierarchy, t, mode)) expanded.add(x);
        }
        const { expand: _e, ..._rest } = opts;
        return noteOps.searchNotes(this.db, query, { ..._rest, tags: Array.from(expanded) });
      }
    }
    // Strip the internal `expand` before passing to noteOps (it has no field
    // for it; harmless but keep the boundary clean).
    if (opts && "expand" in opts) {
      const { expand: _e, ..._rest } = opts;
      return noteOps.searchNotes(this.db, query, _rest);
    }
    return noteOps.searchNotes(this.db, query, opts);
  }

  // ---- Tags ----

  async tagNote(noteId: string, tags: string[]): Promise<void> {
    noteOps.tagNote(this.db, noteId, tags);
  }

  async untagNote(noteId: string, tags: string[]): Promise<void> {
    noteOps.untagNote(this.db, noteId, tags);
  }

  async expandTagsWithDescendants(tags: string[]): Promise<Set<string>> {
    // Thin `mode:"subtypes"` shim over the mode-aware `expandTags`, so existing
    // callers (tag-scope auth, search) keep the exact descendant semantics.
    return this.expandTags(tags, "subtypes");
  }

  async expandTags(tags: string[], mode: TagExpandMode = DEFAULT_TAG_EXPAND_MODE): Promise<Set<string>> {
    const expanded = new Set<string>();
    if (tags.length === 0) return expanded;
    const hierarchy = this.getTagHierarchy();
    for (const t of tags) {
      for (const x of getTagExpansion(hierarchy, t, mode)) expanded.add(x);
    }
    return expanded;
  }

  async listTags(): Promise<{ name: string; count: number }[]> {
    return noteOps.listTags(this.db);
  }

  async deleteTag(name: string): Promise<{ deleted: boolean; notes_untagged: number }> {
    const result = noteOps.deleteTag(this.db, name);
    // The deleted tag may have been a parent or child in the hierarchy
    // and may have declared `fields` powering schema validation.
    this._tagHierarchy = null;
    this._schemaConfig = null;
    // Fire "deleted" only when SOMETHING happened (the underlying
    // deleteTag returns `deleted: false` when the tag didn't exist).
    // The git-mirror reacts to this by sweeping the schema sidecar.
    if (result.deleted) this.hooks.dispatchTag("deleted", name, this);
    return result;
  }

  async renameTag(oldName: string, newName: string): Promise<noteOps.RenameTagResult> {
    const result = noteOps.renameTag(this.db, oldName, newName);
    // Vault#240: the cascade rewrites parent_names in OTHER tag rows as
    // part of the same transaction, plus tokens.scoped_tags and
    // indexed_fields.declarer_tags. Both caches are tag-keyed, so they
    // must be rebuilt regardless — the hierarchy by tag-set identity,
    // the schema-config by parent_names + fields content.
    this._tagHierarchy = null;
    this._schemaConfig = null;
    // Rename = delete-then-upsert from the perspective of any consumer
    // that keys schema artifacts on the tag name (e.g. the git-mirror's
    // `.parachute/schemas/<tag>.yaml` sidecar file). Fire both events
    // so the consumer drops the old artifact and writes the new one.
    // Only dispatch when the rename actually happened — error returns
    // ({ error: ... }) shouldn't notify subscribers about phantom moves.
    if ("renamed" in result) {
      this.hooks.dispatchTag("deleted", oldName, this);
      this.hooks.dispatchTag("upserted", newName, this);
    }
    return result;
  }

  async mergeTags(
    sources: string[],
    target: string,
  ): Promise<{ merged: Record<string, number>; target: string }> {
    const result = noteOps.mergeTags(this.db, sources, target);
    // Source tags drop out of the hierarchy; downstream callers asking
    // for descendants of target should pick up any merged children. Also
    // bust the schema cache — `fields` declarations follow tag identity.
    this._tagHierarchy = null;
    this._schemaConfig = null;
    // Each merged source vanishes from the tag set; the target's
    // schema may have absorbed fields/relationships from the sources.
    // Fire "deleted" for each source and "upserted" for the target so
    // the mirror sweeps the source sidecars and rewrites the target.
    for (const source of sources) {
      if (source === target) continue;
      this.hooks.dispatchTag("deleted", source, this);
    }
    this.hooks.dispatchTag("upserted", target, this);
    return result;
  }

  // ---- Vault Stats ----

  async getVaultStats(opts?: { topTagsLimit?: number }) {
    return noteOps.getVaultStats(this.db, opts);
  }

  // ---- Links ----

  async createLink(sourceId: string, targetId: string, relationship: string, metadata?: Record<string, unknown>): Promise<Link> {
    return linkOps.createLink(this.db, sourceId, targetId, relationship, metadata);
  }

  async deleteLink(sourceId: string, targetId: string, relationship: string): Promise<void> {
    linkOps.deleteLink(this.db, sourceId, targetId, relationship);
  }

  async getLinks(noteId: string, opts?: { direction?: "outbound" | "inbound" | "both" }): Promise<Link[]> {
    return linkOps.getLinks(this.db, noteId, opts);
  }

  async listLinks(opts?: { noteId?: string; direction?: "outbound" | "inbound" | "both"; relationship?: string }): Promise<Link[]> {
    return linkOps.listLinks(this.db, opts);
  }

  // ---- Bulk Operations ----

  async createNotes(inputs: noteOps.BulkNoteInput[]): Promise<Note[]> {
    const notes = noteOps.createNotes(this.db, inputs);
    for (const note of notes) {
      // Bulk path needs the same config-cache invalidation as singleton
      // createNote — without it, a batch that includes `_tags/*` notes
      // would leave the hierarchy cache stale until the next singleton
      // write happened to bust it.
      this.invalidateConfigCachesForPath(note.path);
      this.hooks.dispatch("created", note, this);
    }
    return notes;
  }

  async batchTag(noteIds: string[], tags: string[]): Promise<number> {
    return noteOps.batchTag(this.db, noteIds, tags);
  }

  async batchUntag(noteIds: string[], tags: string[]): Promise<number> {
    return noteOps.batchUntag(this.db, noteIds, tags);
  }

  // ---- Deeper Link Queries ----

  async traverseLinks(noteId: string, opts?: { max_depth?: number; relationship?: string }) {
    return linkOps.traverseLinks(this.db, noteId, opts);
  }

  async findPath(sourceId: string, targetId: string, opts?: { max_depth?: number }) {
    return linkOps.findPath(this.db, sourceId, targetId, opts);
  }

  // ---- Tag Schemas ----

  async listTagSchemas() {
    return tagSchemaOps.listTagSchemas(this.db);
  }

  async getTagSchema(tag: string) {
    return tagSchemaOps.getTagSchema(this.db, tag);
  }

  async upsertTagSchema(tag: string, schema: { description?: string; fields?: Record<string, tagSchemaOps.TagFieldSchema> }) {
    const result = tagSchemaOps.upsertTagSchema(this.db, tag, schema);
    // `fields` drives validation — bust the schema cache so the next
    // create/update sees the new declarations.
    this._schemaConfig = null;
    // The tag schema sidecar in the mirror needs to track this. Fire
    // "upserted" regardless of whether the row was created or modified
    // — the mirror writes the sidecar fresh either way.
    this.hooks.dispatchTag("upserted", tag, this);
    return result;
  }

  async deleteTagSchema(tag: string) {
    const result = tagSchemaOps.deleteTagSchema(this.db, tag);
    if (result) {
      this._schemaConfig = null;
      // Schema-only delete: the tag may still exist as a name in the
      // hierarchy, but the sidecar lost its content. Mirror reacts by
      // sweeping the sidecar file. (If the underlying row was reduced
      // to a bare name with no schema content, hasSchemaContent() in
      // exportVaultToDir already wouldn't have written it on the next
      // export pass — the targeted delete is the fast path; the sweep
      // is the safety net.)
      this.hooks.dispatchTag("deleted", tag, this);
    }
    return result;
  }

  async getTagSchemaMap() {
    return tagSchemaOps.getTagSchemaMap(this.db);
  }

  // ---- Indexed-field lifecycle (generated columns + indexes) ----

  /**
   * Prune orphaned `indexed_fields` declarers — declarer tags that no longer
   * have a `tags` row. Fields with no surviving live declarer are dropped
   * wholesale (row + generated column + index); co-declared fields keep their
   * column and just lose the dead declarers. `dryRun` (default true) returns
   * the plan without mutating. See the gitcoin orphaned-fields bug.
   */
  async pruneIndexedFields(opts?: { dryRun?: boolean }): Promise<PrunedField[]> {
    const plan = pruneOrphanedIndexedFields(this.db, opts);
    // A drop changes the queryable-field catalog vault-info advertises; bust
    // the schema cache so the next read reflects it.
    if (opts?.dryRun === false && plan.length > 0) this._schemaConfig = null;
    return plan;
  }

  /**
   * Replay `declareField` for every `indexed: true` field across all current
   * tag records, materializing the generated columns + indexes. Idempotent —
   * used by the portable-md import path so a fresh import ends with the same
   * backing columns a live vault would have. Returns the count of (tag, field)
   * declarations replayed.
   */
  async reconcileDeclaredIndexes(): Promise<number> {
    const schemas = await this.listTagRecords();
    const count = reconcileDeclaredIndexes(this.db, schemas);
    if (count > 0) this._schemaConfig = null;
    return count;
  }

  // ---- Tag Records (post-v14: full identity row) ----

  async listTagRecords() {
    return tagSchemaOps.listTagRecords(this.db);
  }

  async getTagRecord(tag: string) {
    return tagSchemaOps.getTagRecord(this.db, tag);
  }

  /**
   * Partial upsert of the full tag record. Any patch field left undefined
   * is preserved; pass null to clear. Invalidates the tag-hierarchy cache
   * when `parent_names` is touched.
   *
   * Indexed-field lifecycle is reconciled HERE — at the single store
   * chokepoint every caller (MCP update-tag, REST PUT /tags/:name, import)
   * funnels through — so no caller can persist a `fields` change without the
   * matching declareField/releaseField. When `patch.fields` is touched
   * (object or explicit `null`), the prior-vs-next indexed-field set is
   * diffed: added indexed fields get `declareField`, removed ones get
   * `releaseField` (which drops the generated column + index only when this
   * tag is the last live declarer — the co-declaration guard). `patch.fields
   * === undefined` (no-touch) skips reconciliation entirely. Centralizing
   * here is the same discipline as moving delete-release into noteOps.deleteTag
   * — it closes the REST PUT orphaned-column leak. See the gitcoin bug.
   */
  async upsertTagRecord(
    tag: string,
    patch: {
      description?: string | null;
      fields?: Record<string, tagSchemaOps.TagFieldSchema> | null;
      relationships?: tagSchemaOps.TagRelationshipMap | null;
      parent_names?: string[] | null;
    },
  ) {
    // Snapshot the prior indexed-field set BEFORE the write so the diff below
    // sees what this tag declared going in. Only needed when `fields` changes.
    const priorRecord =
      patch.fields !== undefined ? tagSchemaOps.getTagRecord(this.db, tag) : null;

    const result = tagSchemaOps.upsertTagRecord(this.db, tag, patch);

    if (patch.fields !== undefined) {
      const indexedSet = (fields: Record<string, tagSchemaOps.TagFieldSchema> | null | undefined) =>
        new Set(
          Object.entries(fields ?? {})
            .filter(([, v]) => v.indexed === true)
            .map(([k]) => k),
        );
      const nextFields = patch.fields; // object | null
      const priorIndexed = indexedSet(priorRecord?.fields);
      const nextIndexed = indexedSet(nextFields);
      for (const fieldName of nextIndexed) {
        const spec = nextFields![fieldName]!;
        const mapped = indexedFieldOps.mapFieldType(spec.type);
        // Unmappable type for indexing is a caller error; surface it rather
        // than silently skipping. MCP/REST validate up-front for a cleaner
        // message, but this is the backstop at the chokepoint.
        if (!mapped) {
          throw new indexedFieldOps.IndexedFieldError(
            `field "${fieldName}" has unsupported type "${spec.type}" for indexing (supported: string, integer, boolean)`,
          );
        }
        indexedFieldOps.declareField(this.db, fieldName, mapped, tag);
      }
      for (const fieldName of priorIndexed) {
        if (!nextIndexed.has(fieldName)) {
          indexedFieldOps.releaseField(this.db, fieldName, tag);
        }
      }
    }

    if (patch.parent_names !== undefined) {
      // parent_names drives both query expansion (tag hierarchy) AND, post
      // vault#270, schema inheritance — bust both caches.
      this._tagHierarchy = null;
      this._schemaConfig = null;
    }
    if (patch.fields !== undefined) {
      this._schemaConfig = null;
    }
    // First-time creation of a tag row (e.g. an empty `_default` placeholder)
    // changes the `_default` universal-parent gate even when no fields or
    // parent_names are touched. Cheap to bust: caches rebuild on next read.
    if (tag === "_default") {
      this._tagHierarchy = null;
      this._schemaConfig = null;
    }
    // Tag-mutation event for the git-mirror and any other downstream
    // consumer. Fire "upserted" on every successful tag-record write —
    // schema/relationship/parent-name mutations all alter the sidecar
    // contents the mirror persists.
    this.hooks.dispatchTag("upserted", tag, this);
    return result;
  }

  // ---- Batch Wikilink Sync ----

  /**
   * Create a note without triggering wikilink sync.
   * Use this during bulk imports, then call syncAllWikilinks() after.
   *
   * Does **not** invalidate the `_tags/*` config cache — importers writing
   * tag-hierarchy notes through this path must call `rebuildConfigCaches()`
   * once the import is done. (Default importers follow `createNoteRaw` with
   * `syncAllWikilinks`, so adding the cache rebuild there is the natural
   * place.)
   */
  async createNoteRaw(content: string, opts?: { id?: string; path?: string; tags?: string[]; metadata?: Record<string, unknown>; created_at?: string; extension?: string }): Promise<Note> {
    return noteOps.createNote(this.db, content, opts);
  }

  /**
   * Drop the config caches unconditionally. Used by bulk-import paths that
   * skip per-note invalidation for throughput, and by importers that
   * directly mutate `tags` / `tags.fields` outside the singleton write
   * methods.
   */
  rebuildConfigCaches(): void {
    this._tagHierarchy = null;
    this._schemaConfig = null;
  }

  /**
   * Sync wikilinks for all notes in the vault.
   * Efficient for bulk imports — call once after importing all notes.
   */
  async syncAllWikilinks(): Promise<{ synced: number; totalAdded: number; totalRemoved: number }> {
    const allNotes = noteOps.queryNotes(this.db, { limit: 1000000 });
    let synced = 0;
    let totalAdded = 0;
    let totalRemoved = 0;

    for (const note of allNotes) {
      if (!note.content) continue;
      const result = syncWikilinks(this.db, note.id, note.content);
      if (result.added > 0 || result.removed > 0) {
        synced++;
        totalAdded += result.added;
        totalRemoved += result.removed;
      }
    }

    return { synced, totalAdded, totalRemoved };
  }

  // ---- Attachments ----

  async addAttachment(noteId: string, filePath: string, mimeType: string, metadata?: Record<string, unknown>): Promise<Attachment> {
    const id = noteOps.generateId();
    const now = new Date().toISOString();
    const metadataJson = metadata ? JSON.stringify(metadata) : "{}";
    this.db.prepare(
      "INSERT INTO attachments (id, note_id, path, mime_type, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, noteId, filePath, mimeType, metadataJson, now);

    const attachment: Attachment = { id, noteId, path: filePath, mimeType, metadata, createdAt: now };
    this.hooks.dispatchAttachment("created", attachment, this);
    return attachment;
  }

  async getAttachments(noteId: string): Promise<Attachment[]> {
    const rows = this.db.prepare(
      "SELECT * FROM attachments WHERE note_id = ? ORDER BY created_at",
    ).all(noteId) as { id: string; note_id: string; path: string; mime_type: string; metadata: string | null; created_at: string }[];

    return rows.map((r) => {
      let metadata: Record<string, unknown> | undefined;
      if (r.metadata && r.metadata !== "{}") {
        try { metadata = JSON.parse(r.metadata); } catch {}
      }
      return {
        id: r.id,
        noteId: r.note_id,
        path: r.path,
        mimeType: r.mime_type,
        metadata,
        createdAt: r.created_at,
      };
    });
  }

  async deleteAttachment(
    noteId: string,
    attachmentId: string,
  ): Promise<{ deleted: boolean; path: string | null; orphaned: boolean }> {
    // Scope by noteId so a token authorized for note A can't delete note B's attachments.
    const row = this.db.prepare(
      "SELECT path FROM attachments WHERE id = ? AND note_id = ?",
    ).get(attachmentId, noteId) as { path: string } | null;
    if (!row) return { deleted: false, path: null, orphaned: false };

    this.db.prepare("DELETE FROM attachments WHERE id = ? AND note_id = ?").run(attachmentId, noteId);

    // Orphan check: caller uses this to decide whether to unlink the file on disk.
    const other = this.db.prepare(
      "SELECT 1 FROM attachments WHERE path = ? LIMIT 1",
    ).get(row.path);

    // Post-delete event for downstream consumers (e.g. the git-mirror's
    // sweep of `.parachute/attachments/<id>/...`). Payload is the
    // DeletedAttachmentRef — the row is gone, so we pass only id /
    // note_id / path.
    this.hooks.dispatchAttachment(
      "deleted",
      { id: attachmentId, noteId, path: row.path },
      this,
    );

    return { deleted: true, path: row.path, orphaned: !other };
  }

  async getAttachment(attachmentId: string): Promise<Attachment | null> {
    const row = this.db.prepare(
      "SELECT * FROM attachments WHERE id = ?",
    ).get(attachmentId) as { id: string; note_id: string; path: string; mime_type: string; metadata: string | null; created_at: string } | null;
    if (!row) return null;
    let metadata: Record<string, unknown> | undefined;
    if (row.metadata && row.metadata !== "{}") {
      try { metadata = JSON.parse(row.metadata); } catch {}
    }
    return {
      id: row.id,
      noteId: row.note_id,
      path: row.path,
      mimeType: row.mime_type,
      metadata,
      createdAt: row.created_at,
    };
  }

  /**
   * Reverse-lookup: every attachment row whose `path` column equals the given
   * vault-internal relative path (`<date>/<filename>`). A single on-disk asset
   * can be referenced by more than one attachment row (the orphan check in
   * `deleteAttachment` accounts for that), so this returns an array. Used by
   * the raw `/api/storage/<date>/<file>` byte-serve path to map a requested
   * file back to its owning note(s) for tag-scope enforcement — without this,
   * a tag-scoped token could fetch an out-of-scope note's attachment bytes
   * directly by path (the path-secrecy-only bypass; see the C0 adversarial
   * audit finding).
   */
  async getAttachmentsByPath(path: string): Promise<Attachment[]> {
    const rows = this.db.prepare(
      "SELECT * FROM attachments WHERE path = ? ORDER BY created_at",
    ).all(path) as { id: string; note_id: string; path: string; mime_type: string; metadata: string | null; created_at: string }[];

    return rows.map((r) => {
      let metadata: Record<string, unknown> | undefined;
      if (r.metadata && r.metadata !== "{}") {
        try { metadata = JSON.parse(r.metadata); } catch {}
      }
      return {
        id: r.id,
        noteId: r.note_id,
        path: r.path,
        mimeType: r.mime_type,
        metadata,
        createdAt: r.created_at,
      };
    });
  }

  /**
   * Replace the attachment's metadata JSON blob. The caller passes the full
   * merged object — this is a set, not a patch, so partial-field updates
   * don't silently drop other keys.
   */
  async setAttachmentMetadata(attachmentId: string, metadata: Record<string, unknown>): Promise<void> {
    const json = JSON.stringify(metadata);
    this.db.prepare("UPDATE attachments SET metadata = ? WHERE id = ?").run(json, attachmentId);
  }

  /**
   * Return attachments whose metadata.transcribe_status matches the given
   * status, oldest first (FIFO). Used by the transcription worker to drain
   * the queue. `status = "pending"` is the queue; `"failed"` feeds a retry
   * sweep; `"done"` is only useful for tests and diagnostics.
   */
  async listAttachmentsByTranscribeStatus(
    status: "pending" | "failed" | "done",
    limit = 50,
  ): Promise<Attachment[]> {
    const rows = this.db.prepare(
      `SELECT * FROM attachments
       WHERE json_extract(metadata, '$.transcribe_status') = ?
       ORDER BY created_at ASC
       LIMIT ?`,
    ).all(status, limit) as { id: string; note_id: string; path: string; mime_type: string; metadata: string | null; created_at: string }[];

    return rows.map((r) => {
      let metadata: Record<string, unknown> | undefined;
      if (r.metadata && r.metadata !== "{}") {
        try { metadata = JSON.parse(r.metadata); } catch {}
      }
      return {
        id: r.id,
        noteId: r.note_id,
        path: r.path,
        mimeType: r.mime_type,
        metadata,
        createdAt: r.created_at,
      };
    });
  }
}

/** @deprecated Renamed to `BunSqliteStore` to make the runtime split explicit. Kept as an alias for backward compatibility. */
export const SqliteStore = BunSqliteStore;
/** @deprecated Renamed to `BunSqliteStore`. */
export type SqliteStore = BunSqliteStore;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
