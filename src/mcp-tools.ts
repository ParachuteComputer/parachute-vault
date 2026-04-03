/**
 * MCP tool generation with per-vault description enrichment.
 *
 * Wraps core's generateMcpTools and overlays vault-specific tool_hints
 * from vault.yaml.
 */

import { generateMcpTools } from "../core/src/mcp.ts";
import type { McpToolDef } from "../core/src/mcp.ts";
import { Database } from "bun:sqlite";
import type { VaultConfig } from "./config.ts";

/**
 * Generate MCP tools for a vault, enriched with per-vault hints.
 *
 * If the vault config has a `description`, it's prepended to every tool.
 * If it has `tool_hints`, matching tool descriptions are appended.
 */
export function generateVaultMcpTools(
  db: Database,
  vaultConfig: VaultConfig,
): McpToolDef[] {
  const tools = generateMcpTools(db);

  const prefix = vaultConfig.description
    ? `[Vault: ${vaultConfig.name}] ${vaultConfig.description}\n\n`
    : "";

  const hints = vaultConfig.tool_hints ?? {};

  return tools.map((tool) => {
    const hint = hints[tool.name];
    let description = tool.description;
    if (prefix) description = prefix + description;
    if (hint) description = description + "\n\n" + hint;
    return { ...tool, description };
  });
}
