# Parachute Vault

A self-hosted knowledge graph for AI agents. Notes, tags, links, and semantic search — exposed over MCP. Any AI gets a personal knowledge vault in one command.

## Quick start (Mac)

Requires [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`).

```bash
bun install -g github:ParachuteComputer/parachute-vault
parachute vault init
```

That's it. `vault init` creates a vault, starts a background daemon, and configures Claude Code's MCP automatically. It walks you through transcription and semantic search setup interactively.

## Quick start (Linux VPS)

Requires [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`).

```bash
git clone https://github.com/ParachuteComputer/parachute-vault
cd parachute-vault
bun install
bun src/cli.ts vault init    # interactive setup, installs systemd service
```

For remote access (Claude Desktop, mobile apps, etc.), set up a Cloudflare Tunnel — see below.

## Remote access via Cloudflare Tunnel

Your vault runs on `localhost:1940` by default. To access it from Claude Desktop, your phone, or anywhere else, you need a public HTTPS URL. [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) gives you one for free — no domain required, no port forwarding.

### Install cloudflared

```bash
# Mac
brew install cloudflared

# Linux (Debian/Ubuntu)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb

# Or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
```

### Quick tunnel (instant, temporary)

```bash
cloudflared tunnel --url http://localhost:1940
# → Your vault is at https://random-words.trycloudflare.com
```

Good for testing. URL changes each time you restart.

### Permanent tunnel (recommended for production)

```bash
# Authenticate with Cloudflare (free account required)
cloudflared tunnel login

# Create a named tunnel
cloudflared tunnel create vault

# Point your domain at the tunnel
cloudflared tunnel route dns vault vault.yourdomain.com

# Create the config file (required for background service)
sudo mkdir -p /etc/cloudflared
sudo tee /etc/cloudflared/config.yml << EOF
tunnel: $(cloudflared tunnel list -o json | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
credentials-file: $HOME/.cloudflared/$(cloudflared tunnel list -o json | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4).json

ingress:
  - hostname: vault.yourdomain.com
    service: http://localhost:1940
  - service: http_status:404
EOF

# Install as system service (runs in background, survives reboot)
sudo cloudflared service install
sudo systemctl start cloudflared
```

Or run in foreground for testing: `cloudflared tunnel run vault`

See [Cloudflare Tunnel docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/) for the full guide.

### Connect Claude Desktop

Once your tunnel is running:
- Settings → Integrations → Add MCP Server
- URL: `https://vault.yourdomain.com/mcp`
- Header: `Authorization: Bearer pvk_your-api-key`

## Docker deployment

For VPS hosting without installing Bun directly:

```bash
git clone https://github.com/ParachuteComputer/parachute-vault
cd parachute-vault
cp .env.example .env
# Edit .env with your config

# Option A: Caddy for HTTPS (need a domain pointed at this server)
echo "VAULT_DOMAIN=vault.yourdomain.com" >> .env
docker compose up -d

# Option B: Cloudflare Tunnel (no domain needed, recommended)
docker compose up -d vault   # just the vault, no Caddy
# Then set up cloudflared as above
```

### Cloud platforms

**Railway** ($5/mo) — Deploy from GitHub, auto-detects Dockerfile, persistent volume. One click.

**Fly.io** ($3-5/mo):
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

# Obsidian import/export (imports into an existing vault)
parachute vault import ~/Obsidian/MyVault              # import into default vault
parachute vault import ~/Obsidian/Work --vault work    # import into a specific vault
parachute vault import <path> --dry-run                # preview without importing
parachute vault export ./output                        # export default vault
parachute vault export ./output --vault work           # export a specific vault

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

`vault init` walks you through setup interactively. To change settings later:

```bash
# Transcription
parachute vault config set TRANSCRIBE_PROVIDER groq
parachute vault config set GROQ_API_KEY gsk_...

# Semantic search
parachute vault config set EMBEDDING_PROVIDER openai
parachute vault config set OPENAI_API_KEY sk-...

# Apply changes
parachute vault restart

# See all options
parachute vault config
```

### Providers

**Transcription** (voice → text, requires [parachute-scribe](https://github.com/ParachuteComputer/parachute-scribe)):

| Provider | Type | Platform | Notes |
|----------|------|----------|-------|
| `groq` | Cloud API | Any | Fast, cheap (~$0.06/hr of audio). |
| `whisper` | Local | Any | Uses faster-whisper. `pip install whisper-ctranslate2`. Free, private. |
| `parakeet-mlx` | Local | Mac only | Fastest local option. Apple Silicon required. |
| `openai` | Cloud API | Any | Reference Whisper API. |

**Cleanup** (LLM cleans up transcriptions — filler words, punctuation):

| Provider | Type | Notes |
|----------|------|-------|
| `claude` | Cloud API | Best quality. Needs `ANTHROPIC_API_KEY`. |
| `groq` | Cloud API | Fast. Reuses your `GROQ_API_KEY`. |
| `ollama` | Local | Free, private. Needs Ollama running. |

**Embeddings** (semantic search):

| Provider | Type | Notes |
|----------|------|-------|
| `openai` | Cloud API | `text-embedding-3-small`. Cheap (~$0.02/M tokens). |
| `ollama` | Local | `nomic-embed-text`. Free, private. Needs Ollama running. |

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

Import adds notes into an existing Parachute vault. Notes with paths that already exist are skipped (no duplicates). Wikilinks are resolved in a single pass after all notes are imported.

```bash
# Import into a new vault
parachute vault create research
parachute vault import ~/Obsidian/Research --vault research

# Or import into the default vault
parachute vault import ~/Obsidian/MyVault

# Preview first
parachute vault import ~/Obsidian/MyVault --dry-run

# Export back to Obsidian-compatible markdown
parachute vault export ./output --vault research
```

What gets imported: frontmatter → metadata, `#tags` → tags table, `[[wikilinks]]` → links table, file paths → note.path.

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

- [Bun](https://bun.sh) runtime — `curl -fsSL https://bun.sh/install | bash`
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) — for remote HTTPS access (optional)
- [Docker](https://docs.docker.com/get-docker/) — for containerized deployment (alternative to Bun)
- macOS (launchd) or Linux (systemd) for background daemon

## License

AGPL-3.0
