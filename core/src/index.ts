// Schema
export { initSchema, SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

// Types
export type {
  Note,
  Link,
  Attachment,
  QueryOpts,
  Store,
} from "./types.js";

// Store
export { SqliteStore } from "./store.js";

// Operations
export * as notes from "./notes.js";
export * as links from "./links.js";

// MCP
export { generateMcpTools, listMcpTools } from "./mcp.js";
export type { McpToolDef } from "./mcp.js";

// Seed
export { seedBuiltins, BUILTIN_TAGS } from "./seed.js";
