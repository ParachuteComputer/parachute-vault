# Parachute Vault: From 0.2.4 to 0.4.5 — Architectural Arc & Migration Guide

*Re-audited 2026-05-16 directly from git log + merged PRs. The previous synthesis read from the CHANGELOG and missed substantive work that landed in the unwritten rc.2–rc.29 window of the 0.3.6 chain (PRs #160 through #258). 106 commits between `v0.2.4` (commit `752367b`) and `main`. CHANGELOG version markers: 40+, but the 0.3.6-rc chain skips rc.2–rc.29 entirely. This document reconstructs the real arc from primary sources and is sourced to commit SHA / PR # at every claim.*

## § 1. The Arc

Between 0.2.4 (commit `752367b`, 2026-04-18) and 0.4.5 (`66ddd70`, 2026-05-15), Parachute Vault crossed three distinct phases. The CHANGELOG narrative compresses Phase 1 into "0.3.6-rc.1 was the load-bearing release," but the git log shows the load-bearing "release" is a *cluster* of 29 PRs (#128 through #258) across ~16 days under `0.3.6-rc.N` versioning. The CHANGELOG narrates rc.1 and rc.30–rc.39 explicitly; rc.2 through rc.29 are silently absent despite carrying substantive work (catalogued in §7).

**Phase 1: launch & ecosystem-fit (2026-04-18 → 2026-05-05, v0.2.4 → 0.4.0).** Four overlapping waves:

*Pre-launch tail (PRs #128–#133).* DELETE on attachments by id (#128); atomic tag rename + multi-source merge (#131); transcription worker with `transcribe: true` (#132); audio-retention API + `"never"` mode (#133). OLD synthesis folded these into 0.3.6-rc.1; they're three separate substantive commits.

*Launch wave (PRs #134–#150).* CLI rename (#134); services.json self-registration (#135); indexed metadata fields (#136); `updated_at = created_at` invariant + backfill (#137, schema v11); URL migration (#138); `has_tags`/`has_links` (#139); operator objects + `order_by` (#141); filesystem moves (#142, #144); `/.parachute/info` + icon.svg (#143); `PARACHUTE_HUB_ORIGIN` + services catalog + `kind: "api"` (#147); module-config endpoints (#148); RFC 8414 path-insertion discovery (#149, #152); help reshape (#150).

*Auth-substrate wave (PRs #153–#159).* Optimistic-concurrency safe-by-default (#153). Scope enforcement at HTTP + MCP boundary (#154, schema v12). Scribe context provider (#156). `.env` loaded before `SCRIBE_URL` check (#158). Event-driven transcription (#159).

*Pre-launch operator-UX wave (PRs #160–#168).* MCP-config confirm (#160); `docs/auth-model.md` (#161); loopback bind + `--scope` (#162, #164); README + init prompts reshape (#165, #166); docs sweep `@openparachute/cli` → `@openparachute/hub` (#170); vault-name prompt (#168). 0.3.5 cuts (#171).

*Hub-JWT through 0.4.0 (PRs #172–#264).* Hub-issued JWT dual-validation (#172, `59add712`) — 0.3.6-rc.1. Then: narrowed scopes + per-vault audience (#180, rc.2); `--json` flag on create (#184, rc.3); five cleanup batches (#187, #188, #190, #193, #194 — see §7); synthesize-notes (#198, net zero); update-note operations bundle (#200); notes-as-config (#204 — convention shipped then retired); REST token endpoints (#205); 9-nit cleanup (#206); `init --no-autostart` (#207); `create` re-registers services.json (#209); scope-guard library (#212); camelCase aliases + store-routing (#224); pvt_* banner beforeunload (#225); generalized date_filter (#230); FTS routing fix (#231); typecheck cleanup (#232); **priv-esc fix** (#233); empty-note + batch-cap (#235); tag-scoped tokens (#241, schema v13, rc.30); single-row tag identity (#245, schema v14, rc.31); `note_schemas`+`schema_mappings` tables (#249, schema v15, rc.32); v14 wrap (#251, rc.34); admin SPA A/B/C (#219, #220, #222); per-vault mount + three follow-ups (#252, #254, #255, #256); per-vault token storage (#258, schema v16, rc.39); batch atomicity (#260); `.changes` → `RETURNING` (#262). 0.4.0 cuts (#264).

**Phase 2: maturation (PRs #269–#286, 2026-05-09 → 2026-05-10).** Audit-driven retirement of `note_schemas`/`schema_mappings` + 6 MCP tools + `synthesize-notes` (#269, schema v17). Tag schema inheritance + `_default` (#272). `vault-info` projection (#273). Full tag rename cascade (#275). Stats-line distinction (#280). Hub revocation list (#281, scope-guard 0.2.0). MCP tool count drops 16 → 9. 0.4.2 cuts. `dateFilter` recognizes `updated_at` + `include_content: false` (#286).

**Phase 3: substrate completion (PRs #289–#332, 2026-05-10 → 2026-05-15).** HTTP bracket-style metadata filter (#289); 0.4.3 cuts; hub-mint default + project-level + multi-vault (#291, 0.4.4-rc.1); interactive walkthrough (#292); preview-accuracy pin (#301); `uninstall --skip-daemon` (#303); `bun test` web/ui exclusion (#304); MCP-install plan close (#305); HTTP `validation_status` symmetry (#307); portable-markdown PR 1 (#317) + PR 2 (#319); Gitcoin ergonomics (#320); REST `if_missing=create` link symmetry (#322); empty-notes-valid restoration + daemon-busy detection (#324); file-extension support (#329, schema v18); case-collision + ambiguity (#331). 0.4.5 stable cuts (#332).

**Headline shape.** 0.2.4 was a working single-host vault with OAuth + backup + tokens. 0.4.5 round-trips losslessly to git (vault#308), handles non-markdown as first-class (vault#328, schema v18), lives behind a hub that issues / scopes / revokes its tokens (vault#212 Phases 0–4 + Phase A), validates against a 2296-note real vault with zero silent loss, has 9 MCP tools (peaked at 16), sits at schema v18 (from v9 — nine migrations: v10 indexed-fields scaffold, v11 `updated_at` backfill, v12 scopes, v13 scoped_tags, v14 single-row tag identity, v15 note_schemas/schema_mappings, v16 per-vault tokens, v17 retire v15, v18 extension column). Biggest upgrader moment is the launch-wave cluster (PRs #134, #138, #142, #144). Everything after is mostly additive.

## § 2. Themed Changes

### Theme: URL Surface & Naming Migrations (PRs #134, #138, #142, #144, #170)

The single biggest upgrader-facing change in the entire arc.

- **URL migration (PR #138, `7372a7da`).** One URL shape: API at `/vault/<name>/api/...`, MCP at `/vault/<name>/mcp`, OAuth at `/vault/<name>/oauth/{register,authorize,token}`, discovery at `/vault/<name>/.well-known/oauth-*`, published notes at `/vault/<name>/view/:id`. Unscoped `/api`, `/mcp`, `/oauth/*`, `/view/*` (single-vault auto-default) and previous **plural** `/vaults/<name>/...` prefix are gone (404). Cross-vault `GET /vaults`, `/vaults/list`, `/health` unchanged. Unified MCP endpoint that fanned tool calls across vaults dropped; each MCP session pins to one vault by URL. `list-vaults` MCP tool retired. RFC 9728 `WWW-Authenticate: Bearer resource_metadata="..."` header on every MCP 401.

- **CLI rename (PR #134, `8b1f1cab`).** `parachute` → `parachute-vault`. Frees the `parachute` name for the dispatcher. Dispatcher transparently forwards `parachute vault <cmd>` to `parachute-vault <cmd>`. CLI's own arg-parser accepts leading `vault` prefix (`parachute-vault vault init`), so existing launchd/systemd wrappers continue working.

- **Filesystem restructure (PRs #142 + #144, `8600555` + `9e9764c7`).** Move 1: vault state moves from `~/.parachute/` into `~/.parachute/vault/` (`.env`, `config.yaml`, daemon logs, `start.sh`, `server-path`, `vaults/`, `assets/`, `backup-last.json`, `*.db` snapshots). Ecosystem root (`~/.parachute/`) hosts multiple sibling services; `services.json` + `well-known/` stay there, CLI-owned. Move 2: `vault/vaults/` → `vault/data/` (Postgres/Redis convention, avoids doubled "vault/vaults"); daemon logs into `vault/logs/`. Both moves auto-migrating, idempotent, target-wins. EXDEV mount-boundary failures surface a hint (PR #146).

- **`@openparachute/cli` → `@openparachute/hub` docs sweep (PR #170, `b804a4d8`).** Upstream rename on 2026-04-26. Vault's docs and inline comments refresh. No functional changes.

Combined effect: a 0.2.4 user typing `parachute vault status` against `/vaults/work/api/notes` now types `parachute-vault status` against `/vault/work/api/notes`, state under `~/.parachute/vault/data/work/`.

### Theme: Hub Integration & Multi-Writer Auth (vault#212 Phase 0–4, Phase A; PRs #147, #172, #180, #194, #205, #212, #233, #258, #265, #281, #291)

Vault becomes a pure OAuth resource server. Trust boundary moves from "vault mints and validates its own tokens" to "vault accepts hub-issued JWTs alongside legacy `pvt_*`, with the hub as canonical issuer."

- **Phase 0 — hub as advertised issuer (PR #147, `86dce9ec`).** `PARACHUTE_HUB_ORIGIN` env makes vault advertise a hub as the OAuth AS. Discovery is origin-aware: requests via hub origin get `issuer = $HUB` with `${HUB}/oauth/*` endpoints; other origins (loopback) get vault-rooted. Same vault concurrently exposes two self-consistent issuer views (RFC 8414 §2). Token response includes `services` catalog from `~/.parachute/services.json`. `/.parachute/info` returns `kind: "api"`.

- **Phase 1 — hub-issued JWT validation (PR #172, `59add712`, 0.3.6-rc.1).** Dual-validation: JWT-shaped tokens (`eyJ` prefix) route through `src/hub-jwt.ts` — `jose.createRemoteJWKSet` (5-min cache, 30s cooldown), `jwtVerify` checks RS256 + claims, `iss` MUST equal configured hub origin (the **load-bearing trust check**). `pvt_*` callers untouched; JWT-shaped tokens commit to JWT validation (no fallthrough). `legacyDerived` is `false` for JWT-issued scopes. `authenticateVaultRequest`/`authenticateGlobalRequest` become async; await ripples through 5 routing call sites + `isViewAuthenticated`.

- **Phase 1.5 — vault scope narrowing + per-vault audience (PR #180, `5ee65ac1`, 0.3.6-rc.2).** Hub JWT path now **rejects broad** `vault:<verb>` scopes — forces picker semantics. Per-vault audience strict-checked. Cross-vault routes (`/vaults`, global `/mcp`) reject hub JWTs (no single audience to bind). `pvt_*` unaffected.

- **Phase 2 — scope enforcement at HTTP + MCP boundary (PR #154, `ed08a2dd`, schema v12).** Tokens carry OAuth-standard whitespace-separated `scopes`. HTTP: reads → `vault:read`, mutations → `vault:write`, `/.parachute/config` → `vault:admin`. Inheritance `admin ⊇ write ⊇ read`. MCP: read tools require `vault:read`; mutation tools require `vault:write`. Read-only tokens only see read tools in `tools/list`; mutation `tools/call` returns `{error_type: "insufficient_scope", required_scope, granted_scopes}`. `parachute-vault tokens create --read` is now enforcement-real. Pre-v12 NULL-scope rows fall back to `legacyPermissionToScopes(permission)` for one release. Reviewer-fold closed vault-info description-update bypass (outer router gated at `vault:read` so read-only callers could fetch stats; inner write branch wasn't checked).

- **Phase 3 — per-vault audience binding (PR #180 also lands this).** JWT audience switches from hardcoded `"hub"` to per-vault `aud: vault.<name>`. Tokens minted for `vault.work` can't replay at `vault.personal`. Old `aud: "hub"` claims validate during rolling-update window.

- **Phase 4 — hub revocation enforcement (PR #281, `6b73b867`, 0.4.1-rc.6).** JWTs checked against `<hub-origin>/.well-known/parachute-revocation.json`. Bumps `@openparachute/scope-guard` `^0.1.0` → `^0.2.0`. **60s TTL** matching hub's `Cache-Control`. **Fail-open** with last-good cache during outage; **fail-closed** only on cold-start. Client-facing 401s for revocation codes are sanitized (`"token has been revoked"` / `"revocation list unavailable"`); full diagnostics route to server-side audit log via `console.warn`. Inheritable pattern across vault/scribe/agent.

- **scope-guard library adoption (PR #212, `e3216ef2`; bumped to stable in #265, `8b827ac2`).** Replaces vault's JWKS fetch + jwtVerify + cache + audience check + RFC 7519 handling + error-classifying glue with one thin adapter around `createScopeGuard({ hubOrigin })`. Public surface preserved; test files unchanged. Shared with hub/scribe/agent.

- **Phase A — hub-mint as default install (PR #291, `225174f`, 0.4.4-rc.1).** `parachute-vault mcp-install` default flips: `--mint` reads `~/.parachute/operator.token`, POSTs to hub's `/api/auth/mint-token`. `--token <bearer>` pastes existing; `--legacy-pat` falls back to `pvt_*` with deprecation notice. `--scope` expands to `vault:<vault-name>:<verb>` — JWT can't replay against other vaults on same hub.

- **Cross-vault token rejection (PR #258, `9b39758d`, 0.3.6-rc.39, schema v16).** `tokens.vault_name TEXT` + index. New mints bind to minting vault; cross-vault use returns 403 naming both vaults. Pre-v16 NULL-bound rows authenticate server-wide (legacy compat). CLI gains `--vault <name>` and `--all` flags; list output annotates legacy rows `[server-wide]`. Companion PR #205 (`011b4213`) earlier exposed `POST`/`GET`/`DELETE /vault/<name>/tokens` with hub-JWT `vault:<name>:admin` auth, two-layer defense (routing gate + `validateMintedScopes`).

- **OAuth rate-limiter + scope binding (cleanup batch 5, PR #194, `c85ccb90`).** Per-vault rate limiter + memory cap with FIFO eviction (#93); server-side scope binding at `/oauth/authorize`, validated against requested scope at `/oauth/token` per RFC 6749 §3.3 (#94). Pre-launch security hardening.

- **Privilege-escalation fix (PR #233, `a342098d`).** Global `config.yaml`'s `api_keys` parser dropped the `scope` field, leaving `globalKey.scope` undefined. Auth check `globalKey.scope === "read"` then resolved any non-"read" value (including undefined) to "full" — silently escalating user-authored `scope: read` global keys to full access. Mirror the vault-level parser. Behavior change documented; impact scan locally found zero affected keys.

### Theme: MCP Update-Note Operations Bundle (vault#79, #80, #81, #309, #321; PRs #200, #320, #322)

The `update-note` MCP tool evolves from blunt full-document replacement into a surgical edit surface.

- **Append + prepend + content_edit + if_updated_at baseline (PR #200, `753ed930`).** Closes vault#79/#80/#81. SQL-atomic append/prepend (avoids RMW race); `content_edit` with mutual-exclusion + multi-match guard (`error_type: "no_match"` / `"multiple_matches"`); `if_updated_at` integration. Wikilink sync correctly reads back post-write. Followups in #193 (typed `409 path_conflict`, PDF+mp4 allowlist) and #206 (frontmatter-aware prepend skips frontmatter, `content_edit` returns 422 not 404 on no-match, `isAppendOnly` excludes tags/links).

- **Upsert via `if_missing: "create"` (PR #320, `f92e9fff`, 0.4.4-rc.12).** `update-note if_missing: "fail" | "create"` (default `"fail"`). On `"create"`: if `resolveNote` returns null, treat update payload as create; `if_updated_at` skipped. Response carries `created: true|false`. Idempotent. Tag-schema defaults + `validation_status` fire identically to `create-note`. ID-vs-path heuristic: if `id` looks path-shaped (`/` or doesn't match `^[A-Za-z0-9_-]+$`) and `path` isn't explicitly set, use `id` as path — matches Gitcoin's canonical-key shape.

- **REST `if_missing=create` link symmetry (PR #322, `c709388e`, 0.4.4-rc.13).** MCP create-on-missing branch processed `links.add`; REST PATCH create-on-missing branch didn't. Gitcoin would have tripped migrating MCP → REST. REST now mirrors MCP. Schema-conflict warning pin on both MCP and REST (vault#321 F3); MCP `links.add` on create branch pin (F4 — code was there pre-fold but untested).

- **JSON integer coercion (vault#310, in PR #320).** `SchemaField.type` union adds `"integer"`. `Number.isInteger` accepts `5` and `5.0`; rejects `5.5`, `"5"`, `5.0000000000001`, `NaN`, `Infinity`. Gitcoin's drift detector emits JSON for diffs (JSON has no separate integer type) — every `kpi: 3` previously triggered false-positive `type_mismatch`.

### Theme: Indexed Metadata & Query Maturity (PRs #136, #141, #139, #224, #230, #231, #286, #289)

Query surface evolves from "exact-match metadata as JSON scan" to "operator-objects on indexed fields."

- **Indexed metadata fields (PR #136, `1971fe55`, schema v10 scaffold).** `update-tag` field specs gain `indexed: boolean`. Any tag declaring a field as indexed adds VIRTUAL generated column `meta_<field>` (= `json_extract(notes.metadata, ...)`) + B-tree index. Index is **universal across notes**, not partitioned by tag. `type` and `indexed` are global (all declarers must agree); `description` and `enum` per-tag. New `indexed_fields` table is the SSOT; column + index drop when last declarer releases the flag. Type map: `string`→TEXT, `integer`/`boolean`→INTEGER. Field-name pattern `[A-Za-z_][A-Za-z0-9_]{0,62}` for SQL-identifier safety. `rebuildIndexes(db)` runs idempotently on every init.

- **Operator objects + `order_by` (PR #141, `f5b5f736`).** `query-notes metadata` accepts operator objects: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`, `exists`. Multiple ops on one field AND. `order_by` sorts by a metadata field (`created_at` tiebreaker). Both paths require `indexed: true` — route through `meta_<field>` to stay O(log n). Loud errors: `UNKNOWN_OPERATOR`, `FIELD_NOT_INDEXED`, `INVALID_OPERATOR_VALUE`. `ne` preserves "unset AND differs" via `(col IS NULL OR col <> ?)`. Empty `in: []` contradicts; empty `not_in: []` is a no-op (literals `0`/`1` avoid SQLite `IN ()` syntax error).

- **`has_tags` / `has_links` presence filters (PR #139, `969c28ae`).** Booleans on `query-notes` (MCP + REST). Correlated `EXISTS`/`NOT EXISTS`. When `tag` is set, `has_tags` is ignored.

- **camelCase/singular alias fix + store-route (PR #224, `b15b3697`).** Closes vault#214. JSON-RPC drops unknown keys with no inputSchema enforcement — `excludeTags`/`exclude_tag`/bare string previously vanished silently. Now normalized through `normalizeTags`. Routes through `store.queryNotes` instead of `noteOps.queryNotes` so tag-hierarchy expansion via `_tags/<name>` is honored. FTS routing fix follows in PR #231 (`f146b06b`) for the same class of bug.

- **Generalized `date_filter` (PR #230, `72324a09`).** Closes vault#215. Legacy `date_from`/`date_to` always filtered on `n.created_at` (ingestion time) — Prism syncing an old email got `created_at = now`. Now `date_filter: { field, from, to }`. `field` defaults to `created_at`; non-default fields must be `indexed: true`. `updated_at` recognition (#286) builds on this.

- **HTTP bracket-style metadata filter (PR #289, `39acbf38`, 0.4.3-rc.2).** Stripe/JSON:API convention `?meta[field][op]=value`. Array forms `meta[field][in][]=v1&meta[field][in][]=v2` (and comma-separated). Shorthand `meta[field]=value` is JSON-scan fallback (no index required). Bridge for `created_at`/`updated_at` accepts only `gte`/`lt` (half-open `dateFilter` contract). Hand-rolled parser hardens three silent-data-loss classes: cross-column date filter rejection; shorthand-vs-operator on same field mutually exclusive; `[]` array syntax gated to `in`/`not_in`. Array-bucket keying via nested `Map<field, Map<op, values>>` (was string-concat).

- **`updated_at` recognized in `dateFilter` (PR #286, `1997b54`, 0.4.3-rc.1).** Real column, no `indexed: true` required. Unblocks incremental-rebuild. No B-tree today; sequential scan fine. Flat date-param deprecation also lands — `?date_field=`/`?date_from=`/`?date_to=` functional through 0.5.x; bracket canonical; planned removal 0.6.0. On overlap, bracket wins.

### Theme: Tag Lifecycle & Schema Cascading (PRs #131, #204, #241, #245, #249, #251, #269, #272, #275, #280)

Tag identity reshapes from a name-only enrolment row into the SSOT for everything *about* a tag — and every reference is made cascade-safe.

- **Atomic tag rename + merge endpoints (PR #131, `1bd38053`).** `POST /api/tags/{name}/rename` rewrites the tag across `tags`, `note_tags`, schema row in one transaction. `POST /api/tags/merge` retags every note carrying any source tag onto the target. Rename returns `409 target_exists` when `new_name` exists. Retires the prior N+1 client-side PATCH stopgap.

- **Notes-as-config convention shipped then retired (PR #204, `4797ae44`).** Promoted `_tags/<name>` and `_schemas/<name>` notes as SSOT for tag parents + path-prefix default-schema bindings. **Critical reviewer fix:** GLOB instead of LIKE — leading underscore in LIKE was a wildcard, the resolver got the wrong notes. Bulk `createNotes` cache invalidation missed pre-fix. This is the convention that #245 (single-row tag identity) and #249 (note_schemas table) immediately migrated away from into first-class tables — convention shipped and started retiring inside ~5 days. See §7.

- **Tag-scoped tokens Phase 1 (PR #241, `2d54a2ee`, schema v13, 0.3.6-rc.30).** `tokens.scoped_tags TEXT NULL`. A `pvt_*` token can carry an immutable root-tag allowlist; only sees/writes notes whose tags (after hierarchy expansion) intersect that allowlist. Out-of-scope reads return 404 (no existence leak). Hub-issued JWTs always carry `scoped_tags: null` (vault-internal, not an OAuth claim). Use case: per-purpose paraclaw bots slicing one vault. Orphan sub-tag fail-open via string-form `tag.split("/")[0] ∈ rawRoots` fallback. Post-PR fold: tag-delete/merge/rename fail closed (409 `tag_in_use_by_tokens`) when a tag-scoped token references the doomed tag — stopgap that #275 later replaces with full cascade.

- **Tag identity reshape (PR #245, `71af0367`, schema v14, 0.3.6-rc.31).** Six new columns on `tags`: `description`, `fields` (JSON array), `relationships` (JSON object keyed by relationship name; cardinality vocabulary `"one"|"optional"|"many"|"many-required"`), `parent_names` (JSON array), `created_at`, `updated_at`. Hierarchy resolver swaps from `_tags/<name>` notes to `tags.parent_names`. `tag_schemas` sidecar table drops; rows fold into `tags`. `update-tag`/`list-tags` accept and return full record; partial-upsert (undefined preserves, null clears, empty array collapses to null). Legacy `_tags/*` notes left as inert audit trail.

- **`_schemas/*` table form (PR #249, `98b7d049`, schema v15, 0.3.6-rc.32).** Two new tables — `note_schemas` (definition) and `schema_mappings` (binding: `match_kind ∈ {path_prefix, tag}`, ON DELETE CASCADE) — replace notes-as-config. Six new MCP tools (`list-note-schemas`, `update-note-schema`, `delete-note-schema`, `list-schema-mappings`, `set-schema-mapping`, `delete-schema-mapping`). Tool count 10 → 16. Cache-invalidation hook moves off note writes onto table writes. (Reviewer fold rc.33: tightened auth boundary on `/api/note-schemas`, fixed v15 `||` short-circuit.)

- **v14 transaction wrap (PR #251, `7b92d4c5`, 0.3.6-rc.34).** vault#248. Body wrapped in `BEGIN IMMEDIATE / COMMIT` (try/catch ROLLBACK) so a crash mid-migration leaves DB in either pre-v14 or post-v14 state. Regression test injects throw on `DROP TABLE tag_schemas`.

- **Tag schema inheritance + `_default` universal parent (PR #272, `fc8db55b`, 0.4.1-rc.2).** `parent_names` now drives schema inheritance: child's effective `fields` = its own ∪ all ancestors' (recursive walk, cycle-safe; multi-inheritance via multiple parents). `_default` is implicit universal parent of every note. **First-in-walk wins** — child outranks inherited; among parents, earlier outranks later. Losers surface as `schema_conflict` advisory warnings with structured `schema`/`loser_schema` fields. Reviewer-fold: `tagMatch: "any"` + `_default` drops the tag filter entirely (was narrowing wrong); `searchNotes` honors `_default` filter-strip.

- **`note_schemas`+`schema_mappings` retire (PR #269, `f7c47f17`, schema v17, 0.4.1-rc.1).** Audit revealed zero rows in real vaults — v15 standalone subsystem was a parallel path to `tags.fields` nobody used. Schema v17 drops both tables; six MCP tools retire; `/api/note-schemas` REST endpoints removed. **MCP tool count drops 16 → 9**: `query-notes`, `create-note`, `update-note`, `delete-note`, `list-tags`, `update-tag`, `delete-tag`, `find-path`, `vault-info`. `synthesize-notes` retires alongside under vault#268.

- **Tag rename cascade (PR #275, `5a278cc0`, 0.4.1-rc.4).** `renameTag(old, new)` rewrites every surface in one `BEGIN IMMEDIATE` transaction: tags PK + recursive sub-tag rows; `note_tags.tag_name` FK refs; `tags.parent_names`; `tokens.scoped_tags` (replaces fail-closed 409 stopgap from rc.30); `indexed_fields.declarer_tags`; note body `#oldname` / `[[_tags/oldname]]`; `_tags/<oldname>` config-note paths. Pre-flight collision check. **Breaking** for callers relying on the 409 — returns `200` with per-surface counts. LIKE wildcards (`%`, `_`) inside tag names escaped at every pre-filter site (tag named `task_` was producing `LIKE 'task_%'` matching `taskX`). Re-review caught the sub-tag discovery query was also vulnerable — was populating rename set, would have rewritten `taskX/sub` to `<new>/sub`.

- **`vault-info` stats distinction (PR #280).** `100 tags` → `100 tags total, 5 with schemas`. (Covered also under "Response Shape Flexibility & Self-Orientation".)

### Theme: Transcription Integration (PRs #132, #133, #156, #158, #159)

- **Server-side transcription on attachment upload (PR #132, `be8d34ec`).** `POST /api/notes/{id}/attachments {transcribe: true}` stamps `transcribe_status: "pending"` and `transcribe_stub: true` on the note. Background worker (enabled by `SCRIBE_URL`) drains queue FIFO, POSTs audio to `${SCRIBE_URL}/v1/audio/transcriptions`. On success replaces `_Transcript pending._` placeholder. If user cleared stub marker before transcript arrived, note is left alone but transcript still recorded on attachment. Exponential backoff up to 3 attempts. Queue is the `attachments` table — restart resumes pending work.

- **Audio retention API (PR #133, `8e145d69`).** `GET`/`PATCH /api/vault` expose `config.audio_retention`: `"keep"` (default), `"until_transcribed"` (unlinks file after success, keeps row addressable), `"never"` (unlinks on any terminal state). File kept during mid-queue retries. Invalid modes return 400 `invalid_audio_retention`. Pre-existing vaults read back as `"keep"`.

- **Vault is scribe context provider (PR #156, `5340058a`).** Two surfaces, one shape. Webhook triggers gain `include_context: [{tag, exclude_tag?, include_metadata?}]` pre-fetched at fire time. Dedicated worker gets same surface via `transcription.context` in `vault.yaml`. Only whitelisted `include_metadata` keys surfaced. Fetch failures isolated per-predicate. `SCRIBE_AUTH_TOKEN` canonical; `SCRIBE_TOKEN` deprecated alias for one release. Boot-warning when trigger and worker target same host.

- **`.env` ordering hotfix (PR #158, `907a9114`).** `SCRIBE_URL` gate for `startTranscriptionWorker` ran before `loadEnvFile()` — worker silently stayed off when env was in `~/.parachute/vault/.env` rather than shell. Moved `ensureConfigDirSync()` + `loadEnvFile()` above both call sites.

- **Event-driven transcription (PR #159, `d1e0b3ad`).** Upload latency was equalling poll latency on cold path. `core/src/hooks.ts` grows `attachment:created` event alongside note `created`/`updated`. `onAttachment()` + `dispatchAttachment()` share semaphore/drain/logger. `store.addAttachment` dispatches after row commits. Generic: any feature can listen. Sweep remains as safety net.

### Theme: Portable Export & Lossless Round-Trip (vault#308; PRs #317, #319)

- **PR 1 — portable-markdown export (PR #317, `f0bd5f9e`, 0.4.4-rc.9).** `core/src/portable-md.ts` is canonical home for the format. Fixed top-level frontmatter key order (`id` → `path` → `tags` → `metadata` → `links` → `attachments` → `created_at` → `updated_at`) with alpha-sorted nested objects. Re-exporting unchanged vault produces byte-identical files. `exportVaultToDir` writes `.parachute/vault.yaml`, `.parachute/schemas/<tag>.yaml`, per-note `<note.path>.md`. Typed links in `links:` frontmatter block; wikilinks stay in content. IDs preserved in frontmatter. Hand-rolled YAML emitter with strict quoting for type-ambiguous values. Legacy `core/src/obsidian.ts` becomes back-compat shim.

- **PR 1 review fold (0.4.4-rc.10).** Three critical bugs caught before merge. **F1 (silent corruption):** multi-line metadata strings truncated by single-quoted YAML — `needsQuote` now detects `\n\r\t\v\f` + control chars, switches to double-quoted with escape sequences. **F2 (tautology test):** rc.9's "byte-identical re-emit" called `toPortableMarkdown` twice on same in-memory object. Fixed: parse emitted markdown back through `parseFrontmatter`, reconstruct, re-emit, compare bytes. **F3 (path traversal):** `exportVaultToDir` joined without verifying resolved path under `outDir`. Now refuses with `console.warn` rather than aborting. Plus F4 typo, F5 1M-note bulk-load ceiling comment, F6 `unquote` round-trip.

- **PR 2 — attachments + import + round-trip (PR #319, `c71b02df`, 0.4.4-rc.11).** `importPortableVault` upserts by frontmatter `id`. `--blow-away` wipes target first then replays (confirm defaults NO after reviewer fold; `--yes` skips, `--dry-run` simulates). Tag schemas restored before notes. Typed links replayed after all notes exist (forward-ref safe). Attachment binaries: `.parachute/attachments/<id>/<basename>`; path-traversal guards both ends. `Store.restoreNoteTimestamps(id, createdAt, updatedAt)` — import-only setter. `Store.syncAllWikilinks` lifted to Store interface. Round-trip byte-equivalent integration test pins the load-bearing invariant.

- **Known limitation: attachment IDs re-minted on import.** `addAttachment` generates fresh id; Store doesn't yet expose `restoreAttachment(id, ...)`. Frontmatter refs resolve by `(note_id, path)` — note-level round-trip unbroken, but full round-trip with attachments produces byte-different `attachments[].id`. Future enhancement.

### Theme: Non-Markdown Content as First-Class (vault#328; PR #329)

- **Schema v17 → v18 (PR #329, `7acdf6ac`, 0.4.5-rc.1).** `ALTER TABLE notes ADD COLUMN extension TEXT NOT NULL DEFAULT 'md'`; uniqueness index widens from `(path)` to `(path, extension)`. Backward-compat by construction. Threaded `extension` through `Note`/`NoteSummary`/`NoteIndex`, Store interface, `BulkNoteInput`, `QueryOpts.extension` (case-insensitive `LOWER(n.extension) IN (...)`).

- **API surface.** MCP and REST `create-note`/`update-note`/`query-notes`/`POST /notes`/`PATCH /notes/:id`/`GET /notes` gain symmetric `extension` field. Validation `/^[a-z0-9]{1,16}$/` + reserved `parachute` prefix guard. SSOT at `core/src/notes.ts:validateExtension`. 400 `invalid_extension` on bad input.

- **Export/import.** `supportsInlineFrontmatter(ext)` splits extensions: **frontmatter-compatible** (`md`, `mdx`) → metadata inline; **sidecar-required** (everything else) → metadata in `.parachute/notes-meta/<note-id>.yaml`. Path-traversal guard symmetric with attachments. Import builds `(path, extension) → sidecar` index, walks every content file (new `walkContentFiles`). Orphaned content files skipped with warning. Frontmatter `extension` OMITTED for `md` so pre-vault#328 markdown-only exports produce byte-identical bytes before/after upgrade.

- **Wikilink ambiguity.** Two notes sharing a path differing only by extension: `[[Foo]]` refused (returns null, recorded as unresolved); `[[Foo.md]]`/`[[Foo.csv]]` resolve unambiguously. Wikilink parser's extension-recognition mirrors `EXTENSION_PATTERN` in `core/src/notes.ts`.

### Theme: Case-Insensitive Filesystem Disambiguation (vault#327, vault#330; PR #331)

On macOS APFS and Windows NTFS, notes whose paths differ only by case silently collide on export. Aaron's real default vault hit this.

- **Export detection (PR #331, `7bdb75e5`, 0.4.5-rc.2).** `probeCaseSensitive` writes hidden tempfile with lowercase name, tests uppercase reachability, cleans up. Defaults conservative `true` on probe failure. On case-insensitive FS, builds lowercased `(path, ext)` index during export walk; collisions auto-disambiguate to `<path>__<id-prefix>.<ext>` (deterministic across runs — note IDs are stable, timestamp-prefixed). Stored `path` stays canonical; only on-disk filename munged. `ExportStats.case_insensitive_fs` + `disambiguated_paths` audit trail.

- **API (vault#330 S1).** New `AmbiguousPathError` (distinct from `PathConflictError`) carries `code=AMBIGUOUS_PATH` + `candidates: [{id, extension}, ...]`. `getNoteByPath(path, extension?)` signature; >1 row with no hint throws. MCP + REST `resolveNote` parse trailing `.<ext>` as `(path, extension)`. REST 409 with `error_type=ambiguous_path`. Three surfaces share `ambiguousPathResponse` helper.

- **Import (vault#330 S2).** Orphaned sidecars (sidecar present, content file missing) land in `ImportStats.skipped_sidecars`. `sidecarByKey` is multi-value `Map<key, sidecar[]>` so case-collided sidecars coexist. Three-tier fallback: exact-case canonical match → first remaining bucket entry → id-prefix fallback for disambiguated filenames.

### Theme: Response Shape Flexibility & Self-Orientation (vault#271, #274, #286, #287; PRs #273, #280, #286, #307)

- **Lean response (PR #286, `1997b54`, 0.4.3-rc.1).** `update-note include_content: false` returns `NoteIndex` (drops `content`, keeps `byteSize`, `preview`, `validation_status`). Order-of-magnitude smaller on big notes.

- **Validation status on HTTP (PR #307, `d0e685f1`, 0.4.4-rc.8).** HTTP `POST`/`PATCH /notes` attach `validation_status` to responses (single + batch). Mirrors MCP contract. `attachValidationStatus` exported from `core/src/mcp.ts` so both transports share one SSOT.

- **`vault-info` projection (PR #273, `4ca781f3`, 0.4.1-rc.3).** Comprehensive description: `tags` (schema-bearing records with `effective_fields`/`effective_parents`), `indexed_fields` catalog, `query_hints` array. MCP `initialize` carries markdown projection rendered from same state. Agents see schema landscape at session start. Token budget verified under ~5K at 50 schema-bearing tags. Tag-scoped tokens filter via descendant expansion.

- **Stats line distinction (PR #280, `8173ade0`, 0.4.1-rc.5).** `100 tags` → `100 tags total, 5 with schemas`.

### Theme: Import Reliability & Empty-Note Handling (vault#213, vault#323; PRs #235, #324)

The round-trip import smoke test on a real 2290-note vault revealed two blockers — and surfaced that one of the pre-launch guards was over-tight.

- **Empty-note + 500-cap batches guard (PR #235, `d363b2b7`, closes vault#213).** Empty-note invariant enforced at Store boundary so HTTP + MCP both protected atomically. Three legit shapes (content-only, path-only, both) accepted; only empty+empty rejected — the runaway-client signature (7,453 empty pathless rows in one burst). POST batches now 413 over 500 items; MCP throws `BatchTooLargeError`. Mixed batches like `{notes: [{path: "x"}, {}]}` were creating prefix before loop hit empty entry — pre-validate fix shipped same PR.

- **Empty-note guard *dropped* (PR #324, `a1a2019c`, 0.4.4-rc.14).** Aaron's real default vault (2290 notes / 12 schemas / 298 attachments) tripped on empty-content rows during round-trip import smoke. Skeletons / drafts / organizing notes are valid state. Dropped `EmptyNoteError` class + Store throw + MCP/REST pre-walks. Batch atomicity + `MAX_BATCH_SIZE` untouched. **Net of #235 + #324: cap remains; empty-note rejection rolled back.**

- **Daemon detection on import (vault#323, same PR #324).** Import opens its own bun:sqlite connection. When daemon running, first `createNote` hit SQLITE_BUSY leaving vault partially replayed. `cmdImport` now probes `checkHealth(port)` after vault verification; healthy/unhealthy prints clear error pointing at `parachute stop vault`, exits 1. Proper WAL is a separate follow-up.

### Theme: Admin SPA — Scaffold + Per-Vault Mount (vault#252 chain; PRs #219, #220, #222, #252, #254, #255, #256)

- **Scaffold + Phase A (PR #219, `3e1ae6e3`).** Vite + React + TypeScript SPA at `/admin/`. Reads hub-issued `vault:<name>:admin` JWT from URL fragment, stashes module-scoped, strips visible URL. Module-scoped over localStorage keeps XSS surface narrow.

- **Phase B (PR #220, `0ee9cac0`).** `lib/scope.ts` client-side JWT payload decode (no signature verify; vault is the trust boundary). `lib/tokens-api.ts` listTokens/mintToken/revokeToken. Renders mint one-time plaintext `pvt_*` exactly once; hides mutate UI from read-only tokens.

- **Phase C (PR #222, `e9119be2`).** Forward-pointing Permissions link to hub's permissions UI. Hub origin read from JWT's `iss` claim — no runtime-config endpoint needed.

- **Per-vault mount (PR #252, `bb0abab0`, 0.3.6-rc.35).** Three layers in lockstep — server static-file dispatch, React Router runtime basename, Vite asset-base — so same compiled bundle works at any per-vault mount without rebuild. Mount regex `/^\/vault\/([^/]+)\/admin(?=\/|$)/`. Bare `/vault/<name>/admin` redirects to `/vault/<name>/admin/` (301) — browsers resolve relative URLs against the directory of the current document.

- **Mount-mode route table (PR #254, `e8a402da`, 0.3.6-rc.36).** Switch route table on mount mode instead of `<Navigate>` (which under React Router v6 `basename` was resolving to doubled `/vault/<name>/admin/vault/<name>`).

- **JWT fragment preservation (PR #255, `21f34260`, 0.3.6-rc.37).** `module.json`'s `managementUrl` carries trailing slash — hub-issued JWT fragments (`#token=…`) survive click-through (browsers drop `#fragment` across 301s).

- **Stats wire-shape alignment (PR #256, `4a4d7195`, 0.3.6-rc.38).** SPA's `VaultStats` interface used short field names not present in wire payload; server's `VaultStats` had no attachment count. Aligned to wire-shape; `attachmentCount: number` added server-side.

### Theme: Optimistic Concurrency & Correctness (PRs #137, #153, #260, #262)

- **`updated_at = created_at` on insert + backfill (PR #137, `917ff6ec`, schema v11).** Clients using `updatedAt ?? createdAt` were 409'd on first edit. Insert writes both columns; idempotent migration backfills NULL rows.

- **Safe-by-default `update-note` (PR #153, `724b6571`).** `update-note` requires `if_updated_at` or `force: true`. MCP returns `InvalidParams` with `error_type: "precondition_required"`; REST 428. Structured conflict body `{error_type: "conflict", current_updated_at, your_updated_at, path, note_id}`. `query-notes` and `create-note` now return `updatedAt`.

- **Batch atomicity (PR #260, `04d0c3ce`, 0.4.0-rc.1).** Three public batch entry points wrap loops in `BEGIN`/`COMMIT`/`ROLLBACK`. Mid-batch failure no longer leaves prefix items written. Single-item paths skip the wrap (avoid colliding on shared bun:sqlite connection).

- **`.changes` → `RETURNING` (PR #262, `11be1830`, 0.4.0-rc.2).** Inside multi-statement transactions with intervening writes, `Statement.run().changes` could carry stale values, silently bypassing `if_updated_at`. Six sites migrated.

### Theme: Services.json & Module Protocol (PRs #135, #140, #143, #147, #148, #188, #207, #209)

- **`init` registers in `~/.parachute/services.json` (PR #135, `a2a29306`).** Writes `{name, port, paths, health, version}` into shared manifest hub dispatcher consumes for discovery/health probes/routing. Upsert-by-name. Atomic write via temp + rename.

- **services.json `paths[0]` is `/vault/<default_vault>` (PR #140, `dd19cf7e`).** Post URL migration, init still wrote `paths: ["/"]`. Hub uses `paths[0]` as `.well-known/parachute.json` URL suffix and `parachute expose` mount.

- **`/.parachute/info` + `icon.svg` (PR #143, `e8d24f48`).** Two public no-auth CORS-* endpoints. `info` returns `name/displayName/tagline/version/iconUrl`; `icon.svg` placeholder monogram with `X-Content-Type-Options: nosniff` (review-fold PR #146). Non-GET returns 405 before auth.

- **Module-config endpoints (PR #148, `57d4351b`).** Phase 2 of module architecture. `src/module-config.ts` builds schema + values: `audio_retention` (per-vault enum), `scribe_url` (env, read-only until Phase 3), `scribe_token` (env, `writeOnly` — never returned by GET), `port` (read-only informational). `vault:admin` gates `/config` once Phase 3 lands. `PUT /.parachute/config` returns 405 — explicitly Phase 3.

- **`.parachute/module.json` (PR #188, `e23d9539`).** Closes vault#175. Ships in package: name, manifestName, displayName, tagline, kind=api, port, paths, health, startCmd, scopes.defines. Companion fix: services-manifest merge upsert preserves hub-stamped `installDir` (parachute-hub#84) — pre-fix, vault's self-registration pass wiped those fields by spreading `entry` onto the slot. Now `{ ...current.services[idx], ...entry }`.

- **`create` re-registers (PR #209, `c6101554`).** Multi-vault setups stay in sync. New `buildVaultServicePaths` helper shared by `cmdInit` and `cmdCreate`: default vault first (so `paths[0]` stays canonical mount). Re-running `init` doubles as recovery path for stale services.json (test pinned in PR #211).

- **`init --no-autostart` (PR #207, `1e077b11`).** Closes vault#113. Skips daemon registration. Persists in global config. Lifecycle and crash-restart respect the flag. For CI, dev sandboxes, Docker, alt supervisors.

### Theme: MCP-Install Walkthrough & Smart Defaults (vault#291–#304; PRs #291, #292, #295, #301, #303, #304, #305)

The install command grows from silent default writes into a contextual walkthrough.

- **Phase A+B (PR #291, `225174f`, 0.4.4-rc.1).** New flag surface: `--mint`/`--token <bearer>`/`--legacy-pat` (mutually exclusive); `--scope vault:read|write|admin`; `--install-scope user|project`; `--vault <name>`; `--client claude-code`. Hub-mint becomes default. Per-vault entry key `parachute-vault-<name>` so multi-vault installs coexist. `removeMcpConfig` cleans both `~/.claude.json` and `./.mcp.json`. `readMcpEntry` (doctor) checks both target files.

- **Interactive walkthrough (PR #292, `33fcbdd9`, 0.4.4-rc.2).** Bare `mcp-install` (TTY, no flags) walks through vault target, install location, auth mode + scope, preview + confirm. Smart defaults from ambient context (number of vaults, hub reachability, project-directory detection, existing entries). New module `src/mcp-install-interactive.ts` with `runInteractiveInstall` + `InteractiveIO` seam (production wires to `prompt.ts`, tests mock). Pure helpers: `detectInstallContext`, `detectProjectContext`, `detectExistingEntries`. 39 new tests. Piped/CI stdin + no flags falls through to non-interactive defaults.

- **Local install scope + always-prompt (PR #295, `8aa167b7`, 0.4.4-rc.3).** Added `local` (`~/.claude.json` under `projects[<absolute-cwd>].mcpServers`). Walkthrough always prompts (no marker-gate skip — Claude Code reads `./.mcp.json` and `projects[<cwd>]` regardless of git/package markers). Default tilts: markers present → `project`, absent → `local`. **Breaking**: non-interactive default changed `user` → `local`. Scripted installs need `--install-scope user`.

- **Preview-accuracy pin (PR #301, `5481a75b`, 0.4.4-rc.4).** Extract `buildMcpEntryPlan` as SSOT for `(entryKey, url)`. Both preview and writer call it. Thread `port` + `env` + `existingEntryKey` through `InstallContext`/`InstallDecision`.

- **Plan close on writer side (PR #305, `08f70d1b`, 0.4.4-rc.7).** `InstallMcpConfigOpts` now requires `url` from caller. `installMcpConfig` is pure file-writer. `init --add-mcp` bootstrap path also goes through `buildMcpEntryPlan` so init and `mcp-install` share the URL-computation seam.

- **`uninstall --skip-daemon` test-isolation flag (PR #303, `1d1cb9c9`, 0.4.4-rc.5).** `uninstall` calls `uninstallAgent()` against hardcoded launchd label `computer.parachute.vault` — label ignores `PARACHUTE_HOME`, naive subprocess test would `launchctl bootout` real daemon. Undocumented flag bypasses launchd/systemd/backup-agent uninstall; absent from `usage()`.

- **`bun test` exclusion for `web/ui/` (PR #304, `c30ef36f`, 0.4.4-rc.6).** Misdiagnosed as `vi.mock` incompatibility. Root cause: `bun test` walked entire repo including SPA tests using vitest 4.x's `vi.mock("path")` single-arg form that `bun:test` rejects. `bunfig.toml` adds `pathIgnorePatterns = ["web/ui/**"]`. Config + docs only.

### Theme: Pre-Launch Polish & Operator UX (PRs #150, #160–#168, #184)

- **MCP-config confirm before write (PR #160, `88f12d2f`).** `parachute install vault` no longer unconditionally writes vault's MCP URL + API token into `~/.claude.json`. TTY prompt (default yes); non-TTY default yes for back-compat. `--mcp`/`--no-mcp`/`--skip-mcp` override.

- **Auth-model reference docs (PR #161, `9dab710c`).** `docs/auth-model.md` covers OAuth 2.1/PKCE/DCR, API tokens, legacy YAML keys, every routed endpoint's auth requirement and error shape, exposure posture. Source-of-truth for user-facing security copy.

- **Loopback bind by default + `--scope` flag (PR #162, `4855698e`).** Addresses auth-model §5: server bound 0.0.0.0 forced marketing to say "not loopback-only at the socket level." Now binds 127.0.0.1. `VAULT_BIND` escape hatch for Docker bridge / LAN. Empty/whitespace treated as unset. Startup line echoes resolved hostname. **And:** `--scope` accepts the three enforceable scopes, comma-separated or repeated. Precedence `--scope` > `--read` > `--permission` > default (full). `--read` preserved as shorthand.

- **VAULT_BIND display fix (PR #164, `349d1e71`).** Launch-day fix: two hardcoded `http://0.0.0.0:` strings in init output remained after #162. `resolveBindHostname` ensures display matches actual bind.

- **README reshape + no-password-on-init + matrix-summary + password-echo fix (PR #165, `c3ddc3d1`).** Featured path: Claude Code/Codex/Goose/OpenCode/local MCP clients. claude.ai/ChatGPT/Gemini "coming next few weeks." Init skips owner-password prompt — only needed for OAuth consent (browser clients), "coming soon." Init summary rewritten with `127.0.0.1:<port>/vault/<name>/mcp` baked in. `prompt.ts`: batch per-data-event stdout writes in `askPassword` (Bun 1.2.x per-char writes appeared in bursts, looked like dropped keystrokes).

- **Explicit token + MCP prompts + matrix summary (PR #166, `7f779309`).** Two prompts at init (MCP install? token generation?) both defaulting yes. Summary branches on `(addMcp, addToken)` matrix. Extracted `buildInitSummaryLines` to `src/init-summary.ts` for unit testability.

- **`init` prompts for vault name (PR #168, `ec4ad2a6`).** TTY: "What would you like to call this vault? [default]". `--vault-name <name>` non-interactive. Non-TTY no flag uses "default" (preserves piped-install). Validation: lowercase alphanumeric + hyphens + underscores; reserved names rejected.

- **`--json` flag on `create` (PR #184, `d59649e4`).** Single-line JSON `{name, token, paths, set_as_default}` for orchestrator integration. Position-independent flag.

- **CLI help reshape (PR #150, `726fc4f0`).** Two-section restructure: Standard use vs Advanced/standalone. Header points CLI users at `parachute start vault`/`parachute status` wrappers (PID tracking, log rotation, cross-service status). No deprecation — `serve`/`status` remain functional.

### Theme: Cleanup Bundles (PRs #187, #188, #190, #193, #194, #206)

Five cleanup batches + one 9-nit bundle across 24 hours on 2026-04-28 → 2026-04-29 — bumped rc chain from rc.2 to rc.8. The OLD synthesis didn't break these out; each contains substantive items.

- **Batch 1 (PR #187, `3ecb84c4`).** Array `aud` handling per RFC 7519; e2e integration test for `authenticateHubJwt` full request path; cmdCreate flag-stripper comment.
- **Batch 2 (PR #188, `e23d9539`).** `.parachute/module.json` ships. services-manifest merge upsert preserves hub-stamped `installDir`.
- **Batch 3 (PR #190, `d0f4c7c1`).** **`query-notes near` SQL WHERE fix** — pre-fix `ORDER BY + LIMIT` against full table dropped neighborhoods beyond first N (real bug, not a nit). `GET /auth/status` public unauthenticated discovery endpoint.
- **Batch 4 (PR #193, `f84cc959`).** Graceful stop via filesystem sentinel `~/.parachute/vault/stop.signal` (polled by serve loop, deleted on receipt; stale sentinels removed at startup). Typed `409 path_conflict` on create/rename. PDF + mp4 attachment allowlist (SVG/HTML still excluded — sniff-as-HTML defense).
- **Batch 5 (PR #194, `c85ccb90`).** OAuth per-vault rate limiter + memory cap with FIFO eviction; server-side scope binding at `/oauth/authorize`, validated at `/oauth/token` per RFC 6749 §3.3. Pre-launch security hardening.
- **9-nit bundle (PR #206, `038ade73`).** `/auth/status` discovery rate-limit eligibility; frontmatter-aware prepend (skips frontmatter rather than appending in front); `content_edit` returns 422 not 404 on no-match; `isAppendOnly` excludes tags/links; reject absent scope on `/authorize` POST.

### Theme: Synthesize-Notes Tool (Promoted + Retired) — vault#18, #268; PRs #198, #269

`synthesize-notes` MCP tool shipped in PR #198 (`360170e9`) — graph-aware neighborhood for an agent (anchor + query + scope; structured output; uses `traverseLinks`/`searchNotes`; no LLM, no embeddings) — and retired in PR #269 (0.4.1-rc.1) when audit revealed zero production invocations. Replicable with `query-notes(near={note_id, depth: 2})` + `find-path` + agent aggregation. **Net for an upgrader:** never in v0.2.4, not in v0.4.5. Acknowledged for audit completeness.

## § 3. Breaking Changes for 0.2.4 Operators

Sourced to PR # / commit.

| Issue | Version | PR | Change | Action Required |
|-------|---------|-------------|--------|-----------------|
| URL migration | 0.3.6-rc.1 | #138 | Every vault-touching route → `/vault/<name>/...`. Old URLs 404. Unified cross-vault MCP endpoint + `list-vaults` MCP tool retired. | Claude Code: run `parachute-vault mcp-install`. Other OAuth clients re-handshake. curl/scripts: rewrite URLs. Permalinks: `/view/<id>` → `/vault/<name>/view/<id>`. Tokens keep working. |
| CLI rename | 0.3.6-rc.1 | #134 | `parachute` → `parachute-vault`. | Update shell aliases / shebangs / CI / README refs. Dispatcher and CLI's arg-parser accept `parachute vault <cmd>` forward — wrappers keep working. |
| Filesystem restructure | 0.3.6-rc.1 | #142 + #144 | Vault state → `~/.parachute/vault/`; `vault/vaults/<name>/` → `vault/data/<name>/`; logs → `vault/logs/`. | Auto-migrating, idempotent, target-wins. EXDEV failures surface a hint. Update backup scripts pointing at old paths. |
| Bind change | 0.3.6-rc.1 | #162 | Server bound 0.0.0.0 → 127.0.0.1. | Set `VAULT_BIND=0.0.0.0` if topology relies on wide bind (Docker bridge, LAN). |
| Scope enforcement | 0.3.6-rc.1 | #154 | `vault:read`/`write`/`admin` enforced at HTTP + MCP. `tokens create --read` is now enforcement-real (403 on writes). MCP `tools/list` returns only read tools for read-scoped tokens. | Audit `--read` callers writing. Pre-v12 NULL-scope rows fall back to legacy permission for one release. |
| Hub JWT scopes + audience | 0.3.6-rc.2 | #180 | Hub JWT rejects broad `vault:<verb>` scopes — forces picker semantics. Audience: hardcoded `"hub"` → per-vault `aud: vault.<name>`. Cross-vault routes reject hub JWTs. | Scripted JWT minting must narrow to `vault:<name>:<verb>`. Old `aud: "hub"` validates during rolling-update window. |
| Priv-esc fix | 0.4.0 chain | #233 | Global `config.yaml` `scope: read` rows previously silently inflated to full access. Now correctly resolve to read-only. | Audit `~/.parachute/vault/config.yaml` for `scope: read` rows; impact scan locally found zero affected. |
| Cross-vault tokens | 0.3.6-rc.39 | #258 | `pvt_*` tokens bind to minting vault (schema v16). Cross-vault use rejected 403. | Pre-v16 NULL-bound tokens authenticate server-wide (legacy compat). New mints default vault-bound; `tokens create --all` opts back into server-wide. |
| Optimistic concurrency | 0.3.6-rc.1 | #153 | `update-note` requires `if_updated_at` or explicit `force: true`. | Either supply the conditional (now returned by `query-notes` and `create-note`) or pass `force: true` for known-safe bulk writes. |
| Empty-note rejection + reversal | 0.3.6-rc.x → 0.4.4-rc.14 | #235, #324 | #235 rejected empty content+empty path notes + capped batches at 500. #324 reversed the empty-note rejection (skeletons / drafts valid). | The 500-cap stays. Empty-note rejection rolled back; callers don't need to special-case `{}` anymore. |
| `note_schemas` family + `synthesize-notes` retire | 0.4.2 | #269 | `note_schemas` + `schema_mappings` tables + six MCP tools + `/api/note-schemas` REST endpoints removed. `synthesize-notes` MCP tool removed. `tags.fields` is sole schema surface. | Migrate retired-tool callers to `list-tags`/`update-tag` with `fields`. Replicate `synthesize-notes` with `query-notes(near={note_id, depth: 2})` + `find-path` + agent aggregation. Schema v17 migration is automatic. |
| Tag rename cascade | 0.4.2 | #275 | Tag rename returns 200 with cascade stats (was 409 `tag_in_use_by_tokens` from rc.30 fold). | Callers expecting 409 must adapt to 200 + inspect cascade result. Token rewrite automatic. `result.renamed` unchanged. |
| Hub-mint default | 0.4.4-rc.1 | #291 | Hub-mint replaces vault-minted `pvt_*` as `mcp-install` default. `--legacy-pat` falls back with deprecation. | Fresh installs default `--mint` (requires operator token + hub origin). Self-hosted-without-hub: pass `--legacy-pat`. |
| Install scope default | 0.4.4-rc.3 | #295 | Non-interactive `mcp-install` default `user` → `local`. Interactive walkthrough always prompts. | Scripted installs add `--install-scope user` for prior behavior. `local` default prints a consequence callout. |
| Portable-md format change | 0.4.4-rc.9 | #317 | Export shape changed from flat Obsidian to nested `metadata:` block with fixed key order. `toObsidianMarkdown` still available. | No operator action — export is projection. Re-run `export` if you store output. |
| `if_missing` parameter | 0.4.4-rc.12 | #320 | `update-note if_missing` parameter; default `"fail"`. Response carries new `created: boolean`. | None required — defaults preserve semantics. Sync consumers that strict-deserialize the response need to accept the additive `created` field. |
| File extension uniqueness | 0.4.5 | #329 | Path uniqueness `(path)` → `(path, extension)`. Wikilink ambiguity requires explicit extension when same-path different-extension notes exist. | Auto-migrate (schema v18; all rows default `md`). Manual CSV/YAML/JSON: supply `extension`. Wikilinks to ambiguous bare paths return unresolved. |
| AmbiguousPathError | 0.4.5-rc.2 | #331 | New error distinct from `PathConflictError`. `getNoteByPath(path, extension?)` throws when >1 row with no hint. REST 409 with `error_type: "ambiguous_path"` + `candidates` array. | Callers fetching by path may need to handle the new error shape if their vault contains case-collisions or extension-collisions. |

## § 4. New CLI Commands & Surface Area

Everything new since 0.2.4, sourced to PR. Bin rename itself first.

### CLI

| Command/Parameter | Version | PR | Description |
|---|---|---|---|
| `parachute-vault <cmd>` | 0.3.6-rc.1 | #134 | **Binary renamed** from `parachute`. All subcommands carry over. `parachute-vault vault <cmd>` and `parachute vault <cmd>` (via dispatcher) both work. |
| `parachute-vault stop` | 0.3.6-rc.x | #193 | Graceful shutdown via filesystem sentinel `~/.parachute/vault/stop.signal`, polled every 500ms. Stale sentinels removed at startup. |
| `parachute-vault export <dir> [--since <iso>]` | 0.4.4-rc.9 | #317 | Portable-markdown (`.parachute/vault.yaml` + per-tag schemas + per-note `.md` + attachment binaries). Byte-identical re-export. `--since` for incremental. |
| `parachute-vault import <dir> [--blow-away] [--yes] [--dry-run]` | 0.4.4-rc.11 / rc.14 | #319, #324 | Auto-detects portable-md vs legacy Obsidian. `--blow-away` wipes before replay (confirm defaults NO after fold). Daemon-busy detection probes `checkHealth(port)`. |
| `parachute-vault create --json` | 0.3.6-rc.3 | #184 | Single-line JSON `{name, token, paths, set_as_default}` for orchestrator integration. |
| `parachute-vault init` flags: `--vault-name`, `--no-autostart`, `--mcp`/`--no-mcp`, `--token`/`--no-token` | 0.3.2–0.4.0 | #168, #207, #160, #166 | Non-interactive overrides for first-run prompts. Default yes for all. Init persists `autostart` in global config. |
| `parachute-vault mcp-install` (interactive walkthrough) | 0.4.4-rc.2 | #292 | TTY walkthrough: vault target, install location, auth mode + scope, preview + confirm. Non-TTY → flag path. |
| `parachute-vault mcp-install` flags: `--mint` (default) / `--token <bearer>` / `--legacy-pat` (mutually exclusive auth modes); `--scope vault:read\|write\|admin`; `--install-scope user\|local\|project`; `--vault <name>`; `--client claude-code` | 0.4.4-rc.1 / rc.3 | #291, #295 | Hub-mint default; `--legacy-pat` deprecation stderr. Per-vault entry key `parachute-vault-<name>`. Default `--install-scope` changed `user` → `local`. Only `claude-code` client wired (others Phase C). |
| `parachute-vault tokens create --scope vault:read\|write\|admin` | 0.3.0 | #162 | Comma-separated or repeated. Precedence `--scope` > `--read` > `--permission` > default (full). |
| `parachute-vault tokens create --vault <name>\|--all`, `tokens list --vault <name>` | 0.3.6-rc.39 | #258 | Per-vault binding (default); `--all` opts in to server-wide mint (warning). List annotates legacy rows `[server-wide]`. |
| `parachute-vault uninstall --skip-daemon` | 0.4.4-rc.5 | #303 | Test-only undocumented flag. Bypasses launchd/systemd/backup-agent uninstall. |
| `VAULT_BIND` env | 0.3.0 | #162 | Override 127.0.0.1 default bind. Empty/whitespace treated as unset. |

### MCP & REST surface

| Surface | Version | PR | Description |
|---|---|---|---|
| `update-tag fields.<name>.indexed: true` / `.type: "integer"` / `.parent_names` / `.relationships` | 0.3.6-rc.1, rc.31; 0.4.4-rc.12 | #136, #245, #320 | Indexed: adds VIRTUAL `meta_<field>` + B-tree index. Type integer: accepts `5`/`5.0`. Hierarchy + typed-link declarations on tag identity row. |
| `update-note` ops: `append`/`prepend`/`content_edit`/`if_updated_at`/`force`/`if_missing`/`include_content` | 0.3.6-rc.1 → 0.4.4-rc.12 | #200, #153, #320, #286 | SQL-atomic append/prepend; content_edit with multi-match guard; safe-by-default optimistic concurrency; upsert with `created` response; lean `NoteIndex` when `include_content: false`. |
| `query-notes metadata: {field: {op: value}}` / `order_by` / `has_tags` / `has_links` / `excludeTags` aliases / `date_filter` / `near` SQL fix | 0.3.6-rc.1 → 0.4.0 chain | #141, #139, #224, #230, #190 | Full operator set: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`, `exists`. Order_by + presence filters. CamelCase/singular alias acceptance. Generalized `date_filter`. Near pushed into SQL WHERE. |
| `create-note`/`update-note`/`query-notes`/`POST /notes`/`PATCH /notes/:id`/`GET /notes`: `extension` field | 0.4.5-rc.1 | #329 | Optional. Validation `/^[a-z0-9]{1,16}$/` + reserved `parachute` prefix guard. Query accepts single or array, case-insensitive. |
| MCP tool count: 10 → 16 → 9 | 0.3.6-rc.32 / 0.4.1-rc.1 | #249, #269 | Six tools added schema v15 (note_schemas family); all six retired schema v17 alongside `synthesize-notes`. **End state: 9 tools** — `query-notes`, `create-note`, `update-note`, `delete-note`, `list-tags`, `update-tag`, `delete-tag`, `find-path`, `vault-info`. |
| REST `POST /api/tags/{name}/rename`, `/tags/merge` | 0.3.6-rc.1 | #131 | Atomic. Rename returns 200 with cascade stats post-#275 (was 409 `target_exists` / `tag_in_use_by_tokens`). |
| REST `DELETE /api/notes/:id/attachments/:attId` | 0.2.4 tail | #128 | Scoped delete; unlinks file when no other row references path. Cross-note deletes 404. |
| REST `POST /api/notes/{id}/attachments {transcribe: true}` | 0.3.6-rc.1 | #132, #159 | Server-side transcription queue. Event-driven dispatch on `attachment:created` hook. |
| REST `GET /api/notes?meta[field][op]=value` / `?extension=...` | 0.4.3-rc.2 / 0.4.5-rc.1 | #289, #329 | Bracket-style metadata filter (full op set); bridge for `created_at`/`updated_at` (only `gte`/`lt`). Extension filter (single, array, comma, repeated). |
| REST `PATCH /notes/:id` (`include_content: false`, `if_missing`, `validation_status`) | 0.4.3-rc.1 → 0.4.4-rc.12 | #286, #320, #307 | Lean response shape; upsert with `created`; validation status mirrored from MCP. |
| REST `POST/GET/DELETE /vault/<name>/tokens` (+ `{tags: [...]}` for tag-scoped mint) | 0.3.6-rc.x / rc.30 | #205, #241 | Token mint/list/revoke with hub-JWT `vault:<name>:admin` auth. Two-layer defense. Tag-scope allowlist (root tags only, subset of caller's). |
| REST `GET /auth/status` | 0.3.6-rc.x | #190, #206 | Public unauthenticated discovery. Boolean-only token presence. Discovery rate-limit eligibility. |
| REST `PATCH /api/vault {audio_retention}` | 0.3.6-rc.1 | #133 | Mutable: `"keep"`, `"until_transcribed"`, `"never"`. |
| REST `GET /.parachute/{info,icon.svg,config,config/schema}` | 0.3.6-rc.1 | #143, #148 | Module protocol surface. `info` locked card shape with `kind: "api"`. `config` returns effective values with `writeOnly` stripped; `PUT` returns 405 (Phase 3). |
| `.parachute/module.json` (ships in package) | 0.3.6-rc.x | #188 | Vendored manifest for hub's `FIRST_PARTY_FALLBACKS` registry. Services-manifest merge upsert preserves hub-stamped fields (`installDir`). |
| OAuth services catalog in token response + rate-limiter + scope binding | 0.3.6-rc.1 / rc.x | #147, #194 | Token endpoint includes `services` catalog. Per-vault rate limit + FIFO eviction. Server-side scope binding per RFC 6749 §3.3. |
| Env `PARACHUTE_HUB_ORIGIN`, `SCRIBE_AUTH_TOKEN`, `SCRIBE_URL` | 0.3.6-rc.1 | #147, #156 | Hub OAuth advertisement + JWT issuer validation; scribe bearer + worker enablement. Old `SCRIBE_TOKEN` deprecated alias for one release. |
| Event bus: `attachment:created` hook | 0.3.6-rc.1 | #159 | Generic event alongside note `created`/`updated`. Any feature can listen. |
| PDF + MP4 attachment allowlist | 0.3.6-rc.x | #193 | Added to allowlist. SVG/HTML still excluded (sniff-as-HTML defense). |
| Typed `409 path_conflict` on create/rename | 0.3.6-rc.x | #193 | `error_type: "path_conflict"`. |
| `vault-info` projection | 0.4.1-rc.3 | #273 | Schema-bearing tag records + indexed_fields + query_hints. MCP `initialize` carries markdown projection. |
| Admin SPA at `/vault/<name>/admin/*` | 0.4.0 | #219, #220, #222, #252–#256 | Per-vault dashboard. Hub-proxied. Three-layer mount (server static dispatch + React Router runtime basename + Vite asset base). |

## § 5. Work Still In Flight / Coming Soon

- **Phase 3 module config write path.** `PUT /vault/<name>/.parachute/config` returns 405; Phase 3 gates by `vault:admin` to let hub write settings without operator shell.
- **Attachment ID restoration.** `addAttachment` mints fresh ids on import; `Store` doesn't yet expose `restoreAttachment(id, ...)`. Frontmatter refs resolve by `(note_id, path)` so note-level round-trip unbroken; full round-trip with attachments produces byte-different ids. Follow-up.
- **Concurrent-writer & WAL.** Import detects daemon-on-write-lock and exits cleanly; single-writer SQLite contention deferred.
- **Cross-client MCP support (Phase C).** Only `claude-code` wired. Cursor, Claude Desktop, Codex, Zed, Goose, Cline + client auto-detection deferred. Flag surface future-proof.
- **Tunable preview length, URL-safe slug, OR in metadata filters, section/diff/line-range edits, streaming exporter for >1M-note vaults, path-prefix-mapped schemas.** All deferred until a real consumer hits a wall.
- **Flat date-param deprecation (vault#288).** Functional through 0.5.x; bracket-style canonical; planned removal 0.6.0.
- **`pvt_*` deprecation (vault#212 Phase 6).** Opaque-token path remains for self-hosted-without-hub. Phase 6 deprecates separately.
- **Hub multi-user UX & dashboard SDK.** In-flight on the hub team. Vault's token/scope machinery is forward-compatible.
- **`updated_at` indexing.** No B-tree today; sequential scan fine for current sizes.

## § 6. Most User-Noticeable Changes

Ranked by user-visible impact for a 0.2.4 operator upgrading to 0.4.5.

1. **URL migration `/vaults/<name>/...` → `/vault/<name>/...` (PR #138, 0.3.6-rc.1).** The biggest "I have to actively change things" moment. Every hardcoded URL, OAuth integration, published-note link, and script breaks. `parachute-vault mcp-install` rewrites `~/.claude.json` for Claude Code; other OAuth clients re-handshake. The unscoped `/api`, `/mcp`, `/oauth/*` paths and `list-vaults` MCP tool also retire.
2. **CLI rename `parachute` → `parachute-vault` (PR #134, 0.3.6-rc.1).** Shell aliases, shebangs, CI scripts, README references update. Dispatcher and CLI's own arg-parser both accept `parachute vault <cmd>` as forward.
3. **Portable, lossless export/import (PRs #317 + #319, 0.4.4-rc.9 + rc.11).** Vault no longer opaque on disk. `parachute-vault export <dir>` produces git-tractable markdown + YAML that round-trips byte-identically; `parachute-vault import --blow-away` is disaster-recovery replay. Real-world smoke on 2296-note vault proved zero silent loss.
4. **File-extension support for non-markdown content (PR #329, 0.4.5-rc.1).** CSV/YAML/JSON/MDX/plaintext notes. Metadata inline (md/mdx) or in sidecars. Path uniqueness `(path, extension)`; wikilinks require explicit extension on ambiguity.
5. **Hub-mint, scope enforcement, revocation (PRs #172, #154, #180, #281, #291).** Hub-issued JWTs canonical; `pvt_*` deprecated. Scope enforcement real (`vault:read`/`write`/`admin`) at HTTP and MCP. Hub revocation list checked every request with 60s caching, fail-open during outage, fail-closed only on cold start.
6. **Filesystem restructure to `~/.parachute/vault/data/...` (PRs #142 + #144, 0.3.6-rc.1).** Auto-migrating, idempotent, target-wins. Backup scripts pointing at old paths need updates.
7. **Loopback bind by default (PR #162, 0.3.0).** Server bound 0.0.0.0; now 127.0.0.1. `VAULT_BIND` env escape hatch for Docker bridge / LAN.
8. **MCP `update-note` operations bundle (PR #200).** Atomic SQL append/prepend, surgical `content_edit` with multi-match guard, `if_updated_at` baseline, frontmatter-aware prepend (#206). Elevates `update-note` from blunt full-document replacement to a real edit surface.
9. **Indexed metadata + operator-object queries (PRs #136 + #141, 0.3.6-rc.1).** `update-tag fields.<name>.indexed: true` adds B-tree index; `query-notes metadata: {priority: {gte: 3, lt: 10}, status: {in: ["open"]}}` becomes O(log n). HTTP catches up in 0.4.3-rc.2 with `?meta[field][op]=value`. Combined with `has_tags`/`has_links`/`order_by`, query expressiveness is ~5x what 0.2.4 offered.
10. **Server-side transcription wired to scribe (PRs #132, #133, #156, #158, #159).** `POST /api/notes/{id}/attachments {transcribe: true}` queues audio for transcription via dedicated worker. Event-driven via `attachment:created` hook. Vault becomes canonical context provider via per-trigger `include_context` and per-worker `transcription.context`. Audio retention configurable per-vault.
11. **Upsert on update (PR #320, 0.4.4-rc.12).** `update-note if_missing: "create"` eliminates query-then-create dance. Idempotent; response includes `created: true|false`.
12. **Tag schema inheritance + `_default` universal parent (PR #272, 0.4.1-rc.2).** Child's effective fields = own ∪ all ancestors'. `_default` implicit universal parent. First-in-walk-wins with advisory `schema_conflict` warnings.
13. **Atomic tag rename + full cascade (PRs #131 + #275).** Single transaction across tags, sub-tags, `note_tags`, `parent_names`, `tokens.scoped_tags`, `indexed_fields.declarer_tags`, note body refs, `_tags/<name>` paths.
14. **Interactive MCP install with smart defaults (PRs #292 + #295).** TTY walkthrough replaces silent defaults. Project markers inform install location; hub reachability informs auth-mode. Three scopes (`user`, `local`, `project`); `local` is new default.
15. **Case-insensitive filesystem disambiguation (PR #331, 0.4.5-rc.2).** macOS APFS / Windows NTFS path-case-collisions no longer silent on export. Probe-driven; deterministic `__<id-prefix>` suffix; canonical path in frontmatter unchanged. `AmbiguousPathError` with `candidates` array on REST 409.
16. **Admin SPA mounted per-vault (PRs #219, #220, #222, #252).** Per-vault dashboard at `/vault/<name>/admin/` reachable through hub's proxy. Vault detail, tokens, permissions. Same compiled bundle at any per-vault mount without rebuild.
17. **Tag-scoped tokens (PR #241, 0.3.6-rc.30).** `pvt_*` token can carry immutable root-tag allowlist. Use case: per-purpose paraclaw bots slicing one vault. Out-of-scope reads return 404.
18. **Empty notes are valid (PR #324, 0.4.4-rc.14).** Earlier guard (#235) rejected empty + empty creates; reversed after real-vault round-trip smoke proved skeletons / drafts / organizing notes are valid.
19. **Graceful stop via filesystem sentinel (PR #193).** `parachute-vault stop` writes `~/.parachute/vault/stop.signal`. Server polls every 500ms.

## § 7. What the CHANGELOG Missed

The CHANGELOG narrates `0.3.6-rc.1` and `0.3.6-rc.30` through `rc.39` explicitly; **`0.3.6-rc.2` through `0.3.6-rc.29` are missing**. That's a 28-RC window spanning 2026-04-26 → 2026-05-03 — eight days during which 13 PRs landed. None of those are in any CHANGELOG version entry. Some folded into rc.30+'s narrative or got mentioned in 0.4.0's summary; most are silently absent. Below, per PR — and the OLD synthesis missed all of these as distinct items.

- **PR #172 (`59add712`, 2026-04-26) — Hub JWT dual-validation.** Listed in OLD synthesis under "Phase 1 — hub-issued JWT validation." This is the actual rc.1; CHANGELOG conflates rc.1 with the larger ecosystem-fit cluster.

- **PR #179 (`0d184145`, 2026-04-28) — Vault config + scope semantics design doc.** Aaron green-lit 2026-04-28. Five open questions resolved (force picker; no migration window; `parachute:host:admin` for cross-vault admin; paraclaw deep-links; one services.json entry multi-path). Design context for everything that followed.

- **PR #180 (`5ee65ac1`, 2026-04-28) — Narrowed scopes + per-vault audience enforcement.** Phase 1 vault-side. Bumps to 0.3.6-rc.2. **Missing from any CHANGELOG version entry; the OLD synthesis collapsed it into Phase 3 + Phase 0 under 0.3.6-rc.1.** Real shipping shape: rc.2.

- **PR #184 (`d59649e4`, 2026-04-28) — `create --json` flag.** Bumps to rc.3. Not in CHANGELOG.

- **PRs #187/#188/#190/#193/#194 (`3ecb84c4` → `c85ccb90`, 2026-04-28) — Cleanup batches 1–5.** Substantive items: `.parachute/module.json` ships (#188); services-manifest merge upsert preserves hub-stamped `installDir` (#188); `query-notes near` SQL WHERE fix — a real bug, neighborhoods beyond first N silently dropped (#190); `GET /auth/status` public unauthenticated discovery (#190); graceful stop via filesystem sentinel (#193); typed `409 path_conflict` (#193); PDF + mp4 allowlist (#193); OAuth per-vault rate limiter + memory cap (#194); server-side OAuth scope binding per RFC 6749 §3.3 (#194). **None in CHANGELOG.**

- **PR #198 (`360170e9`, 2026-04-29) — `synthesize-notes` MCP tool.** Added; retired 11 days later in #269. Mentioned in CHANGELOG under #269 (retirement) but not under its own addition. Net zero for upgraders.

- **PR #200 (`753ed930`, 2026-04-29) — `update-note` operations bundle.** SQL-atomic append/prepend + `content_edit` + `if_updated_at` baseline. **Not in CHANGELOG as a version entry — closes vault#79/#80/#81. Significant new MCP capability.** Frontmatter-aware prepend folded in #206.

- **PR #204 (`4797ae44`, 2026-04-29) — Notes-as-config (tag hierarchies + default schemas).** **Not in CHANGELOG.** And shipped → migrated to first-class tables ~5 days later (#245, #249), then partially audited away 11 days later (#269). The convention had a ~one-week shelf life. Users who upgraded between rc.5 and rc.30 would have encountered the convention and seen it disappear.

- **PR #205 (`011b4213`, 2026-04-29) — REST endpoints for vault token mint/list/revoke.** Two-layer defense (routing gate + `validateMintedScopes`). **Not in CHANGELOG.** This is the surface the admin SPA uses.

- **PR #206 (`038ade73`, 2026-04-29) — 9-nit cleanup.** Substantive: `/auth/status` rate-limit eligibility; frontmatter-aware prepend; `content_edit` 422 not 404; `isAppendOnly` excludes tags/links; reject absent scope on `/authorize` POST. **Not in CHANGELOG.**

- **PR #207 (`1e077b11`, 2026-04-29) — `init --no-autostart`.** Mentioned in CHANGELOG 0.4.0 summary; no own version entry.

- **PR #209 (`c6101554`, 2026-04-29) — `create` re-registers services.json.** Mentioned in 0.4.0 summary; no own version entry.

- **PR #210/#211 (`7d538041`, 2026-04-29) — init-as-repair pin + cmdInit stderr.** Not in CHANGELOG.

- **PR #212 (`e3216ef2`, 2026-04-30) — scope-guard library adoption.** Step 2 of 4 in cross-ecosystem trust-kernel consolidation. Mentioned in 0.4.0 summary; no own version entry.

- **PR #224 (`b15b3697`, 2026-05-02) — `query-notes` camelCase aliases + store-routing fix.** Two distinct bugs: silent-no-op on near-miss field names and `tag` filter not matching descendant-tagged notes. Mentioned in 0.4.0 summary; no own version entry.

- **PR #225 (`824c1211`, 2026-05-02) — `beforeunload` warning while pvt_* banner showing.** SPA-only fix for one-time plaintext token loss on accidental tab close. Not in CHANGELOG.

- **PR #230 (`72324a09`, 2026-05-02) — Generalized `date_filter`.** Unblocks Prism's semantic-date workflow. Mentioned in 0.4.0 summary; no own version entry.

- **PR #231 (`f146b06b`, 2026-05-02) — FTS routing fix.** Same class as #224 — search branch bypassing store wrapper. Mentioned in 0.4.0 summary.

- **PR #232 (`dd8180f1`, 2026-05-02) — Canonical `bun run typecheck`.** Excludes test files + `web/ui` from root tsconfig. Drops 339 error lines (555 → 216) without papering. Mentioned in 0.4.0 summary.

- **PR #233 (`a342098d`, 2026-05-02) — Priv-esc fix on `readGlobalConfig`.** Global config.yaml `api_keys` parser dropped `scope` field; auth check `=== "read"` then resolved undefined to "full" — silently escalating any user-authored `scope: read` global key to full access. **Mentioned in CHANGELOG 0.4.0 summary as "smaller fixes worth naming" — that undersells a real privilege-escalation bug.** Impact scan locally found zero affected keys, but could have escalated any production user's `scope: read` key.

- **PR #235 (`d363b2b7`, 2026-05-02) — Empty-note rejection + 500-cap batches.** **Reversed in part by #324 11 days later — empty-note rejection is gone in 0.4.5; the 500-cap stays.** Mentioned in 0.4.0 summary.

**What this means for an UPGRADING.md / blog / preview page:**

- The "0.3.6-rc.1 is the load-bearing release" framing is real but compressed. What actually shipped across PRs #128 → #258 over ~16 days is the ecosystem-fit phase.
- Two substantive PRs landed and partially rolled back inside the arc: (a) notes-as-config in #204 (migrated to tables in #245/#249, partially retired in #269); (b) empty-note rejection in #235 (reversed in #324). Both endpoints converge for upgraders; history is worth knowing.
- The priv-esc fix in #233 deserves explicit callout; CHANGELOG buries it.
- `synthesize-notes` (#198) shipped + retired (#269) inside the arc; net zero for upgraders.
- Cleanup bundles (#187/#188/#190/#193/#194/#206) carry substantive items (graceful stop, OAuth rate-limiter + scope binding, query-notes `near` SQL fix, `/auth/status`, `module.json`, services-manifest hub-field preservation, frontmatter-aware prepend, content_edit 422) — framed as "reviewer nits" but covered both cosmetic and bug-class issues. The OLD synthesis missed all of these as distinct items.

## Appendix: Schema Migrations

The full migration ladder a 0.2.4 vault (schema v9) traverses to reach 0.4.5 (schema v18). Nine migrations. Each idempotent, wrapped in `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` post-#251 (the v14 wrap was the subject of vault#248 hardening; v15/v16/v17/v18 follow the same shape).

| Version | Release | PR / Commit | Change | Backward-Compat |
|---------|---------|-------------|--------|-----------------|
| v9 | starting point | — | OAuth codes carry `vault_name`. (At v0.2.4.) | — |
| v10 | 0.3.6-rc.1 | PR #136 / `1971fe55` | `indexed_fields` table as SSOT for indexed metadata fields (declarer set per field). `CREATE TABLE IF NOT EXISTS`. No data migration — `rebuildIndexes()` downstream handles column/index creation on existing data. | Automatic. Fresh vaults pick up the new table via SCHEMA_SQL. |
| v11 | 0.3.6-rc.1 | PR #137 / `917ff6ec` | Backfill `updated_at = created_at` for notes that never received an update. Pre-v11 inserts left `updated_at` NULL, which broke optimistic concurrency for clients that fall back to `createdAt` (the `updatedAt ?? createdAt` pattern). | Automatic. Idempotent — safe to run on every boot. |
| v12 | 0.3.6-rc.1 | PR #154 / `ed08a2dd` | `tokens.scopes TEXT` added. Tokens now carry OAuth-standard whitespace-separated scope string. | Automatic. Idempotent. Pre-v12 NULL rows fall back to `legacyPermissionToScopes(permission)` for one release with deprecation warning. |
| v13 | 0.3.6-rc.30 | PR #241 / `2d54a2ee` | `tokens.scoped_tags TEXT NULL` added. Tag-scoped tokens — root-tag allowlist. JSON array. | Automatic. Existing rows untouched (= unscoped). |
| v14 | 0.3.6-rc.31 | PR #245 / `71af0367` | Six new columns on `tags` (description, fields, relationships, parent_names, created_at, updated_at). Drop `tag_schemas` sidecar table; rows fold into `tags`. Hierarchy resolver swaps from `_tags/<name>` notes to `tags.parent_names`. Legacy `_tags/*` notes left in place as inert audit trail. | Automatic. Idempotent. v14 transaction wrap added in 0.3.6-rc.34 (PR #251). |
| v15 | 0.3.6-rc.32 | PR #249 / `98b7d049` | Two new tables: `note_schemas` + `schema_mappings`. Replace `_schemas/*` and `_schema_defaults` notes-as-config. Legacy notes left in place inert. | Automatic. Short-circuit fix in 0.3.6-rc.33 (was `hasSchemas && hasMappings`, should be `||`). |
| v16 | 0.3.6-rc.39 | PR #258 / `9b39758d` | `tokens.vault_name TEXT` + `idx_tokens_vault_name`. Per-vault token storage. | Automatic. Existing rows get NULL (= legacy server-wide); new mints default to vault-bound. |
| v17 | 0.4.1-rc.1 | PR #269 / `f7c47f17` | Drop `note_schemas` + `schema_mappings` tables. Six MCP tools retire. `/api/note-schemas` REST endpoints removed. `synthesize-notes` MCP tool removed in same PR. `tags.fields` is sole schema surface. | Automatic. Logs warning naming any dropped schemas/mappings (zero in real vaults). |
| v18 | 0.4.5-rc.1 | PR #329 / `7acdf6ac` | `ALTER TABLE notes ADD COLUMN extension TEXT NOT NULL DEFAULT 'md'`. Widen uniqueness index from `(path)` to `(path, extension)`. | Automatic. All existing rows default to `md`; new composite-index uniqueness collapses to prior behavior on existing data. |

---

**Compiled 2026-05-16 from primary sources: git log (106 non-merge commits `752367b`/v0.2.4 → `66ddd70`/main), 87 merged PRs, CHANGELOG cross-referenced against both. Version span: 0.2.4 + 0.3.0 launch + 0.3.5 + 0.3.6-rc.1 through rc.39 (rc.2–rc.29 silently absent from CHANGELOG; documented in §7) + 0.4.0-rc.1/2/stable + 0.4.1-rc.1 through rc.6 (shipped as 0.4.2 stable per RC-versioning) + 0.4.3-rc.1/2 + 0.4.4-rc.1 through rc.14 + 0.4.5-rc.1/2/stable.**

"0.3.6-rc.1 is the load-bearing release" framing is correct in spirit. In practice, the load-bearing release is a cluster of 29 PRs (#128 → #258) across 16 days; only #172 carried the explicit `rc.1` stamp. The rest landed in rc.2–rc.29, never CHANGELOG-narrated. That gap is what this audit closes.

The OLD synthesis at `.OLD-changelog-only.md` is preserved for cross-reference. Items in OLD that this audit OMITTED — deliberate cuts because too internal / not user-facing: none of substance; this audit broadened coverage rather than narrowed it. Items in OLD that this audit RESTRUCTURED: the "Phase 0–4 + Phase A" sub-breakdown of vault#212 got compacted from one-bullet-per-phase to one-bullet-per-PR; semantic content preserved.
