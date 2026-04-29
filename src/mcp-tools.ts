/**
 * MCP tool generation for the scoped (per-vault) MCP endpoint.
 *
 * Every MCP session is now bound to one vault via `/vault/<name>/mcp`, so
 * tools operate on that vault and vault-info picks up its config directly.
 */

import { generateMcpTools } from "../core/src/mcp.ts";
import type { McpToolDef } from "../core/src/mcp.ts";
import { readVaultConfig, writeVaultConfig } from "./config.ts";
import { getVaultStore } from "./vault-store.ts";
import { hasScopeForVault } from "./scopes.ts";
import type { AuthResult } from "./auth.ts";

/**
 * Get the MCP server instruction for a vault.
 * Sent once at session init — not per tool.
 */
export function getServerInstruction(vaultName: string): string {
  const config = readVaultConfig(vaultName);

  const parts: string[] = [
    `You are connected to Parachute Vault "${vaultName}".`,
  ];

  if (config?.description) {
    parts.push("", config.description);
  }

  return parts.join("\n");
}

/**
 * Generate MCP tools scoped to a single vault.
 *
 * `auth` is the resolved token for the caller and is captured by vault-info's
 * execute closure so the description-update branch can perform a secondary
 * scope check: the tool itself is gated at vault:read (so read-only callers
 * can fetch stats), but writing a new description requires vault:write.
 *
 * When omitted (internal callers that only inspect the tool list — no execute
 * path exercised), the description-update branch is disabled entirely.
 */
export function generateScopedMcpTools(vaultName: string, auth?: AuthResult): McpToolDef[] {
  const store = getVaultStore(vaultName);
  const tools = generateMcpTools(store);

  overrideVaultInfo(tools, vaultName, auth);

  return tools;
}

function overrideVaultInfo(
  tools: McpToolDef[],
  vaultName: string,
  auth: AuthResult | undefined,
): void {
  const vaultInfo = tools.find((t) => t.name === "vault-info");
  if (!vaultInfo) return;

  vaultInfo.execute = async (params) => {
    const config = readVaultConfig(vaultName);
    if (!config) throw new Error(`Vault "${vaultName}" not found`);

    if (params.description !== undefined) {
      // Secondary scope check: vault-info is read-gated so read-only callers
      // can fetch stats, but mutating the vault description requires write
      // for THIS vault. Without this, a vault:read token could bypass the
      // outer gate by passing `description` to a tool the outer gate
      // considers read-only.
      if (!auth || !hasScopeForVault(auth.scopes, vaultName, "write")) {
        throw new Error(
          `Forbidden: updating the vault description requires the 'vault:write' scope (or 'vault:${vaultName}:write'). Granted scopes: ${auth?.scopes.join(" ") || "(none)"}.`,
        );
      }
      config.description = params.description as string;
      writeVaultConfig(config);
    }

    const result: any = {
      name: config.name,
      description: config.description ?? null,
    };

    if (params.include_stats) {
      const store = getVaultStore(vaultName);
      result.stats = await store.getVaultStats();
    }

    return result;
  };
}
