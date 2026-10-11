import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMcpTools } from "../core/src/mcp.ts";
import type { Note } from "../core/src/types.ts";
import { SqliteStore } from "../core/src/store.ts";
import { handleNotes } from "./routes.ts";
import { runSubprocess } from "./test-support/spawn.ts";
import { migratePackState, type PackManifest } from "./external-packs.ts";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "packs-cli-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });
const cli = (...args: string[]) => runSubprocess({ cmd: ["bun", join(import.meta.dir, "cli.ts"), ...args], env: { PARACHUTE_HOME: home, PARACHUTE_HUB_ORIGIN: undefined } });
const manifest = (): PackManifest => ({
  id: "calendar", name: "Calendar", version: "1.0.0", description: "Events",
  tags: [
    { name: "scheduled", description: "Scheduled" },
    { name: "event", description: "Events", parent_names: ["scheduled"], fields: { start: { type: "date", indexed: true }, status: { type: "string", default: "planned" } } },
  ],
  notes: [{ path: "Calendar/README", content: "Guide", tags: ["event"], metadata: { start: "2026-10-10" } }],
  connector: { run: "never-executed", scope: { tags: ["event"], verbs: ["read"] }, publishes: [] },
  views: [{ kind: "calendar" }],
});

test("running HTTP server sees subsequent CLI install and removal without reopening its store", async () => {
  expect((await cli("create", "packed")).exitCode).toBe(0);
  const vault = join(home, "vault", "data", "packed");
  const store = new SqliteStore(new Database(join(vault, "vault.db")));
  const path = join(home, "pack.json"); writeFileSync(path, JSON.stringify(manifest()));
  // Prime BOTH caches before another process changes the database.
  store.getTagHierarchy();
  expect(store.validateNoteAgainstSchemas({ tags: ["event"], metadata: { start: "bad" } })).toBeNull();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req => handleNotes(req, store, "") });
  const url = `http://127.0.0.1:${server.port}/notes`;
  try {
    const install = await cli("packs", "add", path, "--vault", "packed");
    expect(install.exitCode).toBe(0);
    expect(store.validateNoteAgainstSchemas({ tags: ["event"], metadata: { start: "bad" } })).not.toBeNull();
    const response = await fetch(`${url}?tag=scheduled&expand=subtypes&include_content=true`);
    expect(response.status).toBe(200);
    expect((await response.json() as any[]).some(n => n.path === "Calendar/README")).toBe(true);
    const createNote = generateMcpTools(store).find(t => t.name === "create-note")!;
    const created = await createNote.execute({ content: "Event", path: "Calendar/one", tags: ["event"], metadata: { start: "2026-10-11" } }) as Note;
    expect(created.metadata?.status).toBe("planned");
    expect((await store.queryNotes({ metadata: { start: { eq: "2026-10-11" } } })).some(n => n.id === created.id)).toBe(true);
    expect((await cli("packs", "remove", "calendar", "--vault", "packed")).exitCode).toBe(0);
    expect(store.validateNoteAgainstSchemas({ tags: ["event"], metadata: { start: "bad" } })).toBeNull();
    expect(await (await fetch(`${url}?tag=scheduled&expand=subtypes`)).json()).toEqual([]);
    const after = await createNote.execute({ content: "After removal", tags: ["event"] }) as Note;
    expect(after.metadata?.status).toBeUndefined();
  } finally { server.stop(true); store.db.close(); }
}, 20000);

test("alias, list and remove migrate legacy registrations once", async () => {
  expect((await cli("create", "packed")).exitCode).toBe(0);
  const path = join(home, "pack.json"); writeFileSync(path, JSON.stringify(manifest()));
  expect((await cli("add-pack", path, "--vault", "packed")).exitCode).toBe(0);
  const vault = join(home, "vault", "data", "packed");
  renameSync(join(vault, "packs"), join(vault, "modules"));
  const before = readFileSync(join(vault, "modules", "calendar.json"), "utf8");
  const listed = await cli("packs", "list", "--vault", "packed");
  expect(listed.exitCode).toBe(0);
  expect(JSON.parse(listed.stdout)).toEqual([{ id: "calendar", version: "1.0.0" }]);
  expect(existsSync(join(vault, "modules"))).toBe(false);
  expect(readFileSync(join(vault, "packs", "calendar.json"), "utf8")).toBe(before);
  expect((await cli("packs", "remove", "calendar", "--vault", "packed")).exitCode).toBe(0);
  expect(JSON.parse((await cli("packs", "list", "--vault", "packed")).stdout)).toEqual([]);
}, 20000);

test("migration merges disjoint directories, preserves conflicts and refuses legacy locks", () => {
  const legacy = join(home, "modules"), packs = join(home, "packs");
  mkdirSync(legacy); mkdirSync(packs);
  writeFileSync(join(legacy, "a.json"), "old"); writeFileSync(join(packs, "b.json"), "new");
  expect(migratePackState(home)).toBe(packs);
  expect(readFileSync(join(packs, "a.json"), "utf8")).toBe("old");
  mkdirSync(legacy); writeFileSync(join(legacy, "a.json"), "conflict");
  expect(() => migratePackState(home)).toThrow("conflict");
  expect(readFileSync(join(legacy, "a.json"), "utf8")).toBe("conflict");
  expect(readFileSync(join(packs, "a.json"), "utf8")).toBe("old");
  mkdirSync(join(legacy, ".lock"));
  expect(() => migratePackState(home)).toThrow("locked");
});
