/**
 * MCP tool generation for multi-vault.
 *
 * Wraps core tools with vault resolution (optional `vault` param) and
 * overrides vault-info with actual vault config access.
 */

import { generateMcpTools } from "../core/src/mcp.ts";
import type { McpToolDef } from "../core/src/mcp.ts";
import { readVaultConfig, writeVaultConfig, readGlobalConfig, listVaults as getVaultNames } from "./config.ts";
import { getVaultStore } from "./vault-store.ts";

/**
 * Get the MCP server instruction for a vault (or the default vault).
 * Sent once at session init — not per tool.
 */
export function getServerInstruction(vaultName?: string): string {
  const globalConfig = readGlobalConfig();
  const name = vaultName ?? globalConfig.default_vault ?? "default";
  const config = readVaultConfig(name);

  const parts: string[] = [
    `You are connected to Parachute Vault "${name}".`,
  ];

  if (config?.description) {
    parts.push("", config.description);
  }

  return parts.join("\n");
}

/**
 * Generate the unified MCP tool set.
 * Each tool has an optional `vault` param that defaults to the default vault.
 */
export function generateUnifiedMcpTools(): McpToolDef[] {
  const globalConfig = readGlobalConfig();
  const defaultVault = globalConfig.default_vault ?? "default";
  const vaultNames = getVaultNames();
  const multiVault = vaultNames.length > 1;

  // Get tool definitions from core (using default vault for schema)
  const defaultStore = getVaultStore(defaultVault);
  const coreTools = generateMcpTools(defaultStore);

  // Wrap each core tool with vault resolution
  const tools: McpToolDef[] = coreTools.map((coreTool) => {
    let description = coreTool.description;
    if (multiVault) {
      description += `\n\nMulti-vault: pass 'vault' to target a specific vault. Default: "${defaultVault}". Available: ${vaultNames.join(", ")}`;
    }

    const inputSchema = {
      ...coreTool.inputSchema,
      properties: {
        vault: {
          type: "string",
          description: `Vault name (default: "${defaultVault}")`,
        },
        ...(coreTool.inputSchema as any).properties,
      },
    };

    return {
      name: coreTool.name,
      description,
      inputSchema,
      execute: (params) => {
        const vaultName = (params.vault as string) ?? defaultVault;
        const config = readVaultConfig(vaultName);
        if (!config) {
          throw new Error(`Vault "${vaultName}" not found. Available: ${getVaultNames().join(", ")}`);
        }
        const store = getVaultStore(vaultName);
        const vaultTools = generateMcpTools(store);
        const tool = vaultTools.find((t) => t.name === coreTool.name)!;
        const { vault: _, ...rest } = params;
        return tool.execute(rest);
      },
    };
  });

  // Override vault-info with actual vault config access
  overrideVaultInfo(tools, defaultVault);

  // Add list-vaults (multi-vault only, not in core)
  if (multiVault) {
    tools.push({
      name: "list-vaults",
      description: "List all available vaults with their descriptions.",
      inputSchema: { type: "object", properties: {} },
      execute: () => {
        const names = getVaultNames();
        return names.map((name) => {
          const config = readVaultConfig(name);
          return {
            name,
            description: config?.description,
            created_at: config?.created_at,
            is_default: name === defaultVault,
          };
        });
      },
    });
  }

  return tools;
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
function overrideVaultInfo(tools: McpToolDef[], defaultVault: string): void {
  const vaultInfo = tools.find((t) => t.name === "vault-info");
  if (!vaultInfo) return;

  vaultInfo.execute = (params) => {
    const vaultName = (params.vault as string) ?? defaultVault;
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
      result.stats = store.getVaultStats();
    }

    return result;
  };
}
