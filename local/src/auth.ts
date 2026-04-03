/**
 * API key authentication for the Parachute Daily server.
 *
 * Three modes:
 *   - "remote" (default): localhost bypasses auth, remote requests require key
 *   - "always": all requests require a valid key
 *   - "disabled": no auth (dev only)
 *
 * Keys are stored hashed (SHA-256) in ~/.parachute/server.yaml.
 * Format: para_<32 random chars>, ID: k_<12 chars>.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Hono } from "hono";
import type { Context, Next } from "hono";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthMode = "remote" | "always" | "disabled";

interface StoredKey {
  id: string;
  label: string;
  key_hash: string;
  created_at: string;
  last_used_at?: string;
}

interface ServerConfig {
  security?: {
    auth_mode?: AuthMode;
    api_keys?: StoredKey[];
  };
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.join(os.homedir(), ".parachute", "server.yaml");

/** Simple YAML serializer for our narrow config shape. */
function serializeConfig(config: ServerConfig): string {
  const lines: string[] = ["security:"];
  lines.push(`  auth_mode: ${config.security?.auth_mode ?? "remote"}`);
  lines.push("  api_keys:");
  for (const key of config.security?.api_keys ?? []) {
    lines.push(`    - id: ${key.id}`);
    lines.push(`      label: ${key.label}`);
    lines.push(`      key_hash: ${key.key_hash}`);
    lines.push(`      created_at: "${key.created_at}"`);
    if (key.last_used_at) {
      lines.push(`      last_used_at: "${key.last_used_at}"`);
    }
  }
  return lines.join("\n") + "\n";
}

/** Simple YAML parser for our narrow config shape. */
function parseConfig(yaml: string): ServerConfig {
  const config: ServerConfig = { security: { auth_mode: "remote", api_keys: [] } };

  const modeMatch = yaml.match(/auth_mode:\s*(\w+)/);
  if (modeMatch) {
    config.security!.auth_mode = modeMatch[1] as AuthMode;
  }

  // Parse api_keys entries
  const keys: StoredKey[] = [];
  const keyBlocks = yaml.split(/\n\s+-\s+id:\s+/).slice(1);
  for (const block of keyBlocks) {
    const idMatch = block.match(/^(\S+)/);
    const labelMatch = block.match(/label:\s*(.+)/);
    const hashMatch = block.match(/key_hash:\s*(\S+)/);
    const createdMatch = block.match(/created_at:\s*"?([^"\n]+)"?/);
    const lastUsedMatch = block.match(/last_used_at:\s*"?([^"\n]+)"?/);

    if (idMatch && hashMatch) {
      keys.push({
        id: idMatch[1],
        label: (labelMatch?.[1] ?? "").trim(),
        key_hash: hashMatch[1],
        created_at: createdMatch?.[1] ?? new Date().toISOString(),
        last_used_at: lastUsedMatch?.[1],
      });
    }
  }
  config.security!.api_keys = keys;
  return config;
}

function loadConfig(): ServerConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return parseConfig(fs.readFileSync(CONFIG_PATH, "utf-8"));
    }
  } catch (e) {
    console.warn(`[auth] Failed to load config: ${e}`);
  }
  return { security: { auth_mode: "remote", api_keys: [] } };
}

function saveConfig(config: ServerConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, serializeConfig(config), "utf-8");
  fs.chmodSync(CONFIG_PATH, 0o600);
}

// ---------------------------------------------------------------------------
// Key operations
// ---------------------------------------------------------------------------

function hashKey(key: string): string {
  return "sha256:" + crypto.createHash("sha256").update(key).digest("hex");
}

function verifyKey(providedKey: string, storedHash: string): boolean {
  const computed = hashKey(providedKey);
  if (computed.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(storedHash));
}

function generateKey(): { fullKey: string; keyId: string } {
  const random = crypto.randomBytes(32).toString("base64url").slice(0, 32);
  return {
    fullKey: `para_${random}`,
    keyId: `k_${random.slice(0, 12)}`,
  };
}

// ---------------------------------------------------------------------------
// In-memory state (loaded once at startup, updated on key changes)
// ---------------------------------------------------------------------------

let _config: ServerConfig = loadConfig();
let _configMtime: number = 0;
try { _configMtime = fs.statSync(CONFIG_PATH).mtimeMs; } catch (_) {}

/** Reload config from disk if the file has been modified. */
function reloadConfigIfChanged(): void {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    if (stat.mtimeMs > _configMtime) {
      _config = loadConfig();
      _configMtime = stat.mtimeMs;
    }
  } catch (_) {
    // File doesn't exist or can't be read — keep current config
  }
}

export function getAuthMode(): AuthMode {
  reloadConfigIfChanged();
  return _config.security?.auth_mode ?? "remote";
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

function isLocalhost(c: Context): boolean {
  // Check X-Forwarded-For first (in case of proxy)
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0].trim();
    return first === "127.0.0.1" || first === "::1" || first === "::ffff:127.0.0.1";
  }
  // Hono on node-server: check the raw socket
  const addr = (c.env as any)?.incoming?.socket?.remoteAddress;
  if (addr) {
    return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  }
  return false;
}

/** Paths that skip auth entirely. */
const SKIP_PATHS = ["/api/health"];

export function authMiddleware() {
  return async (c: Context, next: Next) => {
    const mode = getAuthMode();

    // Disabled mode: skip all auth
    if (mode === "disabled") {
      return next();
    }

    // Skip auth for health check
    const urlPath = new URL(c.req.url).pathname;
    if (SKIP_PATHS.some((p) => urlPath === p)) {
      return next();
    }

    // Allow localhost key management without auth
    if (urlPath.startsWith("/api/auth") && isLocalhost(c)) {
      return next();
    }

    // Remote mode: localhost bypasses auth
    if (mode === "remote" && isLocalhost(c)) {
      return next();
    }

    // Extract key from headers
    const authHeader = c.req.header("Authorization");
    const apiKeyHeader = c.req.header("X-API-Key");
    const providedKey = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : apiKeyHeader ?? null;

    if (!providedKey) {
      return c.json({ error: "Unauthorized", message: "API key required" }, 401);
    }

    // Validate against stored keys
    const keys = _config.security?.api_keys ?? [];
    const matched = keys.find((k) => verifyKey(providedKey, k.key_hash));

    if (!matched) {
      return c.json({ error: "Unauthorized", message: "Invalid API key" }, 401);
    }

    // Update last_used_at
    matched.last_used_at = new Date().toISOString();
    // Fire-and-forget config save (don't block the request)
    try { saveConfig(_config); } catch (_) { /* non-critical */ }

    return next();
  };
}

// ---------------------------------------------------------------------------
// Auth management routes (localhost-only bootstrap)
// ---------------------------------------------------------------------------

export function authRoutes(): Hono {
  const app = new Hono();

  // GET /keys — list keys (metadata only, never plaintext)
  app.get("/keys", (c) => {
    const keys = (_config.security?.api_keys ?? []).map((k) => ({
      id: k.id,
      label: k.label,
      created_at: k.created_at,
      last_used_at: k.last_used_at,
    }));
    return c.json({ keys, auth_mode: getAuthMode() });
  });

  // POST /keys — create a new key (returns plaintext exactly once)
  app.post("/keys", async (c) => {
    const body = await c.req.json<{ label?: string }>().catch(() => ({}));
    const label = (body as any)?.label || "default";

    const { fullKey, keyId } = generateKey();
    const stored: StoredKey = {
      id: keyId,
      label,
      key_hash: hashKey(fullKey),
      created_at: new Date().toISOString(),
    };

    if (!_config.security) _config.security = { auth_mode: "remote", api_keys: [] };
    if (!_config.security.api_keys) _config.security.api_keys = [];
    _config.security.api_keys.push(stored);
    saveConfig(_config);

    return c.json({
      id: keyId,
      key: fullKey,
      label,
      message: "Save this key — it will not be shown again.",
    }, 201);
  });

  // DELETE /keys/:id — revoke a key
  app.delete("/keys/:id", (c) => {
    const id = c.req.param("id");
    const keys = _config.security?.api_keys ?? [];
    const idx = keys.findIndex((k) => k.id === id);
    if (idx === -1) {
      return c.json({ error: "Key not found" }, 404);
    }
    keys.splice(idx, 1);
    saveConfig(_config);
    return c.json({ deleted: true, id });
  });

  // GET /settings — current auth mode
  app.get("/settings", (c) => {
    return c.json({ auth_mode: getAuthMode() });
  });

  // PUT /settings — update auth mode
  app.put("/settings", async (c) => {
    const body = await c.req.json<{ auth_mode: AuthMode }>();
    if (!["remote", "always", "disabled"].includes(body.auth_mode)) {
      return c.json({ error: "Invalid auth_mode" }, 400);
    }
    if (!_config.security) _config.security = {};
    _config.security.auth_mode = body.auth_mode;
    saveConfig(_config);
    return c.json({ auth_mode: body.auth_mode });
  });

  return app;
}
