// ---- Note ----

export interface Note {
  id: string;
  content: string;
  path?: string;
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
  createdAt: string;
}

// ---- Attachment ----

export interface Attachment {
  id: string;
  noteId: string;
  path: string;
  mimeType: string;
  createdAt: string;
}

// ---- Query Options ----

export interface QueryOpts {
  tags?: string[];
  excludeTags?: string[];
  dateFrom?: string; // ISO date
  dateTo?: string;   // ISO date
  sort?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

// ---- Store Interface ----

export interface Store {
  // Notes
  createNote(content: string, opts?: { id?: string; path?: string; tags?: string[] }): Note;
  getNote(id: string): Note | null;
  updateNote(id: string, updates: { content?: string; path?: string }): Note;
  deleteNote(id: string): void;
  queryNotes(opts: QueryOpts): Note[];
  searchNotes(query: string, opts?: { tags?: string[]; limit?: number }): Note[];

  // Tags
  tagNote(noteId: string, tags: string[]): void;
  untagNote(noteId: string, tags: string[]): void;
  listTags(): { name: string; count: number }[];

  // Links
  createLink(sourceId: string, targetId: string, relationship: string): Link;
  deleteLink(sourceId: string, targetId: string, relationship: string): void;
  getLinks(noteId: string, opts?: { direction?: "outbound" | "inbound" | "both" }): Link[];

  // Attachments
  addAttachment(noteId: string, path: string, mimeType: string): Attachment;
  getAttachments(noteId: string): Attachment[];
}
