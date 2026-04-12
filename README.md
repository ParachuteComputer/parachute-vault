# Parachute Vault

A self-hosted knowledge graph for AI agents. Notes, tags, links, and semantic search — exposed over MCP. Any AI gets a personal knowledge vault in one command.

## Quick start

Requires [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`).

```bash
git clone https://github.com/ParachuteComputer/parachute-vault
cd parachute-vault
bun install
bun src/cli.ts vault init
```

`vault init` creates a vault, starts a background daemon (launchd on Mac, systemd on Linux), and configures Claude Code's MCP. It walks you through semantic search setup interactively.

For remote access from Claude Desktop or mobile apps, see [Deployment](#deployment) below.

## What you get

A server on port 1940 with:

- **MCP** — 20 tools for AI agents (notes, search, tags, links, graph traversal, semantic search)
- **REST API** — Full CRUD for notes, tags, links, full-text search
- **Wikilink auto-linking** — `[[wikilinks]]` in note content automatically create links in the graph
- **Semantic search** — Vector embeddings via sqlite-vec (configure an embedding provider)
- **Obsidian import/export** — Bidirectional interop with Obsidian vaults
- **Webhook triggers** — Config-driven webhooks that fire on note mutations matching tag/metadata predicates
- **View endpoint** — Serve notes as clean HTML pages (public or authenticated)

Each vault is its own SQLite database. Run multiple vaults on one server.

## CLI

```bash
# Setup
parachute vault init                       # one-command setup
parachute vault status                     # check what's running

# Vaults
parachute vault create work                # create a new vault
parachute vault list                       # list all vaults
parachute vault remove work --yes          # delete a vault

# Obsidian
parachute vault import ~/Obsidian/MyVault              # import into default vault
parachute vault import ~/Obsidian/Work --vault work    # import into a specific vault
parachute vault import <path> --dry-run                # preview without importing
parachute vault export ./output --vault work           # export a specific vault

# Config
parachute vault config                     # show all options
parachute vault config set KEY value       # set a config value
parachute vault restart                    # apply changes
```

## Configuration

All config lives in `~/.parachute/.env`. `vault init` walks you through setup. To change later:

```bash
parachute vault config set EMBEDDING_PROVIDER openai
parachute vault config set OPENAI_API_KEY sk-...
parachute vault restart
```

### Providers

**Embeddings** (semantic search):

| Provider | Type | Notes |
|----------|------|-------|
| `openai` | Cloud | `text-embedding-3-small`. Cheap (~$0.02/M tokens) |
| `ollama` | Local | `nomic-embed-text`. Requires Ollama running |

## MCP tools

**Notes**: `get-note`, `create-note`, `update-note`, `delete-note`, `read-notes`, `search-notes`
**Tags**: `tag-note`, `untag-note`, `list-tags`
**Links**: `create-link`, `delete-link`, `get-links`
**Bulk**: `create-notes`, `batch-tag`, `batch-untag`
**Graph**: `traverse-links`, `find-path`
**Vault**: `list-vaults`, `get-vault-description`, `update-vault-description`, `get-vault-stats`
**Semantic** (when configured): `semantic-search`, `embed-notes`

### Vault descriptions

Each vault teaches AI agents how to use it:

```yaml
# ~/.parachute/vaults/default/vault.yaml
name: default
description: |
  Personal knowledge vault. Tags in use: daily, voice, reader, project.
  Use lowercase tags. Tag every note. Read before writing to avoid duplicates.
```

Sent as the MCP server instruction at session start.

## Features

### Wikilink auto-linking

`[[wikilinks]]` in note content automatically create links in the graph. Supports aliases (`[[Name|display]]`), anchors (`[[Note#Section]]`), and embeds (`![[Image]]`). Unresolved links auto-resolve when the target note is created later.

### Semantic search

With an embedding provider configured, `semantic-search` finds conceptually related notes even without exact keyword matches. Supports tag and date filters.

### Obsidian import/export

```bash
parachute vault create research
parachute vault import ~/Obsidian/Research --vault research
parachute vault export ./output --vault research
```

Imports: frontmatter → metadata, `#tags` → tags table, `[[wikilinks]]` → links table, file paths → note.path. Skips duplicates.

### Path conventions

Note paths work like Obsidian file paths (`Projects/Parachute/README`). Normalized, unique, case-insensitive resolution. Renaming a note's path updates `[[wikilinks]]` in other notes.

### Webhook triggers

Declarative config-driven webhooks that fire when a note mutation matches a predicate. Configured in `~/.parachute/config.yaml`:

```yaml
triggers:
  - name: tts_reader
    events: [created, updated]
    when:
      tags: [reader]
      has_content: true
      missing_metadata: [audio_rendered_at]
    action:
      webhook: http://localhost:8090/tts
      timeout: 120000
```

**Predicate fields**: `tags` (all must match), `has_content` (true/false), `missing_metadata` (keys that must be absent), `has_metadata` (keys that must be present).

**Two-phase markers**: On match, the trigger sets `<name>_pending_at` metadata before calling the webhook, then replaces it with `<name>_rendered_at` on success. This prevents re-entry and concurrent runs.

**Webhook contract**: POST `{ trigger, event, note: { id, content, path, tags, metadata, attachments } }`. Response: `{ content?, metadata?, attachments?, skipped_reason? }`.

### View endpoint

Serve notes as clean HTML pages at `/view/:noteId`:

- **Without auth**: only serves notes tagged `published` (or with `metadata.published: true`). Returns 404 for unpublished notes.
- **With auth**: serves any note. Pass API key via `Authorization: Bearer pvk_...` header or `?key=pvk_...` query param.
- **Custom tag**: set `published_tag` in vault.yaml to use a different tag name (default: `published`).

```yaml
# ~/.parachute/vaults/default/vault.yaml
published_tag: public
```

## REST API

```
GET/POST       /api/notes              query or create notes
GET/PATCH/DEL  /api/notes/:id          read, update, delete
POST/DEL       /api/notes/:id/tags     tag/untag
GET            /api/tags               list tags
DELETE         /api/tags/:name         delete a tag from all notes
POST/DEL       /api/links              create/delete links
GET            /api/search?q=...       full-text search
GET            /api/resolve-wikilink?title=...  resolve a wikilink title to note
GET            /api/unresolved-wikilinks        list unresolved wikilinks
POST           /api/ingest             upload file + create note
GET            /api/graph              full knowledge graph
POST           /mcp                    MCP endpoint
GET            /view/:noteId           render note as HTML (public or auth)
GET            /health                 health check
```

Per-vault routes at `/vaults/{name}/api/...`, `/vaults/{name}/mcp`, and `/vaults/{name}/view/:noteId`.

## Data model

```
notes       (id, content, path, metadata, created_at, updated_at)
tags        (name)
note_tags   (note_id, tag_name)
links       (source_id, target_id, relationship, metadata, created_at)
attachments (id, note_id, path, mime_type, metadata, created_at)
```

Metadata is a JSON column. Vaults start blank — no predefined tags or schema.

## Auth

API keys per vault (SHA-256 hashed). Localhost bypasses auth. Remote requests need `Authorization: Bearer pvk_...` or `X-API-Key: pvk_...`.

## Deployment

### Remote access via Cloudflare Tunnel (free)

Your vault needs a public HTTPS URL for Claude Desktop and mobile apps. [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) provides one for free.

```bash
# Install: Mac
brew install cloudflared
# Install: Linux
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb && sudo dpkg -i cloudflared.deb

# Quick tunnel (temporary, for testing)
cloudflared tunnel --url http://localhost:1940

# Permanent tunnel (production)
cloudflared tunnel login
cloudflared tunnel create vault
cloudflared tunnel route dns vault vault.yourdomain.com

# Write config (required for background service)
sudo mkdir -p /etc/cloudflared
sudo tee /etc/cloudflared/config.yml << EOF
tunnel: $(cloudflared tunnel list -o json | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
credentials-file: $HOME/.cloudflared/$(cloudflared tunnel list -o json | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4).json

ingress:
  - hostname: vault.yourdomain.com
    service: http://localhost:1940
  - service: http_status:404
EOF

# Run as background service
sudo cloudflared service install
sudo systemctl start cloudflared
```

Then in Claude Desktop: Settings → Integrations → Add MCP → `https://vault.yourdomain.com/mcp` with `Authorization: Bearer pvk_...`.

### Docker

```bash
cp .env.example .env   # edit with your config
docker compose up -d
```

### Cloud platforms

**Railway** ($5/mo) — Deploy from GitHub, persistent volume, public URL.
**Fly.io** ($3-5/mo) — `fly launch --copy-config && fly volumes create vault_data --size 1 && fly deploy`

## Requirements

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- macOS (launchd) or Linux (systemd) for background daemon
- [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) for remote access (optional)

## License

AGPL-3.0
