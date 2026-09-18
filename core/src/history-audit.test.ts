import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { auditHistoryBlobs, runDoctorScan } from "./doctor.js";
import { hashContent } from "./history.js";
import { encodeDelta } from "./delta.js";

test("deep audit pages whole/delta blobs, detects content damage without writes", () => {
  const db = new Database(":memory:"); new SqliteStore(db);
  try {
    const insert = db.prepare("INSERT INTO note_blobs(hash,content,byte_size,encoding,delta_of) VALUES(?,?,?,?,?)");
    const base = "base text ".repeat(100), changed = base + "new tail";
    const a = hashContent(base), b = hashContent(changed), c = hashContent("original");
    insert.run(a, base, base.length, null, null);
    const delta = encodeDelta(base, changed);
    insert.run(b, delta, delta.length, "fossil-delta", a);
    insert.run(c, "tampered", 8, null, null);
    const before = db.prepare("SELECT * FROM note_blobs ORDER BY hash").all();
    let after = "", checked = 0, corrupt = 0;
    do {
      const p = auditHistoryBlobs(db, after, 1);
      checked += p.checked; corrupt += p.corrupt;
      if (p.complete) { expect(p.next_after).toBeNull(); break; }
      expect(p.next_after! > after).toBe(true); after = p.next_after!;
    } while (true);
    expect(checked).toBe(3); expect(corrupt).toBe(1);
    const report = runDoctorScan(db, { deep: true });
    expect(report.history_audit?.examples).toEqual([c]);
    expect(report.findings.find(f => f.type === "history_content_audit")?.severity).toBe("error");
    expect(db.prepare("SELECT * FROM note_blobs ORDER BY hash").all()).toEqual(before);
    db.prepare("UPDATE note_blobs SET content='invalid delta' WHERE hash=?").run(b);
    expect(auditHistoryBlobs(db).corrupt).toBe(2);
  } finally { db.close(); }
});

test("deep audit is explicit, bounded, scope-safe, and reports empty completion", () => {
  const db = new Database(":memory:"); new SqliteStore(db);
  try {
    expect(runDoctorScan(db).history_audit).toBeUndefined();
    expect(auditHistoryBlobs(db)).toEqual({ checked: 0, corrupt: 0, examples: [], complete: true, next_after: null });
    expect(() => runDoctorScan(db, { deep: true, allowedTags: new Set() })).toThrow("unrestricted");
    for (const n of [0, -1, 501, NaN, 1.5]) expect(() => auditHistoryBlobs(db, "", n)).toThrow();
    expect(() => auditHistoryBlobs(db, "bad cursor")).toThrow();
    expect(() => auditHistoryBlobs(db, "", 100, 1001)).toThrow();
    for (let i=0;i<7;i++) db.prepare("INSERT INTO note_blobs(hash,content,byte_size) VALUES(?,?,?)").run(hashContent(String(i)), "broken", 6);
    const p = auditHistoryBlobs(db, "", 2);
    expect(p.checked).toBe(2); expect(p.complete).toBe(false); expect(p.next_after).not.toBeNull();
    expect(auditHistoryBlobs(db).examples).toHaveLength(5);
    expect(runDoctorScan(db, { deep: true, history_max_blobs: 2 }).summary).toContain("error");
  } finally { db.close(); }
});
