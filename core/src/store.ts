import { Database } from "bun:sqlite";
import type { Store, Note, Link, Attachment, QueryOpts, QueryNotesPage, AggregateRow, SemanticSearchResult } from "./types.js";
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
  parseWikilinks,
  resolveWikilinkDetailed,
  rewriteWikilinkTargets,
  wikilinkPathForm,
  wikilinkRenameCandidates,
  resolveUnresolvedWikilinks,
  resolveOrQueueLink,
  clearQueuedLink,
  clearQueuedLinkTarget,
  clearAmbiguousLink,
  clearAmbiguousLinkTarget,
  refreshAmbiguousLinks,
  noteResolutionKeys,
  pathResolutionKeys,
  requeueInboundWikilinksForDelete,
} from "./wikilinks.js";
import { chunkForInClause } from "./sql-in.js";
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
  normalizeDateFields,
  type ResolvedSchemas,
  type ValidationStatus,
} from "./schema-defaults.js";
import {
  countConformanceViolations,
  type ConformanceReport,
} from "./conformance.js";
import type { SearchMode } from "./search-query.js";
import { runDoctorScan, type DoctorReport, type DoctorScanOpts } from "./doctor.js";
import { EmbeddingError, type EmbeddingProvider } from "./embedding/provider.js";
import { normalize } from "./embedding/vector-codec.js";
import { QueryError } from "./query-operators.js";

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

  /**
   * The active `EmbeddingProvider` (EXPERIMENTAL — semantic search MVP),
   * when one is configured. `undefined` on a vault with no provider —
   * `semanticSearch` reports that honestly (`semantic_unavailable`)
   * rather than silently falling back to keyword search. Resolved ONCE at
   * construction (mirrors `hooks`) — self-host/cloud each build the
   * concrete provider (ONNX/external-API, Workers AI) and pass it in here;
   * core never imports a model library itself (dependency-purity rule).
   */
  public readonly embeddingProvider?: EmbeddingProvider;

  /**
   * WHY `embeddingProvider` is absent, when the caller knows a specific
   * reason (currently: the operator set `EMBEDDINGS_ENABLED=false` — see
   * `src/embedding/select.ts`). Core never reads env vars itself
   * (dependency-purity rule — see `embeddingProvider`'s doc comment
   * above), so it can't distinguish "explicitly turned off" from "never
   * configured" on its own; the caller passes this through so
   * `semanticSearch`'s error hint can be honest either way instead of
   * defaulting to generic provider-setup instructions when the operator
   * deliberately opted out.
   */
  public readonly embeddingDisabledReason?: string;

  constructor(
    public readonly db: Database,
    opts?: { hooks?: HookRegistry; embeddingProvider?: EmbeddingProvider; embeddingDisabledReason?: string },
  ) {
    initSchema(db);
    this.hooks = opts?.hooks ?? new HookRegistry();
    this.embeddingProvider = opts?.embeddingProvider;
    this.embeddingDisabledReason = opts?.embeddingDisabledReason;
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
   * is written, so `note.tags`/`note.metadata` reflect the final state. This
   * is the WRITE-PATH (reconciling) sync; the gap #3 schema-declaration
   * backfill is a separate, purely-additive path
   * ({@link backfillReferenceFieldLinks}), so a `update-tag` re-declare never
   * churns already-correct edges.
   *
   * `priorMetadata` is the note's metadata BEFORE this write (`undefined` on
   * create). For each SCALAR reference
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
      // vault#581 twin: a recorded ambiguity for the OLD value must go too,
      // or the field would keep reporting a collision it no longer has.
      clearAmbiguousLink(this.db, note.id, fieldName);

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
   * Reconciles against the RESOLVED next-set, NOT a raw-value diff (round-4
   * review NIT 3). Resolving every element of the new array yields the exact
   * set of `target_id`s the field's edges under this relationship SHOULD
   * point at; existing edges are then reconciled TO that set:
   * - Delete every existing edge under `(noteId, relationship)` whose
   *   `target_id` is NOT in the resolved next-set. Reconciling on resolved
   *   TARGETS (not by re-resolving each removed raw string) is what makes
   *   the three corners the raw-value diff got wrong come out right:
   *   (a) a removed element whose target was renamed/deleted since — its
   *   edge's `target_id` is simply absent from the next-set, so it's
   *   dropped (the raw-value approach re-resolved the stale string, missed,
   *   and left the edge forever); (b) a removed element now ambiguous —
   *   same, dropped by target; (c) two elements ALIASING the same target
   *   (a path and its H1 title both resolving to one note) — removing one
   *   alias keeps the shared edge, because the surviving alias still
   *   resolves that `target_id` INTO the next-set (the raw-value approach
   *   deleted the shared edge when it processed the removed alias, then
   *   never recreated it because the surviving alias looked "unchanged").
   * - Create every resolved next-set edge via `createLink`'s `INSERT OR
   *   IGNORE` — an already-present edge (an element unchanged across the
   *   update) is untouched, so it KEEPS its original `created_at`.
   * - A next-set element that doesn't resolve is queued exactly like a
   *   scalar reference (self-links and ambiguous matches follow the same
   *   contract: a self element creates a self-loop; an ambiguous one is
   *   neither linked nor queued, vault#570). Queued forward-refs for
   *   elements DROPPED from the array (in prior, absent from next) are
   *   cleared per-element via {@link clearQueuedLinkTarget} — NOT the
   *   blanket {@link clearQueuedLink}, which would also drop OTHER elements'
   *   still-pending queue rows under the same relationship.
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

    // Resolve the ENTIRE next-set (queuing misses) → the target ids the
    // field's edges under this relationship should point at right now.
    const desiredTargetIds = new Set<string>();
    for (const value of nextSet) {
      const outcome = resolveOrQueueLink(this.db, noteId, value, fieldName);
      if (outcome.status === "resolved") desiredTargetIds.add(outcome.note_id);
    }

    // Reconcile existing edges to the desired target set (see the doc comment
    // for why deleting by resolved TARGET, not by re-resolved raw value, is
    // what fixes the rename / ambiguous / aliasing corners).
    const existing = linkOps.getLinks(this.db, noteId, { direction: "outbound" });
    for (const link of existing) {
      if (link.relationship !== fieldName) continue;
      if (!desiredTargetIds.has(link.targetId)) {
        linkOps.deleteLink(this.db, noteId, link.targetId, fieldName);
      }
    }

    // Create every desired edge — INSERT OR IGNORE keeps an unchanged
    // element's row (and its `created_at`) intact.
    for (const targetId of desiredTargetIds) {
      linkOps.createLink(this.db, noteId, targetId, fieldName);
    }

    // Drop queued forward-refs for elements removed from the array. A
    // still-present-but-unresolved element stays queued (re-queued
    // idempotently above).
    for (const value of priorSet) {
      if (!nextSet.has(value)) {
        clearQueuedLinkTarget(this.db, noteId, fieldName, value);
        clearAmbiguousLinkTarget(this.db, noteId, fieldName, value); // vault#581 twin
      }
    }
  }

  /**
   * Gap #3 backfill (vault typed-reference-field,
   * docs/design/typed-reference-field.md): when `update-tag`'s persisted
   * schema for `tag` includes one or more `type: "reference"` fields,
   * existing notes that already carry a value for such a field may predate
   * the declaration (or predate the gap #2 array-link fix) and sit unlinked
   * — only a future write that actually touches the field would otherwise
   * sync it. This walks every note carrying `tag` (or a descendant, via
   * schema inheritance — same scope `countConformanceViolations` uses for
   * its own schema-change impact walk) and materializes the missing links
   * for each note's CURRENT value of the declared reference field(s).
   *
   * `referenceFieldNames` is the set of fields THIS `update-tag` persisted
   * as `type: "reference"` (round-4 review NIT 5) — the walk syncs ONLY
   * those, never every reference field the note happens to carry from OTHER
   * co-tags/ancestors, so declaring a reference field on tag A can't churn
   * an unrelated reference field contributed by tag B on a note carrying
   * both. Fired for ANY reference field in the declared schema, not just a
   * type-transition (round-4 review BLOCKER 2), so re-declaring an
   * already-reference field HEALS notes whose links were never built —
   * exactly what UPGRADING tells operators to do. Safe to re-run: the
   * backfill is purely ADDITIVE + idempotent (see
   * {@link backfillOneReferenceField}).
   *
   * Walks the FULL matching note set — the id sweep is unbounded (round-4
   * review BLOCKER 1: `queryNotes` silently caps at LIMIT 100, which on a
   * >100-note tag left the majority of notes unlinked — the exact
   * silent-half-graph this feature exists to prevent). Ids are collected by
   * a direct `note_tags` scan chunked under the IN-param cap, then hydrated
   * in batches.
   *
   * Runs INSIDE the caller's tag-write transaction (round-4 review NIT 4 —
   * NOT its own separate transaction), so a walk failure rolls the schema
   * write back and the retry re-fires rather than leaving a persisted
   * `reference` schema whose links never got built. `update-tag` is
   * `vault:admin`-tier, so a bounded per-tag(+descendants) walk is an
   * accepted cost.
   */
  private backfillReferenceFieldLinks(tag: string, referenceFieldNames: Set<string>): void {
    if (referenceFieldNames.size === 0) return;
    const hierarchy = this.getTagHierarchy();
    const tagSet = Array.from(getTagDescendants(hierarchy, tag));
    if (tagSet.length === 0) return;

    // Unbounded id sweep: every note carrying `tag` or a descendant. Direct
    // note_tags scan (deduped across tags), chunked under the IN-param cap —
    // NO default LIMIT, unlike `queryNotes`.
    const idSet = new Set<string>();
    for (const chunk of chunkForInClause(tagSet)) {
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = this.db.prepare(
        `SELECT DISTINCT note_id FROM note_tags WHERE tag_name IN (${placeholders})`,
      ).all(...chunk) as { note_id: string }[];
      for (const r of rows) idSet.add(r.note_id);
    }
    if (idSet.size === 0) return;

    const ids = Array.from(idSet);
    const schemaConfig = this.getSchemaConfig();
    const tagsById = noteOps.getNoteTagsForNotes(this.db, ids);
    const notes = noteOps.getNotes(this.db, ids);

    for (const note of notes) {
      const tags = tagsById.get(note.id) ?? note.tags ?? [];
      const resolution = resolveNoteSchemas(schemaConfig, { tags });
      const metadata = note.metadata ?? {};
      for (const fieldName of referenceFieldNames) {
        const merged = resolution.mergedFields.get(fieldName);
        // The field must actually be `reference` in THIS note's effective
        // schema — a descendant tag can override it to a non-reference type
        // (first-in-walk wins), in which case this note doesn't get a link.
        if (!merged || merged.spec.type !== "reference") continue;
        this.backfillOneReferenceField(note.id, fieldName, metadata[fieldName]);
      }
    }
  }

  /**
   * Materialize the missing graph link(s) for ONE reference field's current
   * value on one note (gap #3 backfill helper). Purely ADDITIVE and
   * idempotent: for each element of the value (a scalar string is a
   * one-element set; an array is deduped via {@link referenceValueToSet}),
   * resolve-or-queue and, on a resolve, `createLink`. It NEVER deletes an
   * edge — a backfill materializes links that were never built; reconciling
   * divergent state (removing a stale edge when a value CHANGES) stays the
   * write path's job (`syncReferenceFieldLinks` /
   * {@link syncReferenceFieldArrayLinks}). Because `createLink` and the
   * forward-ref queue are both `INSERT OR IGNORE`, a re-run — or an edge
   * that already exists — is a no-op that preserves the existing row's
   * `created_at` (so re-declaring a schema doesn't churn already-correct
   * edges, and a scalar value that has since gone ambiguous doesn't silently
   * lose its already-built edge — round-4 review NIT 5).
   */
  private backfillOneReferenceField(noteId: string, fieldName: string, value: unknown): void {
    for (const element of referenceValueToSet(value)) {
      const outcome = resolveOrQueueLink(this.db, noteId, element, fieldName);
      if (outcome.status === "resolved") {
        linkOps.createLink(this.db, noteId, outcome.note_id, fieldName);
      }
    }
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
    // Normalize `date`-typed field values to canonical UTC ISO form BEFORE
    // the write (vault#date-field-type — mixed-offset TEXT-compare
    // corruption). COPY-ON-WRITE (round 2) — reassign the local `opts`
    // binding from the returned value rather than mutating the caller's
    // object; see `normalizeDateFields`'s doc comment.
    if (opts?.metadata) {
      const normalized = normalizeDateFields(this.getSchemaConfig(), { tags: opts.tags, metadata: opts.metadata });
      if (normalized !== opts.metadata) opts = { ...opts, metadata: normalized };
    }

    const note = noteOps.createNote(this.db, content, opts);

    if (content) {
      syncWikilinks(this.db, note.id, content);
    }

    if (note.path) {
      resolveUnresolvedWikilinks(this.db, note.path, note.id);
      // vault#581 — this note becoming a NEW candidate can only make an
      // existing ambiguity wider, but the recorded `candidate_count` has to
      // stay honest. Bounded to rows whose target could name this note.
      refreshAmbiguousLinks(this.db, noteResolutionKeys(note));
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
      /**
       * `date`-field normalization override (vault#date-field-type review
       * round 2). By default, `normalizeDateFields` below resolves the note's
       * effective schema against its CURRENT tags in the DB — correct when
       * this call doesn't also change tags. A caller that adds a tag IN THIS
       * SAME logical update (via a separate `store.tagNote` issued right
       * after this call — see mcp.ts's `update-note` handler and the batch
       * upsert "update"/"replace" branch) must pass the PROJECTED final tag
       * set here instead, or a newly-added tag's `type: "date"` field never
       * gets seen (the schema resolution would still be looking at the
       * pre-write tag set) and its offset-bearing value would persist
       * verbatim. Ignored when `updates.metadata` is undefined.
       */
      tagsForSchemaResolution?: string[];
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
      if (updates.metadata !== undefined) {
        priorMetadataForRefs = existing?.metadata;
        // Normalize `date`-typed field values to canonical UTC ISO form
        // BEFORE the write (vault#date-field-type — mixed-offset TEXT-
        // compare corruption). COPY-ON-WRITE (round 2) — reassign the local
        // `updates` binding from the returned value rather than mutating the
        // caller's object; see `normalizeDateFields`'s doc comment.
        // `tagsForSchemaResolution` (when the caller is ALSO adding a tag in
        // this same logical update) wins over the note's current DB tags.
        const tagsForResolution = updates.tagsForSchemaResolution ?? existing?.tags;
        const normalized = normalizeDateFields(this.getSchemaConfig(), { tags: tagsForResolution, metadata: updates.metadata });
        if (normalized !== updates.metadata) updates = { ...updates, metadata: normalized };
      }
    }

    // vault#708 — the rename cascade has to know which brackets resolved to
    // THIS note, and resolution is only observable BEFORE the path moves.
    // So the plan (source note -> the exact bracket texts that pointed here)
    // is computed against the pre-write index; `cascadeRename` applies it
    // after, when the new path is known.
    const cascadePlan = oldPath && updates.path !== undefined && oldPath !== updates.path
      ? this.planCascadeRename(id, oldPath)
      : undefined;

    const note = noteOps.updateNote(this.db, id, updates);

    // Wikilink sync runs against the *resulting* content. For append/prepend
    // we don't have the new value pre-write — read it back off the returned
    // note so a `[[Foo]]` introduced via append still creates the link.
    if (updates.content !== undefined || updates.append !== undefined || updates.prepend !== undefined) {
      syncWikilinks(this.db, id, note.content);
    }

    if (updates.path !== undefined && note.path) {
      if (cascadePlan && oldPath && oldPath !== note.path) {
        this.cascadeRename(cascadePlan, note, oldPath);
      }
      resolveUnresolvedWikilinks(this.db, note.path, id);
      // vault#581 — a rename is one of the two ways an ambiguity stops being
      // ambiguous (the other is a delete). Sweep the OLD path's keys as well
      // as the new ones: it's the target the collision was recorded under.
      refreshAmbiguousLinks(this.db, [
        ...pathResolutionKeys(oldPath, note.extension),
        ...noteResolutionKeys(note),
      ]);
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
   * Plan the rename cascade (vault#708) — for a note about to move off
   * `oldPath`, the exact `[[bracket]]` texts in each source note that
   * RESOLVED TO THIS NOTE, keyed by source id.
   *
   * MUST run before the path write: resolution is a property of the index,
   * and once the row moves, `[[Rename]]` no longer means what it meant.
   *
   * The source set comes from the `links` rows pointing at this note
   * (`relationship = 'wikilink'`) — an index-driven prefilter that already
   * excludes the two classes the old basename-matching cascade corrupted:
   *   - AMBIGUOUS brackets (`[[Rename]]` with `keep/Rename` AND `move/Rename`
   *     present) never get a `links` row at all — they live in
   *     `ambiguous_wikilinks` (vault#581/#707) and are healed by
   *     `refreshAmbiguousLinks` after the rename, not by a text rewrite.
   *   - brackets that resolved to a DIFFERENT same-basename note, whose
   *     `links` row points elsewhere.
   * The note itself is added to the set because a self-referencing bracket
   * is deliberately never given a `links` row (`syncWikilinks` skips
   * self-links) yet the old cascade rewrote it — parity.
   *
   * `links` rows only say "this note links here", not WHICH bracket did it
   * (`syncWikilinks` dedupes by resolved target id and stores no bracket
   * text), so every candidate source is re-parsed and each bracket
   * re-resolved. That is also what keeps a source's OTHER same-named
   * brackets untouched.
   */
  private planCascadeRename(id: string, oldPath: string): Map<string, string[]> {
    const rows = this.db.prepare(
      "SELECT source_id FROM links WHERE target_id = ? AND relationship = 'wikilink'",
    ).all(id) as { source_id: string }[];
    const sourceIds = new Set<string>(rows.map((r) => r.source_id));
    sourceIds.add(id);

    const plan = new Map<string, string[]>();
    for (const sourceId of sourceIds) {
      const row = this.db.prepare("SELECT content FROM notes WHERE id = ?")
        .get(sourceId) as { content: string } | null;
      if (!row?.content) continue;
      const targets: string[] = [];
      const seen = new Set<string>();
      for (const wl of parseWikilinks(row.content)) {
        const key = wl.target.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        // Only path-derived forms of the old path can be invalidated by a
        // repath; an H1-title-fallback bracket keeps resolving and must not
        // be touched.
        if (!wikilinkPathForm(wl.target, oldPath)) continue;
        const detail = resolveWikilinkDetailed(this.db, wl.target);
        if (detail.resolved && detail.note_id === id) targets.push(wl.target);
      }
      if (targets.length > 0) plan.set(sourceId, targets);
    }
    return plan;
  }

  /**
   * Apply a {@link planCascadeRename} plan after the path write: rewrite only
   * the brackets that resolved to the renamed note, preserving each one's
   * shape (basename stays a basename, full path stays a full path, an
   * explicit `.ext` keeps its `.ext`). A basename widens to the full path
   * only when the NEW basename would no longer resolve back to this note —
   * i.e. the move created a fresh collision.
   *
   * Each rewritten source is re-parsed via `syncWikilinks`, so `links`,
   * `unresolved_wikilinks` and `ambiguous_wikilinks` stay consistent with
   * the new text.
   */
  private cascadeRename(plan: Map<string, string[]>, note: Note, oldPath: string): void {
    if (plan.size === 0 || !note.path) return;
    const newPath = note.path;

    // One resolution per distinct bracket text, shared across sources.
    const replacement = new Map<string, string>();

    for (const [sourceId, targets] of plan) {
      const row = this.db.prepare("SELECT content FROM notes WHERE id = ?")
        .get(sourceId) as { content: string } | null;
      if (!row?.content) continue;

      const mapping = new Map<string, string>();
      for (const target of targets) {
        const key = target.toLowerCase();
        let next = replacement.get(key);
        if (next === undefined) {
          const form = wikilinkPathForm(target, oldPath);
          if (!form) continue;
          const candidates = wikilinkRenameCandidates(form, newPath, note.extension);
          // First candidate that actually resolves back to this note wins;
          // if none does (e.g. every shape is now ambiguous), keep the
          // preferred shape rather than inventing a third one.
          next = candidates.find((c) => {
            const detail = resolveWikilinkDetailed(this.db, c);
            return detail.resolved && detail.note_id === note.id;
          }) ?? candidates[0]!;
          replacement.set(key, next);
        }
        if (next !== target) mapping.set(key, next);
      }
      if (mapping.size === 0) continue;

      const updated = rewriteWikilinkTargets(
        row.content,
        (target) => mapping.get(target.toLowerCase()) ?? null,
      );
      if (updated !== row.content) {
        noteOps.updateNote(this.db, sourceId, { content: updated });
        syncWikilinks(this.db, sourceId, updated);
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
    // vault#581 — the deleted note's resolution keys, captured BEFORE the row
    // goes away and swept AFTER, so a `[[Dup]]` that was ambiguous only
    // because of THIS note resolves (or, if it was the last candidate,
    // demotes to an ordinary broken link).
    const ambiguityKeys = noteResolutionKeys(existing);
    noteOps.deleteNote(this.db, id);
    refreshAmbiguousLinks(this.db, ambiguityKeys);
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

  async searchNotes(query: string, opts?: QueryOpts & { mode?: SearchMode }): Promise<Note[]> {
    // Same bare-tag strip + hierarchy expansion queryNotes uses, so
    // `search` + `tag: "manual"` still matches declared descendants
    // (vault#227) and `#tag` / `tag` resolve identically. Default
    // `tagMatch` to `"any"` when the caller didn't set it — historical FTS
    // tag semantics are a single IN (...) ("any tag matches"), which also
    // makes `_default` collapse drop the whole tag filter (OR + universal
    // parent = every note).
    const incoming = opts ?? {};
    const withTagMatch: QueryOpts & { mode?: SearchMode } = {
      ...incoming,
      tagMatch: incoming.tagMatch ?? (incoming.tags && incoming.tags.length > 0 ? "any" : undefined),
    };
    const expanded = this.expandQueryTags(this.normalizeQueryTags(withTagMatch));
    const { expand: _e, ...rest } = expanded as QueryOpts & { mode?: SearchMode };
    return noteOps.searchNotes(this.db, query, rest);
  }

  /**
   * Semantic search (EXPERIMENTAL — `SEMANTIC-MVP-PLAN.md`). The ONE
   * invocation point for `embeddingProvider`: resolves it, embeds
   * `nearText` into a query vector, normalizes it (stored vectors are
   * ALSO L2-normalized — see `note_vectors`'s schema comment — so the
   * scan's dot product is cosine similarity), and calls
   * `noteOps.semanticSearchNotes` with the SAME tag-hierarchy expansion
   * `queryNotes` applies (so `semantic: true, tag: "manual"` composes with
   * the tag `expand` axis identically to a structured query).
   *
   * Throws a `QueryError` (`error_type: "semantic_unavailable"`) when no
   * provider is configured, the configured one reports itself not ready,
   * OR the embed call itself fails mid-flight (e.g. the bundled ONNX
   * floor's lazy model load fails on this — the FIRST — real `embed()`
   * attempt, after `available()` optimistically reported `ok: true`; see
   * `onnx-transformers.ts`'s "lazy-fail, not crash" doc) — NEVER a silent
   * fallback to keyword search, and never a raw unstructured 500. Callers
   * (MCP/REST) let this propagate uncaught, same as
   * `invalid_search_syntax` above.
   */
  async semanticSearch(nearText: string, opts?: QueryOpts): Promise<SemanticSearchResult> {
    if (!this.embeddingProvider) {
      // Honest either way: if the caller told us WHY (operator explicitly
      // set EMBEDDINGS_ENABLED=false), say that — not generic provider-setup
      // instructions that would be actively misleading for a deliberate
      // opt-out. See `embeddingDisabledReason`'s doc comment.
      throw new QueryError(
        `semantic search requires an embedding provider — none is configured on this vault`,
        "SEMANTIC_UNAVAILABLE",
        {
          error_type: "semantic_unavailable",
          hint:
            this.embeddingDisabledReason ??
            "configure EMBEDDING_API_URL/EMBEDDING_API_KEY/EMBEDDING_MODEL, or rely on the bundled floor provider (self-host); semantic search is not yet available on this door otherwise",
        },
      );
    }
    const availability = await this.embeddingProvider.available();
    if (!availability.ok) {
      throw new QueryError(
        `semantic search is unavailable: ${availability.reason ?? "embedding provider not ready"}`,
        "SEMANTIC_UNAVAILABLE",
        { error_type: "semantic_unavailable", hint: availability.reason },
      );
    }

    let vectors: Float32Array[];
    try {
      ({ vectors } = await this.embeddingProvider.embed({ texts: [nearText] }));
    } catch (err) {
      // `available()` passing is only a CHEAP readiness check (never a real
      // network/model round-trip — see EmbeddingProvider.available's doc
      // comment) — it can't catch a provider whose actual first embed call
      // fails (a lazy model load blowing up, a transient upstream error).
      // Map ANY embed()-time failure to the same honest semantic_unavailable
      // shape as the checks above, rather than letting a raw EmbeddingError
      // (or whatever else a provider throws) surface as an unstructured 500.
      const reason = err instanceof EmbeddingError ? err.message : err instanceof Error ? err.message : String(err);
      throw new QueryError(`semantic search is unavailable: ${reason}`, "SEMANTIC_UNAVAILABLE", {
        error_type: "semantic_unavailable",
        hint: reason,
      });
    }
    const queryVector = normalize(vectors[0]!);

    const filterOpts = this.expandQueryTags(this.normalizeQueryTags(opts ?? {}));
    return noteOps.semanticSearchNotes(this.db, queryVector, filterOpts, this.embeddingProvider.model);
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
    // Same pre-write `date`-field normalization as singleton createNote
    // (vault#date-field-type) — this bulk path bypasses it otherwise.
    // COPY-ON-WRITE (round 2) — build a new array with only the items that
    // actually need a rewrite replaced; never mutate the caller's `inputs`
    // or its element objects.
    const schemaConfig = this.getSchemaConfig();
    const normalizedInputs = inputs.map((input) => {
      if (!input.metadata) return input;
      const normalized = normalizeDateFields(schemaConfig, { tags: input.tags, metadata: input.metadata });
      return normalized !== input.metadata ? { ...input, metadata: normalized } : input;
    });
    const notes = noteOps.createNotes(this.db, normalizedInputs);
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

    // Gap #3 backfill target set (vault typed-reference-field,
    // docs/design/typed-reference-field.md) — the field names THIS call
    // persists as `type: "reference"`. Fired for ANY reference field in the
    // declared schema, NOT just a type-transition (round-4 review BLOCKER
    // 2): keying on "transition to reference" made the documented
    // "re-declare the field to heal existing notes" path a silent no-op (an
    // already-reference field stays reference, so the transition never
    // fires), stranding pre-fix vaults whose reference-many links were never
    // built. The backfill itself is additive + idempotent, so re-firing on
    // every declare is safe; `update-tag` is a rare admin op, so the bounded
    // walk is an accepted cost. Empty when `fields` is untouched or cleared.
    const referenceFieldNames = new Set<string>(
      patch.fields !== undefined
        ? Object.entries(nextFields ?? {})
            .filter(([, spec]) => spec.type === "reference")
            .map(([name]) => name)
        : [],
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
            `field "${fieldName}" has unsupported type "${spec.type}" for indexing (supported: string, integer, boolean, reference, date)`,
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

    // Persist the record + reconcile the indexed-field lifecycle AND the
    // gap #3 reference-link backfill atomically, in ONE transaction (round-4
    // review NIT 4). If declareField throws (e.g. a cross-tag type mismatch
    // only detectable once the existing declarer set is consulted) OR the
    // backfill walk throws, the whole write rolls back — the schema never
    // ends up claiming an index that doesn't exist (vault#478), and never
    // persists a `reference` declaration whose links silently failed to
    // build (a partial-state 500 whose retry, post-BLOCKER-2, would re-fire
    // and heal — but atomic avoids the partial state in the first place).
    let result: tagSchemaOps.TagRecord;
    try {
      result = this.transaction(() => {
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

        // Gap #3 backfill — INSIDE the transaction. Bust the in-memory
        // caches FIRST (round-4 review NIT 6): the walk's
        // `resolveNoteSchemas` must see the just-persisted reference
        // declaration, and `getTagDescendants` must see the post-write
        // hierarchy — including the `_default` universal-parent gate a
        // first-time `_default` row flips (which used to be busted only
        // AFTER the backfill call). Nulling a cache inside the txn is safe:
        // it only forces a rebuild from the current in-txn DB state; the
        // `finally` below re-nulls so a rollback can't strand the rebuild.
        if (referenceFieldNames.size > 0) {
          this._tagHierarchy = null;
          this._schemaConfig = null;
          this.backfillReferenceFieldLinks(tag, referenceFieldNames);
        }
        return record;
      });
    } finally {
      // Invalidate whatever this write (or the backfill's mid-txn cache
      // rebuild) may have touched — on BOTH the commit and the rollback
      // path. `parent_names` drives query expansion + (vault#270) schema
      // inheritance; `fields` drives schema validation; a first-time
      // `_default` row flips the universal-parent gate; and the backfill
      // above re-caches mid-transaction state a rollback must not keep.
      if (
        patch.parent_names !== undefined ||
        patch.fields !== undefined ||
        tag === "_default" ||
        referenceFieldNames.size > 0
      ) {
        this._tagHierarchy = null;
        this._schemaConfig = null;
      }
    }

    // Tag-mutation event for the git-mirror and any other downstream
    // consumer. Fire "upserted" on every successful tag-record write —
    // schema/relationship/parent-name mutations all alter the sidecar
    // contents the mirror persists. (Success path only — a thrown/rolled-back
    // write never reaches here.)
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
    // Same pre-write `date`-field normalization as createNote
    // (vault#date-field-type) — the legacy Obsidian importer (obsidian.ts)
    // funnels through this path and bypasses createNote's copy otherwise.
    // COPY-ON-WRITE (round 2) — see normalizeDateFields's doc comment.
    if (opts?.metadata) {
      const normalized = normalizeDateFields(this.getSchemaConfig(), { tags: opts.tags, metadata: opts.metadata });
      if (normalized !== opts.metadata) opts = { ...opts, metadata: normalized };
    }
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
