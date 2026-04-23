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
};

/**
 * Build the post-install summary lines for `vault init`, branched on the
 * (addMcp, addToken) decision matrix:
 *
 *   Y, Y → token baked into claude.json + printed prominently
 *   Y, N → token baked into claude.json, hint about `tokens create`
 *   N, Y → token printed prominently, no claude.json entry
 *   N, N → warning: vault unreachable; both recovery paths listed
 */
export function buildInitSummaryLines(input: InitSummaryInput): string[] {
  const { addMcp, addToken, apiKey, configDir, bindHost, port, mcpUrl } = input;
  const lines: string[] = [];
  lines.push("");
  lines.push("---");

  if (addMcp && addToken && apiKey) {
    lines.push("");
    lines.push(`Your API token: ${apiKey}`);
    lines.push(`  - Baked into ~/.claude.json for Claude Code ✓`);
    lines.push(`  - Paste into your other MCP client's config, or use as Authorization: Bearer <token>`);
    lines.push(`  - Won't be shown again — save it now.`);
  } else if (addMcp && !addToken) {
    lines.push("");
    lines.push(
      "Token in ~/.claude.json; run `parachute vault tokens create` later if you need one for other clients.",
    );
  } else if (!addMcp && addToken && apiKey) {
    lines.push("");
    lines.push(`Your API token: ${apiKey}`);
    lines.push(`  - Paste into your other MCP client's config, or use as Authorization: Bearer <token>`);
    lines.push(`  - Won't be shown again — save it now.`);
  } else if (!addMcp && !addToken) {
    lines.push("");
    lines.push(
      "You've skipped both MCP install and token generation — your vault isn't reachable by any client.",
    );
    lines.push(
      "  Add Claude Code later with `parachute-vault mcp-install`, or mint a token with `parachute vault tokens create`.",
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
    lines.push(`  - Mint a token:     parachute vault tokens create`);
  }
  lines.push(`  - Check status:     parachute-vault status`);
  lines.push(`  - Edit config:      parachute-vault config`);

  return lines;
}
