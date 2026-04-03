/**
 * MCP tool generation with per-vault description enrichment.
 *
 * Wraps core's generateMcpTools and overlays vault-specific tool_hints
 * from vault.yaml. Also adds vault-level tools (templates).
 */

import { generateMcpTools } from "../core/src/mcp.ts";
import type { McpToolDef } from "../core/src/mcp.ts";
import * as noteOps from "../core/src/notes.ts";
import { Database } from "bun:sqlite";
import type { VaultConfig } from "./config.ts";

/**
 * Generate MCP tools for a vault, enriched with per-vault hints.
 *
 * If the vault config has a `description`, it's prepended to every tool.
 * If it has `tool_hints`, matching tool descriptions are appended.
 * If it has `templates`, adds list-templates and create-from-template tools.
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

  const enriched = tools.map((tool) => {
    const hint = hints[tool.name];
    let description = tool.description;
    if (prefix) description = prefix + description;
    if (hint) description = description + "\n\n" + hint;
    return { ...tool, description };
  });

  // Add template tools if vault has templates
  const templates = vaultConfig.templates ?? [];
  if (templates.length > 0) {
    const templateList = templates
      .map((t) => `  - ${t.name}: ${t.description}`)
      .join("\n");

    enriched.push({
      name: "list-templates",
      description: `List available note templates for this vault.\n\nAvailable templates:\n${templateList}`,
      inputSchema: { type: "object", properties: {} },
      execute: () =>
        templates.map((t) => ({
          name: t.name,
          description: t.description,
          tags: t.tags,
          path: t.path,
        })),
    });

    enriched.push({
      name: "create-from-template",
      description: `Create a note from a vault template. The template provides default content, tags, and path. You can override or extend the content.\n\nAvailable templates:\n${templateList}`,
      inputSchema: {
        type: "object",
        properties: {
          template: {
            type: "string",
            description: "Template name",
            enum: templates.map((t) => t.name),
          },
          content: {
            type: "string",
            description: "Additional content to append to the template (optional)",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Additional tags beyond the template defaults (optional)",
          },
        },
        required: ["template"],
      },
      execute: (params) => {
        const templateName = params.template as string;
        const tmpl = templates.find((t) => t.name === templateName);
        if (!tmpl) {
          throw new Error(`Template "${templateName}" not found`);
        }

        let content = tmpl.content;
        if (params.content) {
          content = content + "\n\n" + (params.content as string);
        }

        const tags = [
          ...(tmpl.tags ?? []),
          ...((params.tags as string[]) ?? []),
        ];

        return noteOps.createNote(db, content, {
          tags: tags.length > 0 ? tags : undefined,
          path: tmpl.path,
        });
      },
    });
  }

  return enriched;
}
