# Upgrading Parachute Vault

Operator-facing migration guidance. For the full chronological CHANGELOG,
see [CHANGELOG.md](./CHANGELOG.md).

## 0.2.4 → 0.4.5

If you installed Parachute Vault on launch day (2026-04-23) and haven't
upgraded, you're on `0.2.4`. The current stable is `0.4.5` (2026-05-15).
That's ~3 weeks of substrate-grade maturation: lossless export/import,
non-markdown content, hub-issued auth, schema inheritance, upsert
semantics, case-insensitive filesystem safety.

### TL;DR

- Most upgrades are automatic — schema `v16 → v18` migrations run
  idempotently on first boot.
- Three breaking changes worth a manual check (detailed below).
- Substantive new capabilities you'll want to adopt — portable export,
  file-extension notes, upsert-on-update.

### Step-by-step

1. **Stop the daemon** before upgrading:

   ```
   parachute stop vault
   ```
2. **Pull the new package**:

   ```
   parachute upgrade vault
   # or: npm install -g @openparachute/vault@latest
   ```
3. **Restart the daemon**:

   ```
   parachute start vault
   ```
4. **Verify the migration ran**. `parachute-vault doctor` reports the
   active schema version — should be `v18`.
5. **No data action required** unless you hit one of the breaking-change
   call-outs below.

Schema migrations are wrapped in `BEGIN IMMEDIATE` transactions —
crash-resistant, idempotent, no half-applied state. Existing rows
default `extension = "md"` (vault#328), so the new
`(path, extension)` uniqueness collapses to the prior `(path)`
uniqueness on your existing data.

### Breaking changes

#### 1. Tag rename no longer returns 409 on token conflict (vault#240 / vault#247, in 0.4.2)

Pre-0.4.2, `parachute-vault rename-tag <old> <new>` returned 409
`tag_in_use_by_tokens` when any token's `scoped_tags` referenced the
old name. Post-0.4.2, rename cascades transparently across every
surface in one transaction — `tags`, sub-tags, `note_tags`,
`parent_names`, `tokens.scoped_tags`, `indexed_fields.declarer_tags`,
note body `#oldname` references, and `_tags/<old>` config paths.
Response is now `200` with per-surface cascade counts.

**Action**: if you have scripts that key on the 409 to abort,
adapt them to read the `200` cascade-stats body. The token-rewrite
itself happens automatically — no manual cleanup needed.

#### 2. `note_schemas` + `schema_mappings` tables retired (vault#267, in 0.4.2)

Schema v17 dropped the standalone `note_schemas` / `schema_mappings`
subsystem and the six MCP tools that managed it (`list-note-schemas`,
`update-note-schema`, `delete-note-schema`, `list-schema-mappings`,
`set-schema-mapping`, `delete-schema-mapping`). The corresponding
`/api/note-schemas` REST endpoints are gone. `tags.fields` is now
the sole schema surface.

**Action**: real vaults had zero rows in these tables, so the
migration is silent. If you had custom callers using those MCP
tools, migrate to `list-tags` / `update-tag` with the `fields`
parameter. The DB migration logs the names of any dropped schemas
+ mappings so you can recreate them as `tags.fields` declarations
if needed.

#### 3. Path uniqueness widened to `(path, extension)` (vault#328, in 0.4.5)

The unique index on `notes.path` is now `(path, extension)`. This
lets `Recipes/pasta.md` and `Recipes/pasta.csv` coexist. Wikilinks
to ambiguous bare paths (`[[Recipes/pasta]]` when both extensions
exist) are refused and recorded as unresolved; use the explicit
form `[[Recipes/pasta.md]]` or `[[Recipes/pasta.csv]]`.

**Action**: vaults that only contain `.md` notes see no behavior
change — every row defaults `extension = "md"` and the composite
uniqueness reduces to the prior `(path)` uniqueness. If you start
authoring non-markdown notes, pass `extension` on `create-note` /
update wikilinks in existing content to use the explicit form
where you intentionally want one extension over another.

There's a smaller behavioral shift worth knowing about: scripted
`mcp-install` defaults changed from global (`user` scope, writes
`~/.claude.json`) to directory-private (`local` scope, writes
`projects[<cwd>].mcpServers` in `~/.claude.json`) in 0.4.4-rc.3
(vault#293). Add `--install-scope user` if you want the old global
behavior in scripts. Interactive `mcp-install` always prompts.

### What you can now do

Ranked by impact for operators upgrading from 0.2.4:

- **Lossless portable export.** `parachute-vault export <dir>` writes
  git-tractable markdown (`.parachute/vault.yaml` + per-tag schemas +
  notes with frontmatter + attachment binaries). `parachute-vault
  import <dir>` is the lossless inverse. `--blow-away` wipes and
  replays for disaster recovery. `--since <iso>` for incremental
  exports (git projections, SSG rebuilds). Round-trip is
  byte-identical (vault#308).
- **Non-markdown notes as first-class.** Pass `extension: "csv"`
  (or yaml/json/mdx/txt/etc.) on `create-note`. Frontmatter-compatible
  formats (md, mdx) carry metadata inline; the rest get a sidecar
  at `.parachute/notes-meta/<id>.yaml`. Filter by extension via
  `query-notes extension: ["csv", "yaml"]` or REST
  `?extension=csv&extension=yaml` (vault#328).
- **Upsert-on-update.** Pass `if_missing: "create"` on `update-note`
  (MCP) or `PATCH /notes/:id` (REST). Eliminates the query-then-create
  round trip on nightly syncs. Response carries `created: true|false`
  so sync loops can branch without a follow-up query (vault#309).
- **Bracket-style metadata filters** for REST `GET /notes`:
  `?meta[field][op]=value` with `eq` / `ne` / `gt` / `gte` / `lt` /
  `lte` / `in` / `not_in` / `exists`. Also bridges to real columns
  for `created_at` / `updated_at` (`?meta[updated_at][gte]=...` for
  incremental rebuilds — vault#286, vault#289).
- **Schema inheritance.** Tags can declare `parent_names`; a child's
  effective fields = its own ∪ all ancestors'. `_default` is the
  implicit universal parent. Conflict resolution is first-in-walk-wins
  with an advisory `schema_conflict` warning (vault#270).
- **Hub-minted auth.** `parachute-vault mcp-install --mint` (now the
  default) reads `~/.parachute/operator.token`, requests a JWT from
  the hub, and configures the MCP client. JWTs are revocation-checked
  every request (60s cache, fail-open on hub outage). `--legacy-pat`
  falls back to `pvt_*` opaque tokens with a deprecation notice
  (vault#212).
- **Interactive `mcp-install`.** Bare `parachute-vault mcp-install`
  from a TTY walks through vault choice, install scope, auth mode,
  and previews the exact JSON before any network call (vault#292).
- **Case-collision safety.** Exports probe filesystem case-sensitivity
  and auto-disambiguate colliding filenames on macOS APFS / Windows
  NTFS while keeping canonical paths in frontmatter (vault#327).
- **Empty notes are valid.** Skeleton notes, drafts-saved-before-
  content, organizing-only notes all create + round-trip cleanly
  (vault#323).

### Where to learn more

- [CHANGELOG.md](./CHANGELOG.md) — chronological per-release notes.
- [parachute-patterns cookbook](https://github.com/ParachuteComputer/parachute-patterns)
  — recipes for portable export, schema inheritance, upsert sync.
- [parachute.computer/design](https://parachute.computer/design) —
  architecture references for the module protocol and OAuth shape.

### Reporting issues

If your upgrade surfaces something not covered here, please file at
[ParachuteComputer/parachute-vault/issues](https://github.com/ParachuteComputer/parachute-vault/issues).
