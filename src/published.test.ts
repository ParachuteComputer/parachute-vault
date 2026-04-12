import { describe, it, expect } from "bun:test";
import { handleViewNote } from "./routes.ts";

// Redirect URL builder — mirrors the logic in server.ts
function buildRedirectUrl(reqUrl: string, noteId: string, prefix = ""): string {
  const dest = new URL(`${prefix}/view/${noteId}`, reqUrl);
  dest.search = new URL(reqUrl).search;
  return dest.toString();
}

describe("/public → /view redirect", () => {
  it("preserves query params including ?key=", () => {
    const url = buildRedirectUrl("http://localhost:1940/public/abc?key=pvk_secret", "abc");
    expect(url).toBe("http://localhost:1940/view/abc?key=pvk_secret");
  });

  it("works without query params", () => {
    const url = buildRedirectUrl("http://localhost:1940/public/abc", "abc");
    expect(url).toBe("http://localhost:1940/view/abc");
  });

  it("preserves multiple query params", () => {
    const url = buildRedirectUrl("http://localhost:1940/public/abc?key=pvk_x&format=html", "abc");
    expect(url).toBe("http://localhost:1940/view/abc?key=pvk_x&format=html");
  });

  it("works for vault-scoped paths", () => {
    const url = buildRedirectUrl("http://localhost:1940/vaults/work/public/abc?key=pvk_x", "abc", "/vaults/work");
    expect(url).toBe("http://localhost:1940/vaults/work/view/abc?key=pvk_x");
  });
});

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

describe("handleViewNote", () => {
  it("returns 404 for non-existent note", () => {
    const store = makeStore({});
    const resp = handleViewNote(store, "missing");
    expect(resp.status).toBe(404);
  });

  it("returns 404 for note without published tag (unauthenticated)", () => {
    const store = makeStore({
      "n1": { content: "hello", tags: ["other"] },
    });
    const resp = handleViewNote(store, "n1");
    expect(resp.status).toBe(404);
  });

  it("serves note with published tag as HTML", async () => {
    const store = makeStore({
      "n1": { content: "# Hello\n\nWorld", tags: ["published"], path: "Blog/My Post.md" },
    });
    const resp = handleViewNote(store, "n1");
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
    const resp = handleViewNote(store, "n2");
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
    const resp = handleViewNote(store, "n3");
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
    const resp = handleViewNote(store, "n4");
    const html = await resp.text();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("strips javascript: URI links to prevent XSS", async () => {
    const store = makeStore({
      "n6": { content: "[click me](javascript:alert(1))", tags: ["published"] },
    });
    const resp = handleViewNote(store, "n6");
    const html = await resp.text();
    expect(html).not.toContain("javascript:");
    expect(html).toContain("click me");
    expect(html).not.toContain("<a ");
  });

  it("strips data: URI links to prevent XSS", async () => {
    const store = makeStore({
      "n7": { content: "[click](data:text/html;base64,PHNjcmlwdD4=)", tags: ["published"] },
    });
    const resp = handleViewNote(store, "n7");
    const html = await resp.text();
    expect(html).not.toContain("data:");
    expect(html).toContain("click");
  });

  it("allows safe http/https/mailto links", async () => {
    const store = makeStore({
      "n8": { content: "[site](https://example.com) and [mail](mailto:a@b.com)", tags: ["published"] },
    });
    const resp = handleViewNote(store, "n8");
    const html = await resp.text();
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('href="mailto:a@b.com"');
  });

  it("supports dark mode via media query", async () => {
    const store = makeStore({
      "n5": { content: "test", tags: ["published"] },
    });
    const resp = handleViewNote(store, "n5");
    const html = await resp.text();
    expect(html).toContain("prefers-color-scheme: dark");
  });

  // Auth-aware behavior
  it("serves any note when authenticated", async () => {
    const store = makeStore({
      "private": { content: "secret stuff", tags: ["internal"] },
    });
    const resp = handleViewNote(store, "private", { authenticated: true });
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain("<p>secret stuff</p>");
  });

  it("returns 404 for unpublished note when not authenticated", () => {
    const store = makeStore({
      "private": { content: "secret stuff", tags: ["internal"] },
    });
    const resp = handleViewNote(store, "private");
    expect(resp.status).toBe(404);
  });

  // Custom published tag
  it("uses custom published_tag from config", async () => {
    const store = makeStore({
      "n1": { content: "public content", tags: ["public"] },
    });
    const resp = handleViewNote(store, "n1", { publishedTag: "public" });
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain("<p>public content</p>");
  });

  it("rejects note with default tag when custom tag is configured", () => {
    const store = makeStore({
      "n1": { content: "content", tags: ["published"] },
    });
    const resp = handleViewNote(store, "n1", { publishedTag: "public" });
    expect(resp.status).toBe(404);
  });
});
