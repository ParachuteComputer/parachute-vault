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
  vaultName: "default",
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

    test("includes the mcp-install-later hint", () => {
      expect(out).toContain("Token in ~/.claude.json");
      expect(out).toContain("parachute-vault mcp-install");
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

  // vault#442: the DEFAULT init path — MCP wired, NO token minted (per-user
  // OAuth). The summary must LEAD with the OAuth connect path, never mint, and
  // never surface the old "no token issued" failure copy.
  describe("MCP=Y + no token (vault#442 OAuth default)", () => {
    const out = lines(true, false, undefined).join("\n");

    test("leads with the OAuth connect message — no token needed", () => {
      expect(out).toContain("no token needed, you'll sign in on first use");
    });

    test("tells the user Claude Code is already wired in", () => {
      expect(out).toContain("Claude Code is already wired in");
    });

    test("shows the OAuth `claude mcp add` command for other clients", () => {
      expect(out).toContain(
        "claude mcp add --transport http parachute-vault http://127.0.0.1:1940/vault/default/mcp",
      );
    });

    test("offers the scope-narrow opt-in mint for scripts (full vault:<name>:read, never admin)", () => {
      // Must be the three-segment named-resource form the hub mint-token model
      // requires — a bare `vault:read` would mint a malformed scope (vault#443).
      expect(out).toContain("parachute auth mint-token --scope vault:default:read");
      expect(out).not.toContain("--scope vault:read ");
      expect(out).not.toMatch(/--scope vault:read$/m);
      expect(out).not.toContain("vault:admin");
    });

    test("does NOT print or imply any minted token", () => {
      expect(out).not.toContain("Your API token:");
      expect(out).not.toContain("Baked into ~/.claude.json");
      expect(out).not.toContain("Authorization: Bearer");
    });

    test("does NOT surface the old no-token-issued failure copy", () => {
      expect(out).not.toContain("No token issued");
    });

    test("threads a non-default vault name into the mint-token scope", () => {
      const out2 = buildInitSummaryLines({
        ...baseInput,
        vaultName: "journal",
        mcpUrl: "http://127.0.0.1:1940/vault/journal/mcp",
        addMcp: true,
        addToken: false,
        apiKey: undefined,
      }).join("\n");
      expect(out2).toContain("parachute auth mint-token --scope vault:journal:read");
      expect(out2).not.toContain("vault:default:read");
    });
  });

  describe("MCP=N + token=N (OAuth default, Claude Code not wired)", () => {
    const out = lines(false, false, undefined).join("\n");

    test("frames skipping the MCP entry as OAuth-first, not 'unreachable'", () => {
      expect(out).toContain("uses per-user OAuth, no token needed");
      expect(out).not.toContain("your vault isn't reachable by any client");
    });

    test("points to mcp-install (no token-minting framing)", () => {
      expect(out).toContain("parachute-vault mcp-install");
      expect(out).not.toContain("mints a hub JWT");
    });

    test("does not print any token", () => {
      expect(out).not.toContain("Your API token:");
      expect(out).not.toMatch(/pvt_/);
    });

    test("omits the Bearer curl example", () => {
      expect(out).not.toContain("Authorization: Bearer");
    });
  });

  // Explicit opt-in but no hub reachable to mint (vault#282 Stage 2 path,
  // reached only when the operator passes --token without a hub).
  describe("MCP=N + token=Y but no hub (opt-in mint failed, standalone)", () => {
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
  });

  // #445: opted into a token, none minted, but a HUB IS PRESENT. The vault is
  // reachable via the hub's browser OAuth flow even with no header-auth token,
  // so the standalone "isn't reachable" framing would be false here.
  describe("MCP=N + token=Y, no token minted, but hub present (#445)", () => {
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

    test("never claims the vault isn't reachable by any client", () => {
      expect(out).not.toContain("isn't reachable by any client");
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
