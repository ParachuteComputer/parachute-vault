/**
 * Tests for `buildInitSummaryLines` — the post-install summary printed at the
 * end of `vault init`.
 *
 * 2026-06-23 messaging realignment: the site no longer claims "Claude Code is
 * auto-configured," and init no longer writes ~/.claude.json by default. The
 * summary now (1) leads with the web setup wizard hand-off and (2) always
 * surfaces the self-serve connect info — the connector URL plus a
 * ready-to-paste `claude mcp add` command — so a Claude Code user opts in by
 * copy-paste rather than via a silent side effect. These tests pin that copy
 * across the (addMcp, addToken) decision matrix.
 */

import { describe, test, expect } from "bun:test";
import { buildInitSummaryLines } from "./init-summary.ts";

const baseInput = {
  configDir: "/tmp/parachute",
  bindHost: "127.0.0.1",
  port: 1940,
  mcpUrl: "http://127.0.0.1:1940/vault/default/mcp",
  wizardUrl: "http://127.0.0.1:1939/admin/setup",
  vaultName: "default",
};

function lines(addMcp: boolean, addToken: boolean, apiKey: string | undefined) {
  return buildInitSummaryLines({ ...baseInput, addMcp, addToken, apiKey });
}

describe("buildInitSummaryLines", () => {
  // The wizard hand-off + self-serve connect info are the load-bearing pieces
  // of the new messaging — they must appear in every branch.
  describe("always surfaces the wizard + the copy-paste connect info", () => {
    for (const [addMcp, addToken] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      const out = lines(addMcp, addToken, addMcp || addToken ? "pvt_k" : undefined).join("\n");

      test(`(addMcp=${addMcp}, addToken=${addToken}) prints the web wizard URL prominently`, () => {
        expect(out).toContain("Finish setup in your browser:");
        expect(out).toContain("http://127.0.0.1:1939/admin/setup");
      });

      test(`(addMcp=${addMcp}, addToken=${addToken}) surfaces the connector URL`, () => {
        expect(out).toContain("http://127.0.0.1:1940/vault/default/mcp");
      });

      test(`(addMcp=${addMcp}, addToken=${addToken}) always prints Config: and Server: lines`, () => {
        expect(out).toContain("Config:   /tmp/parachute");
        expect(out).toContain("Server:   http://127.0.0.1:1940");
      });
    }
  });

  // The new DEFAULT init path — no MCP write, no token minted (per-user OAuth).
  // init pointed the operator at the wizard and surfaced the copy-paste connect
  // info; it did NOT write ~/.claude.json.
  describe("DEFAULT (addMcp=N, token=N) — wizard hand-off + copy-paste opt-in", () => {
    const out = lines(false, false, undefined).join("\n");

    test("does NOT claim Claude Code is already wired in", () => {
      expect(out).not.toContain("already wired in");
      expect(out).not.toContain("Baked into ~/.claude.json");
    });

    test("offers the ready-to-paste `claude mcp add` opt-in command", () => {
      expect(out).toContain(
        "claude mcp add --transport http parachute-vault http://127.0.0.1:1940/vault/default/mcp",
      );
    });

    test("points at the guided installer as an alternative", () => {
      expect(out).toContain("parachute-vault mcp-install");
    });

    test("frames OAuth-first connect — no token needed", () => {
      expect(out).toContain("no token needed, you'll sign in on first use");
    });

    test("offers the scope-narrow opt-in mint for scripts (full vault:<name>:read, never admin)", () => {
      // Must be the three-segment named-resource form the hub mint-token model
      // requires — a bare `vault:read` would mint a malformed scope (vault#443).
      expect(out).toContain("parachute auth mint-token --scope vault:default:read");
      expect(out).not.toContain("vault:admin");
    });

    test("does not print any token", () => {
      expect(out).not.toContain("Your API token:");
      expect(out).not.toMatch(/pvt_/);
      expect(out).not.toContain("Authorization: Bearer");
    });

    test("threads a non-default vault name into the mint-token scope + connector URL", () => {
      const out2 = buildInitSummaryLines({
        ...baseInput,
        vaultName: "journal",
        mcpUrl: "http://127.0.0.1:1940/vault/journal/mcp",
        addMcp: false,
        addToken: false,
        apiKey: undefined,
      }).join("\n");
      expect(out2).toContain("parachute auth mint-token --scope vault:journal:read");
      expect(out2).toContain("http://127.0.0.1:1940/vault/journal/mcp");
    });
  });

  // Opt-in: operator passed --configure-claude-code, so init DID write the entry.
  describe("opted into MCP write (addMcp=Y, token=N, OAuth)", () => {
    const out = lines(true, false, undefined).join("\n");

    test("tells the user Claude Code is already wired in", () => {
      expect(out).toContain("Claude Code is already wired in");
    });

    test("still surfaces the connector URL for other clients", () => {
      expect(out).toContain("http://127.0.0.1:1940/vault/default/mcp");
    });

    test("does NOT print or imply any minted token", () => {
      expect(out).not.toContain("Your API token:");
      expect(out).not.toContain("Authorization: Bearer");
    });
  });

  describe("opted into MCP write + token minted (addMcp=Y, token=Y)", () => {
    const out = lines(true, true, "pvt_abc123").join("\n");

    test("prints token prominently", () => {
      expect(out).toContain("Your API token: pvt_abc123");
    });

    test("notes token is baked into ~/.claude.json", () => {
      expect(out).toContain("Baked into ~/.claude.json for Claude Code");
    });

    test("includes save-it-now warning", () => {
      expect(out).toContain("Won't be shown again — save it now.");
    });

    test("includes Bearer curl example", () => {
      expect(out).toContain(
        'curl -H "Authorization: Bearer pvt_abc123" http://localhost:1940/api/notes',
      );
    });

    test("Next steps mentions starting a Claude Code session", () => {
      expect(out).toContain("Start a new Claude Code session");
    });
  });

  describe("token only, no MCP write (addMcp=N, token=Y, minted)", () => {
    const out = lines(false, true, "pvt_xyz").join("\n");

    test("prints token prominently", () => {
      expect(out).toContain("Your API token: pvt_xyz");
    });

    test("omits the 'Baked into' bullet (no claude.json entry written)", () => {
      expect(out).not.toContain("Baked into ~/.claude.json");
    });

    test("includes Bearer curl example", () => {
      expect(out).toContain("Authorization: Bearer pvt_xyz");
    });

    test("surfaces the connector URL + a copy-paste Claude Code opt-in", () => {
      expect(out).toContain("http://127.0.0.1:1940/vault/default/mcp");
      expect(out).toContain(
        "claude mcp add --transport http parachute-vault http://127.0.0.1:1940/vault/default/mcp",
      );
    });
  });

  // Explicit opt-in to a token but no hub reachable to mint (vault#282 Stage 2).
  describe("token opt-in but no hub (standalone, mint failed)", () => {
    const out = buildInitSummaryLines({
      ...baseInput,
      addMcp: false,
      addToken: true,
      apiKey: undefined,
      noTokenGuidance: "No token issued — hub unreachable.",
      hubPresent: false,
    }).join("\n");

    test("surfaces the no-token-issued guidance + recovery", () => {
      expect(out).toContain("No token issued");
      expect(out).toContain("parachute-vault mcp-install");
    });

    test("standalone framing — points at bringing a hub up / VAULT_AUTH_TOKEN", () => {
      expect(out).toContain("Once a hub is running");
      expect(out).toContain("VAULT_AUTH_TOKEN");
    });

    test("does NOT claim the vault is reachable (no hub present)", () => {
      expect(out).not.toContain("Your vault is still reachable");
    });

    test("still surfaces the connector URL for self-serve connect", () => {
      expect(out).toContain("http://127.0.0.1:1940/vault/default/mcp");
    });
  });

  // #445: opted into a token, none minted, but a HUB IS PRESENT.
  describe("token opt-in, none minted, hub present (#445)", () => {
    const out = buildInitSummaryLines({
      ...baseInput,
      addMcp: false,
      addToken: true,
      apiKey: undefined,
      noTokenGuidance: "No token yet — the hub's admin wizard mints it.",
      hubPresent: true,
    }).join("\n");

    test("affirms the vault is still reachable via the hub's OAuth flow", () => {
      expect(out).toContain("Your vault is still reachable");
      expect(out).toContain("sign-in (OAuth)");
    });

    test("frames a header-auth token as optional (scripts / non-OAuth clients)", () => {
      expect(out).toContain("only needed for scripts");
      expect(out).toContain("parachute-vault mcp-install");
    });

    test("does NOT print the standalone 'Once a hub is running' / VAULT_AUTH_TOKEN copy", () => {
      expect(out).not.toContain("Once a hub is running");
      expect(out).not.toContain("VAULT_AUTH_TOKEN");
    });
  });

  // Defensive: the summary must still render coherently if no wizard URL is
  // supplied (e.g. an older caller / a hub-origin resolution failure).
  test("omits the wizard hand-off cleanly when wizardUrl is absent", () => {
    const out = buildInitSummaryLines({
      ...baseInput,
      wizardUrl: undefined,
      addMcp: false,
      addToken: false,
      apiKey: undefined,
    }).join("\n");
    expect(out).not.toContain("Finish setup in your browser:");
    // The connect info is still surfaced.
    expect(out).toContain("http://127.0.0.1:1940/vault/default/mcp");
  });
});
