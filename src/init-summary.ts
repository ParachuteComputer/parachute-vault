/**
 * Pure helper for `vault init`'s post-install summary. Extracted from cli.ts
 * so the (addMcp, addToken) decision-matrix branches can be unit-tested
 * without side-effects from importing the CLI entrypoint.
 */

export type InitSummaryInput = {
  addMcp: boolean;
  addToken: boolean;
  apiKey: string | undefined;
  configDir: string;
  bindHost: string;
  port: number;
  mcpUrl: string;
  /**
   * The default vault's name — used to emit the three-segment
   * `vault:<vaultName>:read` scope in the OAuth-first mint-token suggestion
   * (the hub mint-token model requires the named-resource form;
   * a bare `vault:read` would mint a malformed scope). vault#442/#443.
   */
  vaultName: string;
  /**
   * Guidance from the bootstrap-credential step when no token could be issued
   * (standalone install, no hub reachable — vault#282 Stage 2). Surfaced when
   * the operator wanted a token (`addMcp || addToken`) but `apiKey` is
   * undefined, so they know why and how to make the vault reachable.
   */
  noTokenGuidance?: string | undefined;
};

/**
 * Build the post-install summary lines for `vault init`, branched on the
 * (addMcp, addToken, apiKey) decision matrix.
 *
 * vault#442: the DEFAULT is per-user OAuth — no token is minted, and the
 * Claude Code MCP entry is written without a baked bearer (browser sign-in on
 * first connect). A token is minted only on explicit opt-in (`addToken`), and
 * then scope-narrow. Branches:
 *
 *   addMcp,  !apiKey            → OAuth-first: connect, sign in on first use
 *   addMcp,  addToken,  apiKey  → token baked into claude.json + printed
 *   addMcp,  !addToken, apiKey  → token baked into claude.json, hint
 *   !addMcp, addToken,  apiKey  → token printed prominently
 *   !addMcp, addToken,  !apiKey → opted into a token but no hub reachable
 *   !addMcp, !addToken          → OAuth-first: add Claude Code later
 */
export function buildInitSummaryLines(input: InitSummaryInput): string[] {
  const { addMcp, addToken, apiKey, configDir, bindHost, port, mcpUrl, vaultName, noTokenGuidance } = input;
  const lines: string[] = [];
  lines.push("");
  lines.push("---");

  if (addMcp && apiKey && addToken) {
    lines.push("");
    lines.push(`Your API token: ${apiKey}`);
    lines.push(`  - Baked into ~/.claude.json for Claude Code ✓`);
    lines.push(`  - Paste into your other MCP client's config, or use as Authorization: Bearer <token>`);
    lines.push(`  - Won't be shown again — save it now.`);
  } else if (addMcp && apiKey && !addToken) {
    lines.push("");
    lines.push(
      "Token in ~/.claude.json; run `parachute-vault mcp-install` later if you need one for other clients.",
    );
  } else if (addMcp && !apiKey) {
    // vault#442 default: OAuth-first. The MCP entry is wired without a bearer —
    // Claude Code signs in via browser OAuth on first connect. No token needed.
    lines.push("");
    lines.push("Connect your AI — no token needed, you'll sign in on first use:");
    lines.push(`  Claude Code is already wired in (~/.claude.json) — just start a session.`);
    lines.push(`  Other clients: claude mcp add --transport http parachute-vault ${mcpUrl}`);
    lines.push(`  Need a header-auth token for a script? parachute auth mint-token --scope vault:${vaultName}:read`);
  } else if (!addMcp && addToken && apiKey) {
    lines.push("");
    lines.push(`Your API token: ${apiKey}`);
    lines.push(`  - Paste into your other MCP client's config, or use as Authorization: Bearer <token>`);
    lines.push(`  - Won't be shown again — save it now.`);
  } else if (!addMcp && addToken && !apiKey) {
    // Explicitly opted into a token but no hub was reachable to mint one
    // (vault#282 Stage 2 — vault no longer mints local pvt_* tokens). Surface
    // why and the recovery paths.
    lines.push("");
    lines.push(
      noTokenGuidance ??
        "No token issued — no hub was reachable to mint a hub JWT.",
    );
    lines.push(
      "  Once a hub is running, run `parachute-vault mcp-install` to mint + wire a token,",
    );
    lines.push(
      "  or set VAULT_AUTH_TOKEN for an operator-channel bearer.",
    );
  } else if (!addMcp && !addToken) {
    // OAuth-first, but the operator skipped wiring Claude Code too.
    lines.push("");
    lines.push(
      "Skipped the Claude Code MCP entry. Add it anytime — it uses per-user OAuth, no token needed:",
    );
    lines.push(
      "  parachute-vault mcp-install",
    );
  }

  lines.push("");
  lines.push(`Config:   ${configDir}`);
  lines.push(`Server:   http://${bindHost}:${port}`);

  lines.push("");
  lines.push(`Usage examples:`);
  lines.push(`  curl http://localhost:${port}/health`);
  if (addToken && apiKey) {
    lines.push(`  curl -H "Authorization: Bearer ${apiKey}" http://localhost:${port}/api/notes`);
  }

  lines.push("");
  lines.push(`Next steps:`);
  if (addMcp) {
    lines.push(`  - Start a new Claude Code session — your Vault is already wired in. Try:`);
    lines.push(`      claude "Help me set up my parachute vault"`);
    lines.push(`  - Or point any other local MCP client (Codex, Goose, OpenCode, Cursor,`);
    lines.push(`    Zed, Cline, your own agent) at:`);
    lines.push(`      ${mcpUrl}`);
  } else if (addToken) {
    lines.push(`  - Point any local MCP client (Codex, Goose, OpenCode, Cursor, Zed,`);
    lines.push(`    Cline, your own agent) at:`);
    lines.push(`      ${mcpUrl}`);
    lines.push(`  - Or add Claude Code back anytime:  parachute-vault mcp-install`);
  } else {
    lines.push(`  - Add Claude Code:  parachute-vault mcp-install`);
  }
  lines.push(`  - Check status:     parachute-vault status`);
  lines.push(`  - Edit config:      parachute-vault config`);

  return lines;
}
