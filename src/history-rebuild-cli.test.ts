import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeVaultConfig, vaultDbPath } from "./config.ts";
import { BunSqliteStore } from "../core/src/store.ts";
import { runDoctorScan } from "../core/src/doctor.ts";

test("history rebuild-state repairs hints only, without requiring a Git mirror", async () => {
  const taskDir = mkdtempSync(join(tmpdir(), "history-rebuild-"));
  const saved = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = taskDir;
  let db: Database | undefined;
  try {
    writeVaultConfig({ name: "repair", api_keys: [], created_at: new Date().toISOString() });
    db = new Database(vaultDbPath("repair"), { create: true });
    const store = new BunSqliteStore(db);
    const n = await store.createNote("before");
    await store.updateNote(n.id, { content: "after" });
    db.exec("UPDATE history_compact_state SET stored=999,refused=1");
    expect(runDoctorScan(db).findings.some(f=>f.type==="history_compact_state_drift")).toBe(true);
    const notes = db.query("SELECT * FROM notes").all(), versions = db.query("SELECT * FROM note_versions").all(), blobs = db.query("SELECT * FROM note_blobs").all();
    db.close(); db=undefined;
    const proc = Bun.spawnSync({ cmd: [process.execPath, join(import.meta.dir,"cli.ts"),"history","rebuild-state","--vault","repair","--json"], env: {...process.env, PARACHUTE_HOME: taskDir}, stdout:"pipe",stderr:"pipe" });
    expect(proc.exitCode, new TextDecoder().decode(proc.stderr)).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(proc.stdout))).toEqual({ vault: "repair", rebuilt_notes: 1 });
    db = new Database(vaultDbPath("repair"));
    expect(runDoctorScan(db).findings.some(f=>f.type==="history_compact_state_drift")).toBe(false);
    expect(db.query("SELECT * FROM notes").all()).toEqual(notes);
    expect(db.query("SELECT * FROM note_versions").all()).toEqual(versions);
    expect(db.query("SELECT * FROM note_blobs").all()).toEqual(blobs);
  } finally {
    db?.close();
    if(saved===undefined)delete process.env.PARACHUTE_HOME;else process.env.PARACHUTE_HOME=saved;
    rmSync(taskDir,{recursive:true,force:true});
  }
});
