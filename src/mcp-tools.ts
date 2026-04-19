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
 * No vault param — tools operate on that vault only.
 */
export function generateScopedMcpTools(vaultName: string): McpToolDef[] {
  const store = getVaultStore(vaultName);
  const tools = generateMcpTools(store);

  // Override vault-info with actual vault config access
  overrideVaultInfo(tools, vaultName);

  return tools;
}

/**
 * Override vault-info's placeholder execute with real vault config access.
 */
function overrideVaultInfo(tools: McpToolDef[], vaultName: string): void {
  const vaultInfo = tools.find((t) => t.name === "vault-info");
  if (!vaultInfo) return;

  vaultInfo.execute = async (params) => {
    const config = readVaultConfig(vaultName);
    if (!config) throw new Error(`Vault "${vaultName}" not found`);

    // Update description if provided
    if (params.description !== undefined) {
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
