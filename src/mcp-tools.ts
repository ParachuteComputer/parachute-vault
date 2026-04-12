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
        const result = tool.execute(rest);

        const schemas = store.getTagSchemaMap();
        if (Object.keys(schemas).length > 0) {
          applyTagSchemaEffects(coreTool.name, result, rest, store, schemas);
        }

        return result;
      },
    };
  });

  // Vault management tools
  addVaultManagementTools(tools, defaultVault);

  // Tag schema tools
  addTagSchemaTools(tools, defaultVault, multiVault);

  return tools;
}

/**
 * Generate MCP tools scoped to a single vault.
 * No vault param — tools operate on that vault only.
 */
export function generateScopedMcpTools(vaultName: string): McpToolDef[] {
  const store = getVaultStore(vaultName);
  const tools = generateMcpTools(store);

  // Wrap tools with schema effects (defaults + warnings) for scoped mode
  for (const tool of tools) {
    if (SCHEMA_EFFECT_TOOLS.has(tool.name)) {
      const originalExecute = tool.execute;
      const toolName = tool.name;
      tool.execute = (params) => {
        const result = originalExecute(params);
        const schemas = store.getTagSchemaMap();
        if (Object.keys(schemas).length > 0) {
          applyTagSchemaEffects(toolName, result, params, store, schemas);
        }
        return result;
      };
    }
  }

  addVaultManagementTools(tools, vaultName, true);
  addTagSchemaTools(tools, vaultName, false, true);
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

// ---------------------------------------------------------------------------
// Tag schema validation (soft)
// ---------------------------------------------------------------------------

import type { TagFieldSchema } from "../core/src/tag-schemas.ts";
import type { Store } from "../core/src/types.ts";

type TagSchema = { description?: string; fields?: Record<string, TagFieldSchema> };

/** Tools that can trigger schema effects (defaults + warnings). */
const SCHEMA_EFFECT_TOOLS = new Set([
  "create-note", "create-notes", "tag-note", "batch-tag",
]);

/**
 * Unified schema effects: auto-populate defaults + attach warnings.
 * Handles all tool shapes: note-returning (create-note), array-returning
 * (create-notes), and non-note-returning (tag-note, batch-tag).
 */
function applyTagSchemaEffects(
  toolName: string,
  result: unknown,
  params: Record<string, unknown>,
  store: Store,
  schemas: Record<string, TagSchema>,
): void {
  if (toolName === "create-note") {
    // create-note returns a Note with tags — populate defaults + warn
    const note = result as { id: string; tags?: string[]; metadata?: Record<string, unknown> };
    if (note.tags) {
      populateSchemaDefaults(store, [note.id], note.tags, schemas);
      // Re-read for accurate warnings after defaults are populated
      const fresh = store.getNote(note.id);
      if (fresh) {
        const warnings = checkTagSchemaWarnings(
          { tags: fresh.tags, metadata: fresh.metadata as Record<string, unknown> | undefined },
          schemas,
        );
        if (warnings.length > 0) (result as any)._schema_warnings = warnings;
      }
    }
  } else if (toolName === "create-notes") {
    // create-notes returns an array of Notes
    const notes = result as Array<{ id: string; tags?: string[] }>;
    for (const note of notes) {
      if (note.tags) {
        populateSchemaDefaults(store, [note.id], note.tags, schemas);
      }
    }
  } else if (toolName === "tag-note") {
    const noteId = params.id as string;
    const tags = params.tags as string[] | undefined;
    if (tags) {
      populateSchemaDefaults(store, [noteId], tags, schemas);
      const fresh = store.getNote(noteId);
      if (fresh) {
        const warnings = checkTagSchemaWarnings(
          { tags: fresh.tags, metadata: fresh.metadata as Record<string, unknown> | undefined },
          schemas,
        );
        if (warnings.length > 0) (result as any)._schema_warnings = warnings;
      }
    }
  } else if (toolName === "batch-tag") {
    const noteIds = (params.note_ids as string[]) ?? [];
    const tags = params.tags as string[] | undefined;
    if (tags) {
      populateSchemaDefaults(store, noteIds, tags, schemas);
    }
  }
}

/**
 * Auto-populate metadata defaults for notes when tags with schemas are applied.
 * Only adds fields that are missing — never overwrites existing values.
 * Uses skipUpdatedAt since this is system enrichment, not a user edit.
 */
function populateSchemaDefaults(
  store: Store,
  noteIds: string[],
  tags: string[],
  schemas: Record<string, TagSchema>,
): void {
  // Collect all default fields from the applied tags' schemas
  const defaults: Record<string, unknown> = {};
  for (const tag of tags) {
    const schema = schemas[tag];
    if (!schema?.fields) continue;
    for (const [field, fieldSchema] of Object.entries(schema.fields)) {
      if (!(field in defaults)) {
        defaults[field] = defaultForField(fieldSchema);
      }
    }
  }
  if (Object.keys(defaults).length === 0) return;

  for (const noteId of noteIds) {
    const note = store.getNote(noteId);
    if (!note) continue;
    const existing = (note.metadata as Record<string, unknown> | undefined) ?? {};
    const missing: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(defaults)) {
      if (!(field in existing)) {
        missing[field] = value;
      }
    }
    if (Object.keys(missing).length === 0) continue;
    store.updateNote(noteId, {
      metadata: { ...existing, ...missing },
      skipUpdatedAt: true,
    });
  }
}

function defaultForField(field: TagFieldSchema): unknown {
  if (field.enum && field.enum.length > 0) return field.enum[0];
  switch (field.type) {
    case "boolean": return false;
    case "integer": return 0;
    default: return "";
  }
}

/**
 * Check a note's tags against tag schemas and return warnings for missing
 * metadata fields. Purely advisory — never rejects a write.
 */
function checkTagSchemaWarnings(
  note: { tags?: string[]; metadata?: Record<string, unknown> },
  schemas: Record<string, TagSchema>,
): string[] {
  const warnings: string[] = [];
  if (!note.tags) return warnings;

  for (const tag of note.tags) {
    const schema = schemas[tag];
    if (!schema?.fields) continue;
    const meta = note.metadata ?? {};
    const missing = Object.keys(schema.fields).filter((f) => !(f in meta));
    if (missing.length > 0) {
      warnings.push(`Tag "${tag}" expects metadata fields: ${missing.join(", ")}`);
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Tag schema tools
// ---------------------------------------------------------------------------

function addTagSchemaTools(tools: McpToolDef[], defaultVault: string, multiVault = false, scoped = false) {
  const vaultProp = scoped ? {} : {
    vault: { type: "string", description: `Vault name (default: "${defaultVault}")` },
  };

  function resolveStore(params: Record<string, unknown>) {
    const name = scoped ? defaultVault : ((params.vault as string) ?? defaultVault);
    return getVaultStore(name);
  }

  tools.push({
    name: "list-tag-schemas",
    description: "List all tag schemas defined for this vault. Tag schemas describe the expected metadata fields for notes with specific tags.",
    inputSchema: { type: "object", properties: { ...vaultProp } },
    execute: (params) => resolveStore(params).listTagSchemas(),
  });

  tools.push({
    name: "describe-tag",
    description: "Get the schema for a specific tag — its description and expected metadata fields. Returns null if no schema is defined for the tag.",
    inputSchema: {
      type: "object",
      properties: { ...vaultProp, tag: { type: "string", description: "Tag name to describe" } },
      required: ["tag"],
    },
    execute: (params) => resolveStore(params).getTagSchema(params.tag as string),
  });

  tools.push({
    name: "create-tag-schema",
    description: "Create or replace a tag's schema. Defines what metadata fields notes with this tag should have. Fields get auto-populated with defaults when the tag is applied to a note.",
    inputSchema: {
      type: "object",
      properties: {
        ...vaultProp,
        tag: { type: "string", description: "Tag name" },
        description: { type: "string", description: "Human-readable description of what this tag means" },
        fields: {
          type: "object",
          description: 'Metadata fields. Each key maps to { type, description?, enum? }. Example: { "status": { "type": "string", "enum": ["active", "archived"] } }',
          additionalProperties: {
            type: "object",
            properties: {
              type: { type: "string", description: "Field type: string, boolean, integer" },
              description: { type: "string", description: "What this field means" },
              enum: { type: "array", items: { type: "string" }, description: "Allowed values (first is the default)" },
            },
            required: ["type"],
          },
        },
      },
      required: ["tag"],
    },
    execute: (params) => resolveStore(params).upsertTagSchema(
      params.tag as string,
      { description: params.description as string | undefined, fields: params.fields as any },
    ),
  });

  tools.push({
    name: "update-tag-schema",
    description: "Update an existing tag schema. Merges provided fields with existing ones. Pass description to update it, fields to add/replace field definitions.",
    inputSchema: {
      type: "object",
      properties: {
        ...vaultProp,
        tag: { type: "string", description: "Tag name" },
        description: { type: "string", description: "Updated description" },
        fields: {
          type: "object",
          description: "Fields to add or update (merged with existing)",
          additionalProperties: {
            type: "object",
            properties: {
              type: { type: "string" },
              description: { type: "string" },
              enum: { type: "array", items: { type: "string" } },
            },
            required: ["type"],
          },
        },
      },
      required: ["tag"],
    },
    execute: (params) => {
      const store = resolveStore(params);
      const tag = params.tag as string;
      const existing = store.getTagSchema(tag);
      const mergedFields = { ...existing?.fields, ...(params.fields as any) };
      return store.upsertTagSchema(tag, {
        description: (params.description as string | undefined) ?? existing?.description,
        fields: Object.keys(mergedFields).length > 0 ? mergedFields : undefined,
      });
    },
  });

  tools.push({
    name: "delete-tag-schema",
    description: "Remove a tag's schema. Does not delete the tag itself or remove it from notes — only removes the metadata schema definition.",
    inputSchema: {
      type: "object",
      properties: { ...vaultProp, tag: { type: "string", description: "Tag name" } },
      required: ["tag"],
    },
    execute: (params) => {
      const deleted = resolveStore(params).deleteTagSchema(params.tag as string);
      return { deleted };
    },
  });
}

