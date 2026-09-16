import { test, expect } from "bun:test";
import { handleMcp } from "./mcp-http.ts";
import type { McpToolDef } from "../core/src/mcp.ts";

async function errorEnvelope(fields: Record<string, unknown>) {
  const tool: McpToolDef = {
    name: "query-notes", description: "serializer boundary fixture", requiredVerb: "read",
    inputSchema: { type: "object" },
    execute() { throw Object.assign(new Error("Unrecoverable history"), fields); },
  };
  const request = new Request("http://localhost/vault/import-test/mcp", {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool.name, arguments: {} } }),
  });
  const response = await handleMcp(request, () => [tool], "import-test", "import-test", {
    permission: "full", scopes: ["vault:import-test:read"], legacyDerived: false,
    scoped_tags: null, vault_name: null, caller_jti: null, actor: "test", via: "api",
  }, "");
  return await response.json() as any;
}
test("HTTP MCP forwards valid imported history references only on the dedicated error branch", async () => {
  const fields = { code: "HISTORY_UNRECOVERABLE", error_type: "history_unrecoverable", origin: "git-import", import_ix: 0, version_ix: -1 };
  const rpc = await errorEnvelope(fields);
  expect(rpc.result).toBeUndefined();
  expect(rpc.error.code).toBe(-32602);
  expect(rpc.error.data).toEqual({ error_type: "history_unrecoverable", origin: "git-import", import_ix: 0 });
  for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "0", null]) {
    const bad = await errorEnvelope({ ...fields, import_ix: invalid });
    expect(bad.result).toBeUndefined();
    expect(bad.error.data).toEqual({ error_type: "history_unrecoverable" });
  }
  const generic = await errorEnvelope({ ...fields, code: "OTHER" });
  expect(generic.error.data).toEqual({ error_type: "history_unrecoverable" });
  const native = await errorEnvelope({ code: "HISTORY_UNRECOVERABLE", error_type: "history_unrecoverable", version_ix: 0, note_id: "note" });
  expect(native.error.data).toEqual({ error_type: "history_unrecoverable" });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeVaultConfig } from "./config.ts";
import { getVaultStore, clearVaultStoreCache } from "./vault-store.ts";
import { generateScopedMcpTools } from "./mcp-tools.ts";
import { applyImportedNote, beginImportRun, importTargetDigest } from "../core/src/history-import.ts";
import { resolveHistoryPolicy } from "../core/src/history.ts";

test("HTTP MCP imported get/list/error keeps discriminator and rejects mixed selectors", async () => {
  const saved = process.env.PARACHUTE_HOME;
  const dir = mkdtempSync(join(tmpdir(), "history-import-mcp-"));
  process.env.PARACHUTE_HOME = dir;
  try {
    writeVaultConfig({ name: "import-test", api_keys: [], created_at: new Date().toISOString() });
    const store = getVaultStore("import-test");
    const note = await store.createNote("live");
    const run = { run_id: "test", source_fingerprint: "source", tip: "tip", options_digest: "options" };
    beginImportRun(store.db, run);
    applyImportedNote(store.db, {
      run, noteId: note.id, policy: resolveHistoryPolicy({ min_versions: 20 }), now: Date.now(),
      targetDigest: importTargetDigest(store.db, note.id),
      observations: [{ content: "archive", path: null, metadata: {}, extension: "md", created_at: null, observed_at: new Date().toISOString(), commit: "commit", blob: "blob" }],
    });
    const auth = { permission: "full" as const, scopes: ["vault:import-test:read"], legacyDerived: false, scoped_tags: null, vault_name: null, caller_jti: null, actor: "test", via: "api" };
    async function call(selector: Record<string, unknown>) {
      const req = new Request("http://localhost/vault/import-test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query-notes", arguments: { versions: { note_id: note.id, ...selector } } } }) });
      return await (await handleMcp(req, () => generateScopedMcpTools("import-test", auth), "test", "import-test", auth, "")).json() as any;
    }
    const got = await call({ origin: "git-import", import_ix: 0 });
    const row = JSON.parse(got.result.content[0].text);
    expect(row.content).toBe("archive");
    expect(row.origin).toBe("git-import");
    expect(row.import_ix).toBe(0);
    expect(row.version_ix).toBeUndefined();
    const listed = JSON.parse((await call({})).result.content[0].text);
    expect(listed.versions[0].origin).toBe("git-import");
    for (const selector of [{ origin: "git-import" }, { import_ix: 0 }, { version_ix: 0, origin: "git-import", import_ix: 0 }, { version_ix: -1 }]) {
      const invalid = await call(selector);
      expect(invalid.error).toBeDefined();
      expect(invalid.result).toBeUndefined();
    }
    store.db.exec("UPDATE note_blobs SET encoding='unknown'");
    const broken = await call({ origin: "git-import", import_ix: 0 });
    expect(broken.result).toBeUndefined();
    expect(broken.error.data).toEqual({ error_type: "history_unrecoverable", origin: "git-import", import_ix: 0 });
    expect(broken.error.message).not.toContain("@-1");
    const scoped = generateScopedMcpTools("import-test", { ...auth, scoped_tags: ["journal"] }).find(t => t.name === "query-notes")!;
    const denied = await scoped.execute({ versions: { note_id: note.id, origin: "git-import", import_ix: 0 } });
    expect(denied).toEqual({ error: "Note not found", error_type: "not_found", id: note.id });

  } finally {
    clearVaultStoreCache();
    if (saved === undefined) delete process.env.PARACHUTE_HOME; else process.env.PARACHUTE_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
