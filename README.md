# Parachute Vault

A self-hosted knowledge graph for AI agents. Notes, tags, links, and semantic search — exposed over MCP. Any AI gets a personal knowledge vault in one command.

## Quick start (Mac)

```bash
bun install -g github:ParachuteComputer/parachute-vault
parachute vault init
```

That's it. `vault init` creates a vault, starts a background daemon, and configures Claude Code's MCP automatically. Your AI can now read and write to the vault.

## Remote access (Claude Desktop, mobile apps)

Your vault runs on `localhost:1940` by default. To access it from Claude Desktop, your phone, or anywhere else, you need a public HTTPS URL. The simplest way:

### Cloudflare Tunnel (recommended, free)

```bash
# Install cloudflared
brew install cloudflared

# Expose your vault (instant, temporary URL)
cloudflared tunnel --url http://localhost:1940
# → https://random-words.trycloudflare.com

# For a permanent URL, set up a named tunnel:
cloudflared tunnel login
cloudflared tunnel create vault
cloudflared tunnel route dns vault vault.yourdomain.com
cloudflared tunnel --url http://localhost:1940 run vault
```

Then configure Claude Desktop:
- Settings → Integrations → Add MCP Server
- URL: `https://vault.yourdomain.com/mcp`
- Header: `Authorization: Bearer pvk_your-api-key`

## Self-hosting on a VPS

For an always-on vault without relying on your Mac, deploy to a VPS:

### Docker (Hetzner, DigitalOcean, any VPS)

```bash
git clone https://github.com/ParachuteComputer/parachute-vault
cd parachute-vault
cp .env.example .env
# Edit .env with your config

# Option A: Caddy for HTTPS (need a domain pointed at this server)
echo "VAULT_DOMAIN=vault.yourdomain.com" >> .env
docker compose up -d

# Option B: Cloudflare Tunnel (no domain needed)
docker compose up -d vault   # just the vault, no Caddy
cloudflared tunnel --url http://localhost:1940
```

### Railway (one-click, $5/mo)

Deploy from GitHub — Railway auto-detects the Dockerfile, adds a persistent volume. Get a public URL instantly.

### Fly.io ($3-5/mo)

```bash
fly launch --copy-config
fly volumes create vault_data --size 1
fly deploy
```

## What you get

A server on port 1940 with:

- **MCP** — 20 tools for AI agents (notes, search, tags, links, graph traversal, semantic search)
- **REST API** — Full CRUD for notes, tags, links, full-text search
- **Wikilink auto-linking** — `[[wikilinks]]` in note content are automatically parsed and linked
- **Semantic search** — Vector embeddings via sqlite-vec (configure an embedding provider)
- **Obsidian import/export** — Bidirectional interop with Obsidian vaults
- **Transcription** — Whisper-compatible endpoint (with [parachute-scribe](https://github.com/ParachuteComputer/parachute-scribe))

Each vault is its own SQLite database. Run multiple vaults on one server.

## CLI

```bash
# Setup
parachute vault init                       # one-command setup (Mac)
parachute vault status                     # check what's running

# Vaults
parachute vault create work                # create a new vault
parachute vault list                       # list all vaults
parachute vault remove work --yes          # delete a vault

# Obsidian
parachute vault import ~/Obsidian/MyVault  # import an Obsidian vault
parachute vault export ./output            # export as Obsidian markdown
parachute vault import <path> --dry-run    # preview import

# Config
parachute vault config                     # show current configuration
parachute vault config set KEY value       # set a config value
parachute vault config unset KEY           # remove a config value

# Keys
parachute vault keys                       # list API keys
parachute vault keys create                # create a key
parachute vault keys create --vault work   # per-vault key
parachute vault keys revoke <id>           # revoke a key

# Server
parachute vault serve                      # run in foreground
parachute vault restart                    # restart daemon
```

## Configuration

All config lives in `~/.parachute/.env` (or `$PARACHUTE_HOME/.env` in Docker). Manage with `vault config` or edit directly.

```bash
# Transcription
parachute vault config set TRANSCRIBE_PROVIDER groq
parachute vault config set GROQ_API_KEY gsk_...

# Semantic search
parachute vault config set EMBEDDING_PROVIDER openai
parachute vault config set EMBEDDING_MODEL text-embedding-3-small
parachute vault config set OPENAI_API_KEY sk-...

parachute vault restart
```

### Providers

| Feature | Provider | Type | Notes |
|---------|----------|------|-------|
| Transcription | `parakeet-mlx` | Local | Mac only (Apple Silicon). Fastest. |
| Transcription | `groq` | API | Fast and cheap. Needs `GROQ_API_KEY`. |
| Transcription | `openai` | API | Reference Whisper API. Needs `OPENAI_API_KEY`. |
| Cleanup | `claude` | API | Post-transcription cleanup. Needs `ANTHROPIC_API_KEY`. |
| Cleanup | `ollama` | Local | Needs Ollama running. |
| Embeddings | `openai` | API | `text-embedding-3-small` (default). Needs `OPENAI_API_KEY`. |
| Embeddings | `ollama` | Local | `nomic-embed-text` (default). Needs Ollama. |

## MCP tools

When an AI connects, it gets these tools:

**Notes**: `get-note`, `create-note`, `update-note`, `delete-note`, `read-notes`, `search-notes`

**Tags**: `tag-note`, `untag-note`, `list-tags`

**Links**: `create-link`, `delete-link`, `get-links`

**Bulk**: `create-notes`, `batch-tag`, `batch-untag`

**Graph**: `traverse-links`, `find-path`

**Vault**: `list-vaults`, `get-vault-description`, `update-vault-description`

**Semantic** (when configured): `semantic-search`, `embed-notes`

### Vault descriptions

Each vault can teach AI agents how to use it. Set via MCP tool or edit `vault.yaml`:

```yaml
name: default
description: |
  Personal knowledge vault. Tags in use: daily, voice, reader, project.
  Use lowercase tags. Tag every note. Read before writing to avoid duplicates.
```

The description is sent as the MCP server instruction at session start.

## Features

### Wikilink auto-linking

Notes with `[[wikilinks]]` automatically create links in the graph:

```markdown
Meeting about [[Project Alpha]] — see [[2026-04-01 Notes]] for context.
```

This creates `wikilink` relationships to "Project Alpha" and "2026-04-01 Notes" (matched by path). Supports aliases (`[[Real Name|display]]`), anchors (`[[Note#Section]]`), and embeds (`![[Image]]`). Unresolved links are tracked and auto-resolved when the target note is created later.

### Semantic search

With an embedding provider configured, `semantic-search` finds conceptually related notes even without exact keyword matches. Supports tag and date filters — search "over just my reader notes" or "voice memos from last week."

### Obsidian import/export

```bash
# Import: frontmatter → metadata, #tags → tags, [[links]] → graph, paths preserved
parachute vault import ~/Obsidian/MyVault

# Export: metadata → frontmatter, tags → frontmatter, paths → file structure
parachute vault export ./output
```

### Path conventions

Note paths work like Obsidian file paths (`Projects/Parachute/README`). Paths are:
- Normalized (trimmed, `.md` stripped, slashes collapsed)
- Unique (enforced at DB level)
- Used for wikilink resolution (case-insensitive)
- Cascading renames (changing a path updates `[[wikilinks]]` in other notes)

## REST API

```
GET    /api/notes                     # query notes (?tag=daily&tag_match=any)
POST   /api/notes                     # create note
GET    /api/notes/:id                 # get note
PATCH  /api/notes/:id                 # update note
DELETE /api/notes/:id                 # delete note
POST   /api/notes/:id/tags           # tag note
DELETE /api/notes/:id/tags           # untag note
GET    /api/tags                      # list tags
POST   /api/links                     # create link
DELETE /api/links                     # delete link
GET    /api/search?q=...              # full-text search
POST   /api/ingest                    # upload audio + create note
POST   /api/storage/upload            # upload file

POST   /mcp                           # MCP endpoint (all vaults)
*      /vaults/{name}/mcp            # per-vault MCP
GET    /health                        # health check
```

Per-vault routes also available at `/vaults/{name}/api/...`.

## Data model

```
notes       (id, content, path, metadata, created_at, updated_at)
tags        (name)
note_tags   (note_id, tag_name)
links       (source_id, target_id, relationship, metadata, created_at)
attachments (id, note_id, path, mime_type, metadata, created_at)
```

Metadata is a JSON column — queryable via `json_extract()`. Vaults start blank — no predefined tags or schema.

## Auth

API keys per vault (SHA-256 hashed, stored in `vault.yaml`). Localhost bypasses auth. Remote requests need `Authorization: Bearer pvk_...` or `X-API-Key: pvk_...`.

## Requirements

- [Bun](https://bun.sh) runtime (for local install)
- Docker (for VPS deployment)
- macOS for launchd daemon (server runs on any platform)

## License

AGPL-3.0
