# Parachute Vault

A self-hosted knowledge graph for AI agents. Notes, tags, links — exposed over MCP. Any AI gets a personal knowledge vault in one command.

## Quick start

Requires [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`).

```bash
# Install globally (registers the `parachute` CLI)
bun add -g github:ParachuteComputer/parachute-vault
parachute vault init

# Or clone and run directly
git clone https://github.com/ParachuteComputer/parachute-vault
cd parachute-vault
bun install
bun src/cli.ts vault init
```

`vault init` creates a vault, generates an API key, starts a background daemon (launchd on Mac, systemd on Linux), and configures Claude Code's MCP — all in one command. Your API key is printed once at init; save it for connecting from other tools.

For remote access from Claude Desktop or mobile apps, see [Deployment](#deployment) below.

## What you get

A server on port 1940 with:

- **MCP** — 9 tools for AI agents (notes, tags, graph, vault info)
- **REST API** — Full CRUD for notes, tags, links, full-text search
- **Wikilink auto-linking** — `[[wikilinks]]` in note content automatically create links in the graph
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

# API keys
parachute vault keys                       # list all keys
parachute vault keys create                # new global key (all vaults)
parachute vault keys create --vault work   # new key for one vault
parachute vault keys create --read-only    # read-only key
parachute vault keys create --label mobile # label for identification
parachute vault keys revoke <key-id>       # revoke a key by ID

# Config
parachute vault config                     # show all options
parachute vault config set KEY value       # set a config value
parachute vault restart                    # apply changes
```

## MCP tools (9)

**Notes**: `query-notes` (universal read — single by ID/path, filter, search, graph neighborhood), `create-note` (single or batch), `update-note` (single or batch — content, tags, links, metadata), `delete-note`
**Tags**: `list-tags` (with optional schema detail), `update-tag` (upsert description + schema fields), `delete-tag`
**Graph**: `find-path` (BFS between two notes)
**Vault**: `vault-info` (get/update description + stats)

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
  - name: scribe
    events: [created, updated]
    when:
      tags: [voice]
      has_content: false
      missing_metadata: [transcribed_at]
    action:
      webhook: http://localhost:3200/v1/audio/transcriptions
      send: attachment
      timeout: 120000

  - name: narrate
    events: [created, updated]
    when:
      tags: [reader]
      has_content: true
      missing_metadata: [audio_rendered_at]
    action:
      webhook: http://localhost:3100/v1/audio/speech
      send: content
```

**Predicate fields**: `tags` (all must match), `has_content` (true/false), `missing_metadata` (keys that must be absent), `has_metadata` (keys that must be present).

**Two-phase markers**: On match, the trigger sets `<name>_pending_at` metadata before calling the webhook, then replaces it with `<name>_rendered_at` on success. This prevents re-entry and concurrent runs.

#### Send modes

| Mode | Request format | Response format | Use case |
|---|---|---|---|
| `json` (default) | POST `{ trigger, event, note }` as JSON | `{ content?, metadata?, attachments?, skipped_reason? }` | General-purpose webhooks |
| `attachment` | POST first audio attachment as multipart/form-data (Whisper API format) | `{ text }` — written to note.content | Transcription (e.g., scribe on :3200) |
| `content` | POST `{ input: note.content, model, voice }` as JSON (OpenAI TTS format) | Binary audio — saved as attachment | Text-to-speech (e.g., narrate on :3100) |

**Example flow — voice note transcription:**
1. Daily app uploads audio via `POST /api/storage/upload`, creates note tagged `voice` with no content
2. Trigger `scribe` matches (tag=voice, has_content=false, missing transcribed_at)
3. Vault reads the audio file from its assets dir, POSTs it to scribe as multipart/form-data
4. Scribe returns `{ text: "transcribed text..." }`
5. Vault writes text to note.content and sets `scribe_rendered_at` metadata

**Example flow — text-to-speech:**
1. A note tagged `reader` is created with text content
2. Trigger `narrate` matches (tag=reader, has_content=true, missing audio_rendered_at)
3. Vault POSTs `{ input: note.content }` to narrate
4. Narrate returns audio bytes
5. Vault saves the audio as an attachment and sets `narrate_rendered_at` metadata

Webhook servers (scribe, narrate) are stateless — they don't need vault's API key.

### View endpoint

Serve notes as clean HTML pages at `/view/:noteId`:

- **Without auth**: only serves notes tagged `published` (or with `metadata.published: true`). Returns 404 for unpublished notes.
- **With auth**: serves any note. Pass API key via `Authorization: Bearer pvk_...` header or `?key=pvk_...` query param.
- **Custom tag**: set `published_tag` in vault.yaml to use a different tag name (default: `publish`).

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
POST           /api/storage/upload     upload file (audio/image)
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

**All API and MCP requests require a valid API key.** No exceptions — localhost gets no special treatment.

`vault init` generates an API key automatically and configures Claude Code's MCP with it.

### Passing the key

```bash
# Header (preferred)
curl -H "Authorization: Bearer pvk_..." http://localhost:1940/api/notes

# Alternative header
curl -H "X-API-Key: pvk_..." http://localhost:1940/api/notes

# Query param (for /view endpoint only — convenient for browsers)
curl http://localhost:1940/view/noteId?key=pvk_...
```

### Claude Desktop

Settings → Integrations → Add MCP → URL: `https://vault.yourdomain.com/mcp`, Header: `Authorization: Bearer pvk_...`

### Claude Code

`vault init` auto-configures `~/.claude.json`. To set manually:

```json
{
  "mcpServers": {
    "parachute-vault": {
      "type": "http",
      "url": "http://127.0.0.1:1940/mcp",
      "headers": { "Authorization": "Bearer pvk_..." }
    }
  }
}
```

### Key management

```bash
parachute vault keys                       # list all keys (shows ID, label, scope, last used)
parachute vault keys create                # new global key
parachute vault keys create --vault work   # new per-vault key
parachute vault keys create --read-only    # read-only key (GET only, no mutations)
parachute vault keys create --label phone  # custom label for identification
parachute vault keys revoke <key-id>       # revoke by ID (shown in `keys` output)
```

Keys are shown once at creation — save them immediately. Keys are SHA-256 hashed at rest and cannot be recovered.

**Per-vault keys** (stored in `vault.yaml`) grant access to one vault's API and `/vaults/{name}/mcp` endpoint. Use for single-purpose integrations (e.g., a mobile app that only writes to one vault).

**Global keys** (stored in `config.yaml`) grant access to all vaults and the unified `/mcp` endpoint. Use for AI agents that work across vaults or for admin access. `vault init` creates a global key automatically.

### Public endpoints

Only two endpoints work without auth:
- `GET /health` — returns `{ status: "ok" }` (no sensitive data)
- `GET /view/:noteId` — serves published notes only (returns 404 for unpublished)

## Network security

Vault runs HTTP on localhost. This is intentional — TLS is handled by the access layer. **Never expose port 1940 directly to the internet without TLS.**

All API and MCP requests require an API key. There is no localhost bypass.

For remote access, always use a TLS-terminating proxy:

| Access path | API key security | Safe? |
|---|---|---|
| localhost (same machine) | Never leaves machine | Yes |
| Tailnet (Tailscale VPN) | WireGuard encrypted | Yes |
| Tailscale Funnel (public HTTPS) | HTTPS at edge, WireGuard to machine | Yes |
| Cloudflare Tunnel (public HTTPS) | HTTPS at edge, local socket to machine | Yes |
| Direct LAN IP (no TLS) | Plaintext on WiFi | Avoid |
| Direct internet (no TLS) | Plaintext on internet | Never do this |

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
