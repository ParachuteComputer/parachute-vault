import { describe, it, expect } from "bun:test";
import { buildPredicate, registerTriggers } from "./triggers.ts";
import { HookRegistry } from "../core/src/hooks.ts";
import type { Note } from "../core/src/types.ts";
import type { TriggerConfig } from "./config.ts";

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "test-1",
    content: "hello world",
    tags: [],
    metadata: {},
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("buildPredicate", () => {
  it("matches when all conditions are met", () => {
    const pred = buildPredicate(
      { tags: ["reader"], has_content: true, missing_metadata: ["audio_rendered_at"] },
      "tts_reader",
    );
    const note = makeNote({ tags: ["reader"], content: "some text" });
    expect(pred(note)).toBe(true);
  });

  it("rejects when pending marker is set", () => {
    const pred = buildPredicate({ tags: ["reader"] }, "tts_reader");
    const note = makeNote({
      tags: ["reader"],
      metadata: { tts_reader_pending_at: "2025-01-01" },
    });
    expect(pred(note)).toBe(false);
  });

  it("rejects when rendered marker is set", () => {
    const pred = buildPredicate({ tags: ["reader"] }, "tts_reader");
    const note = makeNote({
      tags: ["reader"],
      metadata: { tts_reader_rendered_at: "2025-01-01" },
    });
    expect(pred(note)).toBe(false);
  });

  it("rejects when required tag is missing", () => {
    const pred = buildPredicate({ tags: ["reader"] }, "tts_reader");
    const note = makeNote({ tags: ["other"] });
    expect(pred(note)).toBe(false);
  });

  it("rejects when has_content=true and content is empty", () => {
    const pred = buildPredicate({ has_content: true }, "test");
    expect(pred(makeNote({ content: "" }))).toBe(false);
    expect(pred(makeNote({ content: "   " }))).toBe(false);
  });

  it("rejects when has_content=false and content is present", () => {
    const pred = buildPredicate({ has_content: false }, "test");
    expect(pred(makeNote({ content: "hello" }))).toBe(false);
  });

  it("matches has_content=false when content is empty", () => {
    const pred = buildPredicate({ has_content: false }, "test");
    expect(pred(makeNote({ content: "" }))).toBe(true);
  });

  it("rejects when missing_metadata key is present", () => {
    const pred = buildPredicate({ missing_metadata: ["done"] }, "test");
    const note = makeNote({ metadata: { done: true } });
    expect(pred(note)).toBe(false);
  });

  it("matches when missing_metadata key is absent", () => {
    const pred = buildPredicate({ missing_metadata: ["done"] }, "test");
    const note = makeNote({ metadata: {} });
    expect(pred(note)).toBe(true);
  });

  it("rejects when has_metadata key is absent", () => {
    const pred = buildPredicate({ has_metadata: ["source"] }, "test");
    const note = makeNote({ metadata: {} });
    expect(pred(note)).toBe(false);
  });

  it("matches when has_metadata key is present", () => {
    const pred = buildPredicate({ has_metadata: ["source"] }, "test");
    const note = makeNote({ metadata: { source: "voice" } });
    expect(pred(note)).toBe(true);
  });

  it("requires all tags to match", () => {
    const pred = buildPredicate({ tags: ["reader", "important"] }, "test");
    expect(pred(makeNote({ tags: ["reader"] }))).toBe(false);
    expect(pred(makeNote({ tags: ["reader", "important"] }))).toBe(true);
  });
});

describe("registerTriggers", () => {
  it("skips triggers with invalid webhook URLs", () => {
    const hooks = new HookRegistry();
    const errors: string[] = [];
    const logger = {
      error: (...args: unknown[]) => errors.push(args.map(String).join(" ")),
      info: () => {},
    };

    registerTriggers(hooks, [
      {
        name: "bad-url",
        when: { tags: ["test"] },
        action: { webhook: "not-a-url" },
      },
      {
        name: "bad-scheme",
        when: { tags: ["test"] },
        action: { webhook: "ftp://example.com/hook" },
      },
      {
        name: "good",
        when: { tags: ["test"] },
        action: { webhook: "http://localhost:8080/hook" },
      },
    ], logger);

    expect(hooks.size).toBe(1); // only "good" registered
    expect(errors.length).toBe(2);
    expect(errors[0]).toContain("bad-url");
    expect(errors[1]).toContain("bad-scheme");
  });
});
