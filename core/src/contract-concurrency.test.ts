/**
 * Contract suite — concurrency + write-path strengths (Wave 1 of the
 * Reliability & Usability Program, umbrella #556). Encodes the 2026-07-09
 * nine-persona deep test's verdict that "the storage/concurrency core is
 * trustworthy — zero server errors, zero corruption, zero lost writes across
 * ~100 hostile operations and a live two-writer session" (#556, #555 work
 * item "document the strong contracts the deep test verified but that are
 * currently unwritten selling points"). Every test here is a PASSING lock-in
 * — there is no known-broken behavior in this file, only undocumented
 * correctness worth pinning as contract before later waves touch adjacent
 * code paths.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { ConflictError, PathConflictError } from "./notes.js";

let store: SqliteStore;
let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

describe("contract: concurrency — passing (lock in verified strengths)", () => {
  it("sequential interleaved appends from two writers preserve call order and lose nothing (25-line pattern)", async () => {
    const note = await store.createNote("", { id: "log" });

    // Simulate two independent writers interleaving 25 appends each.
    // Sequential (not truly parallel) — the contract under test is that
    // SQL-level `content = content || ?` concatenation never drops or
    // reorders a write relative to the order calls actually landed in,
    // which is exactly what a real two-writer race also guarantees
    // (see core.test.ts's "update-note append is atomic under concurrent
    // calls" for the Promise.all interleaving twin of this test).
    const expectedLines: string[] = [];
    for (let i = 1; i <= 25; i++) {
      const lineA = `writer-A line ${i}\n`;
      await store.updateNote(note.id, { append: lineA });
      expectedLines.push(lineA);

      const lineB = `writer-B line ${i}\n`;
      await store.updateNote(note.id, { append: lineB });
      expectedLines.push(lineB);
    }

    const final = await store.getNote(note.id);
    expect(final!.content).toBe(expectedLines.join(""));
    // 50 appends, none lost: every planted line is present exactly once.
    expect(final!.content.match(/writer-A line/g)?.length).toBe(25);
    expect(final!.content.match(/writer-B line/g)?.length).toBe(25);
  });

  it("two updates racing on the same if_updated_at token: exactly one succeeds, the other gets a ConflictError", async () => {
    const note = await store.createNote("v0", { id: "n1" });
    const token = note.updatedAt!;

    const first = await store.updateNote(note.id, { content: "v1 (writer A)", if_updated_at: token });
    expect(first.content).toBe("v1 (writer A)");

    let err: any;
    try {
      // Writer B read the note before writer A's update landed and is still
      // holding the stale token — this must conflict, not silently overwrite.
      await store.updateNote(note.id, { content: "v1 (writer B)", if_updated_at: token });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.note_id).toBe(note.id);
    expect(err.expected_updated_at).toBe(token);
    expect(err.current_updated_at).toBe(first.updatedAt);

    // Writer A's write is the one that stuck.
    const final = await store.getNote(note.id);
    expect(final!.content).toBe("v1 (writer A)");
  });

  it("creating a note at an already-taken path throws PathConflictError — the prior note is untouched", async () => {
    const original = await store.createNote("original owner", { path: "shared/path" });

    let err: any;
    try {
      await store.createNote("racing creator", { path: "shared/path" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PathConflictError);
    expect(err.path).toBe("shared/path");

    const survivor = await store.getNote(original.id);
    expect(survivor!.content).toBe("original owner");
  });

  it("a metadata update merges rather than replaces — untouched top-level keys survive a partial patch", async () => {
    const note = await store.createNote("has metadata", {
      metadata: { keep: "me", also_keep: 42, drop_me: "bye" },
    });

    // mergeMetadata is the pure merge primitive the MCP/REST write paths
    // call before handing the merged object to store.updateNote (the
    // Store/engine-level updateNote itself replaces `metadata` wholesale —
    // merge is a caller responsibility, exercised here directly).
    const { mergeMetadata } = await import("./notes.js");
    const merged = mergeMetadata(note.metadata as Record<string, unknown>, {
      also_keep: 43,
      drop_me: null,
      new_key: "hello",
    });
    await store.updateNote(note.id, { metadata: merged, if_updated_at: note.updatedAt });

    const after = await store.getNote(note.id);
    expect(after!.metadata).toEqual({ keep: "me", also_keep: 43, new_key: "hello" });
  });
});
