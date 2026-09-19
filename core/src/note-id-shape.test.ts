import { test, expect } from "bun:test";
import { isNoteIdShape } from "./ulid.js";

test("note ID shape accepts exact legacy strings without coercion", () => {
  for (const id of ["a", "A", "legacy:abc123", "2020-01-02-03-04-05", "shortid", "a_b", "a".repeat(64), "01M2KT1VQBHNZ99V5KSGXP6VSE"])
    expect(isNoteIdShape(id)).toBe(true);
  for (const id of ["", "a b", "a/b", "a.b", "a".repeat(65), "-leading", "_leading", ":leading", "a\n", "a\r", "a\0", "é", 123, null, undefined])
    expect(isNoteIdShape(id)).toBe(false);
});
