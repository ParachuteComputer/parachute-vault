/**
 * Unified MCP tool generation for multi-vault.
 *
 * Every tool gets an optional `vault` parameter. Defaults to the
 * configured default vault. Single-vault users never notice it.
 * Multi-vault users pass `vault: "work"` to target a specific vault.
 *
 * Also adds a `list-vaults` tool for vault discovery.
 */

import { generateMcpTools } from "../core/src/mcp.ts";
import type { McpToolDef } from "../core/src/mcp.ts";
import { readVaultConfig, readGlobalConfig, listVaults as getVaultNames } from "./config.ts";
import { getVaultStore } from "./vault-store.ts";

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
  const coreTools = generateMcpTools(defaultStore.db);

  // Get default vault config for description enrichment
  const defaultConfig = readVaultConfig(defaultVault);
  const prefix = defaultConfig?.description
    ? `[Vault: ${defaultVault}] ${defaultConfig.description}\n\n`
    : "";
  const hints = defaultConfig?.tool_hints ?? {};

  // Wrap each core tool with vault resolution
  const tools: McpToolDef[] = coreTools.map((coreTool) => {
    // Build enriched description
    let description = coreTool.description;
    if (prefix) description = prefix + description;
    const hint = hints[coreTool.name];
    if (hint) description = description + "\n\n" + hint;
    if (multiVault) {
      description += `\n\nMulti-vault: pass 'vault' to target a specific vault. Default: "${defaultVault}". Available: ${vaultNames.join(", ")}`;
    }

    // Add vault param to schema
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

        // Validate vault exists
        const config = readVaultConfig(vaultName);
        if (!config) {
          throw new Error(`Vault "${vaultName}" not found. Available: ${getVaultNames().join(", ")}`);
        }

        // Get the store and generate tools for this vault's db
        const store = getVaultStore(vaultName);
        const vaultTools = generateMcpTools(store.db);
        const tool = vaultTools.find((t) => t.name === coreTool.name)!;

        // Strip vault param before passing to core tool
        const { vault: _, ...rest } = params;
        return tool.execute(rest);
      },
    };
  });

  // Add list-vaults tool
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

  return tools;
}
