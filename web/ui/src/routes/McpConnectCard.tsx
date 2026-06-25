/**
 * Per-vault "Connect to your AI" card — the vault admin SPA's twin of hub's
 * `McpConnectCard` (parachute-hub/web/ui/src/components/McpConnectCard.tsx).
 *
 * Why it lives HERE: after setup, the operator lands on the vault admin SPA
 * (the multi-vault home at `/vault/admin`, then this vault's detail page via
 * "Manage"). The "how do I connect my AI to this vault?" affordance — the MCP
 * endpoint URL + the `claude mcp add` command — previously lived ONLY on the
 * hub SPA's account page, where a setup-admin won't look. This card surfaces
 * it as the obvious next step right on the vault detail view.
 *
 * Origin source: the MCP endpoint is `<hub-origin>/vault/<name>/mcp`. The SPA
 * is itself served at `<hub-origin>/vault/admin` (multi-vault home) or
 * `<hub-origin>/vault/<name>/admin` (per-vault detail), so `window.location.
 * origin` IS the hub origin — we derive the endpoint from it + the vault name,
 * no extra fetch or hub coordination needed. (vault-info's `coordinates` block
 * — shipped 0.6.3-rc.3 — is the canonical source if you ever need the origin
 * server-side; the SPA already knows it from its own URL.) Callers may pass an
 * explicit `origin` to override (tests; or a derived-from-coordinates value).
 *
 * Auth paths, OAuth-first (mirrors hub's framing):
 *   - **OAuth (default).** `claude mcp add --transport http …` with NO token.
 *     The client opens a browser on first use, the operator signs in to the
 *     hub + approves the scope, and the client caches its own OAuth tokens.
 *     Nothing secret lands in shell history — this is the lead path.
 *   - **Header auth (secondary).** For clients that can't do browser OAuth
 *     (headless / CI / some hosted clients), mint a scope-narrow hub JWT on
 *     the Tokens page and pass it as an `Authorization: Bearer` header. We
 *     point at the Tokens page (same SPA) rather than re-implementing the
 *     mint flow inline.
 */
import { useState } from "react";
import { Link } from "react-router-dom";

const CONNECT_DOCS_URL = "https://parachute.computer/install#connect-mcp-clients";

/**
 * Build `<origin>/vault/<name>/mcp`. `origin` is origin-absolute, no trailing
 * `/vault/...` segment (it's `window.location.origin`). Strip any trailing
 * slash so we never emit `…//vault/work/mcp`. Exported for direct unit testing.
 */
export function mcpEndpointFor(origin: string, vaultName: string): string {
  return `${origin.replace(/\/+$/, "")}/vault/${encodeURIComponent(vaultName)}/mcp`;
}

/**
 * The OAuth-path `claude mcp add` command — no token, triggers browser OAuth
 * on first use. The server name is `parachute-<vault>` to match hub's card and
 * the wizard's `renderMcpTile`. Exported for direct unit testing.
 */
export function claudeMcpAddCommand(origin: string, vaultName: string): string {
  return `claude mcp add --transport http parachute-${vaultName} ${mcpEndpointFor(origin, vaultName)}`;
}

/**
 * Resolve the hub origin the SPA is served from. `window.location.origin` is
 * the hub origin because the bundle mounts at `<hub-origin>/vault/admin` or
 * `<hub-origin>/vault/<name>/admin`. Returns `null` outside a browser (SSR /
 * tests that don't set a location) so callers can fall back gracefully.
 */
export function currentHubOrigin(): string | null {
  if (typeof window === "undefined" || !window.location?.origin) return null;
  return window.location.origin;
}

/**
 * Copy-to-clipboard button that flips its label to "Copied ✓" for 2s. Mirrors
 * the Tokens page / hub card affordance. Clipboard can be unavailable in
 * insecure contexts; we no-op gracefully (the command stays selectable).
 */
function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="secondary"
      onClick={() => {
        if (typeof navigator === "undefined" || !navigator.clipboard) return;
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}

interface McpConnectCardProps {
  /** Vault short name — drives the endpoint path + the MCP server name. */
  vaultName: string;
  /**
   * Hub origin override. Defaults to `window.location.origin` (the hub origin
   * the SPA is served from). Pass an explicit value in tests or when a
   * derived-from-coordinates origin is preferred.
   */
  origin?: string;
  /**
   * Optional in-SPA route to this vault's Tokens page (header-auth mint path).
   * Resolved against the runtime basename by React Router `Link`. Under the
   * per-vault mount this is `/tokens`.
   */
  tokensHref?: string;
}

/**
 * The "Connect to your AI" card. Self-contained — no network calls. Renders
 * the MCP endpoint, the OAuth `claude mcp add` command, and a brief per-client
 * note (Claude.ai connector / Claude Code / bearer-token clients).
 */
export function McpConnectCard({ vaultName, origin, tokensHref }: McpConnectCardProps) {
  const resolvedOrigin = origin ?? currentHubOrigin();

  // No origin (SSR / a test without a location) — degrade to a relative
  // template rather than emitting a broken `null/vault/...` URL. This path is
  // unreachable in a real browser (`window.location.origin` is always set);
  // the relative command is informational, not directly runnable until the
  // origin resolves.
  const endpoint = resolvedOrigin
    ? mcpEndpointFor(resolvedOrigin, vaultName)
    : `/vault/${encodeURIComponent(vaultName)}/mcp`;
  const oauthCmd = resolvedOrigin
    ? claudeMcpAddCommand(resolvedOrigin, vaultName)
    : `claude mcp add --transport http parachute-${vaultName} ${endpoint}`;

  return (
    <div className="mcp-connect-card">
      <h3>Connect to your AI</h3>
      <p className="muted">
        Connect an AI client — Claude.ai (add it as a connector), Claude Code, or any MCP client —
        to the <code>{vaultName}</code> vault. The client signs in to this hub and reads/writes
        vault data over MCP.
      </p>

      <div className="mcp-field">
        <span className="mcp-field-label">MCP endpoint</span>
        <div className="token-box">
          <code data-testid="mcp-endpoint">{endpoint}</code>
          <CopyButton value={endpoint} />
        </div>
        <p className="dim">
          Claude.ai / ChatGPT: add this URL as a custom connector. You'll sign in to this hub and
          approve access in the browser.
        </p>
      </div>

      <div className="mcp-field">
        <span className="mcp-field-label">Claude Code</span>
        <div className="token-box">
          <code data-testid="mcp-add-command">{oauthCmd}</code>
          <CopyButton value={oauthCmd} />
        </div>
        <p className="dim">
          No token needed — the command triggers browser OAuth on first use (you sign in to this hub
          and approve access).
        </p>
      </div>

      <p className="dim">
        Headless / CI / bearer-token clients that can't do browser OAuth: mint a scope-narrow hub
        token (<code>vault:{vaultName}:read vault:{vaultName}:write</code> — not admin) on the{" "}
        {tokensHref ? <Link to={tokensHref}>Tokens page</Link> : <span>Tokens page</span>} and pass
        it as <code>--header "Authorization: Bearer &lt;token&gt;"</code>.
      </p>

      <p className="dim mcp-docs-link">
        <a href={CONNECT_DOCS_URL} target="_blank" rel="noreferrer">
          Full connect docs →
        </a>
      </p>
    </div>
  );
}
