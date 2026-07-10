# Upgrading Parachute Vault

Operator-facing migration guidance. For the full chronological CHANGELOG,
see [CHANGELOG.md](./CHANGELOG.md) — note the meta-note at the top about
what's actually been published to npm.

## 0.6.x → 0.7.1 — the Reliability & Usability Program + the 0.7.1 launch

`0.7.1` is one launch covering two bodies of work: (1) the reliability
program (`0.7.0-rc.1`–`rc.9`) — a nine-persona deep test against a live vault
(2026-07-09, 9 sandboxed agents, 8 fresh vaults, ~230 notes) that closed
every finding at the query/taxonomy/error boundaries (the storage/concurrency
core already tested trustworthy — zero corruption, zero lost writes); and (2)
the 0.7.1 feature launch — aggregation rollups, a typed `reference` field,
title-fallback link/id resolution, honest unresolved/ambiguous link warnings,
a `vault-info` structural map, ULIDs for new note IDs, and a permissions
re-tier. Both were hardened by further agent-driven test rounds (including
backward-compat + mixed-ID runs against old vaults). `0.7.0` was never
published to npm — `0.6.5` promotes straight to `0.7.1`. Full per-fix detail
is in [CHANGELOG.md](./CHANGELOG.md); this section is the operator's action
list.

### Migrations run automatically on first 0.7.1 boot

No manual steps — every migration below is **automatic, transactional, and
idempotent**, run once on first boot after upgrade. As with any upgrade,
**back up your vault's SQLite file first** as standard practice (these
migrations are crash-safe by construction — see the "all-or-nothing" note
below — but a backup costs nothing and covers you against the unrelated
unknown).

- **`migrateToV24` (schema v23→24) — typed-index poison coercion
  (`core/src/schema.ts`).** Scans every declared indexed metadata field for
  values whose JSON type disagrees with the field's declared storage type
  (e.g. `"4"` in an integer field) and **losslessly coerces** what has an
  exact round-trip conversion (a clean numeric string → its number,
  `"true"`/`"false"` → the boolean, and the reverse). Anything that can't be
  losslessly coerced (a non-numeric string in an integer field, an
  array/object value) is **left in place, never deleted or nulled** — it
  surfaces afterward via `doctor`'s `mixed_type_indexed_field` finding for
  you to clean up deliberately. Runs only if the vault has at least one
  indexed field; a vault with none no-ops immediately.
- **`migrateToV25` (schema v24→25) — full-text search rebuild
  (`core/src/schema.ts`).** Rebuilds `notes_fts` to index a note's `path`
  (title) alongside its `content` (previously content-only — a note's title
  was completely unsearchable), adds Porter stemming to the tokenizer, and
  repopulates the index from every existing note. `notes_fts` is an
  external-content FTS5 table, so this is a DROP + CREATE + repopulate, not
  an `ALTER` — the **entire sequence runs inside one transaction**, so a
  crash mid-migration rolls back to the pre-v25 shape and cleanly retries on
  next boot rather than leaving search silently, permanently empty. **Expect
  a one-time cost proportional to note count** — the repopulation pass reads
  every note once. On a large vault this can take a few seconds to
  low-single-digit minutes; the server logs progress and search stays
  unavailable only for the duration of that one pass.
- **`unresolved_wikilinks` `relationship`-column self-heal
  (`core/src/wikilinks.ts`) — lazy, not tied to `SCHEMA_VERSION`.** A vault
  whose `unresolved_wikilinks` table predates the structured-link resolution
  work (rc.8, #555) gets it rebuilt with a widened 3-column primary key
  (`source_id, target_path, relationship`) the first time the table is
  touched (a pending wikilink or structured-link forward-reference) rather
  than on boot. Existing pending rows backfill as `relationship = 'wikilink'`
  (the only kind that could have been queued pre-rc.8). Also wrapped in a
  transaction for the same crash-safety reason as `migrateToV25`.

### Breaking changes

- **Search is literal-by-default (#551, rc.3).** `search=` (MCP `query-notes`
  / REST `GET /notes`) no longer parses as raw FTS5 syntax — ordinary
  punctuation that used to be silently misparsed as query syntax (a bare
  hyphen as NOT, an apostrophe or decimal point breaking the parse: `search:
  "didn't"`, `"eleven-day capping delay"`, `"18.6"` all used to return `[]`
  against notes containing that exact text) now matches literally as
  content. **Migration:** if you relied on raw FTS5 syntax — manual phrase
  quoting to force exact-adjacency matching, boolean `AND`/`OR`/`NOT`,
  prefix `*` — add `search_mode: "advanced"` to the call to keep that exact
  behavior. Most manually-quoted phrases still find the same content under
  the new literal default; only the adjacency *guarantee* of phrase syntax
  stops being honored as syntax outside advanced mode.
- **Indexed fields reject type-mismatched writes (#553, rc.6).** A write
  whose value's type contradicts a metadata field's declared indexed type
  (e.g. writing `metadata.count = "four"` to an indexed integer field) is
  now **rejected** (`422 schema_validation` / MCP structured error),
  regardless of the field's own `strict` setting — previously this landed
  with only an advisory `type_mismatch` warning, and the poisoned value
  could silently corrupt range queries on that field via SQLite's
  type-affinity sort order. **Migration:** none needed for existing data —
  `migrateToV24` (above) coerces what it safely can on upgrade. Going
  forward, fix the caller to send the declared type; every other constraint
  on an indexed field (enum membership, required, cardinality) still only
  warns unless the field is also `strict: true`.
- **Enum/default backfill is explicit-`default:`-only (#553, rc.6).** The
  old implicit backfill (an unset field silently filled with its first enum
  value, or a type zero-value) is retired. Only a tag schema's explicit
  `fields.<field>.default` now backfills an unset field on write — meaning
  `metadata: { field: { exists: false } }` is finally trustworthy: "never
  set" and "explicitly set to the default" are now distinguishable.
  **Migration:** future writes only — notes already backfilled under the old
  behavior keep their values; nothing rewrites existing data. If you relied
  on the implicit backfill, add an explicit `default:` to the field's schema
  (`update-tag` / `PUT /api/tags/{name}`).
- **`PUT /api/tags/:name` single-bad-default now returns `422
  tag_field_conflict`, was `400 invalid_field_default` (#553/#555, rc.8).** A
  single invalid `default:` value used to fail fast with a `400`, silently
  dropping any other violation in the same call. It's now bundled into the
  same collect-all `422 tag_field_conflict` response every other multi-field
  violation already used (`violations: [{field, reason: "invalid_default",
  message}]`), matching MCP's `update-tag` (which already bundled). **Migration:**
  a REST client pattern-matching on `400`/`invalid_field_default` for this
  one case should re-key on `422` + `violations[]` (the specific reason is
  `invalid_default`).
- **`GET /api/tags/{name}` on a nonexistent tag now 404, was a synthesized
  all-null 200 (#550, rc.2).** Previously a tag with no identity row and no
  notes carrying it returned a `200` with every field null; now it returns a
  structured `404 tag_not_found` (`did_you_mean` populated when a close
  match exists). **Migration:** a client checking for tag existence via
  "did the 200 come back all-null" should check for `404` instead.
- **Cursor bootstrap wire-shape — an empty-string `cursor` now returns the
  `{notes, next_cursor}` envelope, was a flat array (#550, rc.2, labeled
  "breaking-lite" in its own changelog).** `?cursor=` / `cursor: ""` now
  correctly engages cursor mode on the FIRST call (previously an empty
  string was treated as "no cursor" and got today's plain flat array — the
  documented bootstrap flow was unreachable). **Migration:** low practical
  risk (the old empty-string path was effectively unreachable), but a client
  that deliberately sent an empty-string cursor and parsed a flat array must
  now read the `{notes, next_cursor}` envelope. An OMITTED `cursor` still
  returns a flat array, unchanged.
- **Permissions re-tier — taxonomy/schema tools now require `admin`, not
  `write` (0.7.1).** `write` now means "author notes" (`create-note` /
  `update-note` / `delete-note`); reorganizing the taxonomy or editing schemas
  — `update-tag`, `delete-tag`, `rename-tag`, `merge-tags`, `prune-schema`,
  and `vault-info`'s description-write — now requires `admin`. Enforced
  identically on **both doors** (MCP tool tiers + REST). The upside: you can
  safely mint a tag-scoped `write` token that adds content without letting it
  restructure your vault (protection against a careless agent as much as a
  malicious one). Two consequences: (a) a `write` token that previously
  renamed/merged/deleted/updated tags now needs `admin` — re-mint it; (b)
  `doctor` moved the OTHER way (admin → `read`), so read-only monitoring /
  tending jobs can now run the integrity scan without an admin credential.

### Behavior changes cursor / sync consumers should know

- **`updated_at` now bumps on tags-only / links-only mutations (#555, rc.8
  fix 2 + rc.9).** A tag-only or link-only `update-note`/`PATCH` (and an
  `if_exists:"update"` that changes only tags/links) used to leave
  `updated_at` frozen; it now bumps like any other real mutation.
  **Additive, not strictly breaking** — MORE mutations are now visible to
  `ORDER BY updated_at` / cursor since-last-check consumers, not fewer — but
  a cursor-based sync will now **re-deliver** notes on tag/link changes it
  previously missed. Expect that increased re-delivery rather than being
  surprised by it. (Deliberately NOT bumped: the bulk `note_tags` repoint
  inside a `rename-tag`/`merge-tags` — a taxonomy rename doesn't change a
  note's own content, and flooding cursor consumers with thousands of
  no-signal bumps was judged worse than the omission.)

### New capabilities (brief pointers — full docs in [docs/HTTP_API.md](./docs/HTTP_API.md))

- **New in 0.7.1** — **aggregation rollups** (`aggregate: {group_by, op:
  count|sum, field?}` on `query-notes` — count/sum grouped by an indexed field
  or `tag`, server-side); a **typed `reference` field** (a schema field that
  is BOTH a filterable indexed value AND an auto-maintained graph link, from
  one declaration — scalar/one-to-one today); **title-fallback resolution**
  (`id: "<a note's H1 title>"` and `[[wikilinks]]` resolve by title when path
  misses); a **`vault-info` structural `map`** (tags + path buckets + counts
  for one-call orientation); **honest `unresolved_link`/`ambiguous_link`
  warnings** on writes.
- **ULIDs for new note IDs (0.7.1).** New notes get opaque, collision-resistant,
  time-sortable ULIDs instead of the old `YYYY-MM-DD-HH-MM-SS-ffffff` timestamp
  format. **Existing IDs are unchanged** — old and new coexist (mixed-format
  links, lookups, and cursor pagination all work; verified against real old
  vaults). No migration. One thing to check: if any of your own tooling
  **parses a note ID to derive a creation time**, switch it to the `created_at`
  field — IDs are now opaque and must not be parsed for time.
- **Honest-query warnings channel** (#550) — `unknown_tag`/`did_you_mean`,
  `removed_param`, `empty_search`, `search_did_you_mean`, `ignored_param` on
  `query-notes`/`GET /notes`, via REST envelope/`X-Parachute-Warnings` header
  or MCP's wrapped response.
- **Cursor bootstrap** (#550) — an explicit empty-string `cursor` (`?cursor=`
  / `cursor: ""`) now correctly engages the `{notes, next_cursor}` envelope
  on the first call.
- **Structured error taxonomy** — `error_type` on essentially every REST
  error body and full MCP domain-error mapping; see "Error taxonomy" in
  `docs/HTTP_API.md`.
- **`rename-tag`/`merge-tags` MCP tools + `vault doctor`** (#552) — cascading
  tag rename/merge with referential-integrity and cycle guards; a new
  read-only integrity scan (`doctor` MCP tool / `GET /api/doctor`) — run it
  after upgrading (see below).
- **Title search, stemming, ranking `score`, `search_did_you_mean`** (#551)
  — a note's title/path is now searchable, English affixes stem
  (firefighter/firefighters), every search result carries a relevance
  `score`, and a zero-result search gets a spelling-correction hint.
- **Structured-link lazy resolution + broken-link queries** (#555) — a
  structured `links: [{target, relationship}]` entry now resolves like a
  `[[wikilink]]` (basename/title match, lazy forward-ref queueing);
  `has_broken_links`/`include_broken_links` surface dangling targets.
- **`create-note if_exists` upsert** (#555) — `if_exists:
  "error"|"ignore"|"update"|"replace"` makes `create-note`/`POST /notes`
  idempotent on a path conflict, race-closed (not just sequential-safe).

### Post-upgrade verification

Run `doctor` (MCP tool, or `GET /api/doctor` with a `vault:admin` token)
after upgrading. It's read-only and surfaces anything `migrateToV24` flagged
but couldn't losslessly coerce (`mixed_type_indexed_field`), plus any
pre-existing taxonomy issues (`dangling_parent_name`,
`parent_names_cycle`, `orphaned_indexed_field_declarer`,
`dead_tag_metadata_reference`) — nothing it reports is auto-fixed, so review
the findings and clean up deliberately where they apply to you.

### Known limitations / follow-ups

- **0.7.x polish backlog:** tracked at issue #570.
- **Hosted-door (cloud) gate:** the DO-SQLite backend behind the hosted door
  must run the FTS5 v25 spike (parachute-cloud#114) — confirming
  `tokenize='porter unicode61'` and the two-column external-content FTS5
  shape used by `migrateToV25` behave identically on Cloudflare's SQLite
  build — before the hosted door pulls this core. **This does not affect
  self-hosted (hub/bun) deploys**, which are the only place `0.7.0` runs
  today.

## JWKS now fetched from the local hub (vault#464)

Vault now fetches the hub's JWKS (the signing keys it uses to verify
hub-issued JWTs) from the **local** hub on loopback (`http://127.0.0.1:1939`)
by default, while still validating the token's `iss` against
`PARACHUTE_HUB_ORIGIN`. This fixes the JWKS fetch hairpinning out through the
public Cloudflare tunnel and back to the same box after `parachute expose` —
which timed out the first MCP-over-public auth on co-located deploys.

**The overwhelming common case needs no action** — co-located (hub supervises
vault on the same box), standalone, and Render / single-container deploys all
read keys from loopback automatically.

**If you run vault on a SEPARATE box from its hub** (the rare non-co-located
topology), set `PARACHUTE_HUB_JWKS_ORIGIN` to the hub's reachable internal
address (e.g. `http://10.0.0.5:1939`). Without it, vault defaults the JWKS
fetch to `http://127.0.0.1:1939` — where no hub is listening — and every
hub-JWT validation 401s. `PARACHUTE_HUB_ORIGIN` stays the public origin for
`iss` validation; only the JWKS-fetch origin moves.

## pvt_* token removal — REJECTED as of 0.5.0 (BREAKING)

**TL;DR:** `pvt_*` tokens (the opaque `pvt_…` bearers vault used to mint into
its own SQLite `tokens` table) are **gone as of 0.5.0**. Vault no longer mints
them and no longer validates them — a `pvt_*` bearer now **fails with a 401**.
This is the BREAKING DROP the prior releases warned about (vault#282 Stage 2).
If any MCP client or script still presents a `pvt_…` bearer, **migrate it to a
hub-issued JWT** using the steps below — it has stopped working at 0.5.0.

The pre-0.5.0 releases (the last 0.4.x line) logged a one-time
`[deprecation] pvt_* token …` warning on every pvt_* auth so you could find
which clients still needed migrating ahead of this cutover. If you upgraded
straight from a pvt_*-only install, work through the migration path below.

### Why this is happening

Vault is now a **pure OAuth resource-server**. Granular, revocable,
audience-bound auth is a hub-minted capability — the hub is the single token
issuer for the ecosystem (it already mints the JWTs that browser-based clients
use today). `pvt_*` was vault's own pre-hub token type; it predated the hub and
duplicated a capability that now lives entirely on the hub. Keeping two parallel
auth surfaces (vault-local `pvt_*` + hub JWTs) is what 0.5.0 retired. As of
0.5.0, vault validates hub-issued JWTs (and the coarse `VAULT_AUTH_TOKEN` /
`vault.yaml` operator secrets for the no-granular-auth path) and nothing else.

Every capability `pvt_*` provided has a hub-minted equivalent already shipped:
read/write/admin scopes, per-vault binding, tag-scoped tokens, and
session-managed mint/revoke via the `manage-token` MCP tool. Nothing is
stranded by the removal.

### Who this affects

If you came up on **vault 0.2.4-era** (vault standalone, no hub) you were
**100% on `pvt_*`** — every MCP client and script you wired authenticated with
a `pvt_…` bearer. You are the operator this affects: those bearers stop working
at 0.5.0. Install the hub and re-mint each client's token.

If you are **already running vault behind the hub** and your clients connect
via OAuth (Claude Desktop, claude.ai, Parachute Daily, etc.), those clients
already use hub JWTs — they need no change. You only need to migrate any
**scripts or CLI-wired tokens** that still present a `pvt_…` bearer (your
pre-0.5.0 logs flagged these with `[deprecation] pvt_* token …` lines).

### What broke at 0.5.0

A `pvt_*` bearer now returns **401** on every vault endpoint (per-vault and the
global `/vaults` surface). `parachute-vault tokens create` was removed (it
minted pvt_*); `mcp-install --legacy-pat` was removed. Tokens are now exclusively
hub-issued JWTs. Your existing pvt_* rows stay in the `tokens` table inertly —
they're harmless and the table is kept as the legacy-YAML import landing zone —
but nothing validates them. Work through the migration path below to restore
access for any pvt_*-only client.

### Migration path (no-hub operator)

1. **Install the hub.** It's the OAuth issuer — vault delegates the whole
   authorization flow to it.

   ```bash
   bun add -g @openparachute/hub
   parachute init
   ```

   `parachute init` sets up the hub on `127.0.0.1:1939` and wires the JWT mint
   path. (If vault must reach the hub on a non-default origin, set
   `PARACHUTE_HUB_ORIGIN` in `~/.parachute/vault/.env`.)

2. **Re-mint each client's token as a hub JWT.**

   - **MCP clients** (Claude Code, Claude Desktop, Daily) — re-run the install
     helper; it now writes a hub-minted JWT into the client config instead of a
     `pvt_*`:

     ```bash
     parachute vault mcp-install
     ```

   - **Scripts / headless callers** — mint a scoped JWT directly and use it as
     the bearer:

     ```bash
     parachute auth mint-token --scope vault:<name>:<verb>
     ```

     where `<name>` is the vault and `<verb>` is `read`, `write`, or `admin`.

3. **Swap the configs.** Replace the old `pvt_…` value anywhere you hard-coded
   it (`~/.claude.json` MCP entries, script env vars, `Authorization: Bearer`
   headers) with the freshly-minted JWT. `mcp-install` does this for the MCP
   clients automatically; scripts you wired by hand you update by hand.

4. **Confirm.** Watch your vault logs — once every caller authenticates with a
   hub JWT (no 401s from a stale `pvt_…` bearer), you're done. If you upgraded
   to 0.5.0 before re-minting, do it now: the pvt_* bearers are already
   401-ing, so re-mint each one and swap the config.

Reference: pvt_* retirement arc tracked at
[vault#282](https://github.com/ParachuteComputer/parachute-vault/issues/282);
the Stage-2 DROP propagation tracker is at
[parachute-patterns/migrations/2026-05-28-pvt-token-drop.md](https://github.com/ParachuteComputer/parachute-patterns/blob/main/migrations/2026-05-28-pvt-token-drop.md)
(the Stage-1 operator-mintable-admin enabler is at
[2026-05-28-operator-mintable-vault-admin.md](https://github.com/ParachuteComputer/parachute-patterns/blob/main/migrations/2026-05-28-operator-mintable-vault-admin.md)).

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
- The `tokens` table and hub-issued-JWT validation are unchanged here.
  **(Superseded at 0.5.0 — vault#282 Stage 2 dropped the `pvt_*` CLI tokens +
  bearer-token mint/validation surface entirely; see the pvt_* removal section
  at the top of this file. The `tokens` table is kept inert.)**
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

Your existing vault data (SQLite DBs, `vault.yaml`, and any leftover `pvt_*`
rows in the `tokens` table) needs no schema migration. Hub adds an OAuth layer
on top of the same data shape vault has always had. **(At 0.5.0 / vault#282
Stage 2, the `pvt_*` rows became inert — vault no longer validates them; see
the pvt_* removal section at the top of this file.)**

`VAULT_AUTH_TOKEN` (the server-wide operator bearer) and `~/.claude.json`
entries holding a **hub JWT** keep working. **(`parachute-vault tokens create`
was removed at 0.5.0; `mcp-install` now writes a hub JWT, not a `pvt_*`.)**

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
