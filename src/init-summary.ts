/**
 * Pure helper for `vault init`'s post-install summary. Extracted from cli.ts
 * so the (addMcp, addToken) decision-matrix branches can be unit-tested
 * without side-effects from importing the CLI entrypoint.
 */

export type InitSummaryInput = {
  /**
   * Whether init WROTE the Claude Code MCP config (~/.claude.json) this run.
   * As of 2026-06-23 this is opt-in (default false) — init's primary job is to
   * point the operator at the web setup wizard and surface the self-serve
   * connect info, not to write a config file as a side effect.
   */
  addMcp: boolean;
  addToken: boolean;
  apiKey: string | undefined;
  configDir: string;
  bindHost: string;
  port: number;
  /**
   * The vault's MCP connector URL — `<hub-origin>/vault/<name>/mcp` (hub-origin
   * / expose-state aware). Surfaced in the summary for self-serve copy-paste:
   * a ready-to-run `claude mcp add ...` command is built from it so a Claude
   * Code user can opt in by pasting one line, AND it's printed plain so any
   * other MCP client can be pointed at it.
   */
  mcpUrl: string;
  /**
   * The web setup wizard URL — `<hub-origin>/admin/setup`. init's primary job
   * is to get the operator into this wizard, so it's printed prominently at the
   * top of the summary.
   */
  wizardUrl?: string | undefined;
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
   * the operator wanted a token (`addToken`) but `apiKey` is undefined, so they
   * know why and how to make the vault reachable.
   */
  noTokenGuidance?: string | undefined;
  /**
   * Whether a hub is present on this host (live `/health` probe or a
   * configured hub origin — see `detectHubPresence`). Branches the
   * opted-into-a-token-but-none-minted copy: under a hub the vault is reachable
   * via the hub's browser OAuth flow even with no header-auth token, so the
   * old "your vault isn't reachable by any client" framing is false. #445.
   * Undefined → treat as the conservative standalone case.
   */
  hubPresent?: boolean | undefined;
};

/**
 * Build the post-install summary lines for `vault init`.
 *
 * 2026-06-23 messaging realignment: the site no longer claims "Claude Code is
 * auto-configured," and init no longer writes `~/.claude.json` by default.
 * init's job is to (1) point the operator at the web setup wizard, and
 * (2) SURFACE the self-serve connect info — the connector URL + a ready-to-paste
 * `claude mcp add ...` line — so a Claude Code user opts in by copy-paste rather
 * than a silent side effect.
 *
 * The summary is built in three parts:
 *   1. Wizard hand-off (always) — "finish setup in your browser: <wizardUrl>".
 *   2. Connect-your-AI block — the connector URL + copy-paste `claude mcp add`,
 *      branched on whether init wrote the MCP entry / minted a token.
 *   3. Config / server / next-steps footer.
 *
 * vault#442: per-user OAuth is the default — no token is minted unless the
 * operator opts in (`addToken`), and then it's scope-narrow.
 */
export function buildInitSummaryLines(input: InitSummaryInput): string[] {
  const { addMcp, addToken, apiKey, configDir, bindHost, port, mcpUrl, wizardUrl, vaultName, noTokenGuidance, hubPresent } = input;
  const lines: string[] = [];
  lines.push("");
  lines.push("---");

  // 1. Wizard hand-off — the primary purpose of init is to get the operator
  // into the web setup wizard. Lead with it.
  if (wizardUrl) {
    lines.push("");
    lines.push("Finish setup in your browser:");
    lines.push(`  ${wizardUrl}`);
  }

  // The copy-paste opt-in line for Claude Code (and any client that speaks the
  // `claude mcp add` form). Built from the connector URL so it's the real
  // endpoint, hub-origin aware.
  const claudeAddCmd = `claude mcp add --transport http parachute-vault ${mcpUrl}`;

  // 2. Connect-your-AI — surface the self-serve connect info every time.
  if (addToken && apiKey) {
    // Operator opted into a header-auth token AND it was minted. Surface it
    // prominently (won't be shown again), plus the connector URL.
    lines.push("");
    lines.push(`Your API token: ${apiKey}`);
    if (addMcp) {
      lines.push(`  - Baked into ~/.claude.json for Claude Code ✓`);
    }
    lines.push(`  - Paste into another MCP client's config, or use as Authorization: Bearer <token>`);
    lines.push(`  - Won't be shown again — save it now.`);
    lines.push("");
    lines.push("Connector URL (point any MCP client here):");
    lines.push(`  ${mcpUrl}`);
    if (!addMcp) {
      lines.push("");
      lines.push("Add Claude Code by copy-paste:");
      lines.push(`  ${claudeAddCmd}`);
    }
  } else if (addToken && !apiKey) {
    // Explicitly opted into a token but none was minted (vault#282 Stage 2 —
    // vault no longer mints local pvt_* tokens). Surface why + recovery, then
    // still print the self-serve connect info.
    lines.push("");
    lines.push(
      noTokenGuidance ??
        "No token issued — no hub was reachable to mint a hub JWT.",
    );
    if (hubPresent) {
      // A hub IS present — the vault is already reachable via the hub's
      // browser OAuth flow / web UI. A header-auth token is optional, only for
      // non-OAuth clients + scripts. The "isn't reachable" framing is false
      // here (#445).
      lines.push(
        "  Your vault is still reachable — clients connect through the hub's browser",
      );
      lines.push(
        "  sign-in (OAuth); a header-auth token is only needed for scripts / non-OAuth",
      );
      lines.push(
        "  clients. Run `parachute-vault mcp-install` to mint + wire one when you want it.",
      );
    } else {
      lines.push(
        "  Once a hub is running, run `parachute-vault mcp-install` to mint + wire a token,",
      );
      lines.push(
        "  or set VAULT_AUTH_TOKEN for an operator-channel bearer.",
      );
    }
    lines.push("");
    lines.push("Connect your AI — no token needed, you'll sign in on first use:");
    lines.push(`  Connector URL:  ${mcpUrl}`);
    lines.push(`  Claude Code:    ${claudeAddCmd}`);
  } else {
    // Default path (no token). Per-user OAuth — sign in on first connect.
    lines.push("");
    lines.push("Connect your AI — no token needed, you'll sign in on first use:");
    lines.push(`  Connector URL:  ${mcpUrl}`);
    if (addMcp) {
      lines.push(`  Claude Code is already wired in (~/.claude.json) — just start a session.`);
      lines.push(`  Other clients: ${claudeAddCmd}`);
    } else {
      lines.push(`  Claude Code:    ${claudeAddCmd}`);
      lines.push(`  Other clients (Codex, Goose, OpenCode, Cursor, Zed, Cline): point them at the connector URL above.`);
    }
    lines.push(`  Need a header-auth token for a script? parachute auth mint-token --scope vault:${vaultName}:read`);
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
  if (wizardUrl) {
    lines.push(`  - Finish setup in the web wizard:  ${wizardUrl}`);
  }
  if (addMcp) {
    lines.push(`  - Start a new Claude Code session — your Vault is already wired in. Try:`);
    lines.push(`      claude "Help me set up my parachute vault"`);
  } else {
    lines.push(`  - Wire Claude Code (copy-paste):    ${claudeAddCmd}`);
    lines.push(`    or run the guided installer:      parachute-vault mcp-install`);
  }
  lines.push(`  - Check status:     parachute-vault status`);
  lines.push(`  - Edit config:      parachute-vault config`);

  return lines;
}
