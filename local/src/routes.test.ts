import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { SqliteStore } from "@parachute/core";
import { createRoutes } from "./routes.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

let app: Hono;
let store: SqliteStore;
let assetsDir: string;

beforeEach(() => {
  const db = new Database(":memory:");
  store = new SqliteStore(db);
  assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), "parachute-test-"));

  app = new Hono();
  app.get("/api/health", (c) => c.json({ status: "ok" }));
  app.route("/api", createRoutes(store, assetsDir));
});

async function req(method: string, path: string, body?: unknown) {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) init.body = JSON.stringify(body);
  return app.request(`http://localhost/api${path}`, init);
}

// ---- Health ----

describe("health", () => {
  it("returns ok", async () => {
    const res = await app.request("http://localhost/api/health");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ok");
  });
});

// ---- Notes CRUD ----

describe("notes", () => {
  it("creates a note", async () => {
    const res = await req("POST", "/notes", {
      content: "Morning walk",
      tags: ["daily"],
    });
    expect(res.status).toBe(201);
    const note = await res.json();
    expect(note.content).toBe("Morning walk");
    expect(note.tags).toContain("daily");
  });

  it("creates a note with path", async () => {
    const res = await req("POST", "/notes", {
      content: "# Grocery List",
      path: "Grocery List",
      tags: ["doc"],
    });
    expect(res.status).toBe(201);
    const note = await res.json();
    expect(note.path).toBe("Grocery List");
  });

  it("gets a note by ID", async () => {
    const createRes = await req("POST", "/notes", { content: "Test" });
    const created = await createRes.json();

    const res = await req("GET", `/notes/${created.id}`);
    expect(res.status).toBe(200);
    const note = await res.json();
    expect(note.id).toBe(created.id);
  });

  it("returns 404 for missing note", async () => {
    const res = await req("GET", "/notes/nonexistent");
    expect(res.status).toBe(404);
  });

  it("updates a note", async () => {
    const createRes = await req("POST", "/notes", { content: "Original" });
    const created = await createRes.json();

    const res = await req("PATCH", `/notes/${created.id}`, { content: "Updated" });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.content).toBe("Updated");
  });

  it("deletes a note", async () => {
    const createRes = await req("POST", "/notes", { content: "Delete me" });
    const created = await createRes.json();

    const res = await req("DELETE", `/notes/${created.id}`);
    expect(res.status).toBe(200);

    const getRes = await req("GET", `/notes/${created.id}`);
    expect(getRes.status).toBe(404);
  });

  it("queries notes by tag", async () => {
    await req("POST", "/notes", { content: "Note 1", tags: ["daily"] });
    await req("POST", "/notes", { content: "Doc 1", tags: ["doc"] });

    const res = await req("GET", "/notes?tag=daily");
    expect(res.status).toBe(200);
    const notes = await res.json();
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toBe("Note 1");
  });

  it("queries with exclude_tag", async () => {
    await req("POST", "/notes", { content: "Active", tags: ["digest"] });
    await req("POST", "/notes", { content: "Archived", tags: ["digest", "archived"] });

    const res = await req("GET", "/notes?tag=digest&exclude_tag=archived");
    const notes = await res.json();
    expect(notes).toHaveLength(1);
    expect(notes[0].content).toBe("Active");
  });

  it("tags a note via POST", async () => {
    const createRes = await req("POST", "/notes", { content: "Test" });
    const created = await createRes.json();

    const res = await req("POST", `/notes/${created.id}/tags`, { tags: ["pinned"] });
    expect(res.status).toBe(200);
    const note = await res.json();
    expect(note.tags).toContain("pinned");
  });

  it("untags a note via DELETE", async () => {
    const createRes = await req("POST", "/notes", { content: "Test", tags: ["daily", "voice"] });
    const created = await createRes.json();

    const res = await req("DELETE", `/notes/${created.id}/tags`, { tags: ["voice"] });
    expect(res.status).toBe(200);
    const note = await res.json();
    expect(note.tags).toContain("daily");
    expect(note.tags).not.toContain("voice");
  });

  it("gets links for a note", async () => {
    await req("POST", "/notes", { content: "A", id: "a" });
    await req("POST", "/notes", { content: "B", id: "b" });
    await req("POST", "/links", {
      source_id: "a",
      target_id: "b",
      relationship: "mentions",
    });

    const res = await req("GET", `/notes/a/links?direction=outbound`);
    expect(res.status).toBe(200);
    const links = await res.json();
    expect(links).toHaveLength(1);
    expect(links[0].relationship).toBe("mentions");
  });
});

// ---- Tags ----

describe("tags", () => {
  it("lists builtin tags", async () => {
    const res = await req("GET", "/tags");
    expect(res.status).toBe(200);
    const tags = await res.json();
    expect(tags.length).toBeGreaterThan(0);
    expect(tags.some((t: any) => t.name === "daily")).toBe(true);
    expect(tags.some((t: any) => t.name === "doc")).toBe(true);
    expect(tags.some((t: any) => t.name === "digest")).toBe(true);
  });
});

// ---- Links ----

describe("links", () => {
  it("creates and deletes a link", async () => {
    await req("POST", "/notes", { content: "A", id: "a" });
    await req("POST", "/notes", { content: "B", id: "b" });

    const createRes = await req("POST", "/links", {
      source_id: "a",
      target_id: "b",
      relationship: "links-to",
    });
    expect(createRes.status).toBe(201);

    const delRes = await req("DELETE", "/links", {
      source_id: "a",
      target_id: "b",
      relationship: "links-to",
    });
    expect(delRes.status).toBe(200);
  });
});

// ---- Search ----

describe("search", () => {
  it("searches notes by content", async () => {
    await req("POST", "/notes", { content: "Walked up Flagstaff trail", tags: ["daily"] });
    await req("POST", "/notes", { content: "Meeting about Horizon", tags: ["daily"] });

    const res = await req("GET", "/search?q=Flagstaff");
    expect(res.status).toBe(200);
    const results = await res.json();
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain("Flagstaff");
  });
});

// ---- Error Cases ----

describe("error handling", () => {
  it("returns 201 for note without content", async () => {
    const res = await req("POST", "/notes", {});
    expect(res.status).toBe(201);
  });

  it("returns 404 for missing note", async () => {
    const res = await req("GET", "/notes/nonexistent");
    expect(res.status).toBe(404);
  });

  it("returns 404 for missing storage file", async () => {
    const res = await app.request("http://localhost/api/storage/2026-03-30/nonexistent.wav");
    expect(res.status).toBe(404);
  });

  it("returns 403 for path traversal attempt", async () => {
    const res = await app.request("http://localhost/api/storage/../../etc/passwd");
    expect([403, 404]).toContain(res.status);
  });
});

// ---- Storage ----

describe("storage", () => {
  it("uploads and downloads a file", async () => {
    const audioData = Buffer.from("fake-wav-data");
    const formData = new FormData();
    formData.append("file", new Blob([audioData]), "test.wav");

    const uploadRes = await app.request("http://localhost/api/storage/upload", {
      method: "POST",
      body: formData,
    });
    expect(uploadRes.status).toBe(201);
    const { path: filePath } = await uploadRes.json() as { path: string };
    expect(filePath).toContain("test.wav");

    // Download it
    const downloadRes = await app.request(`http://localhost/api/storage/${filePath}`);
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers.get("content-type")).toBe("audio/wav");
  });

  it("rejects unsupported file types", async () => {
    const formData = new FormData();
    formData.append("file", new Blob([Buffer.from("exe")]), "malware.exe");

    const res = await app.request("http://localhost/api/storage/upload", {
      method: "POST",
      body: formData,
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("not allowed");
  });

  it("rejects uploads without file", async () => {
    const formData = new FormData();
    const res = await app.request("http://localhost/api/storage/upload", {
      method: "POST",
      body: formData,
    });
    expect(res.status).toBe(400);
  });
});
