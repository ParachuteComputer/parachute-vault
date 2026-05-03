// ---- Note ----

export interface Note {
  id: string;
  content: string;
  path?: string;
  metadata?: Record<string, unknown>;
  createdAt: string; // ISO-8601
  updatedAt?: string;
  tags?: string[];
  links?: Link[];
}

// ---- Link ----

export interface Link {
  sourceId: string;
  targetId: string;
  relationship: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// ---- Attachment ----

export interface Attachment {
  id: string;
  noteId: string;
  path: string;
  mimeType: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// ---- Vault Stats ----

export interface VaultStats {
  totalNotes: number;
  earliestNote: { id: string; createdAt: string } | null;
  latestNote: { id: string; createdAt: string } | null;
  notesByMonth: { month: string; count: number }[];
  topTags: { tag: string; count: number }[];
  tagCount: number;
  linkCount: number;
}

// ---- Query Options ----

export interface QueryOpts {
  tags?: string[];
  tagMatch?: "all" | "any"; // "all" = must have ALL tags (default), "any" = must have ANY tag
  excludeTags?: string[];
  // Presence filters. `true` → has at least one; `false` → has none.
  // When `tags` is also set, `hasTags` is ignored (the tag filter already constrains the set).
  // `hasLinks` checks both directions — inbound or outbound counts as "has links".
  hasTags?: boolean;
  hasLinks?: boolean;
  path?: string;        // exact path match (case-insensitive)
  pathPrefix?: string;  // e.g., "Projects/Parachute" matches "Projects/Parachute/README"
  // Restrict results to a specific set of note IDs. The MCP `near` query uses
  // this to push graph-neighborhood scoping into the SQL WHERE clause so that
  // LIMIT and ORDER BY apply to the filtered set, not the whole notes table.
  // Empty array → no rows match (avoids `IN ()` syntax error).
  ids?: string[];
  // Per-field metadata filter. Each value is either a primitive (exact
  // match, today's behavior) or an operator object — `{ eq, ne, gt, gte, lt,
  // lte, in, not_in, exists }` — which routes through the generated column
  // for the field. Operator queries require the field to be declared
  // `indexed: true` in a tag schema; undeclared fields error loudly.
  metadata?: Record<string, unknown>;
  // Legacy shorthand: filters on `n.created_at` (vault ingestion time).
  // Equivalent to `dateFilter: { field: "created_at", from, to }`. Kept
  // as the common path; specifying both this and `dateFilter` rejects.
  dateFrom?: string;    // ISO date
  dateTo?: string;      // ISO date
  // Generalized date range. `field` defaults to `created_at`; any other
  // field must be declared `indexed: true` in a tag schema (so the SQL
  // hits a real B-tree index, same contract as `metadata` operator
  // queries and `orderBy`). Use this to filter on a *content* date — an
  // email's received date, a meeting's scheduled date — rather than the
  // ingestion timestamp.
  dateFilter?: {
    field?: string;
    from?: string;
    to?: string;
  };
  sort?: "asc" | "desc";
  // Sort by an indexed metadata field instead of `created_at`. Must be
  // declared `indexed: true`; errors loudly otherwise. Direction is taken
  // from `sort` (default "asc") and `created_at` is appended as a stable
  // tiebreaker.
  orderBy?: string;
  limit?: number;
  offset?: number;
}

/** Note summary — everything except content. Used in link results. */
export interface NoteSummary {
  id: string;
  path?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
  tags?: string[];
}

/**
 * Lean note index entry — summary + byteSize + single-line preview.
 * Used by query-notes (index mode), GET /notes (list default), and /graph.
 */
export interface NoteIndex {
  id: string;
  path?: string;
  createdAt: string;
  updatedAt?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  byteSize: number;
  preview: string;
}

/** Link with hydrated note summaries. */
export interface HydratedLink extends Link {
  sourceNote?: NoteSummary;
  targetNote?: NoteSummary;
}

// ---- Store Interface ----

export interface Store {
  // Notes
  createNote(content: string, opts?: { id?: string; path?: string; tags?: string[]; metadata?: Record<string, unknown>; created_at?: string }): Promise<Note>;
  getNote(id: string): Promise<Note | null>;
  getNoteByPath(path: string): Promise<Note | null>;
  getNotes(ids: string[]): Promise<Note[]>;
  updateNote(id: string, updates: { content?: string; append?: string; prepend?: string; path?: string; metadata?: Record<string, unknown>; created_at?: string; skipUpdatedAt?: boolean; if_updated_at?: string }): Promise<Note>;
  deleteNote(id: string): Promise<void>;
  queryNotes(opts: QueryOpts): Promise<Note[]>;
  searchNotes(query: string, opts?: { tags?: string[]; limit?: number }): Promise<Note[]>;

  // Tags
  tagNote(noteId: string, tags: string[]): Promise<void>;
  untagNote(noteId: string, tags: string[]): Promise<void>;
  /**
   * Expand a set of tag names to the union of `{tag} ∪ descendants(tag)` for
   * each input, using the `_tags/<name>` config-note hierarchy. Always
   * includes each input tag in the result. Used by tag-scoped tokens to
   * compute the effective allowlisted tag-set at auth time.
   */
  expandTagsWithDescendants(tags: string[]): Promise<Set<string>>;
  listTags(): Promise<{ name: string; count: number }[]>;
  deleteTag(name: string): Promise<{ deleted: boolean; notes_untagged: number }>;
  renameTag(
    oldName: string,
    newName: string,
  ): Promise<{ renamed: number } | { error: "not_found" } | { error: "target_exists" }>;
  mergeTags(
    sources: string[],
    target: string,
  ): Promise<{ merged: Record<string, number>; target: string }>;

  // Vault stats (aggregate, read-only)
  getVaultStats(opts?: { topTagsLimit?: number }): Promise<VaultStats>;

  // Links
  createLink(sourceId: string, targetId: string, relationship: string, metadata?: Record<string, unknown>): Promise<Link>;
  deleteLink(sourceId: string, targetId: string, relationship: string): Promise<void>;
  getLinks(noteId: string, opts?: { direction?: "outbound" | "inbound" | "both" }): Promise<Link[]>;
  listLinks(opts?: { noteId?: string; direction?: "outbound" | "inbound" | "both"; relationship?: string }): Promise<Link[]>;

  // Bulk operations
  createNotes(inputs: { content: string; id?: string; path?: string; tags?: string[] }[]): Promise<Note[]>;
  batchTag(noteIds: string[], tags: string[]): Promise<number>;
  batchUntag(noteIds: string[], tags: string[]): Promise<number>;

  // Deeper link queries
  traverseLinks(noteId: string, opts?: { max_depth?: number; relationship?: string }): Promise<{ noteId: string; depth: number; relationship: string; direction: "outbound" | "inbound" }[]>;
  findPath(sourceId: string, targetId: string, opts?: { max_depth?: number }): Promise<{ path: string[]; relationships: string[] } | null>;

  // Tag schemas
  listTagSchemas(): Promise<{ tag: string; description?: string; fields?: Record<string, { type: string; description?: string; enum?: string[] }> }[]>;
  getTagSchema(tag: string): Promise<{ tag: string; description?: string; fields?: Record<string, { type: string; description?: string; enum?: string[] }> } | null>;
  upsertTagSchema(tag: string, schema: { description?: string; fields?: Record<string, { type: string; description?: string; enum?: string[] }> }): Promise<{ tag: string; description?: string; fields?: Record<string, { type: string; description?: string; enum?: string[] }> }>;
  deleteTagSchema(tag: string): Promise<boolean>;
  getTagSchemaMap(): Promise<Record<string, { description?: string; fields?: Record<string, { type: string; description?: string; enum?: string[] }> }>>;

  // Schema validation (notes-as-config — `_schemas/*` + `_schema_defaults`).
  // Returns null when no schema applies to the given note. Synchronous —
  // the underlying resolver is in-memory after the first lazy load.
  validateNoteAgainstSchemas(note: { path?: string | null; tags?: string[]; metadata?: Record<string, unknown> }): {
    schemas: string[];
    warnings: { field: string; schema: string; reason: "missing_required" | "type_mismatch" | "enum_mismatch"; message: string }[];
  } | null;

  // Attachments
  addAttachment(noteId: string, path: string, mimeType: string, metadata?: Record<string, unknown>): Promise<Attachment>;
  getAttachments(noteId: string): Promise<Attachment[]>;
  getAttachment(attachmentId: string): Promise<Attachment | null>;
  setAttachmentMetadata(attachmentId: string, metadata: Record<string, unknown>): Promise<void>;
  deleteAttachment(noteId: string, attachmentId: string): Promise<{ deleted: boolean; path: string | null; orphaned: boolean }>;
  listAttachmentsByTranscribeStatus(status: "pending" | "failed" | "done", limit?: number): Promise<Attachment[]>;
}
