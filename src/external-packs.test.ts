import { beforeEach, afterEach, describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SqliteStore } from "../core/src/store.ts";
import { installPack, removePack, listPacks, validateManifest, loadManifest, type PackManifest } from "./external-packs.ts";
let store: SqliteStore, dir: string;
const pack = (): PackManifest => ({ id: "calendar", name: "Calendar", version: "0.1.0", description: "Events", tags: [{ name: "event", description: "Events", fields: { start: { type: "date", indexed: true } } }], notes: [{ path: "Calendar/README", content: "Guide", tags: ["event"] }] });
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "external-pack-")); store = new SqliteStore(new Database(":memory:")); });
afterEach(() => { store.db.close(); rmSync(dir, { recursive: true, force: true }); });
describe("external packs", () => {
  test("reinstall leaves every note and schema timestamp untouched; remove retains tags and records", async () => {
    const p = pack(); await installPack(store, dir, p);
    const note = await store.createNote("Event", { path: "Calendar/one", tags: ["event"], metadata: { start: "2026-10-10" } });
    const guide = await store.getNoteByPath("Calendar/README"); const schema = await store.getTagRecord("event");
    const stateBefore = readFileSync(join(dir, "calendar.json"), "utf8");
    const stateTime = statSync(join(dir, "calendar.json")).mtimeMs;
    expect(await installPack(store, dir, p)).toEqual(["= tag event", "= note Calendar/README (untouched)"]);
    expect(readFileSync(join(dir, "calendar.json"), "utf8")).toBe(stateBefore);
    expect(statSync(join(dir, "calendar.json")).mtimeMs).toBe(stateTime);
    expect(await store.getNote(note.id)).toEqual(note); expect(await store.getNote(guide!.id)).toEqual(guide);
    expect(await store.getTagRecord("event")).toEqual(schema);
    await removePack(store, dir, "calendar"); expect(listPacks(dir)).toEqual([]);
    expect((await store.getTagRecord("event"))?.fields).toBeUndefined();
    expect(await store.getNote(note.id)).toEqual(note); expect((await store.getNote(note.id))!.tags).toEqual(["event"]);
    expect(await store.getNote(guide!.id)).toEqual(guide);
  });
  test("reinstall after removal restores only an unchanged cleared owned schema", async () => {
    await installPack(store, dir, pack()); await removePack(store, dir, "calendar");
    await installPack(store, dir, pack());
    expect((await store.getTagRecord("event"))?.fields?.start).toBeDefined();
    await removePack(store, dir, "calendar");
    await store.upsertTagRecord("event", { fields: { custom: { type: "string" } } });
    const custom = await store.getTagRecord("event");
    expect((await installPack(store, dir, pack()))[0]).toContain("DIFF");
    expect(await store.getTagRecord("event")).toEqual(custom);
  });
  test("failed item stays pending; retry completes without losing prior ownership", async () => {
    const original = store.createNote.bind(store);
    store.createNote = async () => { throw new Error("simulated note failure"); };
    await expect(installPack(store, dir, pack())).rejects.toThrow("simulated");
    expect(listPacks(dir)).toEqual([]);
    const dependent = { ...pack(), id: "dependent", requires: ["calendar"], tags: [], notes: [] };
    await expect(installPack(store, dir, dependent)).rejects.toThrow("Missing required");
    store.createNote = original;
    await installPack(store, dir, pack());
    expect(listPacks(dir)).toEqual([{ id: "calendar", version: "0.1.0" }]);
    await removePack(store, dir, "calendar");
    expect((await store.getTagRecord("event"))?.fields).toBeUndefined();
  });
  test("preexisting schemas and notes are preserved and differences reported", async () => {
    await store.upsertTagRecord("event", { description: "Mine", fields: { custom: { type: "string" } } });
    const guide = await store.createNote("My guide", { path: "Calendar/README" });
    const before = await store.getTagRecord("event");
    expect((await installPack(store, dir, pack())).join("\n")).toContain("DIFF tag event");
    expect(await store.getTagRecord("event")).toEqual(before); expect(await store.getNote(guide.id)).toEqual(guide);
    await removePack(store, dir, "calendar"); expect(await store.getTagRecord("event")).toEqual(before);
  });
  test("upgrade modifies owned schema, keeps edited notes and refuses downgrade or silent manifest changes", async () => {
    const p = pack(); await installPack(store, dir, p);
    const guide = (await store.getNoteByPath("Calendar/README"))!; await store.updateNote(guide.id, { content: "Edited" });
    const newer = pack(); newer.version = "0.2.0"; newer.tags[0]!.fields!.end = { type: "date" };
    await installPack(store, dir, newer);
    expect((await store.getTagRecord("event"))?.fields?.end).toEqual({ type: "date" });
    expect((await store.getNote(guide.id))?.content).toBe("Edited");
    await expect(installPack(store, dir, p)).rejects.toThrow("Downgrade");
    const sameVersion = structuredClone(newer); sameVersion.description = "Changed";
    await expect(installPack(store, dir, sameVersion)).rejects.toThrow("version bump");
  });
  test("user edits block upgrade and uninstall; dependencies block absent installs and referenced removals", async () => {
    const p = pack(); p.requires = ["areas"];
    await expect(installPack(store, dir, p)).rejects.toThrow("Missing required pack");
    expect(listPacks(dir)).toEqual([]);
    const areas = { ...pack(), id: "areas", tags: [], notes: [] };
    await installPack(store, dir, areas); await installPack(store, dir, p);
    await expect(removePack(store, dir, "areas")).rejects.toThrow("Required by");
    await store.upsertTagRecord("event", { fields: { mine: { type: "string" } } });
    const edited = await store.getTagRecord("event"); p.version = "0.2.0";
    expect((await installPack(store, dir, p))[0]).toContain("DIFF");
    await removePack(store, dir, "calendar"); expect(await store.getTagRecord("event")).toEqual(edited);
  });
  test("shared schemas survive removing their original owner", async () => {
    await installPack(store, dir, pack()); await installPack(store, dir, { ...pack(), id: "other", notes: [] });
    await removePack(store, dir, "calendar"); expect((await store.getTagRecord("event"))?.fields?.start).toBeDefined();
  });
  test("validation rejects malformed sections before installation", () => {
    for (const patch of [{ id: "../bad" }, { version: "latest" }, { tags: [pack().tags[0], pack().tags[0]] }, { notes: [{ path: ".parachute/packs/x", content: "x" }] }, { connector: { run: "x", scope: { tags: [], verbs: ["admin"] }, publishes: [] } }, { tags: [{ name: "x", description: "x", fields: { x: { type: "typo" } } }] }, { requires: ["calendar"] }, { notes: [{ content: "no path" }] }, { unknown: true }]) {
      expect(() => validateManifest({ ...pack(), ...patch })).toThrow();
    }
  });
  test("JSON, YAML, directory, URL and HTTP failures", async () => {
    const p = pack(); writeFileSync(join(dir, "module.json"), JSON.stringify(p));
    expect(await loadManifest(dir)).toEqual(p);
    writeFileSync(join(dir, "module.yaml"), "id: empty\nname: Empty\nversion: 1.0.0\ndescription: Empty\ntags: []\nnotes: []\n");
    expect((await loadManifest(dir)).id).toBe("empty");
    writeFileSync(join(dir, "pack.json"), JSON.stringify(p));
    expect(await loadManifest(dir)).toEqual(p);
    writeFileSync(join(dir, "pack.yaml"), "id: preferred\nname: Preferred\nversion: 1.0.0\ndescription: Preferred\ntags: []\nnotes: []\n");
    expect((await loadManifest(dir)).id).toBe("preferred");
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req => req.url.endsWith("/ok") ? Response.json(p) : new Response("missing", { status: 404 }) });
    try { expect(await loadManifest(`http://127.0.0.1:${server.port}/ok`)).toEqual(p); await expect(loadManifest(`http://127.0.0.1:${server.port}/missing`)).rejects.toThrow("HTTP 404"); } finally { server.stop(true); }
  });
});
