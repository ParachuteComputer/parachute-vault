import { test, expect } from "bun:test";
import { projectHistoryProvenance } from "./history-visibility.ts";

test("history redaction removes only transport provenance without mutating stored data", () => {
  const row = Object.freeze({ actor: "editor", via: "api", content: "editor mentioned in text",
    metadata: { actor: "user-authored value" }, origin: "git-import", import_ix: 0 });
  expect(projectHistoryProvenance(row, false)).toBe(row);
  expect(projectHistoryProvenance(row, true)).toEqual({ content: row.content, metadata: row.metadata,
    origin: "git-import", import_ix: 0 });
  expect(row.actor).toBe("editor");
});
