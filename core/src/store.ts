import { Database } from "bun:sqlite";
import type { Store, Note, Link, Attachment, QueryOpts, QueryNotesPage, AggregateRow } from "./types.js";
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
import {
  syncWikilinks,
  resolveUnresolvedWikilinks,
  resolveOrQueueLink,
  resolveLinkTargetDetailed,
  clearQueuedLink,
  clearQueuedLinkTarget,
  requeueInboundWikilinksForDelete,
} from "./wikilinks.js";
import { pathTitle } from "./paths.js";
import { timestampToMs } from "./cursor.js";
import { transaction } from "./txn.js";
import { HookRegistry } from "./hooks.js";
import {
  loadTagHierarchy,
  getTagExpansion,
  getTagDescendants,
  stripTagHash,
  TAG_CONFIG_PREFIX,
  DEFAULT_TAG_NAME,
  DEFAULT_TAG_EXPAND_MODE,
  type TagHierarchy,
  type TagExpandMode,
} from "./tag-hierarchy.js";
import {
  loadSchemaConfig,
  validateNote as runValidateNote,
  resolveNoteSchemas,
  type ResolvedSchemas,
  type ValidationStatus,
} from "./schema-defaults.js";
import {
  countConformanceViolations,
  type ConformanceReport,
} from "./conformance.js";
import type { SearchMode } from "./search-query.js";
import { runDoctorScan, type DoctorReport, type DoctorScanOpts } from "./doctor.js";

/**
 * Normalize a `type: "reference"` field value (scalar OR array — see
 * `BunSqliteStore.syncReferenceFieldArrayLinks`) into a Set of non-empty,
 * trimmed string elements. A bare scalar string becomes a one-element set
 * (so a cardinality transition between scalar and array diffs correctly
 * against the other side); a non-array/non-string value (undefined, null,
 * number, object, …) becomes the empty set; array elements that aren't
 * non-empty strings are dropped (they can never resolve to a link target).
 * Set semantics absorb both element ORDER and DUPLICATE entries, matching
 * how the underlying `links` table's UNIQUE(source_id, target_id,
 * relationship) would collapse duplicate-target elements anyway.
 */
function referenceValueToSet(value: unknown): Set<string> {
  const out = new Set<string>();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.trim() !== "") out.add(item);
    }
  } else if (typeof value === "string" && value.trim() !== "") {
    out.add(value);
  }
  return out;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

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
   * The transaction seam (see core/src/txn.ts). bun backs it with
   * `BEGIN IMMEDIATE … COMMIT`; a DO-backed Store overrides this with
   * `ctx.storage.transactionSync`. Synchronous — `fn` must not await.
   */
  transaction<T>(fn: () => T): T {
    return transaction(this.db, fn);
  }

  /**
   * Lazy accessor for the `_tags/*` config-note hierarchy. First call after
   * boot or after an invalidation does the scan; subsequent calls hit the
   * cache. Returns the same object until invalidated, so callers can rely
   * on identity for memoizing per-tag descendant sets.
   *
   * Public (vault#550 fold): the query-warnings collector
   * (`core/src/query-warnings.ts:collectUnknownTagWarnings`) runs on every
   * tag-filtered structured query — threading this cached hierarchy in
   * (instead of a fresh `loadTagHierarchy` per request) keeps the
   * common all-tags-known case at ~zero extra cost. Treat the returned
   * object as READ-ONLY — it's the shared cache, invalidated by writers.
   */
  getTagHierarchy(): TagHierarchy {
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
   * Auto-link sync for `type: "reference"` schema fields
   * (vault#typed-reference-field — see `docs/design/typed-reference-field.md`
   * for the full design; gaps #2/#3 closed below, see the doc for what
   * remains open).
   *
   * A `reference`-typed field is BOTH an indexed value (handled by the
   * ordinary metadata write — no special casing needed there, see
   * `tag-schemas.ts`'s `VALID_FIELD_TYPES`) AND a graph link. This method
   * maintains the second half: for every field the note's EFFECTIVE schema
   * (its own tags + ancestors, same resolution `validateNoteAgainstSchemas`
   * uses) declares `type: "reference"`, resolve the field's current metadata
   * value to a note (reusing the SAME `resolveOrQueueLink` machinery
   * structured `links` entries use — id, then path/title, with lazy
   * forward-ref queueing on a miss) and maintain a `links` edge from this
   * note to that target, `relationship` = the field name.
   *
   * Called from `createNote`/`updateNote`/`createNotes` — the single
   * chokepoint both MCP and REST funnel through — AFTER the note row itself
   * is written, so `note.tags`/`note.metadata` reflect the final state. Also
   * called from `backfillReferenceFieldLinks` (below) when `update-tag`
   * newly declares a field `type: "reference"` — gap #3.
   *
   * `priorMetadata` is the note's metadata BEFORE this write (`undefined` on
   * create, and on a backfill walk — the current value is treated as freshly
   * set so it resolves/queues unconditionally). For each SCALAR reference
   * field, if its value is unchanged from `priorMetadata`, nothing is
   * touched — the existing link (if any) already reflects it, and
   * re-running the resolve/queue machinery on every unrelated write (e.g. a
   * content-only edit) would be wasted work. When the value DID change (set,
   * changed, or removed), every existing link + queued forward-ref under
   * that field's relationship name is cleared first, then re-established
   * from the new value — this makes the field's current value the single
   * source of truth for "this field's link" without needing to track the
   * specific prior target.
   *
   * A `cardinality: "many"` (array) value takes a different path —
   * {@link syncReferenceFieldArrayLinks} — since a relationship name can now
   * back MULTIPLE edges (one per element) rather than at most one, so
   * "clear everything under this relationship, recreate" would be wrong: it
   * would drop+recreate edges for elements that didn't even change. That
   * method diffs old-vs-new array membership (a Set, so element order and
   * duplicate entries don't matter) and only touches what actually changed.
   * Dispatched whenever EITHER side of the comparison is an array — this
   * also correctly handles a field transitioning between scalar and array
   * shape (e.g. a schema's `cardinality` changes), by treating a scalar side
   * as a one-element set.
   */
  private syncReferenceFieldLinks(
    note: Note,
    priorMetadata: Record<string, unknown> | undefined,
  ): void {
    const resolution = resolveNoteSchemas(this.getSchemaConfig(), { tags: note.tags ?? [] });
    if (resolution.mergedFields.size === 0) return;

    const metadata = note.metadata ?? {};
    const prior = priorMetadata ?? {};

    for (const [fieldName, { spec }] of resolution.mergedFields) {
      if (spec.type !== "reference") continue;

      const nextValue = metadata[fieldName];
      const priorValue = prior[fieldName];

      if (Array.isArray(nextValue) || Array.isArray(priorValue)) {
        this.syncReferenceFieldArrayLinks(note.id, fieldName, nextValue, priorValue);
        continue;
      }

      if (nextValue === priorValue) continue; // unchanged — link (if any) already reflects it

      // Re-establish this field's link from scratch: drop whatever it
      // previously pointed at (a resolved link, and/or a queued forward-ref)
      // before applying the new value. See this method's doc comment for why
      // "clear then recreate" is safe and simpler than tracking the prior
      // resolved target.
      linkOps.deleteLinksBySourceRelationship(this.db, note.id, fieldName);
      clearQueuedLink(this.db, note.id, fieldName);

      if (typeof nextValue === "string" && nextValue.trim() !== "") {
        // Resolves now, or queues a lazy forward-ref on a miss — same
        // contract as a structured `links` entry (core/src/mcp.ts,
        // src/routes.ts). A queued forward-ref backfills automatically via
        // `resolveUnresolvedWikilinks` the moment a matching note is
        // created, and surfaces to callers today via the existing
        // `has_broken_links`/`broken_links` query-notes filters (both read
        // the same `unresolved_wikilinks` table this queues into) — see the
        // design doc for the follow-up to also surface an inline
        // `unresolved_link`/`ambiguous_link` warning on the create/update
        // response itself. An `"ambiguous"` outcome (vault#570 — the field's
        // value matched ≥2 notes, e.g. two notes sharing an H1 title) is
        // treated the same as a miss here: no link is created, and nothing
        // is queued (mirrors `resolveOrQueueLink`'s own "don't guess"
        // contract for structured links).
        const outcome = resolveOrQueueLink(this.db, note.id, nextValue, fieldName);
        if (outcome.status === "resolved") {
          linkOps.createLink(this.db, note.id, outcome.note_id, fieldName);
        }
      }
    }
  }

  /**
   * The `cardinality: "many"` counterpart of the scalar sync above (vault
   * typed-reference-field gap #2, docs/design/typed-reference-field.md).
   * ONE link per array element, all sharing `relationship = fieldName` — the
   * `links` table's `UNIQUE(source_id, target_id, relationship)` naturally
   * dedupes distinct elements resolving to the same target, and distinct
   * elements resolving to distinct targets coexist as separate rows under
   * the same relationship name.
   *
   * `nextValue`/`priorValue` are read as SETS of non-empty, trimmed string
   * elements (via {@link referenceValueToSet}) — a non-array scalar
   * contributes a one-element set (so a cardinality transition diffs
   * correctly), non-string/empty elements are dropped (they can never
   * resolve to a link target; `valueMatchesType` already flags them via the
   * normal `type_mismatch` path if the schema disagrees), and DUPLICATE
   * elements collapse to one (a `["carol","carol"]` array creates exactly
   * one edge to carol, matching how `createLink`'s own UNIQUE constraint
   * would collapse it anyway).
   *
   * Diffs the two sets and only touches what changed:
   * - Elements in BOTH sets are left alone — no DB write, and (crucially)
   *   an element still queued as an unresolved forward-ref stays queued
   *   rather than being torn down and re-queued under a fresh row.
   * - Elements only in the OLD set are REMOVED: resolve the value now (the
   *   same resolver the original write used — a target's path/id is stable
   *   unless the target itself was renamed/deleted since) and, if resolved,
   *   delete that one edge; either way, drop any queued forward-ref scoped
   *   to that exact element via {@link clearQueuedLinkTarget} (NOT the
   *   blanket {@link clearQueuedLink}, which would also drop OTHER elements'
   *   still-pending queue rows under the same relationship).
   * - Elements only in the NEW set are ADDED: resolve-or-queue exactly like
   *   the scalar path, including the same self-link (no guard — mirrors the
   *   scalar path, which has none either) and ambiguous-match (neither
   *   linked nor queued, vault#570) contracts.
   *
   * Two sets that are IDENTICAL (regardless of original order/duplicates in
   * either array) short-circuit to a no-op — mirrors the scalar path's
   * unchanged-value fast path.
   */
  private syncReferenceFieldArrayLinks(
    noteId: string,
    fieldName: string,
    nextValue: unknown,
    priorValue: unknown,
  ): void {
    const nextSet = referenceValueToSet(nextValue);
    const priorSet = referenceValueToSet(priorValue);

    if (setsEqual(nextSet, priorSet)) return; // same membership — nothing to do

    for (const value of priorSet) {
      if (nextSet.has(value)) continue; // present in both — untouched
      const detail = resolveLinkTargetDetailed(this.db, value);
      if (detail.resolved && detail.note_id) {
        linkOps.deleteLink(this.db, noteId, detail.note_id, fieldName);
      }
      clearQueuedLinkTarget(this.db, noteId, fieldName, value);
    }

    for (const value of nextSet) {
      if (priorSet.has(value)) continue; // present in both — untouched
      const outcome = resolveOrQueueLink(this.db, noteId, value, fieldName);
      if (outcome.status === "resolved") {
        linkOps.createLink(this.db, noteId, outcome.note_id, fieldName);
      }
    }
  }

  /**
   * Gap #3 backfill (vault typed-reference-field,
   * docs/design/typed-reference-field.md): when `update-tag` DECLARES a
   * field `type: "reference"` for the first time, or CHANGES an existing
   * field's type TO `"reference"`, existing notes that already carry a
   * value for that field predate the declaration and would otherwise sit
   * unlinked forever — only a future write that actually touches the field
   * triggers `syncReferenceFieldLinks`. This walks every note carrying
   * `tag` (or a descendant — same scope `countConformanceViolations` uses
   * for its own schema-change impact walk) and re-runs the write-path sync
   * against each note's CURRENT metadata, exactly as if the value had just
   * been set (`priorMetadata: undefined`).
   *
   * Idempotent by construction: re-declaring an unchanged schema (or
   * calling this twice) re-clears-and-recreates the SAME link/queue state
   * `syncReferenceFieldLinks`/`syncReferenceFieldArrayLinks` would already
   * be in — no duplicate rows (the `links` UNIQUE constraint plus this
   * method's own clear-before-create discipline), and a note with no value
   * for the field is a no-op (`nextValue`/`priorValue` both undefined).
   *
   * Called AFTER the schema-config cache has already been invalidated (see
   * the call site in `upsertTagRecord`), so `resolveNoteSchemas` inside the
   * sync sees the JUST-persisted field declaration rather than a stale
   * pre-write cache. Runs in its own transaction, separate from the tag
   * record write — `update-tag` is `vault:admin`-tier, so a bounded
   * per-tag(+descendants) walk here is an accepted cost, same posture as
   * `countConformanceViolations`.
   */
  private backfillReferenceFieldLinks(tag: string): void {
    const hierarchy = this.getTagHierarchy();
    const tagSet = Array.from(getTagDescendants(hierarchy, tag));
    if (tagSet.length === 0) return;

    const notes = noteOps.queryNotes(this.db, { tags: tagSet, tagMatch: "any" });
    if (notes.length === 0) return;

    const tagsById = noteOps.getNoteTagsForNotes(this.db, notes.map((n) => n.id));

    this.transaction(() => {
      for (const note of notes) {
        const tags = tagsById.get(note.id) ?? note.tags ?? [];
        this.syncReferenceFieldLinks({ ...note, tags }, undefined);
      }
    });
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

  async createNote(content: string, opts?: { id?: string; path?: string; tags?: string[]; metadata?: Record<string, unknown>; created_at?: string; extension?: string; actor?: string | null; via?: string | null }): Promise<Note> {
    const note = noteOps.createNote(this.db, content, opts);

    if (content) {
      syncWikilinks(this.db, note.id, content);
    }

    if (note.path) {
      resolveUnresolvedWikilinks(this.db, note.path, note.id);
    }

    // Reference-field auto-link (vault#typed-reference-field) — no prior
    // metadata on a fresh create. Cheap no-op when nothing on the note's
    // effective schema declares `type: "reference"`.
    this.syncReferenceFieldLinks(note, undefined);

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
      // Write-attribution (vault#298) — principal + interface of this edit.
      actor?: string | null;
      via?: string | null;
      if_updated_at?: string;
    },
  ): Promise<Note> {
    let oldPath: string | undefined;
    // Reference-field auto-link sync (vault#typed-reference-field) needs the
    // PRE-write metadata to detect which reference fields actually changed —
    // read it now, before `noteOps.updateNote` overwrites the row. Only
    // needed when this call touches `metadata` at all (a content/tags/path-
    // only update can't have changed a reference field's value, so this read
    // is skipped on the common non-metadata-touching path).
    let priorMetadataForRefs: Record<string, unknown> | undefined;
    if (updates.path !== undefined || updates.metadata !== undefined) {
      const existing = noteOps.getNote(this.db, id);
      if (updates.path !== undefined) oldPath = existing?.path;
      if (updates.metadata !== undefined) priorMetadataForRefs = existing?.metadata;
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

    // Reference-field auto-link sync (vault#typed-reference-field). Only
    // when this call actually touched `metadata` — see the read above for
    // why a content/tags/path-only update is skipped.
    if (updates.metadata !== undefined) {
      this.syncReferenceFieldLinks(note, priorMetadataForRefs);
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
    //
    // This is THE path by which non-canonical timestamps (space-form,
    // `+02:00` offset, no-`Z`) land in a vault — frontmatter is preserved
    // VERBATIM (byte-identical re-export round-trip), so `updated_at` is NOT
    // canonicalized here. The keyset ordering key `updated_at_ms` (vault#586)
    // is derived UTC-correctly from that verbatim value: `timestampToMs` does
    // NOT read space-form as local time. A genuinely unparseable `updated_at`
    // falls back to `created_at`'s ms, then to 0 — never NULL, never a throw.
    const updatedAtMs = timestampToMs(updatedAt) ?? timestampToMs(createdAt) ?? 0;
    this.db
      .prepare("UPDATE notes SET created_at = ?, updated_at = ?, updated_at_ms = ? WHERE id = ?")
      .run(createdAt, updatedAt, updatedAtMs, id);
  }

  async deleteNote(id: string): Promise<void> {
    // Read before delete so we can invalidate config caches on the way out
    // AND so the post-delete hook dispatch carries the minimum payload
    // ({ id, path }). The full note can't be reconstructed post-delete —
    // by design, hooks subscribing to "deleted" receive a DeletedNoteRef,
    // not a Note.
    const existing = noteOps.getNote(this.db, id);
    // LB6: re-queue inbound wikilink edges BEFORE the FK cascade drops the
    // `links` rows, so recreating a note at this path/title auto-heals the
    // edge instead of leaving every referencing note's `[[link]]` dead until
    // it's individually re-saved. See requeueInboundWikilinksForDelete's doc
    // comment for why this must run pre-delete and what it deliberately
    // excludes (typed `links`, not just wikilinks).
    requeueInboundWikilinksForDelete(this.db, id);
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

  /**
   * Canonical-bare-tag guard (vault#XXX) for the QUERY path. Strip any leading
   * `#` from `tags` / `excludeTags` BEFORE hierarchy expansion so a
   * `#agent/message`-form query matches a bare-stored `agent/message` row (and
   * vice-versa). This is what makes the data migration non-breaking — every
   * old `#`-decorated query keeps working, mapping onto the same bare rows.
   * Runs before `expandQueryTags` so hierarchy resolution / `_default` collapse
   * see the bare names. Empty-after-strip entries are dropped.
   */
  private normalizeQueryTags(opts: QueryOpts): QueryOpts {
    let next = opts;
    if (opts.tags && opts.tags.length > 0) {
      const tags = opts.tags.map(stripTagHash).filter((t) => t !== "");
      next = { ...next, tags };
    }
    if (opts.excludeTags && opts.excludeTags.length > 0) {
      const excludeTags = opts.excludeTags.map(stripTagHash).filter((t) => t !== "");
      next = { ...next, excludeTags };
    }
    return next;
  }

  async queryNotes(opts: QueryOpts): Promise<Note[]> {
    return noteOps.queryNotes(this.db, this.expandQueryTags(this.normalizeQueryTags(opts)));
  }

  async queryNotesPaged(opts: QueryOpts): Promise<QueryNotesPage> {
    // Hierarchy expansion happens internally — but importantly the cursor's
    // query_hash is computed from the CALLER'S opts (pre-expansion), so a
    // tag hierarchy edit between calls invalidates the cursor (different
    // descendant set → different rows match → caller should restart). The
    // alternative — hash the expanded set — would silently keep returning
    // stale results from a hierarchy snapshot the caller never saw.
    //
    // Bare-tag normalization runs first (before the hash is taken inside
    // queryNotesPaged) so a `#tag`-form page-1 and a bare `tag`-form follow-up
    // resolve to the same cursor query_hash.
    return noteOps.queryNotesPaged(this.db, this.expandQueryTags(this.normalizeQueryTags(opts)));
  }

  async aggregateNotes(opts: QueryOpts): Promise<AggregateRow[]> {
    // Same bare-tag normalization + hierarchy expansion `queryNotes` gets —
    // `opts.tags`/`excludeTags` filter the aggregate's input set the same
    // way they'd filter a normal query's result list.
    return noteOps.aggregateNotes(this.db, this.expandQueryTags(this.normalizeQueryTags(opts)));
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

  async searchNotes(query: string, opts?: { tags?: string[]; limit?: number; expand?: TagExpandMode; mode?: SearchMode; sort?: "asc" | "desc" }): Promise<Note[]> {
    // Canonical-bare-tag guard (vault#XXX): strip leading `#` from search tag
    // filters before expansion, so `#manual` and `manual` resolve identically.
    if (opts?.tags && opts.tags.length > 0) {
      opts = { ...opts, tags: opts.tags.map(stripTagHash).filter((t) => t !== "") };
    }
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

  async listTags(): Promise<{ name: string; count: number; expanded_count: number }[]> {
    return noteOps.listTags(this.db);
  }

  async deleteTag(name: string, opts?: noteOps.DeleteTagOpts): Promise<noteOps.DeleteTagResult> {
    const result = noteOps.deleteTag(this.db, name, opts);
    // Referential-integrity refusal (vault#552) — nothing was written;
    // caches and hooks are untouched.
    if ("error" in result) return result;
    // The deleted tag may have been a parent or child in the hierarchy
    // and may have declared `fields` powering schema validation. A
    // cascade/detach repair also rewrites OTHER tags' parent_names, so
    // busting the hierarchy cache covers both cases.
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
      // Same reference-field auto-link sync as singleton createNote
      // (vault#typed-reference-field) — no prior metadata on a fresh create.
      this.syncReferenceFieldLinks(note, undefined);
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

  /**
   * Read-only taxonomy/metadata integrity scan (vault#552). Pure read — no
   * cache invalidation needed since nothing is written.
   */
  async doctor(opts?: DoctorScanOpts): Promise<DoctorReport> {
    return runDoctorScan(this.db, opts);
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
    // Canonical-bare-tag guard (vault#XXX) for the SCHEMA path. Strip leading
    // `#` from the tag NAME being upserted and from every `parent_names` entry,
    // so the `tags` rows and the inheritance graph stay bare — matching the
    // bare-stored note_tags. A `#foo` schema with `parent_names: ["#bar"]`
    // becomes `foo` / `["bar"]`, so `tag:bar` still expands to `foo`.
    tag = stripTagHash(tag);
    if (patch.parent_names != null) {
      patch = {
        ...patch,
        parent_names: patch.parent_names.map(stripTagHash).filter((p) => p !== ""),
      };
    }
    // Snapshot the prior indexed-field set BEFORE the write so the diff below
    // sees what this tag declared going in. Only needed when `fields` changes.
    const priorRecord =
      patch.fields !== undefined ? tagSchemaOps.getTagRecord(this.db, tag) : null;

    const indexedSet = (fields: Record<string, tagSchemaOps.TagFieldSchema> | null | undefined) =>
      new Set(
        Object.entries(fields ?? {})
          .filter(([, v]) => v.indexed === true)
          .map(([k]) => k),
      );
    const nextFields = patch.fields; // object | null | undefined
    const priorIndexed = indexedSet(priorRecord?.fields);
    const nextIndexed = indexedSet(nextFields);

    // Gap #3 backfill trigger (vault typed-reference-field,
    // docs/design/typed-reference-field.md) — a field that's newly declared
    // (or newly CHANGED to) `type: "reference"` in THIS call needs existing
    // notes reconciled, since only a future write touching the field would
    // otherwise sync it. Scoped to fields whose type is transitioning TO
    // "reference" (prior type was something else, or the field didn't exist
    // in the prior record at all) — a field that was ALREADY "reference" and
    // stays "reference" on a re-declare is skipped here (its notes are
    // already in sync from prior writes/backfills; re-declaring an unchanged
    // schema should be a cheap no-op, not a full re-walk every time).
    const priorFieldsForRefCheck = priorRecord?.fields ?? {};
    const needsReferenceBackfill =
      patch.fields !== undefined &&
      Object.entries(nextFields ?? {}).some(
        ([fieldName, spec]) =>
          spec.type === "reference" && priorFieldsForRefCheck[fieldName]?.type !== "reference",
      );

    // PRE-VALIDATE every newly-indexed field BEFORE any persistence. A bad
    // field name (or unmappable type) must fail closed — the schema record
    // must NOT be written when the backing index can't be created. Pre-checking
    // here, before the transaction even opens, turns the failure into a clean
    // caller error (IndexedFieldError → 400) and leaves the schema untouched.
    // Without this, the prior code persisted the field declaration, THEN threw
    // on declareField — a 500 plus a tag claiming an index the engine can't
    // build (the "lying schema" loop). See vault#478.
    if (patch.fields !== undefined) {
      for (const fieldName of nextIndexed) {
        const spec = nextFields![fieldName]!;
        const mapped = indexedFieldOps.mapFieldType(spec.type);
        if (!mapped) {
          throw new indexedFieldOps.IndexedFieldError(
            `field "${fieldName}" has unsupported type "${spec.type}" for indexing (supported: string, integer, boolean, reference)`,
          );
        }
        // Throws IndexedFieldError on an invalid identifier (e.g. kebab-case).
        indexedFieldOps.validateFieldName(fieldName);
      }
      // Default-conformance + type-vocabulary pre-validate (vault#553
      // Decision B; vault#555 fix 4/5) — mirrors the indexed-type/name
      // checks above: fail BEFORE any persistence so a bad `default` or an
      // unrecognized `type` never gets written. Runs over EVERY field in the
      // full (already-merged) `nextFields` map, not just indexed ones — both
      // are tag-schema errors regardless of queryability. This is a
      // DEFENSE-IN-DEPTH backstop, not the primary user-facing gate: both
      // REST's `PUT /api/tags/:name` (`collectCrossTagFieldViolations` +
      // `collectOwnFieldDefaultAndTypeViolations`, bundled 422) and MCP's
      // `update-tag` (`collectTagFieldViolations`, same bundle) now
      // pre-validate every field and report ALL violations together BEFORE
      // ever reaching this chokepoint — a conforming call never trips this
      // fail-fast loop. It stays here so any OTHER caller of
      // `store.upsertTagRecord` (imports, migrations, scripts) still fails
      // closed rather than persisting a lying schema.
      for (const [fieldName, spec] of Object.entries(nextFields ?? {})) {
        const typeViolation = tagSchemaOps.validateFieldType(fieldName, spec);
        if (typeViolation) {
          throw new tagSchemaOps.InvalidFieldTypeError(fieldName, spec.type);
        }
        const defaultViolation = tagSchemaOps.validateFieldDefault(fieldName, spec);
        if (defaultViolation) {
          throw new tagSchemaOps.InvalidFieldDefaultError(fieldName, defaultViolation.message);
        }
      }
    }

    // Persist the record + reconcile the indexed-field lifecycle atomically.
    // If declareField throws inside the transaction (e.g. a cross-tag type
    // mismatch only detectable once the existing declarer set is consulted),
    // the whole write rolls back — the schema never ends up claiming an index
    // that doesn't exist. vault#478 transactional fix.
    const result = this.transaction(() => {
      const record = tagSchemaOps.upsertTagRecord(this.db, tag, patch);

      if (patch.fields !== undefined) {
        for (const fieldName of nextIndexed) {
          const spec = nextFields![fieldName]!;
          // Type already validated above; non-null assertion is safe here.
          const mapped = indexedFieldOps.mapFieldType(spec.type)!;
          indexedFieldOps.declareField(this.db, fieldName, mapped, tag);
        }
        for (const fieldName of priorIndexed) {
          if (!nextIndexed.has(fieldName)) {
            indexedFieldOps.releaseField(this.db, fieldName, tag);
          }
        }
      }
      return record;
    });

    if (patch.parent_names !== undefined) {
      // parent_names drives both query expansion (tag hierarchy) AND, post
      // vault#270, schema inheritance — bust both caches.
      this._tagHierarchy = null;
      this._schemaConfig = null;
    }
    if (patch.fields !== undefined) {
      this._schemaConfig = null;
    }
    // Gap #3 backfill (see the `needsReferenceBackfill` computation above) —
    // MUST run after the `_schemaConfig` invalidation immediately above, so
    // the sync below resolves fields against the JUST-persisted declaration
    // rather than a stale pre-write cache.
    if (needsReferenceBackfill) {
      this.backfillReferenceFieldLinks(tag);
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

  /**
   * Conformance check (vault#283) — count how many EXISTING notes carrying
   * `tag` (descendants included) would violate the PROPOSED field spec, so a
   * tightening edit (strict / required / narrowed enum / changed type) can
   * warn the operator BEFORE save. Pure read — no mutation. See
   * core/src/conformance.ts.
   */
  async countTagConformance(
    tag: string,
    proposedFields: Record<string, tagSchemaOps.TagFieldSchema>,
    opts?: { sampleLimit?: number },
  ): Promise<ConformanceReport> {
    return countConformanceViolations(this.db, tag, proposedFields, opts);
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
