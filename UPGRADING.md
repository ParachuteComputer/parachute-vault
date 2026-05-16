# Upgrading Parachute Vault

Operator-facing migration guidance. For the full chronological CHANGELOG,
see [CHANGELOG.md](./CHANGELOG.md).

## 0.2.4 → 0.4.5

If you installed Parachute Vault on launch week (2026-04-18 — 2026-04-23)
and haven't upgraded, you're on `0.2.4`. The current stable is `0.4.5`
(2026-05-15). That's ~4 weeks of substrate-grade maturation across three
phases:

- **Phase 1 — ecosystem-fit (0.3.6-rc.1 + rc.30–rc.39).** The load-bearing
  release. Vault stopped being a self-contained server and became a pure
  OAuth resource server inside the Parachute Computer ecosystem.
- **Phase 2 — maturation (0.4.1 — 0.4.3).** Tag schema inheritance, hub
  revocation enforcement, tag rename cascades, retired the unused
  `note_schemas` subsystem, indexed-metadata operator queries.
- **Phase 3 — substrate completion (0.4.4 — 0.4.5).** Hub-mint default,
  portable lossless export/import, upsert-on-update, non-markdown content
  as first-class, case-insensitive filesystem safety.

### TL;DR

- **The biggest single moment is Phase 1.** Three simultaneous renames
  (URL surface, CLI binary, filesystem) land in `0.3.6-rc.1`. Each is an
  active change you may need to make.
- Most other upgrades are automatic — schema migrations `v11 → v18` run
  idempotently on first boot.
- Substantive new capabilities you'll want to adopt: portable export,
  file extensions, upsert-on-update, indexed-metadata queries.

### Step-by-step

1. **Stop the daemon** before upgrading:

   ```
   parachute stop vault          # if you have the new dispatcher
   # or, on 0.2.4:
   parachute daemon stop
   ```
2. **Pull the new package**:

   ```
   npm install -g @openparachute/vault@latest
   ```
3. **Restart the daemon**:

   ```
   parachute-vault serve         # or: parachute start vault
   ```
4. **Verify the migration ran**. The boot log should show automatic moves
   for the filesystem restructure (move 1 + move 2 in 0.3.6-rc.1) plus
   schema bumps up through `v18`. `parachute-vault doctor` confirms the
   final schema version.
5. **Rewrite your MCP integration** (see Breaking Change #1 below) — the
   URL surface changed, so existing `~/.claude.json` entries point at
   dead routes.

Schema migrations are wrapped in `BEGIN IMMEDIATE` transactions —
crash-resistant, idempotent, no half-applied state. Each migration also
logs to the boot output so you can audit what ran.

### Breaking changes

These are the active-change moments you need to reckon with, in order of
likely impact.

#### 1. URL surface migrated `/vaults/<name>/...` → `/vault/<name>/...` (0.3.6-rc.1)

The single biggest upgrader-facing change in the entire arc. Every
vault-touching route moved from `/vaults/<name>/...` (plural) and the
unscoped `/api`, `/mcp`, `/oauth/*`, `/view/*` paths to `/vault/<name>/...`
(singular). The unified cross-vault MCP endpoint (which fanned tool calls
across vaults via a `vault` param) dropped — each MCP session pins to one
vault by URL. The `list-vaults` MCP tool retired alongside.

**Action required**, by client type:

- **Claude Code**: run `parachute-vault mcp-install` to rewrite
  `~/.claude.json`. The new install also picks up hub-mint auth and the
  `local` scope default — see Breaking Changes #5 and #6 below if you
  scripted prior installs.
- **OAuth clients** (Claude Desktop, Parachute Daily, custom integrations):
  remove the existing integration and add it back pointing at the new URL.
  OAuth clients have to re-handshake because the issuer URL changed.
- **`curl` scripts and bespoke clients**: rewrite hardcoded URLs.
  `/vaults/work/api/notes` → `/vault/work/api/notes`, etc.
- **Published note permalinks**: `/view/<id>` and `/vaults/<name>/view/<id>`
  both become `/vault/<name>/view/<id>`. Update anywhere those links are
  embedded.

Cross-vault endpoints (`GET /vaults`, `/vaults/list`, `/health`) are
unchanged. Tokens themselves keep working — only the addressing changes.

#### 2. CLI binary renamed `parachute` → `parachute-vault` (0.3.6-rc.1)

The `parachute` name was freed for the forthcoming `@openparachute/hub`
dispatcher. When the dispatcher is installed, it transparently forwards
`parachute vault <cmd>` to `parachute-vault <cmd>`; the vault CLI's own
arg-parser also accepts a leading `vault` prefix
(`parachute-vault vault init`), so existing launchd/systemd wrappers
continue working.

**Action**: update shell aliases, shebangs, CI scripts, and README
references. The canonical command an operator types becomes
`parachute-vault`. Wrappers using the `parachute vault <cmd>` form keep
working — but only with the dispatcher installed.

#### 3. Filesystem restructure to `~/.parachute/vault/data/...` (0.3.6-rc.1)

Two moves land in the same release. Move 1: vault state migrates from
flat `~/.parachute/` into `~/.parachute/vault/` (config, env, logs,
data, daemon scripts). Ecosystem root (`~/.parachute/`) now hosts
multiple sibling services. Move 2: per-vault data
`vault/vaults/<name>/` → `vault/data/<name>/` (avoids the doubled
"vault/vaults" path, matches Postgres/Redis convention); daemon logs
into `vault/logs/`.

**Action**: this is auto-migrating — idempotent, target-wins on
conflict, each move logged. Operator action only required if you have
backup scripts pointing at the old paths
(`~/.parachute/vaults/<name>/`, `~/.parachute/vault.log`, etc.). Update
them to the new shape.

#### 4. Scope enforcement is now real (0.3.6-rc.1, schema v12)

Pre-0.3.6, `parachute-vault tokens create --read` produced a token
documented as read-only but advisory at the boundary. Post-0.3.6, scopes
are enforced. Reads require `vault:read`, mutations `vault:write`,
`/.parachute/config` `vault:admin`. Inheritance: `admin ⊇ write ⊇ read`.
MCP `tools/list` returns only read tools for read-scoped tokens;
mutation `tools/call` returns 403 `insufficient_scope`.

**Action**: audit any caller using `--read` tokens to write — they
receive 403 now. Pre-v12 NULL-scope rows fall back to
`legacyPermissionToScopes(permission)` for one release with a
deprecation warning; new mints should write scopes explicitly.

#### 5. MCP install default scope: `user` → `local` (0.4.4-rc.3)

Scripted (non-interactive) `parachute-vault mcp-install` previously
defaulted to writing the global `~/.claude.json` entry (`user` scope).
The default now writes a directory-private `projects[<cwd>].mcpServers`
entry (`local` scope). Interactive walkthroughs (TTY) always prompt.

**Action**: scripted installs that want the old behavior add
`--install-scope user` explicitly. Interactive installs see a prompt;
operator selects. The `local` default prints a one-line consequence
callout so the change is visible.

#### 6. Hub-mint is the default install auth (0.4.4-rc.1)

`parachute-vault mcp-install` default flips from minting a vault-DB
`pvt_*` token to requesting a hub-issued JWT. `--mint` reads
`~/.parachute/operator.token` and POSTs to `<hub>/api/auth/mint-token`;
`--token <bearer>` accepts a paste; `--legacy-pat` falls back to `pvt_*`
with a deprecation notice.

**Action**: fresh installs need a configured hub origin
(`PARACHUTE_HUB_ORIGIN`) and a valid `~/.parachute/operator.token`. For
self-hosted-without-hub deployments, pass `--legacy-pat` explicitly.
Existing tokens of either shape keep working.

#### Other automatic-but-worth-noting changes

- **`update-note` requires `if_updated_at` or `force: true` (0.3.6-rc.1).**
  The optimistic-concurrency check is now mandatory. Callers omitting
  both receive MCP `InvalidParams` / REST 428 `precondition_required`.
  `query-notes` and `create-note` now return `updatedAt` so callers have
  the token to echo.
- **Tag rename returns 200 with cascade stats (vault#240/#247, in 0.4.2).**
  Used to return 409 `tag_in_use_by_tokens` when tokens scoped to the
  old name; now cascades through every surface (`tags`, sub-tags,
  `note_tags`, `parent_names`, `tokens.scoped_tags`,
  `indexed_fields.declarer_tags`, body refs, `_tags/<name>` paths) in
  one transaction. Callers expecting the 409 must adapt.
- **`note_schemas` + `schema_mappings` tables retired (vault#267, in 0.4.2,
  schema v17).** The standalone subsystem and six MCP tools
  (`list-note-schemas`, etc.) were dropped after audit revealed zero
  real-vault usage. `tags.fields` is the sole schema surface. The
  `synthesize-notes` MCP tool retired in the same release. **End-state
  MCP tool count: 9** (was 10 → 16 → 9 across the arc).
- **Path uniqueness widened `(path)` → `(path, extension)` (vault#328, in
  0.4.5).** Lets `Recipes/pasta.md` and `Recipes/pasta.csv` coexist.
  Wikilinks to ambiguous bare paths (`[[Recipes/pasta]]` when both
  exist) are refused; use the explicit form
  `[[Recipes/pasta.md]]` / `[[Recipes/pasta.csv]]`. Vaults that only
  contain `.md` notes see no behavior change — every row defaults
  `extension = "md"`.
- **Per-vault token binding (vault#257, in 0.3.6-rc.39, schema v16).**
  New `pvt_*` mints bind to the minting vault by default; cross-vault
  use returns 403. Pre-v16 NULL-bound tokens stay server-wide (legacy
  compat). Pass `--all` on `tokens create` to opt back in to server-wide
  with a warning.

### What you can now do

Ranked by impact for operators upgrading from 0.2.4. Each capability
shipped during the arc; adoption is opt-in unless otherwise noted.

- **Lossless portable export.** `parachute-vault export <dir>` writes
  git-tractable markdown (`.parachute/vault.yaml` + per-tag schemas +
  notes with frontmatter + attachment binaries). `parachute-vault
  import <dir>` is the lossless inverse. `--blow-away` wipes and replays
  for disaster recovery (confirm defaults NO). `--since <iso>` for
  incremental exports (git projections, SSG rebuilds). Round-trip is
  byte-identical on unchanged vault state (vault#308).
- **Non-markdown notes as first-class.** Pass `extension: "csv"` (or
  yaml/json/mdx/txt/etc.) on `create-note`. Frontmatter-compatible
  formats (md, mdx) carry metadata inline; the rest get a sidecar at
  `.parachute/notes-meta/<id>.yaml`. Filter by extension via
  `query-notes extension: ["csv", "yaml"]` or REST
  `?extension=csv&extension=yaml` (vault#328).
- **Upsert-on-update.** Pass `if_missing: "create"` on `update-note`
  (MCP) or `PATCH /notes/:id` (REST). Eliminates the query-then-create
  round trip on nightly syncs. Response carries `created: true|false`
  so sync loops branch without a follow-up query (vault#309).
- **Indexed metadata + operator-object queries.** Declare a tag field
  as indexed via `update-tag fields.<name>.indexed: true` — vault adds
  a generated column + B-tree index that's universal across all notes
  (not partitioned by tag). Then query with operators:
  `query-notes metadata: {priority: {gte: 3, lt: 10}, status: {in: ["open"]}}`.
  Full set: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`,
  `exists`. HTTP catches up with `?meta[field][op]=value` bracket-style
  in 0.4.3-rc.2. Also: `has_tags` / `has_links` presence filters,
  `order_by` on indexed fields, `dateFilter` recognizes `updated_at`
  for incremental rebuilds.
- **Tag schema inheritance.** Tags can declare `parent_names`; a
  child's effective fields = its own ∪ all ancestors'. `_default` is
  the implicit universal parent. First-in-walk-wins conflict resolution
  with advisory `schema_conflict` warnings (vault#270).
- **Atomic tag rename + merge.** `POST /api/tags/{name}/rename` rewrites
  the tag across `tags` + `note_tags` + every reference surface in one
  transaction; `POST /api/tags/merge` retags every note carrying any
  source onto the target. Retires the N+1 client-side PATCH stopgap.
- **Hub-minted auth with revocation enforcement.** Hub-issued JWTs are
  the canonical auth path. JWTs are revocation-checked every request
  with 60s caching, fail-open during hub outage, fail-closed only on
  cold start. Tag-scoped tokens narrow a single `pvt_*` to a root-tag
  allowlist (per-purpose bots slicing one vault rather than spinning up
  separate vaults).
- **Server-side transcription.** `POST /api/notes/{id}/attachments
  {transcribe: true}` queues audio for the scribe worker (set
  `SCRIBE_URL` env to enable). Vault becomes the canonical scribe
  context provider via `transcription.context` in `vault.yaml`. Audio
  retention is configurable per-vault (`"keep"`,
  `"until_transcribed"`, `"never"`).
- **Interactive `mcp-install`.** Bare `parachute-vault mcp-install`
  from a TTY walks through vault choice, install location, auth mode,
  and previews the exact JSON before any network call (vault#292).
- **Case-collision safety.** Exports probe filesystem case-sensitivity
  and auto-disambiguate colliding filenames on macOS APFS / Windows
  NTFS while keeping canonical paths in frontmatter (vault#327).
- **Empty notes are valid.** Skeleton notes, drafts-saved-before-
  content, organizing-only notes all create + round-trip cleanly
  (vault#323).
- **Lean response shape.** `update-note include_content: false` returns
  `NoteIndex` (drops `content`, keeps `byteSize`, `preview`,
  `validation_status`). Order-of-magnitude smaller responses on big
  notes. HTTP `validation_status` symmetric with MCP on create/update.
- **Per-vault admin SPA.** Vault detail, tokens, and permissions at
  `/vault/<name>/admin/` (reachable through hub's proxy with hub-issued
  JWT). Same compiled bundle at any per-vault mount.
- **`vault-info` projection.** Returns a comprehensive schema-bearing
  view (own + effective fields, indexed-field catalog, query hints).
  MCP `initialize` carries the markdown projection so agents see the
  schema landscape at session start.

### Where to learn more

- [CHANGELOG.md](./CHANGELOG.md) — chronological per-release notes.
- [parachute-patterns cookbook](https://github.com/ParachuteComputer/parachute-patterns)
  — recipes for portable export, schema inheritance, upsert sync,
  tag-scoped tokens.
- [parachute.computer/design](https://parachute.computer/design) —
  architecture references: module protocol, OAuth shape, hub-as-AS.

### Reporting issues

If your upgrade surfaces something not covered here, please file at
[ParachuteComputer/parachute-vault/issues](https://github.com/ParachuteComputer/parachute-vault/issues).
