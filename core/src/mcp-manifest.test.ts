/**
 * Pin test for the pure-data MCP tool manifest (front-of-house Wave 0).
 *
 * Two invariants, plus the workerd import-graph guard:
 *
 *  1. `generateMcpTools` emits EXACTLY the manifest — every emitted tool's
 *     {name, description, inputSchema, requiredVerb} deep-equals its
 *     `MCP_TOOL_MANIFEST` entry, in manifest order, gated by `condition`.
 *     This is the drift pin: the manifest is the single source of tool
 *     metadata, and the refactor that split behavior (execute) from data
 *     (this manifest) changed NOTHING observable. It fails the moment the
 *     built tools and the manifest disagree.
 *
 *  2. The observable contract shape — the ordered tool names, their scope
 *     verbs, and their inclusion conditions (no-seam → 13 core; +tickets → 2;
 *     +bytes → 1) — matches the table captured from `main` at extraction
 *     time. A verb or a conditional-inclusion change is a wire-contract event
 *     and must update this table deliberately.
 *
 *  3. IMPORT-GRAPH INVARIANT: `mcp-manifest.ts`'s transitive relative-import
 *     closure is free of `bun:sqlite` (and every other `bun:` / `node:`
 *     runtime builtin), so the identity worker can import it under Cloudflare
 *     workerd via the same `file:../../../parachute-vault/core` dep the vault
 *     worker uses — without dragging in the sqlite driver.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generateMcpTools, type McpToolDef } from "./mcp.js";
import { MCP_TOOL_MANIFEST, type McpToolCondition, type McpToolVerb } from "./mcp-manifest.js";

// A store stand-in: generateMcpTools only reads `store.db` to close over it in
// the (never-invoked here) execute closures. No tool is called in this file, so
// an empty object is enough to build the tool set.
const fakeStore = { db: {} } as any;

const ticketOpts = {
  attachmentTickets: {
    provider: {} as any,
    vaultName: "pin",
    urlBase: "https://host/vault/pin",
  },
};
const bytesOpts = { attachmentBytes: { provider: {} as any } };

/**
 * The observable contract, as emitted by `main` the day this manifest was
 * extracted (verified byte-identical against a snapshot of main's
 * `generateMcpTools`). Order is emission order.
 */
const EXPECTED: ReadonlyArray<{
  name: string;
  requiredVerb: McpToolVerb;
  condition: McpToolCondition;
  hasResultContent: boolean;
}> = [
  { name: "query-notes", requiredVerb: "read", condition: "core", hasResultContent: false },
  { name: "create-note", requiredVerb: "write", condition: "core", hasResultContent: false },
  { name: "update-note", requiredVerb: "write", condition: "core", hasResultContent: false },
  { name: "delete-note", requiredVerb: "write", condition: "core", hasResultContent: false },
  { name: "list-tags", requiredVerb: "read", condition: "core", hasResultContent: false },
  { name: "update-tag", requiredVerb: "admin", condition: "core", hasResultContent: false },
  { name: "delete-tag", requiredVerb: "admin", condition: "core", hasResultContent: false },
  { name: "rename-tag", requiredVerb: "admin", condition: "core", hasResultContent: false },
  { name: "merge-tags", requiredVerb: "admin", condition: "core", hasResultContent: false },
  { name: "find-path", requiredVerb: "read", condition: "core", hasResultContent: false },
  { name: "vault-info", requiredVerb: "read", condition: "core", hasResultContent: false },
  { name: "prune-schema", requiredVerb: "admin", condition: "core", hasResultContent: false },
  { name: "doctor", requiredVerb: "read", condition: "core", hasResultContent: false },
  { name: "request-attachment-upload", requiredVerb: "write", condition: "attachment-tickets", hasResultContent: false },
  { name: "request-attachment-download", requiredVerb: "read", condition: "attachment-tickets", hasResultContent: false },
  { name: "read-attachment", requiredVerb: "read", condition: "attachment-bytes", hasResultContent: true },
];

function names(tools: McpToolDef[]): string[] {
  return tools.map((t) => t.name);
}

describe("MCP_TOOL_MANIFEST — shape", () => {
  test("manifest order + verbs + conditions match the captured contract", () => {
    expect(
      MCP_TOOL_MANIFEST.map((e) => ({ name: e.name, requiredVerb: e.requiredVerb, condition: e.condition })),
    ).toEqual(EXPECTED.map((e) => ({ name: e.name, requiredVerb: e.requiredVerb, condition: e.condition })));
  });

  test("every manifest entry carries a non-empty description + object inputSchema", () => {
    for (const e of MCP_TOOL_MANIFEST) {
      expect(typeof e.description).toBe("string");
      expect(e.description.length).toBeGreaterThan(0);
      expect(e.inputSchema).toBeInstanceOf(Object);
      expect((e.inputSchema as any).type).toBe("object");
    }
  });
});

describe("generateMcpTools — conditional inclusion (byte-for-byte with main)", () => {
  test("no seams → exactly the 13 core-condition tools, in manifest order", () => {
    const tools = generateMcpTools(fakeStore);
    expect(names(tools)).toEqual(EXPECTED.filter((e) => e.condition === "core").map((e) => e.name));
    expect(tools.length).toBe(13);
  });

  test("attachmentTickets seam appends the 2 ticket tools (upload=write, download=read)", () => {
    const tools = generateMcpTools(fakeStore, ticketOpts);
    expect(names(tools)).toEqual(
      EXPECTED.filter((e) => e.condition === "core" || e.condition === "attachment-tickets").map((e) => e.name),
    );
    expect(tools.length).toBe(15);
  });

  test("attachmentBytes seam appends read-attachment only", () => {
    const tools = generateMcpTools(fakeStore, bytesOpts);
    expect(names(tools)).toEqual(
      EXPECTED.filter((e) => e.condition === "core" || e.condition === "attachment-bytes").map((e) => e.name),
    );
    expect(tools.length).toBe(14);
  });

  test("both seams → all 16 tools in emission order", () => {
    const tools = generateMcpTools(fakeStore, { ...ticketOpts, ...bytesOpts });
    expect(names(tools)).toEqual(EXPECTED.map((e) => e.name));
    expect(tools.length).toBe(16);
  });
});

describe("generateMcpTools — the emitted set IS the manifest (drift pin)", () => {
  const tools = generateMcpTools(fakeStore, { ...ticketOpts, ...bytesOpts });
  const includedEntries = MCP_TOOL_MANIFEST; // all conditions satisfied by both seams

  test("emitted {name,description,inputSchema,requiredVerb} deep-equals the manifest, in order", () => {
    expect(
      tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        requiredVerb: t.requiredVerb,
      })),
    ).toEqual(
      includedEntries.map((e) => ({
        name: e.name,
        description: e.description,
        inputSchema: e.inputSchema,
        requiredVerb: e.requiredVerb,
      })),
    );
  });

  test("only read-attachment carries a resultContent wrapper", () => {
    for (let i = 0; i < tools.length; i++) {
      expect(typeof tools[i]!.resultContent === "function").toBe(EXPECTED[i]!.hasResultContent);
    }
  });
});

describe("mcp-manifest.ts — workerd import-graph invariant (bun:sqlite-free)", () => {
  // Walk the transitive RELATIVE-import closure of mcp-manifest.ts on disk and
  // collect every bare (non-relative) specifier it reaches. A bare `bun:*` /
  // `node:*` anywhere in that closure would break the identity worker's
  // workerd build. Uses Bun's real import parser (not a regex) so prose in
  // descriptions/comments can't produce phantom specifiers, and so type-only
  // imports — erased at runtime, irrelevant to the workerd graph — are elided.
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  function transitiveBareSpecifiers(entryTs: string): Set<string> {
    const bare = new Set<string>();
    const seen = new Set<string>();
    const stack = [entryTs];
    while (stack.length) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const specs = transpiler.scanImports(readFileSync(file, "utf8")).map((i) => i.path);
      for (const spec of specs) {
        if (spec.startsWith(".")) {
          // Resolve `./x.js` (or extensionless) to the on-disk `.ts` source.
          const base = resolve(dirname(file), spec);
          const candidate = base.endsWith(".js") ? base.slice(0, -3) + ".ts" : base + ".ts";
          stack.push(candidate);
        } else {
          bare.add(spec);
        }
      }
    }
    return bare;
  }

  test("transitive closure reaches no bun:/node: runtime builtin (esp. bun:sqlite)", () => {
    const entry = resolve(import.meta.dir, "mcp-manifest.ts");
    const bare = transitiveBareSpecifiers(entry);
    expect([...bare]).not.toContain("bun:sqlite");
    const runtimeBuiltins = [...bare].filter((s) => s.startsWith("bun:") || s.startsWith("node:"));
    expect(runtimeBuiltins).toEqual([]);
  });

  test("as a positive control, the SAME scan over mcp.ts DOES reach bun:sqlite", () => {
    // Proves the scanner actually follows imports (a vacuous scan would pass
    // the invariant above for the wrong reason).
    const bare = transitiveBareSpecifiers(resolve(import.meta.dir, "mcp.ts"));
    expect([...bare]).toContain("bun:sqlite");
  });
});
