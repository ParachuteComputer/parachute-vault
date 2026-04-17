# Parachute Vault

A self-hosted knowledge graph for AI agents. Notes, tags, links — exposed over MCP. Any AI gets a personal knowledge vault in one command.

## Quick start

Requires [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`).

```bash
# Install globally (registers the `parachute` CLI)
bun add -g @openparachute/vault
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

# Tokens
parachute vault tokens                     # list all tokens
parachute vault tokens create --vault work                    # new full-access token
parachute vault tokens create --vault work --read             # read-only token
parachute vault tokens create --vault work --expires 30d      # token with expiry
parachute vault tokens create --vault work --label mobile     # labeled token
parachute vault tokens revoke <token-id> --vault work         # revoke a token

# Config
parachute vault config                     # show all options
parachute vault config set KEY value       # set a config value
parachute vault restart                    # apply changes

# Backup
parachute vault backup                         # one-shot backup to configured destinations
parachute vault backup --schedule daily        # hourly | daily | weekly | manual (macOS)
parachute vault backup status                  # schedule, last run, destinations, next run
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

### Backing up your vault

Your vault is just SQLite DBs + a handful of YAML files under `~/.parachute/`. `parachute vault backup` snapshots everything into a single timestamped tarball, for a one-shot or a scheduled run.

```bash
parachute vault backup                         # one-shot — snapshot + ship to destinations
parachute vault backup --schedule daily        # register a launchd agent (macOS)
parachute vault backup --schedule manual       # stop scheduled backups
parachute vault backup status                  # schedule, last run, destinations, next run
```

Configure destinations in `~/.parachute/config.yaml`:

```yaml
backup:
  schedule: daily       # hourly | daily | weekly | manual
  retention:
    daily: 7            # last 7 daily snapshots
    weekly: 4           # last-of-week for 4 weeks
    monthly: 12         # last-of-month for 12 months
    yearly: null        # last-of-year, unbounded (null = keep every year forever)
  destinations:
    - kind: local
      path: ~/Library/Mobile Documents/com~apple~CloudDocs/parachute-backups
```

**Retention is tiered** (grandfather / father / son). After each run, the pruner keeps the union of four tiers:

| Tier    | What it keeps                                          |
|---------|--------------------------------------------------------|
| daily   | The N most recent snapshots.                           |
| weekly  | The last snapshot of each of the last N ISO weeks.     |
| monthly | The last snapshot of each of the last N calendar months.|
| yearly  | The last snapshot of each year — `null` means unbounded.|

A snapshot that qualifies for multiple tiers is kept once. Set any tier to `0` to disable it; sparse data (days without a backup) just means some tiers contribute nothing that day. Bucketing uses your local timezone, so calendars line up with what you see, not UTC.

**What's in a snapshot**: atomic `VACUUM INTO` copies of every `vaults/<name>/vault.db`, your `config.yaml`, and each vault's `vault.yaml`, bundled as `parachute-backup-<timestamp>.tar.gz`. Safe under concurrent reads/writes — no need to stop the daemon.

**Restore**: extract the tarball into a fresh `~/.parachute/` and run `parachute vault init` to re-register the daemon. The DBs and configs drop in place; you don't need any special restore command (for now — a dedicated `vault restore` is coming soon).

Destination kinds shipping in this release: `local` (any filesystem path — including iCloud Drive, a mounted external disk, or an rsync/Syncthing-backed folder). `s3`, `rsync`, and `cloud` destinations are planned but not yet implemented.

On Linux, scheduled runs via systemd timers are a follow-up; for now `parachute vault backup` works on Linux but you'll need to wire the cron yourself.

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
GET/POST       /api/notes                         query or create notes
GET/PATCH/DEL  /api/notes/:idOrPath                read, update, delete a single note
GET/POST       /api/notes/:id/attachments          list or add attachments
GET            /api/tags                           list tags (?include_schema=true for schemas)
GET/PUT/DEL    /api/tags/:name                     get, update, or delete a tag
GET            /api/find-path?source=...&target=...  shortest path between two notes
GET/PATCH      /api/vault                          vault info (get or update description)
POST           /api/storage/upload                 upload file (audio/image)
GET            /api/storage/:path                  download file
POST           /mcp                                MCP endpoint (unified, all vaults)
GET            /view/:idOrPath                     render note as HTML (public or auth)
GET            /health                             health check
```

Per-vault routes at `/vaults/{name}/api/...`, `/vaults/{name}/mcp`, and `/vaults/{name}/view/:idOrPath`.

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

Both legacy API keys (`pvk_...`) and scoped tokens (`pvt_...`) work interchangeably:

```bash
# Header (preferred)
curl -H "Authorization: Bearer pvt_..." http://localhost:1940/api/notes

# Alternative header
curl -H "X-API-Key: pvt_..." http://localhost:1940/api/notes

# Query param (for /view endpoint only — convenient for browsers)
curl http://localhost:1940/view/noteId?key=pvt_...
```

### Claude Desktop

Settings → Integrations → Add MCP → URL: `https://vault.yourdomain.com/mcp`, Header: `Authorization: Bearer pvk_...`

### Claude Code

`vault init` auto-configures `~/.claude.json`. To set manually, use the vault-scoped endpoint — `{name}` is the vault to target (`default` on a fresh install, whatever you passed to `vault create` otherwise):

```json
{
  "mcpServers": {
    "parachute-vault": {
      "type": "http",
      "url": "http://127.0.0.1:1940/vaults/{name}/mcp",
      "headers": { "Authorization": "Bearer pvk_..." }
    }
  }
}
```

### Token management

Per-vault tokens with two permission levels:

| Permission | Can do |
|---|---|
| `full` | Everything (CRUD + delete + token management) |
| `read` | Query, list, find-path, vault-info only |

```bash
parachute vault tokens                                        # list all tokens
parachute vault tokens create --vault work                    # full-access token
parachute vault tokens create --vault work --read             # read-only
parachute vault tokens create --vault work --expires 30d      # with expiry
parachute vault tokens create --vault work --label phone      # labeled token
parachute vault tokens revoke <token-id> --vault work         # revoke
```

Tokens are shown once at creation — save them immediately. SHA-256 hashed at rest.

Legacy API keys (`pvk_...`) from config.yaml still work at runtime but the `vault keys` CLI commands have been removed. Use `vault tokens` for all new keys.

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
