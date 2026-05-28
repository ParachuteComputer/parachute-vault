# Upgrading Parachute Vault

Operator-facing migration guidance. For the full chronological CHANGELOG,
see [CHANGELOG.md](./CHANGELOG.md) — note the meta-note at the top about
what's actually been published to npm.

## Mirror event-driven exports + `sync_mode` schema (0.4.9-rc.5 → 0.4.9-rc.6)

The git-mirror feature flipped from polling to event-driven. The watch
loop you may have configured around `interval_seconds: 5` is gone — the
mirror now subscribes to in-process hooks on note/tag/attachment writes
and exports within ~500ms of each change. A safety-net poll (default
hourly) catches anything the event path misses (direct SQL writes,
server restart races).

**Schema rename — silent migration on read:**

| Old field | New field | Behavior |
|---|---|---|
| `watch: true` | `sync_mode: "events"` | Existing configs continue to work; the parser translates on read. |
| `watch: false` | `sync_mode: "manual"` | Same. |
| `interval_seconds: <N>` | `safety_net_seconds: <N>` | Same value, repurposed as the safety-net cadence. Default flipped from 5s to 3600s (1h). |

Hand-edited `config.yaml` files with the old fields keep working —
nothing to change. The SPA reads the new field names; the parser writes
them back on save. If you want to scrub the YAML by hand, the new shape:

```yaml
mirror:
  enabled: true
  location: external
  external_path: "/home/aaron/notes-mirror"
  sync_mode: events          # was: watch: true
  auto_commit: true
  auto_push: false
  commit_template: "export: {{date}} ({{notes_changed}} note{{plural}})"
  safety_net_seconds: 3600   # was: interval_seconds: 5
```

**New: UI-configurable push credentials.** The admin SPA's mirror page
now offers "Connect GitHub" (Device Flow — works on any vault host, no
callback URL setup needed; same flow as `gh auth login`) and "Use
Personal Access Token" (for GitLab/Gitea/Bitbucket/anything else
HTTPS+token). Tokens are stored **per vault** at
`~/.parachute/vault/data/<vaultName>/.mirror-credentials.yaml` with 0600
perms, never appear in API responses, and are embedded into the mirror's
`.git/config` origin URL for push. (Before vault#399 these lived in a
single server-wide `~/.parachute/vault/.mirror-credentials.yaml`, which
leaked the first vault's remote + PAT onto every other vault. On first
boot after upgrade, the legacy server-wide file is migrated to its owning
vault — the default/first vault the mirror was bound to — and preserved as
`.mirror-credentials.yaml.bak`. Other vaults start with no mirror
credentials; configure each separately.)

**Auto-push semantics:**

- `auto_push: true` + `location: internal` is accepted when git
  credentials are wired (a PAT or GitHub OAuth saved via the SPA flows —
  vault sets the mirror's `origin` from them), and rejected only when no
  credentials are configured (an internal mirror has no remote to push to
  otherwise). Connect GitHub / paste a PAT first, or pick `external`.
- The "Push after each commit" checkbox is hidden in the SPA when
  location=internal. (Bare config edit can still set the flag — the
  watch loop logs a non-fatal warning on each push attempt and
  continues.)
- Auto-push needs credentials configured (either via the new SPA flows
  or operator-wired SSH/credential-helper). The SPA's warning text
  updates dynamically: "Will push to @login on GitHub" when configured,
  the legacy "configured outside vault" warning otherwise.

**Deleted notes now propagate.** Pre-event-driven, deleting a note left
its `.md` file in the mirror dir indefinitely. The new export pass
sweeps orphans (notes whose IDs no longer exist in the SQLite). Tag
schemas + attachment dirs sweep the same way. Symlinks inside the
mirror dir pointing outside `outDir` are refused by the prune step.

Reference: design doc at [parachute.computer/design/2026-05-20-vault-as-git-projection.md](https://parachute.computer/design/2026-05-20-vault-as-git-projection/),
propagation tracker at [parachute-patterns/migrations/2026-05-28-mirror-event-driven.md](https://github.com/ParachuteComputer/parachute-patterns/blob/main/migrations/2026-05-28-mirror-event-driven.md).

## Workstream E — standalone OAuth retired

**Hub is now a hard requirement** for OAuth-based clients to connect to
vault. Vault no longer ships a built-in OAuth issuer.

This affects operators who configured vault to run without hub. There
are none in the current user base; this is a forward-facing
simplification, documented here for anyone who would otherwise discover
the change post-upgrade. The few existing beta operators came in on the
precursor "vault + CLI" combo (CLI was renamed to hub) and are tracked
through a separate upgrade pathway.

### What changed

Vault used to ship a standalone OAuth 2.1 + PKCE + DCR issuer with a
server-rendered consent page protected by an owner password (+ optional
TOTP). That code lived in `src/oauth.ts` and was reachable at
`/vault/<name>/oauth/{register,authorize,token}` when vault ran without
the hub. The retirement deletes:

- `src/oauth.ts` (the standalone issuer + consent UI) entirely.
- The DCR / authorize / token endpoints — `/vault/<name>/oauth/*` now
  returns `410 Gone` with a pointer to the protected-resource metadata.
- The in-memory per-IP rate limiter on the consent POST (no traffic to
  limit on a route that no longer exists).
- The end-to-end OAuth-flow tests in `src/oauth.test.ts` and
  `src/auth.test.ts` (per-vault token coherence is still pinned by the
  remaining tests).

What survives:

- The discovery documents at
  `/vault/<name>/.well-known/oauth-{protected-resource,authorization-server}`
  (both the path-append and path-insert RFC 8414/9728 shapes) still respond
  `200` — but the metadata they return forwards every authorization-server
  endpoint to the hub origin. A client that probes vault's discovery URL
  rediscovers the hub.
- The `tokens` table, the bearer-token surface, the `pvt_*` CLI tokens,
  and hub-issued-JWT validation are all unchanged. Existing CLI-minted
  tokens keep authenticating.
- The `oauth_clients` and `oauth_codes` SQLite tables stay (harmless
  empty rows; cleaning them up is a future migration).
- The `parachute-vault set-password` / `parachute-vault 2fa *` CLI
  commands still write `owner_password_hash` / `totp_secret` to
  `config.yaml` because hub's `parachute expose public` posture-check
  reads those YAML fields. They print a deprecation warning and no
  longer gate any auth flow inside vault.

### If you were running vault standalone (no hub)

Browser-based OAuth clients (Claude Desktop, Parachute Daily, claude.ai
integrations, ChatGPT) stop working after the upgrade. To restore:

```bash
parachute install hub
parachute start hub
```

Hub binds `127.0.0.1:1939` by default. Set `PARACHUTE_HUB_ORIGIN` for vault
(in `~/.parachute/vault/.env`) if the hub is reachable on a non-default
origin; otherwise the loopback default works for single-host installs.

Your existing vault data (SQLite DBs, `vault.yaml`, `pvt_*` tokens in the
`tokens` table) is **fully compatible** — no schema migration is needed.
Hub adds an OAuth layer on top of the same data shape vault has always had.

CLI-driven bearer tokens (`parachute-vault tokens create`,
`~/.claude.json` entries written by `parachute-vault mcp-install`,
`VAULT_AUTH_TOKEN`) keep working unchanged. The retirement only affects
the browser-based OAuth handshake.

### If you were already running vault-fronted-by-hub

No action required. Clients re-handshake against the hub on next connect.
The discovery documents vault serves now forward there explicitly (which
they already did when `PARACHUTE_HUB_ORIGIN` was set; this change makes the
hub-rooted forward unconditional).

### If you were exposing vault publicly (Tailscale Funnel, Cloudflare Tunnel, reverse proxy)

If you were exposing vault, you'll also need to expose the hub (or front
both behind the same domain) — the discovery documents now name the hub
origin, and a remote OAuth client that resolves the discovery URL must
be able to reach the hub at that origin to complete the handshake. A
loopback-only hub paired with a publicly-exposed vault leaves clients
unable to authorize.

### Cross-repo follow-up

- **Hub's `expose public` posture-check** (`parachute-hub/src/vault/auth-status.ts`)
  reads `owner_password_hash` and `totp_secret` from vault's `config.yaml`
  to score the deployment's auth posture. The fields and the hub side need
  retirement together once hub gains its own posture-check; tracked as a
  follow-up issue.

## 0.2.4 → 0.4.5

**Most beta users are on `0.2.4`** (the launch version, 2026-04-18).
The current stable is `0.4.5` (2026-05-15). This is the direct upgrade
path; everything in between can be skipped safely.

### Migration is automatic

Schema migrations and filesystem migrations both run on first
post-upgrade boot. They're **idempotent**, **target-wins on conflict**,
and handle the full `v9 → v18` jump in one init — no incremental hops
required.

- **Schema migrations** (every `v3 → v18`): wrapped in
  `BEGIN IMMEDIATE` transactions, log each step to the boot output. A
  `0.2.4` baseline is at schema `v9`; on first post-upgrade boot the
  store walks `v10 → v18` in order. Re-running is a no-op.
- **Filesystem migrations** (run on every CLI command):
  `~/.parachute/<stuff>` → `~/.parachute/vault/<stuff>`, then
  `vault/vaults/<name>/` → `vault/data/<name>/` and daemon logs into
  `vault/logs/`. Each move is logged. EXDEV (cross-mount-boundary)
  failures surface a clear hint.
- **One data-loss carve-out worth knowing about**: the v17 migration
  drops the `note_schemas` + `schema_mappings` tables. For 0.2.4 →
  0.4.5 direct upgraders, this is harmless — those tables were
  transiently present in development RCs between 0.3.x and 0.4.1
  that **never published to npm**, so no real installer had them. If
  the migration finds rows it logs a warning naming the dropped
  schemas + mappings so you can recreate them as `tags.fields`
  declarations on the relevant `tags` rows.

So the operator-visible work is short. The rest of this guide is what
to *actively* change.

### TL;DR — what you have to actively do

1. **Stop the daemon, install, restart.** Schema + filesystem
   migrations run automatically.
2. **Rename CLI references** in shell aliases, shebangs, CI scripts,
   README files: `parachute` → `parachute-vault`.
3. **Re-install your MCP integration** with `parachute-vault
   mcp-install` so `~/.claude.json` rewrites the URL surface. OAuth
   clients re-handshake.
4. **Audit `~/.parachute/vault/config.yaml`** for `api_keys[].scope:
   read` rows — those silently escalated to full access pre-fix
   (vault#233). Upgrading is the fix; the audit confirms whether you
   were affected.
5. **Update scripted JWT minting** (only if you have it) to use
   per-vault audience `aud: vault.<name>` and narrowed scopes
   `vault:<name>:<verb>`.

### Two readers, one doc

*This doc serves two readers:*

*__The human upgrading__: read the TL;DR and the seven numbered
active changes above. ~5min.*

*__An agent helping the human (or building on parachute)__: read
everything. The detailed sections cite specific issues
(`vault#N`), PRs (`#NNN`), commits (`SHA`), and code paths
(`file.ts:line`). An AI fed this whole doc will understand what
shipped, what changed shape, what's still in flight, and where to
look in the codebase for ground truth.*

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
4. **Verify**. The boot log shows automatic schema bumps `v9 → v18`
   and the filesystem moves. `parachute-vault status` reports running
   version + state.
5. **Re-install MCP integration** (see the URL prefix change below):

   ```
   parachute-vault mcp-install
   ```

### Active changes

These are the operator-visible changes 0.2.4 → 0.4.5 in order of
likely impact.

#### 1. CLI binary renamed `parachute` → `parachute-vault`

The `parachute` name was freed for the `@openparachute/hub`
dispatcher. When the dispatcher is installed it transparently forwards
`parachute vault <cmd>` to `parachute-vault <cmd>`; the vault CLI's
own arg-parser also accepts a leading `vault` prefix
(`parachute-vault vault init`), so existing launchd/systemd wrappers
continue working.

**Action**: update shell aliases, shebangs, CI scripts, and README
references. The canonical command an operator types becomes
`parachute-vault`.

#### 2. API URL prefix migrated `/vaults/<name>/...` → `/vault/<name>/...`

Every vault-touching route changed: API at `/vault/<name>/api/...`,
MCP at `/vault/<name>/mcp`, OAuth at
`/vault/<name>/oauth/{register,authorize,token}`, discovery at
`/vault/<name>/.well-known/oauth-*`, published-note view at
`/vault/<name>/view/:id`. The unscoped `/api`, `/mcp`, `/oauth/*`,
`/view/*` paths (single-vault auto-default) retired, as did the
plural `/vaults/<name>/...` prefix and the unified cross-vault MCP
endpoint (each MCP session now pins to one vault by URL).
`list-vaults` MCP tool retired alongside.

**Action**, by client:

- **Claude Code**: run `parachute-vault mcp-install` to rewrite
  `~/.claude.json`. The new install also picks up hub-mint auth and
  the `local` scope default — pass `--legacy-pat` or
  `--install-scope user` if you want the prior behavior.
- **OAuth clients** (Claude Desktop, Parachute Daily, custom
  integrations): remove the existing integration and re-add it
  pointing at the new URL — the issuer URL changed, OAuth must
  re-handshake.
- **`curl` scripts**: rewrite hardcoded URLs.
  `/vaults/work/api/notes` → `/vault/work/api/notes`.
- **Published-note permalinks**: `/view/<id>` and
  `/vaults/<name>/view/<id>` both become
  `/vault/<name>/view/<id>`.

Cross-vault endpoints (`GET /vaults`, `/vaults/list`, `/health`) are
unchanged. Tokens themselves keep working — only the addressing
changes.

#### 3. Token audience binding — per-vault `aud: vault.<name>`

JWT audience switched from hardcoded `"hub"` to per-vault
`aud: vault.<name>`. Tokens minted for `vault.work` can't replay
against `vault.personal`. Cross-vault routes reject hub JWTs (no
single audience to bind). Hub-issued JWTs also reject broad
`vault:<verb>` scopes — they must pick a vault:
`vault:<name>:<verb>`.

**Action**: only matters if you have scripted JWT minting against a
multi-vault setup. Narrow scopes to `vault:<name>:<verb>` and set
`aud: vault.<name>`. `pvt_*` tokens are unaffected. The old
`aud: "hub"` claims validated during a now-closed rolling-update
window.

#### 4. Privilege-escalation fix — audit `config.yaml` (vault#233)

The global `config.yaml` `api_keys` parser previously dropped the
`scope` field. The auth check `globalKey.scope === "read"` then
resolved `undefined` to "full" — silently escalating any
user-authored `scope: read` global key to full access. Upgrading is
the fix; the parser now mirrors the vault-level one.

**Action**: audit `~/.parachute/vault/config.yaml` (or older
`~/.parachute/config.yaml` if your filesystem migration is mid-flight)
for `api_keys[].scope: read` entries. Pre-upgrade they may have been
silently inflated. Impact scan on Aaron's own deployment found zero
affected keys, but the fix exists because the bug existed.

#### 5. Scope enforcement is now real

Pre-0.4.0, `parachute-vault tokens create --read` produced a token
documented as read-only but advisory at the boundary. Post-0.4.0,
scopes are enforced. Reads require `vault:read`, mutations
`vault:write`, `/.parachute/config` `vault:admin`. Inheritance:
`admin ⊇ write ⊇ read`. MCP `tools/list` returns only read tools for
read-scoped tokens; mutation `tools/call` returns 403
`insufficient_scope`.

**Action**: audit any caller using `--read` tokens that performs
writes. Pre-`v12` NULL-scope rows fall back to
`legacyPermissionToScopes(permission)` for one release with a
deprecation warning; new mints write scopes explicitly.

#### 6. `mcp-install` script defaults

Two defaults changed:

- **Install scope** flipped from `user` (global `~/.claude.json`) to
  `local` (`projects[<absolute-cwd>].mcpServers` in
  `~/.claude.json`). Scripted installs that want the old behavior
  add `--install-scope user`. Interactive walkthrough always prompts.
- **Auth mode** flipped from minting a vault-DB `pvt_*` to requesting
  a hub-issued JWT. `--mint` (now the default) reads
  `~/.parachute/operator.token` and POSTs to
  `<hub>/api/auth/mint-token`. `--legacy-pat` falls back to `pvt_*`
  with a deprecation notice. Self-hosted-without-hub deployments
  should pass `--legacy-pat` explicitly.

#### 7. Smaller automatic-but-worth-noting changes

- **Loopback bind by default**: server bound `0.0.0.0`; now binds
  `127.0.0.1`. Set `VAULT_BIND=0.0.0.0` if your topology relies on a
  wide bind (Docker bridge networking, LAN exposure).
- **`update-note` requires `if_updated_at` or `force: true`**: the
  optimistic-concurrency check is now mandatory. Callers omitting
  both receive MCP `InvalidParams` / REST 428
  `precondition_required`. `query-notes` and `create-note` return
  `updatedAt` so callers have the token to echo.
- **Tag rename returns 200 with cascade stats** (was 409
  `tag_in_use_by_tokens`). Cascade rewrites tags, sub-tags,
  `note_tags`, `parent_names`, `tokens.scoped_tags`,
  `indexed_fields.declarer_tags`, body refs, and
  `_tags/<name>` paths in one transaction.
- **Per-vault token binding**: new `pvt_*` mints bind to the
  minting vault (schema `v16`). Pre-`v16` NULL-bound tokens stay
  server-wide (legacy compat). Pass `--all` on `tokens create` to
  opt back in to server-wide with a warning.
- **Path uniqueness widened `(path)` → `(path, extension)`**: lets
  `Foo.md` and `Foo.csv` coexist. Wikilinks to ambiguous bare paths
  (`[[Foo]]`) are refused; use the explicit `[[Foo.csv]]` form.

### What if I happen to be on an intermediate version?

*__If you're not on 0.2.4__ (you installed at some point in the 0.3
or 0.4 window): the schema and filesystem migrations still apply on
first boot from any prior version — they're idempotent and only
execute what's needed. The active changes that affect you depend on
when you installed. The CHANGELOG meta-note at the top of the
[CHANGELOG.md](./CHANGELOG.md) maps installed-version-to-schema-version.
If your upgrade surfaces anything confusing or breaking,
[reach out on GitHub](https://github.com/ParachuteComputer/parachute-vault/issues)
— happy to help in real time.*

### One paragraph on shipped-then-changed-mid-arc

For the niche set of users who tracked development RCs (rather than
published-to-npm versions): three items shipped and then changed
shape inside the arc. The `synthesize-notes` MCP tool shipped in
`vault#198` and retired in `vault#268` (`v17`). The `_tags/<name>`
and `_schemas/<name>` notes-as-config convention shipped in
`vault#204` and migrated to first-class tables (`vault#245`,
`vault#249`) ~5 days later — the legacy notes are left in place as
inert audit trail. Empty-note rejection shipped in `vault#235` and
reversed in `vault#324` after a real-vault round-trip smoke proved
skeletons / drafts / organizing notes are valid state (the 500-cap
on batches stays). None of these affect operators who upgraded
directly between published-to-npm versions.

### What you can now do

Ranked by impact for operators upgrading from 0.2.4. Adoption is
opt-in unless otherwise noted.

- **Lossless portable export.** `parachute-vault export <dir>` writes
  git-tractable markdown (`.parachute/vault.yaml` + per-tag schemas
  + notes with frontmatter + attachment binaries). `parachute-vault
  import <dir>` is the lossless inverse. `--blow-away` wipes and
  replays for disaster recovery (confirm defaults NO). `--since
  <iso>` for incremental exports. Round-trip is byte-identical on
  unchanged vault state. (Caveat: attachment IDs re-mint on import.
  Note-level round-trip is byte-identical; `attachments[].id`
  values differ between original and re-imported. Frontmatter refs
  resolve correctly via `(note_id, path)`. Tracked as a follow-up.)
- **Non-markdown notes as first-class.** Pass `extension: "csv"`
  (or yaml / json / mdx / txt / etc.) on `create-note`.
  Frontmatter-compatible formats (md, mdx) carry metadata inline;
  the rest get a sidecar at `.parachute/notes-meta/<id>.yaml`.
  Filter by extension via `query-notes extension: ["csv", "yaml"]`
  or REST `?extension=csv&extension=yaml` (vault#328).
- **Upsert-on-update.** Pass `if_missing: "create"` on `update-note`
  (MCP) or `PATCH /notes/:id` (REST). Eliminates the
  query-then-create round trip on nightly syncs. Response carries
  `created: true|false` so sync loops branch without a follow-up
  query (vault#309).
- **`update-note` operations bundle.** SQL-atomic `append` /
  `prepend` (concurrent appends never overwrite each other);
  `content_edit: { old_text, new_text }` for surgical
  find-and-replace with multi-match guard; frontmatter-aware
  prepend that skips the YAML block. `update-note` elevated from
  blunt full-document replacement to a real edit surface.
- **Indexed metadata + operator-object queries.** Declare a tag
  field as indexed via `update-tag fields.<name>.indexed: true` —
  vault adds a generated column + B-tree index universal across all
  notes. Then query with operators:
  `query-notes metadata: {priority: {gte: 3, lt: 10}, status: {in:
  ["open"]}}`. Full set: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`,
  `in`, `not_in`, `exists`. HTTP catches up with
  `?meta[field][op]=value` bracket-style. Also: `has_tags` /
  `has_links` presence filters, `order_by` on indexed fields,
  `dateFilter` recognizes `updated_at` for incremental rebuilds.
  *Bonus fix:* `query-notes near` (graph neighborhood) now returns
  all results — a silent SQL `WHERE` bug previously dropped
  neighborhoods beyond the first N rows.
- **JSON integer coercion.** `update-tag fields.<name>.type:
  "integer"` accepts both `5` and `5.0` (zero fractional), rejects
  `5.5`, `"5"`, `NaN`, `Infinity`. Fixes false-positive
  `type_mismatch` warnings from JSON-emitting drift detectors.
- **Tag schema inheritance.** Tags can declare `parent_names`; a
  child's effective fields = its own ∪ all ancestors'. `_default`
  is the implicit universal parent. First-in-walk-wins conflict
  resolution with advisory `schema_conflict` warnings.
- **Atomic tag rename + merge.** `POST /api/tags/{name}/rename`
  rewrites the tag across every reference surface in one
  transaction; `POST /api/tags/merge` retags every note carrying
  any source onto the target.
- **Hub-minted auth with revocation enforcement.** Hub-issued JWTs
  are the canonical auth path. JWTs are revocation-checked every
  request with 60s caching, fail-open during hub outage, fail-closed
  only on cold start. Tag-scoped tokens narrow a single `pvt_*` to
  a root-tag allowlist.
- **Scripted token management via REST.** `POST /vault/<name>/tokens`
  to mint, `GET` to list, `DELETE` to revoke. Same surface the
  Admin SPA uses; useful for orchestrators or CI without shell
  access. Hub-JWT `vault:<name>:admin` auth required.
- **Server-side transcription.** `POST
  /api/notes/{id}/attachments {transcribe: true}` queues audio for
  the scribe worker (set `SCRIBE_URL` env to enable). Event-driven
  via the `attachment:created` hook. Vault becomes the canonical
  scribe context provider via `transcription.context` in
  `vault.yaml`. Audio retention configurable per-vault.
- **Interactive `mcp-install`.** Bare `parachute-vault mcp-install`
  from a TTY walks through vault choice, install location, auth
  mode, and previews the exact JSON before any network call.
- **Graceful stop via filesystem sentinel.** `parachute-vault stop`
  writes `~/.parachute/vault/stop.signal`; the running server polls
  every 500ms and runs the drain-and-exit path. Useful in
  environments where signals are awkward (Docker exec, foreground
  runs without a managed PID).
- **Case-collision safety.** Exports probe filesystem
  case-sensitivity and auto-disambiguate colliding filenames on
  macOS APFS / Windows NTFS while keeping canonical paths in
  frontmatter. `AmbiguousPathError` (distinct from
  `PathConflictError`) surfaces on REST 409 with a `candidates`
  array.
- **Empty notes are valid.** Skeleton notes,
  drafts-saved-before-content, organizing-only notes all create +
  round-trip cleanly.
- **Lean response shape.** `update-note include_content: false`
  returns `NoteIndex` (drops `content`, keeps `byteSize`,
  `preview`, `validation_status`). HTTP `validation_status`
  symmetric with MCP on create/update.
- **`init --no-autostart`.** Skip daemon registration. For CI, dev
  sandboxes, Docker, alt supervisors.
- **Per-vault admin SPA.** Vault detail, tokens, permissions at
  `/vault/<name>/admin/` (reachable through hub's proxy with
  hub-issued JWT).
- **`vault-info` projection.** Comprehensive schema-bearing view
  (own + effective fields, indexed-field catalog, query hints). MCP
  `initialize` carries the markdown projection so agents see the
  schema landscape at session start.
- **Public `/auth/status` discovery endpoint.** Unauthenticated,
  rate-limit-eligible. Boolean-only token presence response.

### Where to learn more

- [CHANGELOG.md](./CHANGELOG.md) — chronological per-release notes
  with the npm-vs-published meta-note at the top.
- [parachute-patterns cookbook](https://github.com/ParachuteComputer/parachute-patterns)
  — recipes for portable export, schema inheritance, upsert sync,
  tag-scoped tokens.
- [parachute.computer/design](https://parachute.computer/design) —
  architecture references: module protocol, OAuth shape, hub-as-AS.

### Reporting issues

If your upgrade surfaces something not covered here, please file at
[ParachuteComputer/parachute-vault/issues](https://github.com/ParachuteComputer/parachute-vault/issues).
