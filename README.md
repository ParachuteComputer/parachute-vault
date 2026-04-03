# Parachute Vault

A self-hosted knowledge graph for AI agents. Notes, tags, and links — exposed over MCP. Any AI gets a personal knowledge vault in one command.

## Quick start

```bash
bun install -g github:ParachuteComputer/parachute-vault
parachute vault init
```

That's it. `vault init` creates a vault, starts a background daemon, and configures Claude Code's MCP automatically. Your AI can now read and write to the vault.

## What you get

A server on port 1940 with:

- **REST API** — CRUD for notes, tags, links, full-text search
- **MCP** — 16 tools that any AI can use (create notes, search, traverse links, bulk operations)
- **Transcription** — Whisper-compatible endpoint (with [parachute-scribe](https://github.com/ParachuteComputer/parachute-scribe))

Each vault is its own SQLite database. You can run multiple vaults on one server.

## CLI

```bash
# Vaults
parachute vault create work           # create a new vault
parachute vault list                   # list all vaults
parachute vault remove work --yes      # delete a vault
parachute vault mcp-install work       # add vault to Claude Code

# Config
parachute vault config                 # show current configuration
parachute vault config set KEY value   # set a config value
parachute vault config unset KEY       # remove a config value

# Server
parachute vault status                 # check what's running
parachute vault restart                # restart after config changes
parachute vault serve                  # run in foreground (for debugging)
```

## Configuration

All config lives in `~/.parachute/.env`. Manage it with `vault config` or edit directly.

```bash
# Transcription (requires parachute-scribe)
parachute vault config set TRANSCRIBE_PROVIDER groq
parachute vault config set GROQ_API_KEY gsk_...
parachute vault config set CLEANUP_PROVIDER claude
parachute vault config set ANTHROPIC_API_KEY sk-ant-...
parachute vault restart
```

### Transcription providers

| Provider | Type | Notes |
|----------|------|-------|
| `parakeet-mlx` | Local | Mac only (Apple Silicon). Fastest local option. |
| `groq` | API | Fast and cheap. Needs `GROQ_API_KEY`. |
| `openai` | API | Reference Whisper API. Needs `OPENAI_API_KEY`. |

### Cleanup providers

After transcription, an LLM can clean up the text (fix filler words, punctuation, formatting):

| Provider | Type | Notes |
|----------|------|-------|
| `claude` | API | Needs `ANTHROPIC_API_KEY`. |
| `ollama` | Local | Needs Ollama running. Set `OLLAMA_MODEL` and `OLLAMA_URL`. |
| `none` | — | No cleanup (default). |

## MCP tools

When an AI connects to a vault, it gets these tools:

| Tool | Description |
|------|-------------|
| `get-note` | Fetch a note by ID, path, or batch of IDs |
| `create-note` | Create a note with optional tags, path, and metadata |
| `update-note` | Update a note's content, path, or metadata |
| `delete-note` | Delete a note |
| `read-notes` | Query notes by tags, path prefix, metadata, and date range |
| `search-notes` | Full-text search |
| `tag-note` | Add tags to a note |
| `untag-note` | Remove tags from a note |
| `create-link` | Create a directed link between notes (with optional metadata) |
| `delete-link` | Delete a link |
| `get-links` | Get links for a note (hydrated with note summaries) |
| `list-tags` | List all tags with counts |
| `create-notes` | Bulk create notes (one transaction) |
| `batch-tag` | Tag multiple notes at once |
| `batch-untag` | Untag multiple notes at once |
| `traverse-links` | Multi-hop graph traversal (with note summaries) |
| `find-path` | Find shortest path between two notes |
| `list-vaults` | List available vaults |

### Per-vault MCP descriptions

Each vault can customize how AI agents use it. Edit `~/.parachute/vaults/{name}/vault.yaml`:

```yaml
name: work
description: "Work knowledge base — product notes, meeting notes, decisions"
tool_hints:
  create-note: "Use #meeting for meeting notes, #decision for ADRs"
  read-notes: "Check #pinned for important context before searching"
```

The vault teaches the AI how to use it. Different vaults can have different conventions.

## REST API

Routes are available per-vault at `/vaults/{name}/api/` or at `/api/` (routes to default vault):

```
GET    /vaults/{name}/api/notes          # query notes
POST   /vaults/{name}/api/notes          # create note
GET    /vaults/{name}/api/notes/:id      # get note
PATCH  /vaults/{name}/api/notes/:id      # update note
DELETE /vaults/{name}/api/notes/:id      # delete note
POST   /vaults/{name}/api/notes/:id/tags # tag note
DELETE /vaults/{name}/api/notes/:id/tags # untag note
GET    /vaults/{name}/api/tags           # list tags
POST   /vaults/{name}/api/links          # create link
DELETE /vaults/{name}/api/links          # delete link
GET    /vaults/{name}/api/search?q=...   # full-text search

POST   /mcp                              # unified MCP (all vaults)
*      /vaults/{name}/mcp               # per-vault scoped MCP
POST   /v1/audio/transcriptions          # transcribe audio (Whisper-compatible)
GET    /v1/models                        # list transcription providers
GET    /health                           # server health
```

## Data model

Each vault is a SQLite database with five tables:

```
notes       (id, content, path, metadata, created_at, updated_at)
tags        (name)
note_tags   (note_id, tag_name)
links       (source_id, target_id, relationship, metadata, created_at)
attachments (id, note_id, path, mime_type, created_at)
```

Metadata is a JSON column — store any structured properties:

```json
{ "status": "draft", "priority": "high", "author": "Aaron", "due": "2026-04-15" }
```

Vaults start blank — no predefined tags or schema. Clients create the tags and conventions they need.

## File layout

```
~/.parachute/
  .env                    # all configuration (API keys, providers, port)
  config.yaml             # global settings (port, default vault)
  start.sh                # daemon wrapper (sources .env)
  vault.log / vault.err   # daemon logs
  vaults/
    default/
      vault.db            # SQLite database
      vault.yaml          # vault config (description, tool_hints, api_keys)
    work/
      vault.db
      vault.yaml
```

## Auth

Each vault has its own API keys (SHA-256 hashed, stored in `vault.yaml`). Localhost bypasses auth. Remote requests need a key via `Authorization: Bearer pvk_...` or `X-API-Key: pvk_...`.

## Requirements

- [Bun](https://bun.sh) runtime
- macOS (launchd daemon) — server works anywhere, daemon is Mac-only

## License

AGPL-3.0
