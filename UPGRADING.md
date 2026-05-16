# Upgrading Parachute Vault

Operator-facing migration guidance. For the full chronological CHANGELOG,
see [CHANGELOG.md](./CHANGELOG.md).

## 0.2.4 → 0.4.5

If you installed Parachute Vault on launch (`v0.2.4`, 2026-04-18) and
haven't upgraded, the current stable is `0.4.5` (2026-05-15). That's
~4 weeks of substrate-grade maturation across three phases:

- **Phase 1 — launch & ecosystem-fit (2026-04-18 → 2026-05-05).** The
  load-bearing phase. Across ~16 days and ~29 PRs, vault stopped being
  a self-contained server and became a pure OAuth resource server
  inside the Parachute Computer ecosystem. The CHANGELOG narrates this
  phase as "0.3.6-rc.1" but most of the work landed silently across
  `rc.2 — rc.29`.
- **Phase 2 — maturation (0.4.1 — 0.4.3).** Tag schema inheritance,
  hub revocation enforcement, tag rename cascades, retired the unused
  `note_schemas` subsystem and `synthesize-notes` tool, indexed-metadata
  operator queries.
- **Phase 3 — substrate completion (0.4.4 — 0.4.5).** Hub-mint default,
  portable lossless export/import, upsert-on-update, non-markdown
  content as first-class, case-insensitive filesystem safety.

The CHANGELOG version markers between `0.3.6-rc.1` and `0.3.6-rc.30` are
silently absent — 28 RCs across eight days during which 13 PRs landed,
none in any version entry. The primary-sourced audit at
[parachute.computer/preview/vault-0.4.5-arc/](https://parachute.computer/preview/vault-0.4.5-arc/)
has the comprehensive record. This UPGRADING.md is the
operator-actionable distillation.

### TL;DR

- **Biggest moment is Phase 1** — three simultaneous renames (URL,
  CLI, filesystem) landed in early-launch. Each is an active change
  you need to make.
- **Two reversed-mid-arc items**: empty-note rejection (`vault#213`,
  later reversed by `vault#323`) and `_tags/*` / `_schemas/*`
  notes-as-config (shipped, migrated to tables, partially retired).
  Net is documented below — most upgraders won't notice.
- **One under-reported security fix**: `vault#233` corrected a
  privilege-escalation in the global `config.yaml` parser. Upgrade
  is the fix.
- Schema migrations `v9 → v18` run idempotently on first boot.
- Substantive new capabilities you'll want to adopt: portable export,
  file extensions, upsert-on-update, indexed-metadata queries.

### Step-by-step

1. **Stop the daemon** before upgrading:

   ```
   parachute stop vault          # if you have the new dispatcher
   # or, on 0.2.4:
   parachute daemon stop
   ```

   If neither command is recognized (some 0.2.4 sub-versions only had
   `parachute serve` as the foreground run surface), kill the process
   directly — `pkill -f parachute` or `launchctl bootout` the launchd
   label.
2. **Pull the new package**:

   ```
   npm install -g @openparachute/vault@latest
   ```
3. **Restart the daemon**:

   ```
   parachute-vault serve         # or: parachute start vault
   ```
4. **Verify the migration ran**. The boot log shows automatic moves
   for the filesystem restructure (move 1 + move 2 in early Phase 1)
   and schema bumps `v9 → v18`. `parachute-vault status` reports
   running version + state.
5. **Rewrite your MCP integration** (see Breaking Change #1 below) —
   the URL surface changed, so existing `~/.claude.json` entries
   point at dead routes.

Schema migrations are wrapped in `BEGIN IMMEDIATE` transactions —
crash-resistant, idempotent, no half-applied state. Each migration
also logs to the boot output so you can audit what ran.

### Breaking changes

These are the active-change moments in order of likely impact.

#### 1. URL surface migrated `/vaults/<name>/...` → `/vault/<name>/...` (Phase 1, PR #138)

The single biggest upgrader-facing change in the entire arc. Every
vault-touching route moved from `/vaults/<name>/...` (plural) and the
unscoped `/api`, `/mcp`, `/oauth/*`, `/view/*` paths to
`/vault/<name>/...` (singular). The unified cross-vault MCP endpoint
(which fanned tool calls across vaults via a `vault` param) dropped —
each MCP session pins to one vault by URL. The `list-vaults` MCP tool
retired alongside.

**Action required**, by client type:

- **Claude Code**: run `parachute-vault mcp-install` to rewrite
  `~/.claude.json`. The new install also picks up hub-mint auth and
  the `local` scope default — see Breaking Changes #5 and #6 below if
  you scripted prior installs.
- **OAuth clients** (Claude Desktop, Parachute Daily, custom
  integrations): remove the existing integration and add it back
  pointing at the new URL. OAuth clients have to re-handshake because
  the issuer URL changed.
- **`curl` scripts and bespoke clients**: rewrite hardcoded URLs.
  `/vaults/work/api/notes` → `/vault/work/api/notes`, etc.
- **Published note permalinks**: `/view/<id>` and
  `/vaults/<name>/view/<id>` both become `/vault/<name>/view/<id>`.
  Update anywhere those links are embedded.

Cross-vault endpoints (`GET /vaults`, `/vaults/list`, `/health`) are
unchanged. Tokens themselves keep working — only the addressing
changes.

#### 2. CLI binary renamed `parachute` → `parachute-vault` (Phase 1, PR #134)

The `parachute` name was freed for the `@openparachute/hub`
dispatcher. When the dispatcher is installed, it transparently
forwards `parachute vault <cmd>` to `parachute-vault <cmd>`; the
vault CLI's own arg-parser also accepts a leading `vault` prefix
(`parachute-vault vault init`), so existing launchd/systemd wrappers
continue working.

**Action**: update shell aliases, shebangs, CI scripts, and README
references. The canonical command an operator types becomes
`parachute-vault`. Wrappers using `parachute vault <cmd>` keep
working — but only with the dispatcher installed.

#### 3. Filesystem restructure (Phase 1, PRs #142 + #144)

Two moves land in the same phase. Move 1: vault state migrates from
flat `~/.parachute/` into `~/.parachute/vault/` (config, env, logs,
data, daemon scripts). Ecosystem root (`~/.parachute/`) now hosts
multiple sibling services. Move 2: per-vault data
`vault/vaults/<name>/` → `vault/data/<name>/` (avoids the doubled
"vault/vaults" path, matches Postgres/Redis convention); daemon logs
into `vault/logs/`.

**Action**: this is auto-migrating — idempotent, target-wins on
conflict, each move logged. EXDEV failures (cross-mount-boundary
copy) surface a clear hint. Operator action only required if you
have backup scripts pointing at the old paths
(`~/.parachute/vaults/<name>/`, `~/.parachute/vault.log`, etc.) —
update them to the new shape.

#### 4. Loopback bind by default (Phase 1, PR #162)

The server bound `0.0.0.0` pre-Phase-1. It now binds `127.0.0.1`.

**Action**: set `VAULT_BIND=0.0.0.0` if your topology relies on a wide
bind (Docker bridge networking, LAN exposure). Empty / whitespace
values are treated as unset. The startup line echoes the resolved
hostname so you can sanity-check.

#### 5. Scope enforcement is real (Phase 1, PR #154, schema v12)

Pre-Phase-1, `parachute-vault tokens create --read` produced a token
documented as read-only but advisory at the boundary. Post-Phase-1,
scopes are enforced. Reads require `vault:read`, mutations
`vault:write`, `/.parachute/config` `vault:admin`. Inheritance:
`admin ⊇ write ⊇ read`. MCP `tools/list` returns only read tools for
read-scoped tokens; mutation `tools/call` returns 403
`insufficient_scope`.

**Action**: audit any caller using `--read` tokens to write — they
receive 403 now. Pre-v12 NULL-scope rows fall back to
`legacyPermissionToScopes(permission)` for one release with a
deprecation warning; new mints should write scopes explicitly.

#### 6. Hub JWT scope narrowing + per-vault audience (Phase 1, PR #180)

Two changes land together:

- Hub-issued JWTs **reject broad** `vault:<verb>` scopes — they must
  pick a vault: `vault:<name>:<verb>`.
- JWT audience switches from hardcoded `"hub"` to per-vault
  `aud: vault.<name>`. Tokens minted for `vault.work` can't replay
  against `vault.personal`. Cross-vault routes (`/vaults`, global
  `/mcp`) reject hub JWTs (no single audience to bind).

**Action**: scripted JWT-minting against multi-vault setups must
narrow scopes to `vault:<name>:<verb>` and set `aud: vault.<name>`.
Old `aud: "hub"` claims validated during a rolling-update window that
is now closed. `pvt_*` tokens are unaffected.

#### 7. Privilege-escalation fix in global `config.yaml` (Phase 1 tail, PR #233)

Worth calling out explicitly: the global `config.yaml` `api_keys`
parser previously dropped the `scope` field. The auth check
`globalKey.scope === "read"` then resolved `undefined` to "full" —
silently escalating any user-authored `scope: read` global key to
full access. The fix mirrors the vault-level parser. An impact scan
locally found zero affected keys, but if you authored a global key
on a vulnerable version, **upgrading is the fix.**

**Action**: audit `~/.parachute/vault/config.yaml` (or older
`~/.parachute/config.yaml`) for `api_keys[].scope: read` entries —
post-upgrade they correctly resolve as read-only.

#### 8. `mcp-install` default scope: `user` → `local` (Phase 3, PR #295)

Scripted (non-interactive) `parachute-vault mcp-install` previously
defaulted to writing the global `~/.claude.json` entry (`user`
scope). The default now writes a directory-private
`projects[<absolute-cwd>].mcpServers` entry (`local` scope).
Interactive walkthroughs (TTY) always prompt.

**Action**: scripted installs that want the old behavior add
`--install-scope user` explicitly. The `local` default prints a
one-line consequence callout so the change is visible.

#### 9. Hub-mint is the default install auth (Phase 3, PR #291)

`parachute-vault mcp-install` default flips from minting a vault-DB
`pvt_*` token to requesting a hub-issued JWT. `--mint` reads
`~/.parachute/operator.token` and POSTs to
`<hub>/api/auth/mint-token`; `--token <bearer>` accepts a paste;
`--legacy-pat` falls back to `pvt_*` with a deprecation notice.

**Action**: fresh installs need a configured hub origin
(`PARACHUTE_HUB_ORIGIN`) and a valid `~/.parachute/operator.token`.
For self-hosted-without-hub deployments, pass `--legacy-pat`
explicitly. Existing tokens of either shape keep working.

#### Other automatic-but-worth-noting changes

- **`update-note` requires `if_updated_at` or `force: true`
  (PR #153).** The optimistic-concurrency check is now mandatory.
  Callers omitting both receive MCP `InvalidParams` / REST 428
  `precondition_required`. `query-notes` and `create-note` now
  return `updatedAt` so callers have the token to echo.
- **Tag rename returns 200 with cascade stats (PRs #131 + #275, in
  0.4.2).** Used to return 409 `tag_in_use_by_tokens` when tokens
  scoped to the old name; now cascades through every surface
  (`tags`, sub-tags, `note_tags`, `parent_names`,
  `tokens.scoped_tags`, `indexed_fields.declarer_tags`, body refs,
  `_tags/<name>` paths) in one transaction. Callers expecting the
  409 must adapt.
- **`note_schemas` + `schema_mappings` tables retired (PR #269, in
  0.4.2, schema v17).** Audit revealed zero rows in real vaults.
  The standalone subsystem, six MCP tools (`list-note-schemas`,
  `update-note-schema`, `delete-note-schema`,
  `list-schema-mappings`, `set-schema-mapping`,
  `delete-schema-mapping`), and `/api/note-schemas` REST endpoints
  all dropped. The `synthesize-notes` MCP tool retired in the same
  release. `tags.fields` is the sole schema surface. **End-state
  MCP tool count: 9** (was 10 → 16 → 9 across the arc).
- **Per-vault token binding (PR #258, in 0.3.6-rc.39, schema v16).**
  New `pvt_*` mints bind to the minting vault; cross-vault use
  returns 403. Pre-v16 NULL-bound tokens stay server-wide (legacy
  compat). Pass `--all` on `tokens create` to opt back in to
  server-wide with a warning.
- **Path uniqueness widened `(path)` → `(path, extension)` (PR #329,
  in 0.4.5).** Lets `Recipes/pasta.md` and `Recipes/pasta.csv`
  coexist. Wikilinks to ambiguous bare paths
  (`[[Recipes/pasta]]` when both exist) are refused; use the
  explicit form. Vaults that only contain `.md` notes see no
  behavior change.
- **Portable-md format change (PR #317, in 0.4.4-rc.9).** Export
  shape changed from flat Obsidian to a nested `metadata:` block
  with fixed key order. `toObsidianMarkdown` is still available as
  a back-compat shim. Re-run `parachute-vault export` if you store
  output.

### Shipped-then-changed during the arc

Two notable items shipped and then changed shape inside Phase 1 — if
you were running an `0.3.6-rc.5` through `rc.29` build, you might
have built against them.

- **`synthesize-notes` MCP tool** shipped in `PR #198` (2026-04-29)
  and retired in `PR #269` (~11 days later, 0.4.2). Replicable with
  `query-notes(near={note_id, depth: 2})` + `find-path` + agent
  aggregation. **Net for upgraders**: never in 0.2.4, not in 0.4.5.
  Acknowledged for completeness.
- **`_tags/<name>` and `_schemas/<name>` notes-as-config convention**
  shipped in `PR #204` (2026-04-29) and migrated to first-class
  tables ~5 days later (`PR #245` for tags, `PR #249` for schemas).
  The legacy notes are left in place as inert audit trail. If you
  authored `_tags/*` or `_schemas/*` notes during the brief window
  they were the canonical surface, they keep working as data but no
  longer drive resolution — use `update-tag` with `parent_names` and
  `fields` instead.
- **Empty-note rejection** shipped in `PR #235` (2026-05-02) — the
  pre-launch hardening that capped batches at 500 also rejected
  empty-content + empty-path notes (the runaway-client signature
  from `vault#213`). The empty-note rejection reversed in `PR #324`
  (`vault#323`, 0.4.4-rc.14) after a real-vault round-trip smoke
  proved skeletons / drafts / organizing notes are valid state.
  **The 500-cap stays.** Empty-note rejection is gone — callers
  don't need to special-case `{}` anymore.

### What you can now do

Ranked by impact for operators upgrading from 0.2.4. Each capability
shipped during the arc; adoption is opt-in unless otherwise noted.

- **Lossless portable export.** `parachute-vault export <dir>` writes
  git-tractable markdown (`.parachute/vault.yaml` + per-tag schemas
  + notes with frontmatter + attachment binaries). `parachute-vault
  import <dir>` is the lossless inverse. `--blow-away` wipes and
  replays for disaster recovery (confirm defaults NO). `--since
  <iso>` for incremental exports (git projections, SSG rebuilds).
  Round-trip is byte-identical on unchanged vault state
  (`vault#308`).
- **Non-markdown notes as first-class.** Pass `extension: "csv"` (or
  yaml / json / mdx / txt / etc.) on `create-note`.
  Frontmatter-compatible formats (md, mdx) carry metadata inline;
  the rest get a sidecar at `.parachute/notes-meta/<id>.yaml`.
  Filter by extension via `query-notes extension: ["csv", "yaml"]`
  or REST `?extension=csv&extension=yaml` (`vault#328`).
- **Upsert-on-update.** Pass `if_missing: "create"` on `update-note`
  (MCP) or `PATCH /notes/:id` (REST). Eliminates the
  query-then-create round trip on nightly syncs. Response carries
  `created: true|false` so sync loops branch without a follow-up
  query (`vault#309`).
- **`update-note` operations bundle.** SQL-atomic `append` / `prepend`
  (concurrent appends never overwrite each other — they both land);
  `content_edit: { old_text, new_text }` for surgical find-and-replace
  with multi-match guard (`error_type: "no_match"` /
  `"multiple_matches"`); frontmatter-aware prepend that skips the YAML
  block (PR #200 + #206). `update-note` elevated from blunt
  full-document replacement to a real edit surface.
- **Indexed metadata + operator-object queries.** Declare a tag field
  as indexed via `update-tag fields.<name>.indexed: true` — vault
  adds a generated column + B-tree index that's universal across
  all notes (not partitioned by tag). Then query with operators:
  `query-notes metadata: {priority: {gte: 3, lt: 10}, status: {in:
  ["open"]}}`. Full set: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`,
  `not_in`, `exists`. HTTP catches up with `?meta[field][op]=value`
  bracket-style. Also: `has_tags` / `has_links` presence filters,
  `order_by` on indexed fields, `dateFilter` recognizes `updated_at`
  for incremental rebuilds.
- **JSON integer coercion.** `update-tag fields.<name>.type:
  "integer"` accepts both `5` and `5.0` (zero fractional), rejects
  `5.5`, `"5"`, `NaN`, `Infinity`. Fixes false-positive
  `type_mismatch` warnings from JSON-emitting drift detectors.
- **Tag schema inheritance.** Tags can declare `parent_names`; a
  child's effective fields = its own ∪ all ancestors'. `_default`
  is the implicit universal parent. First-in-walk-wins conflict
  resolution with advisory `schema_conflict` warnings (`vault#270`).
- **Atomic tag rename + merge.** `POST /api/tags/{name}/rename`
  rewrites the tag across every reference surface in one
  transaction; `POST /api/tags/merge` retags every note carrying
  any source onto the target. Retires the N+1 client-side PATCH
  stopgap.
- **Hub-minted auth with revocation enforcement.** Hub-issued JWTs
  are the canonical auth path. JWTs are revocation-checked every
  request with 60s caching, fail-open during hub outage, fail-closed
  only on cold start. Tag-scoped tokens narrow a single `pvt_*` to
  a root-tag allowlist (per-purpose bots slicing one vault rather
  than spinning up separate vaults; out-of-scope reads return 404,
  no existence leak).
- **Server-side transcription.** `POST /api/notes/{id}/attachments
  {transcribe: true}` queues audio for the scribe worker (set
  `SCRIBE_URL` env to enable). Event-driven via the new
  `attachment:created` hook. Vault becomes the canonical scribe
  context provider via `transcription.context` in `vault.yaml`.
  Audio retention is configurable per-vault (`"keep"`,
  `"until_transcribed"`, `"never"`).
- **Interactive `mcp-install`.** Bare `parachute-vault mcp-install`
  from a TTY walks through vault choice, install location, auth
  mode, and previews the exact JSON before any network call.
  Smart defaults from ambient context (vault count, hub
  reachability, project markers, existing entries — `vault#292`).
- **Graceful stop via filesystem sentinel.** `parachute-vault stop`
  writes `~/.parachute/vault/stop.signal`; the running server polls
  every 500ms and runs the drain-and-exit path. Stale sentinels are
  cleared at startup. Useful in environments where signals are
  awkward (Docker exec, foreground runs without a managed PID).
- **Case-collision safety.** Exports probe filesystem
  case-sensitivity and auto-disambiguate colliding filenames on
  macOS APFS / Windows NTFS while keeping canonical paths in
  frontmatter. `AmbiguousPathError` (distinct from
  `PathConflictError`) surfaces on REST 409 with a `candidates`
  array (`vault#327`, `vault#330`).
- **Empty notes are valid.** Skeleton notes, drafts-saved-before-
  content, organizing-only notes all create + round-trip cleanly
  (`vault#323`).
- **Lean response shape.** `update-note include_content: false`
  returns `NoteIndex` (drops `content`, keeps `byteSize`,
  `preview`, `validation_status`). Order-of-magnitude smaller
  responses on big notes. HTTP `validation_status` symmetric with
  MCP on create/update.
- **`init --no-autostart`.** Skip daemon registration. For CI,
  dev sandboxes, Docker, alt supervisors. Persists `autostart:
  false` in global config.
- **Per-vault admin SPA.** Vault detail, tokens, and permissions
  at `/vault/<name>/admin/` (reachable through hub's proxy with
  hub-issued JWT). Same compiled bundle at any per-vault mount.
- **`vault-info` projection.** Returns a comprehensive
  schema-bearing view (own + effective fields, indexed-field
  catalog, query hints). MCP `initialize` carries the markdown
  projection so agents see the schema landscape at session start.
- **Public `/auth/status` discovery endpoint.** Unauthenticated,
  rate-limit-eligible. Boolean-only token presence response. Lets
  clients probe whether they need to authenticate without
  consuming an auth attempt.

### Where to learn more

- [CHANGELOG.md](./CHANGELOG.md) — chronological per-release notes.
  Note: incomplete for `0.3.6-rc.2` through `rc.29`.
- [parachute.computer/preview/vault-0.4.5-arc/](https://parachute.computer/preview/vault-0.4.5-arc/)
  — primary-sourced audit covering the gap.
- [parachute-patterns/cookbook/vault-portable-export.md](https://github.com/ParachuteComputer/parachute-patterns/blob/main/cookbook/vault-portable-export.md)
  — portable export recipe.
- [parachute-patterns cookbook](https://github.com/ParachuteComputer/parachute-patterns)
  — other recipes: schema inheritance, upsert sync, tag-scoped
  tokens.
- [parachute.computer/design](https://parachute.computer/design) —
  architecture references: module protocol, OAuth shape, hub-as-AS.

### Reporting issues

If your upgrade surfaces something not covered here, please file at
[ParachuteComputer/parachute-vault/issues](https://github.com/ParachuteComputer/parachute-vault/issues).
