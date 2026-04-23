/**
 * Tests for `buildInitSummaryLines` — the post-install summary printed at the
 * end of `vault init`. The summary branches on the (addMcp, addToken) decision
 * matrix; these tests cover all four cells plus the token surfacing /
 * Bearer-example rules.
 */

import { describe, test, expect } from "bun:test";
import { buildInitSummaryLines } from "./init-summary.ts";

const baseInput = {
  configDir: "/tmp/parachute",
  bindHost: "127.0.0.1",
  port: 1940,
  mcpUrl: "http://127.0.0.1:1940/vault/default/mcp",
};

function lines(addMcp: boolean, addToken: boolean, apiKey: string | undefined) {
  return buildInitSummaryLines({ ...baseInput, addMcp, addToken, apiKey });
}

describe("buildInitSummaryLines", () => {
  describe("MCP=Y + token=Y (most common)", () => {
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

  describe("MCP=Y + token=N (MCP wired, token not surfaced)", () => {
    const out = lines(true, false, "pvt_secret").join("\n");

    test("does not print the token prominently", () => {
      expect(out).not.toContain("pvt_secret");
    });

    test("does not include the 'Baked into' bullet", () => {
      expect(out).not.toContain("Baked into ~/.claude.json");
    });

    test("includes the tokens-create-later hint", () => {
      expect(out).toContain("Token in ~/.claude.json");
      expect(out).toContain("parachute vault tokens create");
    });

    test("omits the Bearer curl example", () => {
      expect(out).not.toContain("Authorization: Bearer");
    });

    test("still shows the Claude-Code-session next step", () => {
      expect(out).toContain("Start a new Claude Code session");
    });
  });

  describe("MCP=N + token=Y (token only)", () => {
    const out = lines(false, true, "pvt_xyz").join("\n");

    test("prints token prominently", () => {
      expect(out).toContain("Your API token: pvt_xyz");
    });

    test("omits the 'Baked into' bullet (no claude.json entry written)", () => {
      expect(out).not.toContain("Baked into ~/.claude.json");
    });

    test("includes Bearer curl example", () => {
      expect(out).toContain('Authorization: Bearer pvt_xyz');
    });

    test("Next steps points at any local MCP client", () => {
      expect(out).toContain("Point any local MCP client");
      expect(out).toContain("http://127.0.0.1:1940/vault/default/mcp");
    });

    test("Next steps offers mcp-install as a way back", () => {
      expect(out).toContain("parachute-vault mcp-install");
    });
  });

  describe("MCP=N + token=N (unreachable)", () => {
    const out = lines(false, false, undefined).join("\n");

    test("warns the vault is unreachable", () => {
      expect(out).toContain("your vault isn't reachable by any client");
    });

    test("points to both recovery paths", () => {
      expect(out).toContain("parachute-vault mcp-install");
      expect(out).toContain("parachute vault tokens create");
    });

    test("does not print any token", () => {
      expect(out).not.toContain("Your API token:");
      expect(out).not.toMatch(/pvt_/);
    });

    test("omits the Bearer curl example", () => {
      expect(out).not.toContain("Authorization: Bearer");
    });
  });

  test("always prints Config: and Server: lines", () => {
    for (const [addMcp, addToken] of [
      [true, true],
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      const out = lines(addMcp, addToken, addMcp || addToken ? "pvt_k" : undefined).join("\n");
      expect(out).toContain("Config:   /tmp/parachute");
      expect(out).toContain("Server:   http://127.0.0.1:1940");
    }
  });
});
