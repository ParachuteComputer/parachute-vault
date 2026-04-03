// Tags are flat strings. All tag operations (tagNote, untagNote, listTags)
// live in notes.ts since they operate on the note_tags join table.
//
// This file re-exports them for convenience.

export { tagNote, untagNote, listTags } from "./notes.js";
