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
}

// ---- Query Options ----

export interface QueryOpts {
  tags?: string[];
  tagMatch?: "all" | "any"; // "all" = must have ALL tags (default), "any" = must have ANY tag
  excludeTags?: string[];
  path?: string;        // exact path match (case-insensitive)
  pathPrefix?: string;  // e.g., "Projects/Parachute" matches "Projects/Parachute/README"
  metadata?: Record<string, unknown>; // filter by metadata values (exact match on each key)
  dateFrom?: string;    // ISO date
  dateTo?: string;      // ISO date
  sort?: "asc" | "desc";
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
  updateNote(id: string, updates: { content?: string; path?: string; metadata?: Record<string, unknown>; created_at?: string; skipUpdatedAt?: boolean; if_updated_at?: string }): Promise<Note>;
  deleteNote(id: string): Promise<void>;
  queryNotes(opts: QueryOpts): Promise<Note[]>;
  searchNotes(query: string, opts?: { tags?: string[]; limit?: number }): Promise<Note[]>;

  // Tags
  tagNote(noteId: string, tags: string[]): Promise<void>;
  untagNote(noteId: string, tags: string[]): Promise<void>;
  listTags(): Promise<{ name: string; count: number }[]>;
  deleteTag(name: string): Promise<{ deleted: boolean; notes_untagged: number }>;

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

  // Attachments
  addAttachment(noteId: string, path: string, mimeType: string, metadata?: Record<string, unknown>): Promise<Attachment>;
  getAttachments(noteId: string): Promise<Attachment[]>;
}
