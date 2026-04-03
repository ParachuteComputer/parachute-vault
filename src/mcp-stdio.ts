#!/usr/bin/env bun
/**
 * Stdio MCP transport for a single vault.
 *
 * Usage: bun src/mcp-stdio.ts <vault-name>
 *
 * This is what gets configured in ~/.claude.json for each vault.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readVaultConfig, ensureConfigDirSync, loadEnvFile } from "./config.ts";
import { getVaultStore } from "./vault-store.ts";
import { generateVaultMcpTools } from "./mcp-tools.ts";

const vaultName = process.argv[2];
if (!vaultName) {
  console.error("Usage: bun src/mcp-stdio.ts <vault-name>");
  process.exit(1);
}

ensureConfigDirSync();
loadEnvFile();

const vaultConfig = readVaultConfig(vaultName);
if (!vaultConfig) {
  console.error(`Vault "${vaultName}" not found. Run: parachute vault create ${vaultName}`);
  process.exit(1);
}

const store = getVaultStore(vaultName);
const mcpTools = generateVaultMcpTools(store.db, vaultConfig);

const server = new McpServer(
  { name: `parachute-vault/${vaultName}`, version: "0.1.0" },
);

for (const tool of mcpTools) {
  server.tool(
    tool.name,
    tool.description,
    tool.inputSchema as any,
    async (params) => {
      try {
        const result = tool.execute(params as Record<string, unknown>);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return {
          content: [{ type: "text" as const, text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
