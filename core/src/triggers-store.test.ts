/**
 * Unit tests for the persisted-triggers store (core/src/triggers-store.ts) —
 * JSON encode/decode round-trip + upsert/list/get/delete semantics over an
 * in-memory SQLite DB (schema v21).
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "./schema.js";
import {
  upsertTrigger,
  listTriggers,
  getTrigger,
  deleteTrigger,
  loadAllTriggers,
} from "./triggers-store.js";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
});

function sample(name: string) {
  return {
    name,
    events: ["created", "updated"] as Array<"created" | "updated">,
    when: { tags: ["channel-message"], has_content: true },
    action: {
      webhook: "https://example.test/hook",
      send: "json" as const,
      timeout: 30000,
      auth: { bearer: "jwt-token" },
    },
  };
}

describe("triggers-store", () => {
  test("the triggers table exists after initSchema (v21)", () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='triggers'")
      .get();
    expect(row).toBeTruthy();
  });

  test("upsert → get round-trips the structured JSON columns", () => {
    upsertTrigger(db, sample("inbound"));
    const got = getTrigger(db, "inbound");
    expect(got).not.toBeNull();
    expect(got!.when).toEqual({ tags: ["channel-message"], has_content: true });
    expect(got!.action.webhook).toBe("https://example.test/hook");
    expect(got!.action.auth).toEqual({ bearer: "jwt-token" });
    expect(got!.events).toEqual(["created", "updated"]);
    expect(got!.created_at).toBeTruthy();
    expect(got!.updated_at).toBeTruthy();
  });

  test("upsert by name replaces + preserves created_at, bumps updated_at", async () => {
    const first = upsertTrigger(db, sample("inbound"));
    // Ensure clock advances so updated_at differs.
    await new Promise((r) => setTimeout(r, 5));
    const second = upsertTrigger(db, {
      ...sample("inbound"),
      action: { webhook: "https://example.test/v2" },
    });

    expect(listTriggers(db)).toHaveLength(1);
    expect(second.created_at).toBe(first.created_at);
    expect(second.updated_at >= first.updated_at).toBe(true);
    expect(getTrigger(db, "inbound")!.action.webhook).toBe("https://example.test/v2");
  });

  test("events defaults to [created, updated] when omitted", () => {
    upsertTrigger(db, {
      name: "no-events",
      when: { tags: ["x"] },
      action: { webhook: "https://example.test/hook" },
    });
    expect(getTrigger(db, "no-events")!.events).toEqual(["created", "updated"]);
  });

  test("list / loadAllTriggers return all rows ordered by name", () => {
    upsertTrigger(db, sample("zebra"));
    upsertTrigger(db, sample("alpha"));
    expect(listTriggers(db).map((t) => t.name)).toEqual(["alpha", "zebra"]);
    expect(loadAllTriggers(db).map((t) => t.name)).toEqual(["alpha", "zebra"]);
  });

  test("delete removes the row; returns false on a missing name", () => {
    upsertTrigger(db, sample("inbound"));
    expect(deleteTrigger(db, "inbound")).toBe(true);
    expect(getTrigger(db, "inbound")).toBeNull();
    expect(deleteTrigger(db, "inbound")).toBe(false);
  });

  test("getTrigger returns null for an unknown name", () => {
    expect(getTrigger(db, "nope")).toBeNull();
  });
});
