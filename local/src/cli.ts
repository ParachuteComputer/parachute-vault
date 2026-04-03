#!/usr/bin/env node

/**
 * Parachute CLI — self-hosted personal graph server.
 *
 * Usage:
 *   parachute serve        Start the HTTP server (default port 1940)
 *   parachute mcp          Start the MCP stdio server (for Claude)
 *   parachute init         Initialize database and create first API key
 *   parachute status       Check server health
 *   parachute help         Show this help message
 */

const command = process.argv[2] ?? "help";

switch (command) {
  case "serve":
  case "server":
    await import("./server.js");
    break;

  case "init":
    await runInit();
    break;

  case "status":
    await runStatus();
    break;

  case "help":
  case "--help":
  case "-h":
    printHelp();
    break;

  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}

async function runInit() {
  const path = await import("node:path");
  const os = await import("node:os");
  const fs = await import("node:fs");
  const { createStore } = await import("./db.js");

  const dbPath = process.env.PARACHUTE_DB ?? path.join(os.homedir(), ".parachute", "daily.db");
  const assetsDir = process.env.PARACHUTE_ASSETS ?? path.join(os.homedir(), ".parachute", "daily", "assets");

  // Create directories
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(assetsDir, { recursive: true });

  // Initialize database (schema + seed)
  const store = createStore(dbPath);
  const tags = store.listTags();

  console.log(`Database: ${dbPath}`);
  console.log(`Assets:   ${assetsDir}`);
  console.log(`Tags:     ${tags.length} (${tags.map((t: any) => t.name).join(", ")})`);
  console.log(`\nParachute is ready. Run 'parachute serve' to start the server.`);
}

async function runStatus() {
  const port = process.env.PORT ?? "1940";
  const baseUrl = `http://localhost:${port}`;

  try {
    const res = await fetch(`${baseUrl}/api/health`);
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>;
      console.log(`Server:        running on :${port}`);
      console.log(`Version:       ${data.version}`);
      console.log(`Auth mode:     ${data.auth_mode}`);
      console.log(`Transcription: ${data.transcription_available ? "available" : "not available"}`);
      console.log(`MCP endpoint:  ${baseUrl}/mcp`);
    } else {
      console.log(`Server responded with ${res.status}`);
    }
  } catch {
    console.log(`Server not running on :${port}`);
  }
}

function printHelp() {
  console.log(`
Parachute — personal graph server

Usage:
  parachute serve     Start the HTTP server (default :1940)
  parachute init      Initialize database and show status
  parachute status    Check if server is running

The server includes an MCP endpoint at /mcp for AI agent access.
Add it to Claude Code:
  claude mcp add parachute-daily --transport http --url http://localhost:1940/mcp

Environment:
  PORT                 Server port (default: 1940)
  PARACHUTE_DB         Database path (default: ~/.parachute/daily.db)
  PARACHUTE_ASSETS     Assets directory (default: ~/.parachute/daily/assets)
`.trim());
}
