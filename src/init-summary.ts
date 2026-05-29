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
   * Guidance from the bootstrap-credential step when no token could be issued
   * (standalone install, no hub reachable — vault#282 Stage 2). Surfaced when
   * the operator wanted a token (`addMcp || addToken`) but `apiKey` is
   * undefined, so they know why and how to make the vault reachable.
   */
  noTokenGuidance?: string | undefined;
};

/**
 * Build the post-install summary lines for `vault init`, branched on the
 * (addMcp, addToken, apiKey) decision matrix. Post-0.5.0 the token is a
 * hub-issued JWT minted via operator.token; when no hub is reachable `apiKey`
 * is undefined even though the operator opted in (`addToken`/`addMcp`):
 *
 *   addMcp,  addToken,  apiKey → token baked into claude.json + printed
 *   addMcp,  !addToken, apiKey → token baked into claude.json, hint
 *   !addMcp, addToken,  apiKey → token printed prominently
 *   wanted-token-but-no-hub    → guidance: no token issued, recovery paths
 *   !addMcp, !addToken         → warning: vault unreachable; recovery paths
 */
export function buildInitSummaryLines(input: InitSummaryInput): string[] {
  const { addMcp, addToken, apiKey, configDir, bindHost, port, mcpUrl, noTokenGuidance } = input;
  const lines: string[] = [];
  lines.push("");
  lines.push("---");

  const wantedToken = addMcp || addToken;

  if (addMcp && addToken && apiKey) {
    lines.push("");
    lines.push(`Your API token: ${apiKey}`);
    lines.push(`  - Baked into ~/.claude.json for Claude Code ✓`);
    lines.push(`  - Paste into your other MCP client's config, or use as Authorization: Bearer <token>`);
    lines.push(`  - Won't be shown again — save it now.`);
  } else if (addMcp && !addToken && apiKey) {
    lines.push("");
    lines.push(
      "Token in ~/.claude.json; run `parachute-vault mcp-install` later if you need one for other clients.",
    );
  } else if (!addMcp && addToken && apiKey) {
    lines.push("");
    lines.push(`Your API token: ${apiKey}`);
    lines.push(`  - Paste into your other MCP client's config, or use as Authorization: Bearer <token>`);
    lines.push(`  - Won't be shown again — save it now.`);
  } else if (wantedToken && !apiKey) {
    // Opted into a token but no hub was reachable to mint one (vault#282
    // Stage 2 — vault no longer mints local pvt_* tokens). Surface why and
    // the recovery paths.
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
    lines.push("");
    lines.push(
      "You've skipped both MCP install and token generation — your vault isn't reachable by any client.",
    );
    lines.push(
      "  Add Claude Code later with `parachute-vault mcp-install`, which mints a hub JWT (needs a hub running).",
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
