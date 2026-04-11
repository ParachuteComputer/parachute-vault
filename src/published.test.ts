import { describe, it, expect } from "bun:test";
import { handlePublicNote } from "./routes.ts";

// Minimal Store stub — only getNote is needed
function makeStore(notes: Record<string, { content: string; tags?: string[]; metadata?: Record<string, unknown>; path?: string }>) {
  return {
    getNote(id: string) {
      const n = notes[id];
      if (!n) return null;
      return {
        id,
        content: n.content,
        tags: n.tags ?? [],
        metadata: n.metadata ?? {},
        path: n.path,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      };
    },
  } as any;
}

describe("handlePublicNote", () => {
  it("returns 404 for non-existent note", () => {
    const store = makeStore({});
    const resp = handlePublicNote(store, "missing");
    expect(resp.status).toBe(404);
  });

  it("returns 404 for note without published tag", () => {
    const store = makeStore({
      "n1": { content: "hello", tags: ["other"] },
    });
    const resp = handlePublicNote(store, "n1");
    expect(resp.status).toBe(404);
  });

  it("serves note with published tag as HTML", async () => {
    const store = makeStore({
      "n1": { content: "# Hello\n\nWorld", tags: ["published"], path: "Blog/My Post.md" },
    });
    const resp = handlePublicNote(store, "n1");
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("text/html; charset=utf-8");

    const html = await resp.text();
    expect(html).toContain("<title>My Post</title>");
    expect(html).toContain("<h1>Hello</h1>");
    expect(html).toContain("<p>World</p>");
  });

  it("serves note with metadata.published=true", async () => {
    const store = makeStore({
      "n2": { content: "Content here", metadata: { published: true } },
    });
    const resp = handlePublicNote(store, "n2");
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain("<p>Content here</p>");
  });

  it("renders markdown features correctly", async () => {
    const store = makeStore({
      "n3": {
        content: "**bold** and *italic* and `code`\n\n- item 1\n- item 2\n\n```\ncode block\n```\n\n[link](https://example.com)",
        tags: ["published"],
      },
    });
    const resp = handlePublicNote(store, "n3");
    const html = await resp.text();
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<li>item 1</li>");
    expect(html).toContain("<li>item 2</li>");
    expect(html).toContain("<pre><code>");
    expect(html).toContain('href="https://example.com"');
  });

  it("escapes HTML in note content", async () => {
    const store = makeStore({
      "n4": { content: "<script>alert('xss')</script>", tags: ["published"] },
    });
    const resp = handlePublicNote(store, "n4");
    const html = await resp.text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("supports dark mode via media query", async () => {
    const store = makeStore({
      "n5": { content: "test", tags: ["published"] },
    });
    const resp = handlePublicNote(store, "n5");
    const html = await resp.text();
    expect(html).toContain("prefers-color-scheme: dark");
  });
});
