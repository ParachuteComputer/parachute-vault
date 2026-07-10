/**
 * Tag-scope confidentiality for the `vault doctor` integrity scan (vault#552
 * auth fold). Two finding types query notes VAULT-WIDE and previously leaked
 * out-of-scope data to a tag-scoped caller:
 *
 *   - `mixed_type_indexed_field`: the note query + mismatch count + exemplars
 *     + the "Declared by: <tags>" detail were all unscoped — a caller scoped
 *     to `mine` could see an out-of-scope declarer tag name AND an
 *     out-of-scope note id.
 *   - `dead_tag_metadata_reference`: the example live value (the `e.g.
 *     "<value>"` in detail) was computed vault-wide — leaking an out-of-scope
 *     tag NAME — and (unscoped) exemplars could include out-of-scope note ids.
 *
 * Each test asserts the out-of-scope tag name / note id appears NOWHERE in
 * the serialized findings when scoped, and pairs with an UNSCOPED positive
 * control proving the fixture genuinely carries that leak-able data (so the
 * scoped assertion isn't vacuous — remove the scope filter and the control's
 * leak reappears in the scoped run).
 */
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteStore } from "./store.js";
import { runDoctorScan } from "./doctor.js";

const OUT_OF_SCOPE_TAG = "theirs-secret";

let store: SqliteStore;
let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  store = new SqliteStore(db);
});

describe("doctor mixed_type_indexed_field × tag scope (vault#552 MUST-FIX 3)", () => {
  beforeEach(async () => {
    // Field `n` is indexed INTEGER, co-declared by an in-scope tag (`mine`)
    // and an out-of-scope one (`theirs-secret`). Both carry a note whose
    // metadata.n is a JSON string (type mismatch), not strict so the write
    // lands the poison value.
    await store.upsertTagRecord("mine", { fields: { n: { type: "integer", indexed: true } } });
    await store.upsertTagRecord(OUT_OF_SCOPE_TAG, { fields: { n: { type: "integer", indexed: true } } });
    await store.createNote("in-scope mismatch", { id: "mine-mm", tags: ["mine"], metadata: { n: "bad-mine" } });
    await store.createNote("out-of-scope mismatch", { id: "theirs-mm", tags: [OUT_OF_SCOPE_TAG], metadata: { n: "bad-theirs" } });
  });

  it("scoped caller: the out-of-scope declarer name and out-of-scope note id appear NOWHERE", async () => {
    const report = await store.doctor({ allowedTags: new Set(["mine"]) });
    const finding = report.findings.find((f) => f.type === "mixed_type_indexed_field");
    expect(finding).toBeDefined(); // the in-scope mismatch still fires it
    expect(finding!.subject).toBe("n");

    const serialized = JSON.stringify(report.findings);
    expect(serialized).not.toContain(OUT_OF_SCOPE_TAG);
    expect(serialized).not.toContain("theirs-mm");
    // The in-scope exemplar IS present (proves the finding is real, not empty).
    expect(serialized).toContain("mine-mm");
    // Count reflects the single in-scope mismatch, not both.
    expect(finding!.detail).toContain("1 note(s)");
    expect(finding!.detail).toContain("Declared by: mine.");
  });

  it("unscoped control: the same fixture DOES surface the out-of-scope declarer + note (mutation-check)", async () => {
    const report = await runDoctorScan(db); // no allowedTags
    const serialized = JSON.stringify(report.findings);
    // Absent the scope filter, both the out-of-scope declarer name and the
    // out-of-scope note id leak — this is exactly what the scoped run above
    // must suppress. If the scope filter were removed, the scoped assertions
    // would see these too and fail.
    expect(serialized).toContain(OUT_OF_SCOPE_TAG);
    expect(serialized).toContain("theirs-mm");
  });
});

describe("doctor dead_tag_metadata_reference × tag scope (vault#552 MUST-FIX 4)", () => {
  beforeEach(async () => {
    await store.upsertTagRecord("mine", {});
    await store.upsertTagRecord(OUT_OF_SCOPE_TAG, {});
    // Insertion ORDER matters: the out-of-scope live-tag value is created
    // FIRST so the vault-wide `liveValues[0]` example would be
    // "theirs-secret" absent the scope fix.
    await store.createNote("oos live", { id: "theirs-live", tags: [OUT_OF_SCOPE_TAG], metadata: { epic: OUT_OF_SCOPE_TAG } });
    await store.createNote("in-scope live", { id: "mine-live", tags: ["mine"], metadata: { epic: "mine" } });
    await store.createNote("in-scope dead", { id: "mine-dead", tags: ["mine"], metadata: { epic: "ghost-epic" } });
    await store.createNote("oos dead", { id: "theirs-dead", tags: [OUT_OF_SCOPE_TAG], metadata: { epic: "ghost-epic" } });
  });

  it("scoped caller: the out-of-scope example tag name and out-of-scope note id appear NOWHERE", async () => {
    const report = await store.doctor({ allowedTags: new Set(["mine"]) });
    const finding = report.findings.find((f) => f.type === "dead_tag_metadata_reference");
    expect(finding).toBeDefined();
    expect(finding!.subject).toBe("metadata.epic");
    expect(finding!.heuristic).toBe(true);

    const serialized = JSON.stringify(report.findings);
    // No out-of-scope tag NAME (as the `e.g. "<value>"` live example) and no
    // out-of-scope note id (as an exemplar of the dead value).
    expect(serialized).not.toContain(OUT_OF_SCOPE_TAG);
    expect(serialized).not.toContain("theirs-dead");
    expect(serialized).not.toContain("theirs-live");
    // The in-scope live example + in-scope exemplar + dead value ARE present.
    expect(finding!.detail).toContain('e.g. "mine"');
    expect(serialized).toContain("mine-dead");
    expect(serialized).toContain("ghost-epic");
  });

  it("unscoped control: the same fixture leaks the out-of-scope example name + note id (mutation-check)", async () => {
    const report = await runDoctorScan(db); // no allowedTags
    const finding = report.findings.find((f) => f.type === "dead_tag_metadata_reference")!;
    const serialized = JSON.stringify(report.findings);
    // Vault-wide, the example live value is the first-inserted live tag
    // ("theirs-secret"), and the out-of-scope note id is an exemplar — both
    // the leaks the scoped run suppresses.
    expect(finding.detail).toContain(`e.g. "${OUT_OF_SCOPE_TAG}"`);
    expect(serialized).toContain("theirs-dead");
  });
});
