/**
 * Unified MCP tool generation for multi-vault.
 *
 * Every tool gets an optional `vault` parameter. Defaults to the
 * configured default vault. Single-vault users never notice it.
 *
 * Vault description is sent as the MCP server instruction (not
 * prepended to each tool). Agents get the guidance once at session
 * start.
 */

import { generateMcpTools } from "../core/src/mcp.ts";
import type { McpToolDef } from "../core/src/mcp.ts";
import { readVaultConfig, writeVaultConfig, readGlobalConfig, listVaults as getVaultNames } from "./config.ts";
import { getVaultStore } from "./vault-store.ts";

/**
 * Get the MCP server instruction for a vault (or the default vault).
 * This is sent once at session init — not per tool.
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
  const coreTools = generateMcpTools(defaultStore.db);

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
        const vaultTools = generateMcpTools(store.db);
        const tool = vaultTools.find((t) => t.name === coreTool.name)!;
        const { vault: _, ...rest } = params;
        return tool.execute(rest);
      },
    };
  });

  // Vault management tools
  addVaultManagementTools(tools, defaultVault);

  return tools;
}

/**
 * Generate MCP tools scoped to a single vault.
 * No vault param — tools operate on that vault only.
 */
export function generateScopedMcpTools(vaultName: string): McpToolDef[] {
  const store = getVaultStore(vaultName);
  const tools = generateMcpTools(store.db);
  addVaultManagementTools(tools, vaultName, true);
  return tools;
}

/**
 * Add vault management tools (list-vaults, get/update description).
 */
function addVaultManagementTools(tools: McpToolDef[], defaultVault: string, scoped = false) {
  if (!scoped) {
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

  tools.push({
    name: "get-vault-description",
    description: "Get the description/instructions for a vault. The description tells agents how to use this vault — what tags to use, what conventions to follow, etc.",
    inputSchema: {
      type: "object",
      properties: {
        ...(scoped ? {} : {
          vault: { type: "string", description: `Vault name (default: "${defaultVault}")` },
        }),
      },
    },
    execute: (params) => {
      const name = scoped ? defaultVault : ((params.vault as string) ?? defaultVault);
      const config = readVaultConfig(name);
      if (!config) throw new Error(`Vault "${name}" not found`);
      return {
        name: config.name,
        description: config.description ?? null,
      };
    },
  });

  tools.push({
    name: "update-vault-description",
    description: "Update the description/instructions for a vault. The description guides how AI agents use this vault — tag conventions, writing guidelines, etc. IMPORTANT: Only update when the user explicitly asks you to change the vault's configuration. Never modify unprompted.",
    inputSchema: {
      type: "object",
      properties: {
        ...(scoped ? {} : {
          vault: { type: "string", description: `Vault name (default: "${defaultVault}")` },
        }),
        description: { type: "string", description: "New vault description/instructions" },
      },
      required: ["description"],
    },
    execute: (params) => {
      const name = scoped ? defaultVault : ((params.vault as string) ?? defaultVault);
      const config = readVaultConfig(name);
      if (!config) throw new Error(`Vault "${name}" not found`);
      config.description = params.description as string;
      writeVaultConfig(config);
      return { updated: true, name, description: config.description };
    },
  });
}
