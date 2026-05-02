/**
 * URL picker for `parachute-vault mcp-install`. The URL written into
 * `~/.claude.json` must match vault's advertised OAuth issuer for the origin
 * the client will reach the server on — otherwise strict clients (Claude
 * Code's MCP SDK) reject discovery on origin/issuer mismatch (RFC 8414 §3.1).
 *
 * Selection order:
 *   1. `PARACHUTE_HUB_ORIGIN` env (vault is advertising the hub as issuer).
 *   2. `~/.parachute/expose-state.json` canonical FQDN (active tailnet /
 *      public exposure the CLI brought up).
 *   3. Loopback on the configured port.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type McpUrlSource = "hub-origin" | "expose-state" | "loopback";

export function chooseMcpUrl(
  vaultName: string,
  port: number,
  env: { PARACHUTE_HUB_ORIGIN?: string | undefined } = process.env as { PARACHUTE_HUB_ORIGIN?: string },
): { url: string; source: McpUrlSource } {
  const hub = env.PARACHUTE_HUB_ORIGIN?.replace(/\/$/, "");
  if (hub) {
    return { url: `${hub}/vault/${vaultName}/mcp`, source: "hub-origin" };
  }
  const fqdn = readExposedFqdn();
  if (fqdn) {
    return { url: `https://${fqdn}/vault/${vaultName}/mcp`, source: "expose-state" };
  }
  return { url: `http://127.0.0.1:${port}/vault/${vaultName}/mcp`, source: "loopback" };
}

/**
 * Best-effort read of `~/.parachute/expose-state.json` (CLI-owned). Returns
 * the canonical FQDN when an active tailnet/public exposure is configured;
 * returns undefined on any error or when absent — this is advisory, not
 * load-bearing.
 *
 * Re-derives the ecosystem root per-call so tests that flip `PARACHUTE_HOME`
 * see the override — the top-level `CONFIG_DIR` const in config.ts is frozen
 * at module import.
 */
function readExposedFqdn(): string | undefined {
  try {
    const root = process.env.PARACHUTE_HOME ?? resolve(homedir(), ".parachute");
    const p = resolve(root, "expose-state.json");
    if (!existsSync(p)) return undefined;
    const raw = JSON.parse(readFileSync(p, "utf-8")) as {
      layer?: string;
      canonicalFqdn?: string;
    };
    if ((raw.layer === "tailnet" || raw.layer === "public") && raw.canonicalFqdn) {
      return raw.canonicalFqdn;
    }
  } catch {}
  return undefined;
}
