# Changelog

All notable changes to Parachute Vault are documented here.

This project loosely follows [Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).

## A note on versioning between launch (0.2.4) and 0.4.5

CHANGELOG entries between `0.2.4` and `0.4.5` narrate development work,
but not every entry corresponds to a published version on npm. The
entries starting at `0.3.6-rc.1` (2026-04-26) chronicle internal RC
version bumps in `package.json` during active development; only a subset
were pushed to the npm registry:

| Listed in CHANGELOG                       | Actually published to npm                    |
| ----------------------------------------- | -------------------------------------------- |
| `0.3.6-rc.1` through `0.3.6-rc.39`        | `0.3.0-rc.1`, `0.3.0`, `0.3.1`, `0.3.3`      |
| `0.4.0-rc.1`, `rc.2`, `0.4.0` stable      | `0.4.0` only                                 |
| `0.4.1` chain through `0.4.2`             | (none published)                             |
| `0.4.3-rc.1`, `rc.2`, `0.4.3` stable      | `0.4.3` only                                 |
| `0.4.4-rc.1` through `rc.14` + stable     | `0.4.4-rc.11`, `rc.12`, `rc.14` only         |
| `0.4.5-rc.1`, `rc.2`, `0.4.5` stable      | `0.4.5` only                                 |

Most beta users running an `npm install`-style upgrade between launch
and 0.4.5 ended up on one of: `0.2.4` (no upgrade), `0.3.0`, `0.3.1`,
`0.3.3`, `0.4.0`, `0.4.3`, or `0.4.5`. The "0.3.6" series in the
chronological CHANGELOG below never had a corresponding npm version.

The versioning discipline now codified in
[`parachute-patterns/patterns/governance.md`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md)
(Rule 2 — RC versioning) was instituted as a response to this drift,
around the 0.4.4 cycle. Going forward each CHANGELOG entry on a
code-touching PR bumps the `rc.N` suffix and gets published to npm
under the `@rc` dist-tag; stable promotes drop the suffix and publish
to `@latest`.

## [Unreleased]

## [0.4.8-rc.8] - 2026-05-25

### Fixed

- Unblock Linux release CI for the `web/ui/dist` shipping fix (rc.7 was burned — release CI failed at the test gate before publish; rc.8 re-issues the same payload with the test fixes below). Two pre-existing Linux-only test bugs that had never surfaced because vault tests had never run on Linux until vault#361's tag-triggered workflow landed:
  - **`runBackup` wrote the tarball into the directory it was reading.** `assembleTarball` runs `tar -czf <out> -C <stagingDir> <entries>` where `entries = readdirSync(stagingDir)`. The prior layout put the output at `stagingDir/__out__/<name>.tar.gz`, so `__out__` was in `entries` and tar enumerated the subdir while also writing to it. GNU tar (Linux) treats "file changed as we read it" as fatal; BSD tar (macOS) tolerates the race. Fix: write the tarball to a sibling tempdir, completely outside tar's input set. Affects 3 backup integration tests + 1 `vault backup` CLI test.
  - **`seedVaultWithNotes` polluted `process.env.HOME` without restoring it.** The helper sets HOME so the deferred re-import of `vault-store.ts` reads the test's isolated PARACHUTE_HOME. It never restored either env var, so the polluted value leaked into `resolveInstallTarget` tests in the same process — that function reads `process.env.HOME` directly (Bun caches `os.homedir()` at process start). Fix: capture HOME/PARACHUTE_HOME at module load, restore in afterEach of every describe that calls `seedVaultWithNotes`. Affects 2 install-target tests.

  Closes vault#363.

## [0.4.8-rc.7] - 2026-05-25

### Fixed

- Ship the built admin SPA bundle (`web/ui/dist/`) in the published npm tarball. Previously, any vault installed via `bun add -g @openparachute/vault` (e.g. hub's supervised vault on cloud deploys) hit a 503 on `/vault/<name>/admin/*`: "vault admin SPA bundle not found — run `bun run build` in web/ui/ to produce dist/". The 503 came from `src/admin-spa.ts` finding no `web/ui/dist/` on disk because `package.json` `files:` never shipped the SPA bundle and there was no build hook. PR adds `web/ui/dist` to `files:`, a `build:spa` script, a `postinstall` (gated on `web/ui/` existing — no-op for npm-installed consumers), and a `prepack` so the SPA always rebuilds before publish. Mirrors hub's pattern. Closes vault#362.

## [0.4.8-rc.6] - 2026-05-23

### Removed

- Dropped `kind` field from the `/.parachute/info` runtime endpoint response. Companion to vault#359's module.json drop — kind is no longer part of vault's external contract. Closes part of hub#340.

## [0.4.8-rc.5] - 2026-05-23

### Removed

- Dropped `kind` field from `.parachute/module.json`. Hub's validator made the field optional in hub#327; this PR completes the cleanup per hub#330 Phase B (kind retirement). No behavior change — vault was never branched-on by kind.

### Changed

- `VaultModuleManifest.kind` is now optional (mirrors hub#327's posture). The required-field check on `health` was split out of the prior combined `health`/`kind` validation. Legacy manifests still ship-and-parse fine; new manifests omit the field. Deprecation note added in the type docstring.
- `self-register.test.ts` fixture dropped `kind` to match the new canonical manifest shape.

## [0.4.8-rc.4] - 2026-05-21

feat(vault): enable WAL mode for multi-process SQLite concurrency (#326).

The vault SQLite database now runs in **WAL** (write-ahead logging) journal
mode by default. Before this change `journal_mode` defaulted to the SQLite
classic `DELETE` rollback journal — fine for a single-process daemon, but
incompatible with concurrent multi-process access patterns. `parachute-runner`
polling `tag:job` while the user writes notes through the running daemon is
exactly that pattern, and `vault#323`'s `daemon-busy` guard on `import` was
the symptom: a second connection couldn't get past the writer's lock.

Under WAL: a single writer plus an arbitrary number of concurrent readers
all see consistent snapshots. The new `applyConnectionPragmas` helper in
`core/src/schema.ts` is invoked on every Database open via the existing
`initSchema` entry point and the refactored `openVaultDb` — it sets:

  - `PRAGMA journal_mode = WAL`
  - `PRAGMA synchronous = NORMAL` (safe + recommended pairing per SQLite docs)
  - `PRAGMA wal_autocheckpoint = 1000` (explicit default — 1000 pages ≈ 4MB)
  - `PRAGMA foreign_keys = ON`

It also verifies WAL actually took effect (capturing the return value of
the `PRAGMA journal_mode = WAL` statement) and logs a one-time `[vault]
WAL mode could not be enabled` warning when an underlying filesystem (NFS,
some FUSE / Docker volume drivers) silently refuses the WAL flip. Operators
on those filesystems retain single-writer semantics and now know it.

**Backwards compatibility**: existing vaults created in DELETE journal mode
are migrated to WAL on next open by SQLite itself — no data migration, no
schema bump. **Backup compatibility**: `parachute-vault backup` already
uses `VACUUM INTO` (WAL-safe by design), so the snapshot/restore path is
unchanged. Manual hand-copies of `vault.db` should now also copy the
`vault.db-wal` and `vault.db-shm` sidecars if the database is open and
in-flight — documented in `README.md`.

Long-term followup tracked at vault#326 is the **single-writer** rail
(option 2 in the original issue): route the CLI's write-side commands
through the daemon's HTTP/MCP surface when the daemon is running, so two
processes never compete for the writer slot. This PR delivers option 1
(the read-side win) so multi-reader patterns like `parachute-runner` work
today; the writer-routing piece stays on the roadmap.

## [0.4.8-rc.3] - 2026-05-21

feat(vault): self-register manifest + installDir at startup (#266).

POC for retiring `parachute-hub`'s `FIRST_PARTY_FALLBACKS[vault]` vendored
manifest. Hub currently ships a hard-coded `VAULT_FALLBACK` block in
`service-spec.ts` because (a) bun-link dev mode never runs the hub install
path so `installDir` isn't stamped on the services.json row, and (b) v0.5
vault didn't ship its own `.parachute/module.json` so hub had no manifest
to read at lifecycle time. The endgame — every first-party module
self-registers its manifest + installDir on startup, hub's vendored
fallbacks retire one by one — starts here.

### What ships

- **`src/module-manifest.ts`** — narrow reader for the package's own
  `.parachute/module.json`. Resolves the package root via
  `import.meta.url` (works for both `bun src/cli.ts` dev runs and the
  published-package `parachute-vault` binary). Validates only the fields
  vault stamps onto services.json today (name, manifestName, displayName,
  tagline, kind, port, paths, health, stripPrefix); full validation is
  hub's job at install time.
- **`src/self-register.ts`** — boot-time self-registration. Reads the
  local manifest + computes installDir (the directory containing
  `package.json` + `.parachute/module.json`) and upserts a row into
  `~/.parachute/services.json` carrying both. Idempotent: re-runs report
  `changed: false` when nothing actually shifts. Routed through the
  existing merge-preserving `upsertService` so hub-stamped fields on the
  row (e.g. `installDir` from `parachute-hub#84`, anything future)
  survive each self-registration pass.
- **`src/server.ts` boot wires** `selfRegister({ version: pkg.version })`
  right after the vault auto-creation block. Failure modes (manifest
  missing, services.json unreadable, write failure) log a warning and
  continue — boot must not fail on bookkeeping.
- **CLI registration paths converge** — `cmdInit` and `cmdCreate`
  previously called `upsertService` directly with a hand-built entry that
  omitted displayName/tagline/stripPrefix/installDir. Both now route
  through `selfRegister` so the row from `parachute-vault init` matches
  the row from server boot. Drops two `upsertService` call sites and the
  duplicated `buildVaultServicePaths` (the helper moves into
  `self-register.ts` as the canonical implementation).

### Design choice — filesystem-direct rather than HTTP

In v0.6 (single-container, hub-as-supervisor) hub and vault share the
same filesystem; writing directly to `services.json` with the existing
merge-preserving `upsertService` is the simplest shape that works today
without growing a hub-side endpoint. v0.7 (multi-container cloud) will
need a hub `POST /api/modules/self-register` so a module on a different
container can register without filesystem access to the operator's
`~/.parachute/`. That endpoint is filed as a separate hub follow-up;
this PR's `selfRegister` function is forward-compatible — it's the
single seam that would swap from filesystem to HTTP transport.

### Forward-compatibility with hub's vendored fallback

`FIRST_PARTY_FALLBACKS[vault]` in hub remains in place until every
first-party module ships self-registration reliably (notes, scribe,
runner have their own follow-up issues). The fallback is additive today:
hub reads vault's `installDir` from the self-registered row when
present, and falls back to the vendored manifest only when the row is
missing — which is exactly the state a fresh `bun add @openparachute/vault`
produces before vault has booted once.

## [0.4.8-rc.2] - 2026-05-21

feat(vault): query-notes opaque cursor for since-last-checked agent loops (#313).

Agent loops (Gitcoin Brain, parachute-runner, any "give me what's new"
polling consumer) previously had to track an `updated_at` watermark
client-side and pass it back as `date_filter: { field: "updated_at",
from: <iso> }`. Brittle — wall-clock races at the millisecond boundary
could miss or double-count rows, and every consumer reinvented the
watermark bookkeeping.

`query-notes` now accepts an optional `cursor` parameter. The response
shape switches to `{notes, next_cursor}`; the cursor is opaque
(base64url-encoded JSON internally) and self-contained, so it survives
process restarts and works across deployments. Pass the `next_cursor`
back on the next call to receive only notes created or updated since
the prior page.

### What ships

- **New `cursor: string` parameter** on the `query-notes` MCP tool and
  the `GET /vault/<name>/api/notes` REST endpoint. When present, switches
  the response to `{notes, next_cursor}` and routes through a new
  `Store.queryNotesPaged()` method backed by keyset pagination on
  `(updated_at, id)` — the id is a tiebreaker for the rare two-notes-at-
  the-same-millisecond case so neither row is skipped nor doubled across
  page boundaries.
- **Cursor binds to the query** via sha256 of the result-set-affecting
  filters (tag, path, metadata, date filters, etc. — `limit`/`offset` and
  output-shape params are excluded). Reusing a cursor on a different
  query raises a structured `400 cursor_query_mismatch` rather than
  silently returning wrong rows.
- **`next_cursor` is always present**, even on an empty result page —
  the watermark advances only when actual rows are returned, so a
  polling agent can persist a single string and keep calling without
  special-casing the empty case.
- **Backwards compatible.** Existing callers (no `cursor` param) get
  the legacy flat-array shape; nothing changes for them. `dateFilter`
  remains the lower-level primitive for absolute date ranges — cursor
  and dateFilter coexist (cursor is "since last checked," dateFilter is
  "between X and Y").
- **Engine-level constraints**: cursor mode rejects `sort: desc` (a
  descending iteration would skip newly-written rows) and `order_by`
  (incompatible with the updated_at keyset). MCP-level: cursor is also
  rejected with full-text `search` (FTS has its own ordering) and
  `near` (graph neighborhoods aren't cursor-stable). All four return
  `400 INVALID_QUERY` so the agent loop fails loud rather than silent.

### Engineering notes

`core/src/cursor.ts` is the canonical home for the codec — `encodeCursor`,
`decodeCursor`, `computeQueryHash` (with stable key-order canonicalization
so SDK-side reshuffling doesn't invalidate cursors), plus the
`CursorError` class with `cursor_invalid` / `cursor_query_mismatch`
codes. Tests pin the codec in `core/src/cursor.test.ts`; integration
against `queryNotesPaged` lives in `core/src/core.test.ts` under
`describe("cursor pagination")`. HTTP plumbing tests in
`src/vault.test.ts` under `HTTP /notes` exercise the wrapped envelope,
the structured 400s, and an end-to-end resume across calls.

## [0.4.8-rc.1] — 2026-05-21

feat(vault): auto-transcribe voice uploads via scribe (vault#353).

Part 2 of the [vault↔scribe connection design](https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-scribe-config-and-vault-scribe-connect.md)
(site#52). When an audio attachment lands in a vault — via Notes capture,
the REST API, or any other write path — and the operator has enabled
auto-transcribe, vault forwards the audio to scribe asynchronously and
materializes the result as a sibling `<attachment-path>.transcript.md`
note. Failures (no provider configured, scribe down, timeout) surface as
the same transcript note with `transcript_status: failed` plus the cause
in `transcript_error`. The original audio attachment is never deleted by
this path — it's preserved for retry.

### What ships

- **Inline audio-detect on attachment write.** `POST /vault/<name>/api/notes/<id>/attachments`
  inspects the incoming `mime_type`; when it starts with `audio/` AND
  `auto_transcribe.enabled === true` AND scribe is discoverable, the
  attachment is stamped with `transcribe_status: pending` +
  `transcribe_origin: "auto"`. The existing transcription worker picks it
  up via the `attachment:created` hook (single-digit-ms event-driven path)
  or the 30s sweep (safety net).
- **Service discovery via `~/.parachute/services.json`** (`scribe-discovery.ts`).
  Vault locates scribe by reading the canonical hub-maintained registry
  on first call; the `SCRIBE_URL` env var still wins when set. Cached
  for process lifetime; restart vault to pick up a re-registered scribe.
- **Bearer generation at first boot** (`scribe-env.ts:ensureScribeBearer`).
  When neither `SCRIBE_AUTH_TOKEN` nor the legacy `SCRIBE_TOKEN` is set,
  vault generates a 32-byte base64url bearer and persists it to
  `~/.parachute/vault/.env`. Idempotent — subsequent boots see the
  existing value and don't rotate. Operators are expected to mirror the
  generated bearer into scribe's `SCRIBE_AUTH_TOKEN`; without that
  mirror, transcription fails gracefully with a 401 captured on the
  transcript note.
- **Transcript-note materialization** (`transcript-note.ts`). The
  worker's auto-origin path writes a note at `<attachment-path>.transcript`
  with frontmatter linking back to the original audio:

  ```yaml
  title: Transcript of <filename>
  transcript_of: <attachment-path>
  transcript_attachment_id: <attachment id>
  transcript_status: complete | failed
  transcript_duration_ms: <ms>
  transcript_error: <cause — failed only>
  ```

  Body is the transcript text on success, empty on failure. Tags are
  `[transcript, capture]`. A typed link `transcript_of` is also
  materialized so vault graph queries surface the relation without
  walking frontmatter.
- **Retry endpoint.** `POST /vault/<name>/api/notes/<note-id>/retry-transcription`
  re-enqueues the original audio attachment by flipping its
  `transcribe_status` back to `pending` and kicking the worker.
  Validates the target is a failed transcript note, surfaces clear
  error branches (`invalid_target`, `not_failed`,
  `missing_attachment_id`, `attachment_missing`, `audio_missing`).
  202 on success. The same transcript note is overwritten in place;
  the note id is preserved across retries.
- **Config schema grows `autoTranscribe.*`** (`module-config.ts`). Three
  fields per the design's Q4:
  - `autoTranscribe.enabled` — boolean toggle, default false. Persisted
    in `~/.parachute/vault/config.yaml` under the new `auto_transcribe`
    block.
  - `autoTranscribe.scribeUrl` — readOnly. Effective value resolved
    per-process via `scribe-discovery.ts` (services.json or env override).
  - `autoTranscribe.scribeBearer` — writeOnly. Never returned by GET.
    Sourced from `SCRIBE_AUTH_TOKEN`.

  Legacy `scribe_url` / `scribe_token` are kept as deprecated aliases
  for one release so existing hub admin SPA renders don't regress.

### What's deferred to v0.7

- **Hub-issued JWT replaces the shared bearer.** The loopback shared
  secret is the v0.6 stepping stone per design Q2. Vault swaps the
  bearer for a hub-minted JWT with scope `scribe:transcribe` when
  hub-as-issuer lands; scribe's existing `hub-jwt.ts` validation seam
  is already in place. No wire-shape change — only the token contents.
- **Live-tail of transcription progress** (websocket / SSE from scribe).
  Today's flow is fire-and-write-when-done.
- **Audio retention `until_transcribed` polish.** Today's worker already
  honors the retention enum; no change needed for v0.6.
- **Auto-retry on transient 5xx with backoff cap.** Already implemented
  for the legacy worker path — extends naturally to auto-origin in a
  future PR.

### Versioning

`0.4.8-rc.1`. New rc chain for a feature PR (per governance Rule 2 —
RC versioning at the target stable, not as separate patches).

## [0.4.7-rc.3] — 2026-05-21

fix(vault): `mcp-install` admin-scope path no longer round-trips to hub
mint-token (which rejects it by policy).

### Symptom

Running `parachute vault mcp-install`, picking the `admin` option in the
interactive auth prompt, surfaced:

```
Hub mint-token rejected (HTTP 400, invalid_scope): scope vault:default:admin
is not requestable via mint-token; use OAuth flow or operator rotation
```

The mint-token endpoint has always rejected `vault:<name>:admin` — per-vault
admin is non-requestable by hub policy (see
[`parachute-hub/src/scope-explanations.ts`](https://github.com/ParachuteComputer/parachute-hub/blob/main/src/scope-explanations.ts)'s
`VAULT_ADMIN_RE` + `api-mint-token.ts`'s non-requestable guard). It's mintable
only through the session-cookie-gated `/admin/vault-admin-token/<name>` SPA
endpoint. Vault's `mcp-install` flow shipped this latent bug since vault#291
introduced the `--mint` mode; it stayed latent until an operator exercised
the admin branch.

### Fixed

- **Interactive flow auto-routes `admin` → `legacy-pat`.** Picking "admin"
  at the auth prompt now mints a vault-DB `pvt_*` with full admin
  permissions (the right shape for a local MCP entry needing schema
  management) and prints a one-line explanation of the auto-route so the
  switch isn't silent. Prompt help text updated to telegraph the routing
  upfront.

- **Flag-driven `--mint --scope vault:admin` rejected pre-flight.** The
  combination errors out with an actionable remediation before any
  operator-token / hub-origin check, pointing at
  `--legacy-pat --scope vault:admin` (the working path) and naming the
  admin SPA at `<hub>/admin/vaults/<name>` for operators who'd rather use
  the browser path. The rejection happens locally — no hub round-trip.

- **Docs + help text.** The `mcp-install` function docstring, the inline
  `--legacy-pat` description in `parachute-vault --help`, and the
  interactive prompt's help block all now say "admin requires
  --legacy-pat" explicitly. Removes the trap where the help text listed
  `vault:admin` as a `--scope` choice with no caveat.

### Tests

- `src/mcp-install-interactive.test.ts` — the existing
  `"typing 'admin' produces vault:admin mint"` test was inverted: it
  pinned the buggy behavior. Replaced with a regression test that
  asserts (a) `mode === "legacy-pat"`, (b) `scope === "vault:admin"`,
  and (c) the user-facing explanation appears in the captured log.
- `src/mcp-install.test.ts` — new
  `"rejects --mint --scope vault:admin pre-flight"` test exercising
  Aaron's exact CLI invocation. Pins the remediation message wording
  (`--legacy-pat --scope vault:admin`) and verifies the reject fires
  *before* the operator-token / hub-origin checks (no "Hub unreachable"
  / "No hub origin configured" leak when the operator wasn't going to
  reach the hub anyway).

## [0.4.7-rc.2] — 2026-05-21

fix(vault): export detects case-collision on case-insensitive filesystems
(closes [#327](https://github.com/ParachuteComputer/parachute-vault/issues/327)).

The original 0.4.5-rc.2 fix landed silent auto-disambiguation —
`Journal/Foo.md` and `Journal/foo.md` would both export on macOS APFS
default, but the second note got an `__<id-short>` filename suffix with
no signal printed to the operator. The "silent" half of "silent note loss"
wasn't actually solved — operators with case-colliding vaults still had
no way to notice without poring through the typed `ExportStats` return.

This rc closes the gap two ways:

### Added

- **CLI surfaces case-collision auto-disambiguation explicitly.** When
  `parachute-vault export` lands on a case-insensitive filesystem and
  detects collisions, every disambiguated path now prints to stderr with
  a `Warning:` prefix + a one-line summary count + a pointer to the new
  `--strict-case-collision` flag and #327. Watch mode prints a per-cycle
  `[watch] case-collision: N disambiguated path(s) this cycle` line, so
  the moment a new collision appears in a running mirror loop, the
  operator sees it.

- **`--strict-case-collision` CLI flag + `failOnCaseCollision: boolean`
  on `ExportOptions`** — opt-in fail-fast. When set, the export pre-
  scans the (already-loaded) note list for lowercased-path conflicts
  before any write lands on disk and throws a typed `CaseCollisionError`
  naming every colliding path + the actionable instruction
  ("Rename one of them in the vault before re-exporting, or run from a
  case-sensitive filesystem"). N-way collisions
  (`Foo.md` + `foo.md` + `FOO.md`) and multi-group collisions
  (independent `(Bar, bar)` + `(Baz, baz)` pairs) both surface in a
  single error so the operator fixes the whole set in one pass — no
  paint-by-numbers re-export cycle.

- **`CaseCollisionError` exported from `core/src/portable-md.ts`** with
  a `collisions: Array<Array<{ note_id, path, extension }>>` field for
  programmatic callers. The CLI catches it in both single-shot and
  watch-initial paths, prints the actionable message, and exits non-zero
  so scripts catch failures deterministically.

### Decision: default remains auto-disambiguate; strict mode is opt-in

The 0.4.5 fix's auto-disambiguation path is preserved as the default
because (a) it's lossless — both notes land on disk with the canonical
path intact in frontmatter and round-trip cleanly through import, and
(b) hard-failing every cycle would block the new vault-sync mirror
loop ([#348](https://github.com/ParachuteComputer/parachute-vault/issues/348))
the moment a colliding pair appears, with no path forward but rolling
back the feature. Strict mode is the one-shot CLI flow's escape hatch
when the operator wants to be forced to fix the source-of-truth.

### Tests

Seven new tests under `core/src/portable-md.test.ts` →
`describe("case-collision detection (vault#327)")`:

- `failOnCaseCollision` throws `CaseCollisionError` with both paths +
  the actionable instruction enumerated in `.message`.
- `failOnCaseCollision` is a no-op when the FS is case-sensitive (probe
  override forces the path).
- `failOnCaseCollision` is a no-op on case-insensitive FS when nothing
  collides (single-note pre-scan walks clean).
- Three-way collision lists all three paths in the error.
- Two independent collision groups both surface.
- Directory-level case difference (`Notes/foo` vs `notes/foo`) is
  detected by the lowercased-path key.
- Default (no opt-in) still auto-disambiguates — back-compat contract
  pinned.

### Suite

- `bun test ./core/src/` — 536 pass (+7 over `rc.1`), 0 fail
- `bun test ./src/` — 1086 pass (unchanged), 0 fail
- `bun run typecheck` — clean
- `bunx biome check src/ core/src/` — clean

## [0.4.7-rc.1] — 2026-05-20

Phase A1 of the vault-sync arc — the persistent, vault-managed counterpart
to the manual `parachute-vault export --watch --git-commit` CLI mode that
shipped in `0.4.6` (#346). Vault now reads a `mirror:` block from
`config.yaml` at boot, bootstraps an internal or external git mirror per
the operator's choice, and (optionally) runs the export-watch loop
in-process — no external cron, no separate shell loop, no manual restart
after a config change. See the design doc:
[`parachute.computer/design/2026-05-20-vault-as-git-projection.md`](https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-20-vault-as-git-projection.md).

The CLI primitive from #346 is unchanged; this rc adds the persistent
form alongside it.

### Added

- **`mirror:` block in `config.yaml`** — eight fields (`enabled`,
  `location`, `external_path`, `watch`, `auto_commit`, `auto_push`,
  `commit_template`, `interval_seconds`). Default `enabled: false` so
  vaults upgrading across this PR boundary see zero behavior change
  until they explicitly opt in. Parsed alongside the existing top-level
  keys via the same hand-rolled YAML conventions as `triggers:` /
  `backup:`. Implementation: `src/mirror-config.ts`.

- **Boot-time mirror lifecycle** — when `mirror.enabled: true`, the
  vault server resolves the path, bootstraps an internal mirror if
  needed (`mkdir` + `git init` + initial commit), runs an initial
  full export to bring the mirror to current state, and (if
  `watch: true`) arms an in-process polling loop that re-exports +
  optionally commits on every interval. The watch loop reuses the
  `runGitCommitCycle` helper from #346 — same commit shape, same
  skip rules for `.parachute/`-only churn. Implementation:
  `src/mirror-manager.ts`.

- **Two mirror-location modes**:
  - `internal` → `~/.parachute/vault/data/<vault>/mirror/`. Vault-
    managed; recreated automatically if missing on next boot.
    Bootstrap refuses to clobber a pre-existing non-empty, non-git
    directory — operator chooses cleanup explicitly.
  - `external` → operator-picked path; must exist and be a git repo
    before vault attempts a write. Designed for Obsidian / GitHub /
    shared backups.

- **`GET /vault/<name>/.parachute/mirror`** — admin-gated read of the
  persisted mirror config + the runtime status (resolved path, watch
  status, last export timestamp, last commit sha, most recent error).
  Returns defaults when no `mirror:` block has been written yet so
  the future hub admin SPA always renders against a consistent shape.

- **`PUT /vault/<name>/.parachute/mirror`** — admin-gated update of
  the mirror config. Validates JSON shape + (when `enabled: true`)
  the external path exists and is a git repository. Atomic write to
  `config.yaml`, then in-process restart of the watch loop with the
  new shape — no vault restart needed. Disable-only `{enabled:
  false}` PUTs skip the path validation so an operator can disable
  a mirror whose path has gone missing. Errors are 400 with
  actionable messages naming the offending field.

- **`MirrorManager` lifecycle controller** — singleton per-process
  with `start` / `stop` / `reload` / `runNow` semantics, status
  tracking, and shutdown drain wired into the existing
  `SIGINT`/`SIGTERM` handlers. Dependency-injected `runExport`,
  `firstChangedNoteTitle`, `readMirrorConfig`, `writeMirrorConfig`
  for unit-testability — tests instantiate the manager directly
  without spawning a vault server.

- **URL note** — the design doc names the endpoint `/admin/mirror`,
  but `/vault/<name>/admin/*` is already mounted to the admin SPA's
  static-file bundle (#252). The mirror API lives under
  `.parachute/mirror` instead, sibling to the existing
  `.parachute/config` + `.parachute/info` per the module-protocol
  convention. The hub Phase A2 SPA (future PR) will call this URL
  directly.

### Out of scope for Phase A1

- Hub admin SPA page for configuring mirrors — Phase A2, future PR.
- Bidirectional sync (Architecture B from the design doc) — deferred
  pending demand signal.
- UI history surface in the vault SPA — Phase A1.5 or A2.

## [0.4.6] — 2026-05-20

Stable release covering the multi-user companion + Gitcoin Brain enablement. Cumulative changes since `0.4.5`:

- **`PARACHUTE_VAULT_NAME` env var** (#342): first-boot vault naming via env var. Replaces the hardcoded "default" so hub's wizard can thread the operator's typed vault name through to vault. Length-validated (2-32 chars).
- **`vault_scope` claim consumer** (#344): vault now enforces the `vault_scope` claim from hub-issued JWTs. A token with `vault_scope: ["aaron"]` reaching `/vault/bob/*` returns 403. Defense-in-depth at the resource server for multi-user Phase 1.
- **`parachute-vault mcp-config <name>` CLI** (#345): emits the inline MCP config JSON for `claude -p` runners. Eliminates per-script boilerplate.
- **`mcp-install --dry-run`** (#345): probe `mcp-install` without writing.
- **Doc fixes** (#345): mcp-install recommends `--install-scope user` for headless flows; README notes the Accept-header requirement for the local MCP endpoint.
- **`parachute-vault export --watch + --git-commit`** (#346): live mirror of vault to a markdown directory with optional auto-commit + auto-push. Enables Aaron's Gitcoin Brain vault-as-git-projection workflow.
- **Standalone `render.yaml` deprecated** (#342): per the v0.6 option-A architecture, vault doesn't deploy standalone. The file is retained for advanced users with a clarifying comment.

See individual rc entries below for full detail.

## [0.4.6-rc.6] — 2026-05-20

Aaron's Gitcoin Brain build wants vault as the system of record and a git
mirror as the auto-history projection — same shape as the `vault-portable-
export` cookbook's "git-as-projection" recipe, but live instead of cron-
driven. This rc folds the two missing primitives directly into the CLI so
the operator wires one command, not a cron + a webhook + a shell script.

### Added

- **`parachute-vault export <dir> --watch [--interval <seconds>]`** — stay
  alive after the initial export, re-export incrementally on every vault
  write. Detection is polling on `updated_at >= cursor` (vault writes are
  HTTP-mediated; the bun:sqlite DB is opaque to filesystem watchers, so
  polling is the simplest robust signal). Default interval 5s. Each cycle
  prints a tight status line — `[watch] exported N notes (cursor: ISO)` or
  `[watch] no changes`. Graceful shutdown on SIGINT/SIGTERM
  (`[watch] stopping watch`, exit 0).

- **`parachute-vault export <dir> --git-commit [--git-message-template <t>] [--git-push]`**
  — after each export, `git add -A` + `git commit -m <rendered-template>`
  in `<dir>`. Repo must already be initialized (fails fast with `git init`
  guidance, not after sitting in a watch loop emitting the same error every
  interval). Template variables: `{{date}}`, `{{notes_changed}}`,
  `{{plural}}` (empty when notes_changed === 1), `{{first_note_title}}`,
  `{{vault_name}}`. Default template:
  `export: {{date}} ({{notes_changed}} note{{plural}})`. Empty commits
  skipped; pure `.parachute/vault.yaml` `exported_at` churn (no real note
  changes) is detected and skipped too, so a watch loop doesn't grow a
  commit every interval. `--git-push` is non-fatal on failure — a network
  blip warns but doesn't kill the loop.

- **Combined `--watch --git-commit`** — the canonical Aaron-Gitcoin-Brain
  setup. Vault writes flow through to git history automatically with no
  cron, no webhook, no shell glue:

  ```bash
  parachute-vault export ~/projections/team-brain --watch --git-commit --git-push
  ```

  Drop that command in a launchd plist (or `parachute start`-style
  supervisor) and the git mirror tracks the vault.

### Implementation notes

- No new deps. `git add/commit/push` are shelled out via `Bun.spawn`.
  Helpers live in `src/export-watch.ts` (`renderCommitMessage`,
  `shouldCommit`, `runGitCommitCycle`, …) so they're unit-testable without
  spawning the full CLI.
- Watch loop uses `setInterval` with an in-flight guard so a slow cycle
  doesn't stack tasks. Cursor is captured *before* each export runs, so a
  write that lands mid-export is picked up next cycle (cost: at most one
  re-exported note when `updated_at` equals the cursor — `>=` semantics).
- Tests cover the pure helpers, the git shell helpers against real
  throwaway repos, and three CLI end-to-end scenarios:
  initial-export-only-on-idle, write-triggers-re-export, and the combined
  watch+git-commit happy path.

### Cookbook

The `parachute-vault export` recipe in
`parachute-patterns/cookbook/vault-portable-export.md` now has the
"live projection" idiom alongside the existing cron-driven version. The
git-projection design doc on parachute.computer goes long on when to
reach for which.

## [0.4.6-rc.5] — 2026-05-20

Three small wins surfaced while Aaron was wiring the Gitcoin Brain
runner (vault-as-job-substrate; a Python loop spawning
`claude -p --mcp-config '<json>'` against a vault). Each was per-script
boilerplate or a subtle footgun — folded into the CLI here.

### Added

- **`parachute-vault mcp-config <vault-name>`** — emits the JSON shape
  consumed by `claude -p --mcp-config '<json>'` to stdout. The runner
  pattern:

  ```bash
  export PARACHUTE_VAULT_TOKEN=pvt_...
  claude -p --mcp-config "$(parachute-vault mcp-config gitcoin)" \
            --strict-mcp-config ...
  ```

  Flags: `--token <bearer>` (alternative to `PARACHUTE_VAULT_TOKEN`);
  `--base-url <url>` (override the auto-detected origin, useful for
  tailnet-exposed hubs); `--env-vars` (emit the template form with
  `${PARACHUTE_HUB_URL}` and `${PARACHUTE_VAULT_TOKEN}` placeholders —
  safe to commit; shell-expanded at runtime). With no token and no
  `--env-vars`, exits 1 with a clear error: runners get a fail-fast,
  no surprise auto-minting. Literal mode verifies the vault exists
  locally; `--env-vars` mode is shape-only and works offline.

  The synthesizer lives in `mcp-install.ts:buildMcpConfigJson` so
  third-party tools that import vault as a library can reuse the
  shape. Tests in `mcp-config.test.ts` cover both modes + token
  precedence + base-url override + the no-token / unknown-vault
  error paths.

- **`mcp-install --dry-run`** — prints the write that would happen
  (target file, install scope, project key when local, entry key,
  resolved MCP URL, auth mode) without touching disk or hitting the
  hub for a mint. Aaron hit the inverse case: probing `mcp-install`
  was creating an empty `projects[<cwd>]` entry in `~/.claude.json`
  as a side effect. `--dry-run` is the deliberate "tell me what
  you'd do" path for scripts wiring up runners. Skips the
  operator-token check and the hub round-trip entirely — the point
  is "no side effects, including network."

### Changed

- **`mcp-install` success message + help text recommend
  `--install-scope user` for headless flows.** Local-scope MCP entries
  (under `projects[<cwd>].mcpServers` — the default since vault#290)
  are visible to interactive `claude` from the install directory but
  do **not** propagate to `claude -p` subprocesses spawned by scripts,
  even from the same directory and even with
  `--setting-sources user,project,local`. Operators wiring up runners
  need user-scope. The success-line heads-up on local installs now
  says so; the README cookbook has a "headless flows" subsection with
  the full explanation.

- **README — Troubleshooting: 406 on manual `curl` to
  `/vault/<name>/mcp`.** The MCP HTTP transport requires both
  `application/json` and `text/event-stream` in the `Accept` header
  (it negotiates between JSON response and the SSE streaming variant).
  Claude Code's `--mcp-config` http transport sets this automatically;
  the symptom only shows up when probing the endpoint by hand. Added
  a short troubleshooting entry with the working `curl` invocation.

## [0.4.6-rc.4] — 2026-05-20

Hub multi-user Phase 1 PR 5 — consumer-side adoption of the new
`vault_scope` claim hub mints on every JWT (per
[`2026-05-20-multi-user-phase-1.md`](https://parachute.computer/design/2026-05-20-multi-user-phase-1/)).

### Added

- **`authenticateHubJwt` consumes the `vault_scope` claim** via
  scope-guard's new `enforceVaultScope` helper and refuses cross-vault
  access at the consumer with a **403 + `error_type:
  "vault_scope_mismatch"`** response. A token whose `vault_scope`
  claim names a different vault than the URL targets is rejected
  before any vault data is read. Defense-in-depth: hub's mint path
  (PR 4 / parachute-hub#283) already narrows scopes to the user's
  `assigned_vault`, and the existing audience strict-check + broad-
  scope rejection are the primary gates. The new claim adds a second
  pin against the case where a token-mint bug, manual edit, or
  third-party RS not enforcing the scope-string vocabulary correctly
  produces scope strings naming the wrong vault. Five new tests in
  `auth-hub-jwt.test.ts` cover the matching-pin happy path, the cross-
  vault attempt (403), admin tokens (`vault_scope: []`), pre-PR-4
  tokens (claim absent → unrestricted back-compat), and the ordering
  invariant that broad-scope rejection takes precedence over
  vault_scope_mismatch.

### Changed

- **`@openparachute/scope-guard` dep bumped from `^0.2.0` to
  `^0.3.0-rc.1`.** The 0.3.0 minor adds `HubJwtClaims.vaultScope:
  string[]` (parsed from the JWT's `vault_scope` claim; surfaces as
  `[]` when absent / malformed / explicitly empty) and the
  `enforceVaultScope(claims, requestVaultName)` helper. See
  [parachute-hub#285](https://github.com/ParachuteComputer/parachute-hub/pull/285)
  for the library release.

  **Install order**: scope-guard `0.3.0-rc.1` must publish to npm
  before `bun install` here will succeed. The lockfile auto-updates on
  first post-publish install; CI install fails until then.

## [0.4.6-rc.3] — 2026-05-20

Two small items bundled as one cohesive PR:

- **`PARACHUTE_VAULT_NAME` first-boot env var** — companion fix for the
  hub first-boot wizard (hub#267). When the server starts with zero
  vaults on disk and `PARACHUTE_VAULT_NAME` is set to a valid name, the
  auto-created vault uses that name instead of `"default"`. Validation
  reuses `validateVaultName` so the env var, the `--vault-name` flag,
  and hub's wizard all share one rule (lowercase alphanumeric +
  hyphens/underscores, `list` reserved). Invalid values trigger a
  warning and fall back to `"default"` rather than aborting first boot.
  First-boot log lines call out which path was taken:
  `[vault first-boot] using PARACHUTE_VAULT_NAME=<name>` or
  `[vault first-boot] using default name (no PARACHUTE_VAULT_NAME set)`.
- **Standalone `render.yaml` deprecated as primary path** (closes
  vault#341, Option A). The file stays in tree for the operators who
  specifically want vault as its own Render service, but the
  `render.yaml` header and the README's Deployment → Cloud platforms
  section now point the typical v0.6 user at the hub-managed Render
  deploy (`https://parachute.computer/deploy/render/`).

## [0.4.6-rc.2] — 2026-05-18

Fold reviewer nits on PR #340:

- **server.ts** — log `VAULT_AUTH_TOKEN` active state at startup
  (`[auth] VAULT_AUTH_TOKEN set — server-wide operator bearer active`),
  parallel to the existing `[transcribe]` boot signal. Operator gets a
  bare-minimum visible confirmation the gate is armed.
- **render.yaml** — comment that Render injects `$PORT` at runtime; the
  hardcoded `1940` value is the fallback for local `docker run`
  invocations.

## [0.4.6-rc.1] — 2026-05-18

Phase 1 of the v0.6 Render self-host arc (closes vault#339). Lands the
container-shape primitives vault needs to run as a sibling Render
service alongside hub:

- **Dockerfile + .dockerignore** — two-stage build mirroring
  parachute-hub's shape: `oven/bun:1.3-alpine` base, runtime stage with
  `tini` for SIGTERM forwarding, runs as non-root `bun` (uid 1000) with
  pre-chowned `/parachute` mount point. Build context pruned to
  runtime essentials; tests, docs, and the web/ui SPA tree are
  excluded.
- **render.yaml Blueprint** — one `web` service on the `starter` plan
  (persistent disks aren't available on Render's free tier), persistent
  disk mounted at `/parachute` so vault state survives container
  restarts. Health probe at `/health`. Env vars wired: `PARACHUTE_HOME`,
  `PORT`, `VAULT_BIND=0.0.0.0`, `VAULT_AUTH_TOKEN` (sync: false),
  `TRUST_PROXY=1`, optional `SCRIBE_URL`.
- **`VAULT_AUTH_TOKEN` server-wide operator bearer** — when the env
  var is set, a request with `Authorization: Bearer <value>` matching
  the env var (constant-time compare) authenticates as full/admin
  against any vault on the server. The minimum cross-container auth
  shape: hub (sibling Render container) uses this stable bearer to
  call vault's HTTP surface. When the env var is unset, vault's
  existing token surface (per-vault DB tokens, hub-issued JWTs, legacy
  YAML keys) is unchanged — full backwards compat for local
  self-hosters and `bun link` dev. The end-state hub-issued-JWT-only
  shape stays on the roadmap at vault#282.
- **`/health` invariant pinned** — always returns 200 regardless of
  `VAULT_AUTH_TOKEN` config so Render's health probe + Docker
  `HEALTHCHECK` stay green even before the operator has wired a
  bearer. The response shape (vault names leaked only to authed
  callers) is unchanged.

Deliberately deferred to follow-up PRs / issues:

- Multi-token operator model (one shared bearer fits the v0.6
  closed-beta; per-user operator tokens land alongside hub#258).
- Full hub-issued JWT integration on every endpoint — already shipped
  for the per-vault routes, but the operator-channel use case
  intentionally keeps a simpler shared-bearer path until the JWT-only
  endgame at vault#282.
- Building the admin SPA (`web/ui/dist`) into the container image. The
  503 fallback in `src/admin-spa.ts` covers the missing-bundle case
  and the operator-facing UI lives on hub for v0.6.

Gates on this PR:
- `bun test ./src`: 957 pass, 0 fail (was 941 pre-change).
- `bun run typecheck`: clean.

## [0.4.5] — 2026-05-15

0.4.5 closes the substrate cycle that started with the launch &
ecosystem-fit phase in late April 2026 — the load-bearing phase where
vault stopped being a self-contained server and became a pure OAuth
resource server inside the Parachute Computer ecosystem (URL migration,
CLI rename, filesystem restructure, hub-issued JWT validation, scope
enforcement, indexed metadata fields, atomic tag rename/merge,
server-side transcription). Across roughly four weeks, vault moved
from a working single-host prototype into a substrate-grade module
that round-trips losslessly to git, handles non-markdown content as
first-class, and lives behind a hub that issues, scopes, and revokes
its tokens. Stable promotes from `0.4.5-rc.2` after real-vault smoke
validation on a 2296-note default vault (zero silent loss,
byte-equivalent round-trip across markdown + CSV + sidecar). Same code
as rc.2; only the version suffix drops.

**Coming from 0.2.4?** See [UPGRADING.md](./UPGRADING.md) for the
operator migration guide — the direct upgrade is correctness-safe
(schema and filesystem migrations auto-run on first post-upgrade
boot), and the active-change list is short: CLI rename, URL prefix,
token audience binding, and one priv-esc audit.

Headline arc since 0.4.4:

- **File-extension support** (vault#328) — non-markdown notes as
  first-class citizens. CSV / YAML / JSON / MDX / .txt / etc. carry an
  `extension` field; metadata is inline for frontmatter-compatible
  formats (.md, .mdx) or in `.parachute/notes-meta/<id>.yaml` sidecars
  otherwise. Wikilinks to ambiguous bare paths (`[[Foo]]` when both
  `Foo.md` and `Foo.csv` exist) are refused; use the explicit form.
  Path uniqueness is now `(path, extension)`.
- **Sync ergonomics** (vault#309, vault#310, vault#321) — `update-note
  if_missing: "create"` saves the query-then-create round trip on
  every missing-note sync. JSON int coercion accepts `5.0` for
  integer-typed fields. REST + MCP create-branch link handling is now
  symmetric.
- **Case-collision auto-disambiguation** (vault#327) — exports probe
  filesystem case-sensitivity; on case-insensitive disks (macOS APFS,
  Windows NTFS), colliding notes get on-disk filename suffixes while
  canonical paths in frontmatter stay unchanged. Cross-FS replay
  recovers via three-tier sidecar resolution.
- **AmbiguousPathError** — distinct from `PathConflictError`. Carries
  a `candidates` array listing matching `(path, extension)` pairs.
  REST returns 409 with `error_type: "ambiguous_path"`. Three handlers
  (`handleNotes`, `handleFindPath`, `handleViewNote`) share an
  `ambiguousPathResponse` helper.
- **Sidecar leftover tracking** — orphan sidecars (sidecar present,
  content file missing on import) land in `ImportStats.skipped_sidecars`.
- **Empty notes are a valid state** (vault#323) — dropped the
  `EMPTY_NOTE` guard. Skeleton notes, drafts saved-before-content, and
  organizing-only notes all create + round-trip cleanly.

## [0.4.5-rc.2] — 2026-05-15

0.4.5 cleanup — closes known limitations from rc.1 ship. Four commits
under "0.4.5 cleanup": one substantive (vault#327), three follow-ups
from the vault#328 reviewer (vault#330 S1/S2/F3). 0.4.5 stable
promotes from rc.2.

### fix(export): case-collision detection + auto-disambiguation (vault#327)

Aaron's real default vault on macOS APFS had two notes whose paths
differed only by case silently collapsing into one file on export.
The fix:

- Probe filesystem case-sensitivity at export time
  (`probeCaseSensitive`: write a hidden tempfile with a lowercase
  name, test whether the uppercase variant is reachable). Cleans up
  its tempfile; defaults to conservative true (case-sensitive,
  matches today's behavior) on probe failure.
- On case-insensitive FS, build a lowercased `(path, ext)` index
  during the export walk. Collisions auto-disambiguate to
  `<path>__<id-prefix>.<ext>` — deterministic across runs (note IDs
  are stable, timestamp-prefixed).
- Note's stored `path` (in inline frontmatter + sidecar) stays
  canonical. Only on-disk filename is munged. Import recovers
  truth from frontmatter/sidecar.
- `ExportStats.case_insensitive_fs` + `disambiguated_paths` audit
  trail.
- Import handles both shapes: exact-case canonical match → first
  remaining bucket entry → id-prefix fallback for disambiguated
  filenames. `sidecarByKey` is now multi-value Map<key, sidecar[]>
  so case-collided sidecars coexist.
- `caseSensitiveOverride: boolean` test seam.

### fix(notes): getNoteByPath ambiguity-aware (vault#330 S1)

`getNoteByPath` was non-deterministic under v18 — two same-path-
different-extension notes would resolve to one in SQLite's undefined
row order. Aligns the path-as-key contract with the wikilink
ambiguity policy: `(path, extension)` is the uniqueness tuple
everywhere.

- `getNoteByPath(path, extension?)` signature. >1 row with no
  extension hint → throws new `AmbiguousPathError`
  (`code=AMBIGUOUS_PATH` + `candidates: [{id, extension}, ...]`).
- MCP `resolveNote` + REST `resolveNote` both parse trailing
  `.<ext>` as `(path, extension)` — same explicit-extension form
  as wikilinks. Falls through to the ambiguity-throwing lookup
  when no hint is supplied.
- REST handlers convert `AmbiguousPathError` to structured 409 with
  `error_type=ambiguous_path` + candidates array.

### fix(import): drain orphaned sidecars into ImportStats.skipped_sidecars (vault#330 S2)

The PR2 import flow built `sidecarByIdLeftover` but never iterated
it — the comment promising stale-sidecar warnings was a lie. This
makes the comment honest:

- After the content-file walk, iterate leftover sidecars and record
  each in `ImportStats.skipped_sidecars` (sidecar_id, expected_path,
  expected_extension, reason).
- `console.warn` per entry so CLI / log scrapers can surface the gap.
- Common cause: operator removed a content file by hand without
  deleting the matching sidecar.

### refactor(portable-md): unify the frontmatter/sidecar key-emit loop (vault#330 F3)

`toPortableMarkdown` and `toSidecarYaml` had identical per-key emit
loops with subtly different trailing-newline behaviors. Extracted
`emitFrontmatterKeys(fm)` so both call paths share one source of
truth. Pure refactor — round-trip test still pins byte-equivalence.

## [0.4.5-rc.1] — 2026-05-15

File-extension support — vault#328. Substrate-side feature enabling
notes whose content is NOT markdown (CSV, YAML, JSON, MDX, plaintext,
etc.) as first-class. Markdown stays the default; every existing row
keeps its meaning. Three commits under the vault#328 theme.

### feat(db): add extension column to notes, default 'md' (vault#328)

Schema v17 → v18: `ALTER TABLE notes ADD COLUMN extension TEXT NOT
NULL DEFAULT 'md'`, and widen the path-uniqueness index from `(path)`
to `(path, extension)` so two notes can share a path differing only by
extension (e.g. `Recipes/pasta.md` + `Recipes/pasta.csv`).

Backward-compat by construction — every existing row defaults to "md",
so the new composite-index uniqueness collapses to the v5 "(path WHERE
NOT NULL) is unique" behavior on existing data.

Threaded `extension` through `Note`/`NoteSummary`/`NoteIndex`, the
`Store` interface (`createNote` / `updateNote` / `createNoteRaw`),
`BulkNoteInput`, and `QueryOpts.extension` (single string or array,
case-insensitive `LOWER(n.extension) IN (...)` SQL).

Tests: 7 new in `core/src/core.test.ts` covering default 'md',
explicit persist, v18 migration backfills legacy NULL → 'md',
`updateNote` changes extension, query filter (single + array shapes),
case-insensitive match.

### feat(api): extension field on create-note + update-note + query-notes (vault#328)

MCP and REST surfaces gain a symmetric `extension` field:

- **MCP `create-note`**: optional `extension` on single + batch shapes.
- **MCP `update-note`**: optional `extension`; same validation on both
  the update branch AND the `if_missing: "create"` branch.
- **MCP `query-notes`**: `extension` filter accepts a single string or
  an array.
- **REST `POST /notes`** + **`PATCH /notes/:id`** (incl.
  `if_missing=create` branch): symmetric `extension` field, validation,
  400 `invalid_extension` on bad input with structured
  `error_type`/`extension`/`reason`.
- **REST `GET /notes`**: `?extension=csv` (single) or
  `?extension=csv&extension=yaml` / `?extension=csv,yaml` (array).

Validation: `/^[a-z0-9]{1,16}$/` + reserved `parachute` prefix guard.
Single source of truth at
`core/src/notes.ts:validateExtension`, imported by both transports so
the contract can't drift.

Tests: 7 MCP + 9 REST integration tests — default, persist, validation
rejections (uppercase, dot, slash, reserved prefix, too long, empty),
update branch, `if_missing=create` branch, GET filter (single + array).

### feat(export): non-markdown content with sidecar metadata + .mdx as frontmatter-compatible (vault#328)

`core/src/portable-md.ts:supportsInlineFrontmatter(ext)` predicate
splits extensions into two buckets:

- **Frontmatter-compatible** (`md`, `mdx`): metadata as inline YAML
  frontmatter at top of content file. Today's behavior, extended to
  `.mdx` (YAML frontmatter works in MDX identically — and Aaron's
  planning to use MDX in some notes).
- **Sidecar-required** (`csv`, `yaml`, `json`, anything else): metadata
  in `.parachute/notes-meta/<note-id>.yaml`. Content file holds the
  raw bytes — no frontmatter prepend.

Export emits one sidecar per non-frontmatter-compat note; new
`ExportStats.sidecars` counter pins the count. Sidecar path-traversal
guard symmetric with the attachments path: the sidecar lives under
`.parachute/notes-meta/`, period.

Import builds a `(path, extension) → sidecar` index from the
`.parachute/notes-meta/` directory at the top of the import pass.
Walks every content file (not just `.md` — new `walkContentFiles`
helper) and, for each, parses inline frontmatter (frontmatter-compat
extensions) or looks up the sidecar (non-frontmatter-compat). Orphaned
content files (no matching sidecar) are skipped with a warning rather
than crashing.

`toPortableMarkdown` now returns raw content for sidecar-required
extensions (no synthetic `---` frontmatter prepend). New
`toSidecarYaml` emits the metadata-only bytes for the sidecar.
`portableExportFilePath` honors the note's `extension` (was hardcoded
`.md`).

**Wikilink ambiguity policy** (vault#328 edge case 3): when two notes
share a path differing only by extension (`Foo.md` + `Foo.csv`),
`[[Foo]]` is refused (returns null from `resolveWikilink`) and
recorded as unresolved. `[[Foo.md]]` / `[[Foo.csv]]` resolve
unambiguously to their respective notes via the new explicit-extension
form. The extension-recognition pattern in the wikilink parser mirrors
`EXTENSION_PATTERN` in `core/src/notes.ts` so the two share the same
notion of "this looks like an extension."

Frontmatter `extension` field is OMITTED for `md` (the default) so
pre-vault#328 markdown-only exports produce byte-identical bytes
before and after the upgrade. The sidecar always includes `extension`
(the field is the sidecar's reason for existing).

Tests: 10 new in `core/src/portable-md.test.ts` —
`supportsInlineFrontmatter` true/false matrix, `toPortableMarkdown`
extension awareness (md, mdx, csv), `toSidecarYaml` shape, full
round-trip integration over csv/yaml/json/mdx/empty-content/.md
(export → blow-away import → byte-equiv re-export), orphan-content-
file rejection, wikilink ambiguity refuse + explicit-extension
resolve.

## [0.4.4-rc.14] — 2026-05-15

Round-trip import unblocker — vault#323. Aaron's real default vault
(2290 notes / 12 schemas / 298 attachments) tripped two distinct bugs
on the round-trip import smoke that gates the @latest stable
promotion of `0.4.4`. Three commits, all under vault#323.

### fix(notes): drop EMPTY_NOTE guard — empty content is a valid state (vault#323)

The earlier #213 guard rejected `content + path both absent` from
createNote and updateNote, plus pre-validators in MCP and REST that
short-circuited the same shape with 400 EmptyNoteError. Real vaults
have empty-content notes (skeletons, drafts, organizing notes,
capture-then-fill flows); export emits them fine but the import then
rejected every one — blocking the round-trip.

Design call (Aaron, 2026-05-13): empty notes are a valid state.

Dropped:
- `EmptyNoteError` class + Store-level throw in createNote/updateNote
  (core/src/notes.ts).
- MCP create-note pre-walk that rejected empty entries with item_index
  (core/src/mcp.ts), plus the `EmptyNoteError` re-export.
- REST POST /notes pre-walk + the 400-on-EMPTY_NOTE error mappers in
  POST and PATCH handlers (src/routes.ts).

Tests flipped (core/src/core.test.ts + src/vault.test.ts): empty-
content creates and clears now succeed end-to-end across Store, MCP,
and REST. Batch atomicity (#236) and MAX_BATCH_SIZE (separate
runaway-client protection) are untouched.

### fix(cli): detect running daemon on import, refuse with clear error (vault#323)

`parachute-vault import` opens its own bun:sqlite connection. When a
daemon was already running on the configured port, the first
createNote contended for the writer lock and hit SQLITE_BUSY —
leaving the target vault partially replayed. The error trace
surfaced nothing actionable.

cmdImport now probes `checkHealth(port)` after verifying the vault
and before touching the database. `healthy` or `unhealthy` (port
bound, any HTTP response) prints a clear error pointing at the
workaround and exits 1:

  error: vault daemon is running on port <port>; stop it first with:
    parachute stop vault
  the import requires exclusive write access to the SQLite database.

A proper WAL / concurrent-writer story is a separate follow-up.

Integration test in src/import-daemon-busy.test.ts asserts both
branches.

### test(import): empty-content round-trip in integration suite (vault#323)

Added an empty-content note (`01HX004`, `path: "Inbox/skeleton"`,
tagged `project`) to the round-trip fixture in
`core/src/portable-md.test.ts`. The test now exports → blow-away
import → re-export → byte-equivalent over a fixture that includes
the shape vault#323 was hitting. Pre-fix, importPortableVault threw
on the empty-content create; post-fix, the skeleton survives the
round-trip with content/path/tags intact. Pins the regression so a
future paternalistic guard re-introduction breaks CI before it ships.

## [0.4.4-rc.13] — 2026-05-13

`if_missing` tighten-up — vault#321 follow-ups from the vault#320 review.
Three commits, all under the "if_missing tighten-up" theme. Closes
vault#321 (F2 + F3 + F4 sub-issues).

### fix(api): REST PATCH if_missing=create applies links.add (vault#321 F2)

Cross-surface inconsistency: MCP's create-on-missing branch processed
`links.add` (let drift sync declare typed links at upsert time); REST
PATCH `/notes/:id`'s create-on-missing branch didn't process `links`
at all. Gitcoin would have tripped on this migrating MCP → REST.

REST now mirrors MCP exactly:
- `links.add` applied — drift sync materializes typed links alongside
  the create.
- `links.remove` ignored (nothing to remove on a fresh note).
- Missing target notes skip silently.
- Resolves target via `resolveNote(store, link.target)` — same
  id-or-path lookup as the update path.

Two new REST integration tests (vault.test.ts):
- `links.add` creates typed-link rows (id-target + path-target both
  resolve; metadata round-trips).
- Missing target → silent skip.

### test(api): schema-conflict warning surfaces on if_missing=create branch (vault#321 F3)

The `attachValidationStatus` path handles schema conflicts (two tags
declaring the same field with conflicting types) but the create branch
of `if_missing="create"` reused that path without exercising the case
in a test. Now pinned on BOTH surfaces for symmetry:

- MCP test in core.test.ts.
- REST test in vault.test.ts.

Both confirm a `schema_conflict` warning surfaces in
`validation_status.warnings` when two directly-applied tags declare
the same field with conflicting specs. First-tag-wins precedence
(`schema` = winner, `loser_schema` = the dropped declaration).

### test(mcp): links.add applied on if_missing=create branch (vault#321 F4)

`core/src/mcp.ts:644-650` applies `links.add` on the create branch.
Code was there pre-fold but untested — a future regression breaking
Gitcoin's upsert-with-typed-links workflow would have slipped through.
Now pinned: MCP `update-note` + `if_missing: "create"` + `links.add`
payload → assert link rows materialize with the right targets +
relationships + metadata.

### Gates

- `bun test` (root) → 1416 pass / 3 skip / 0 fail (was 1411; +5 tests)
- `bun test ./src/` → 926 pass / 0 fail (was 923; +3 REST tests: 2 F2 + 1 F3)
- `bun test ./core/src/` → 490 pass / 0 fail (was 488; +2 MCP tests: 1 F3 + 1 F4)
- `bunx tsc --noEmit` clean

## [0.4.4-rc.12] — 2026-05-13

Gitcoin sync ergonomics — bundled two-commit PR. Both close real
friction points from `from_parachute_round_2.md`, queued as the
priorities after vault#308.

### feat(api): `if_missing: "create"` on update-note (closes vault#309)

Pre-fix, Gitcoin's nightly drift-detector loop had to either
query-first-then-create on 404 (1 extra round trip per item, ~500/night)
or accept that "update" semantics weren't safe when the note might not
exist. Now `update-note` accepts an optional `if_missing` field:

- **MCP `update-note`** — new `if_missing: "fail" | "create"` param
  (default `"fail"`, current behavior). On `"create"`: if the note
  doesn't exist (`resolveNote` returns null), treat the update payload
  as a create payload (content/path/tags/metadata become the create
  fields; `if_updated_at` precondition skipped since there's nothing
  to conflict with).
- **REST `PATCH /api/notes/:idOrPath`** — same `if_missing` field in
  the JSON body. Mirrors MCP semantics.
- **Response carries `created: true | false`** on every update-note
  response (both branches). Sync loops read this to know which path
  fired without a separate query.
- **Idempotent**: repeated calls with the same id + payload produce
  the same vault state (first call creates with `created: true`,
  subsequent calls update with `created: false`).
- **Tag-schema defaults + validation_status** fire on the create
  branch identically to `create-note` (the create-path reuses the
  same `applySchemaDefaults` + `attachValidationStatus` recipe).

ID-vs-path heuristic on the create branch: if the `id` field looks
path-shaped (contains `/` or doesn't match `^[A-Za-z0-9_-]+$`) and
`path` isn't explicitly set, use `id` as the path. Otherwise treat as
opaque id. Matches Gitcoin's sync shape where canonical keys are
`Inbox/2026-05-13-meeting`-style paths.

Tests:
- `core/src/core.test.ts`: 6 new MCP tests (create-when-missing,
  update-when-present, no-if_missing-errors, schema-defaults apply,
  validation_status surfaces, idempotency).
- `src/vault.test.ts`: 4 new REST tests (mirror of MCP cases +
  response-shape pin for the additive `created: false` field).

### fix(schema): coerce JSON number → integer when fractional is zero (closes vault#310)

Pre-fix, every integer-typed metadata field warned `type_mismatch` on
legitimate values because the validator had no `"integer"` case at
all — falling through the switch returned `undefined` and the
`if (spec.type && !valueMatchesType(...))` gate fired. Gitcoin's drift
detector emits JSON for diffs (and JSON has no separate integer type),
so every `kpi: 3` triggered a false-positive and buried the real
warnings in the noise floor.

- `SchemaField.type` union extended with `"integer"`.
- `valueMatchesType` adds an `"integer"` case using
  `Number.isInteger(value)`: accepts `5` and `5.0` (zero fractional);
  rejects `5.5`, `"5"` (string — no string→number coercion),
  `5.0000000000001` (edge non-zero fractional), `NaN`, `Infinity`.
- The Gitcoin shape (JSON-decoded integer arriving as JS Number with
  zero fractional part) now passes validation cleanly.

Tests in `core/src/core.test.ts`:
- Happy path: `5`, `5.0`, boolean rejection.
- Strict path: `5.5`, `"5"`, `5.0000000000001`.
- Inner-boundary: `valueMatchesType` rejects `NaN`/`Infinity` directly
  (the outer null-short-circuit at the validator level filters them
  before they reach the type check after JSON.stringify normalization).

### Gates

- `bun test` (root) → 1411 pass / 3 skip / 0 fail (was 1394; +17 tests)
- `bun test ./src/` → 923 pass / 0 fail (was 919; +4 REST tests)
- `bun test ./core/src/` → 488 pass / 0 fail (was 475; +6 MCP if_missing + 7 int coercion)
- `bunx tsc --noEmit` clean

## [0.4.4-rc.11] — 2026-05-13

Portable markdown knowledge-base format — PR 2 of 2 (closes vault#308 +
folds vault#318). Closes the remaining two lossy gaps from PR 1
(attachments + import) and pins the load-bearing byte-equivalent
round-trip invariant.

### Added — export

- `core/src/portable-md.ts` `exportVaultToDir` now copies attachment
  binaries to `<outDir>/.parachute/attachments/<id>/<basename>`
  when `opts.assetsDir` is set (the CLI wires this via
  `src/routes.ts:assetsDir(vault)`; core stays pure — no dep on
  server-side path resolution).
- Attachment refs in note frontmatter preserve the **original
  vault-internal path** (relative to `assetsDir`). The sidecar
  location is derived from `att.id` so it's deterministic across
  renames and different export runs.
- `ExportStats` extended (folds vault#318): adds `attachments`,
  `skipped_traversal`, `skipped_notes`, `skipped_attachments`.
  Programmatic consumers (PR 2 importer; future drift sidecars)
  no longer have to log-scrape.

### Added — import

- `core/src/portable-md.ts` `importPortableVault(store, opts)` —
  reads a portable-md export back into a vault. Upsert by frontmatter
  `id`: existing notes updated in place, new ones created.
- `--blow-away` flag — the disaster-recovery path: wipe the target
  vault first (delete all notes + tags; cascade-deletes flow through
  FKs), then replay from the export. CLI gates this behind a confirm
  prompt unless `--yes` is set. Returns `notes_wiped` count.
- Tag schemas restored from `.parachute/schemas/<tag>.yaml` before
  notes (so any tag a note carries can validate against its schema).
- Typed links replayed after all notes exist (forward-ref safe).
  Skipped links surface in `ImportStats.skipped_links` with the
  reason.
- Attachment binaries restored from
  `.parachute/attachments/<exported-id>/<basename>` to
  `<assetsDir>/<frontmatter-path>` when `opts.assetsDir` is set.
  Path-traversal guards on both ends.
- `--dry-run` counts would-create / would-update without writing.
- `Store.restoreNoteTimestamps(id, createdAt, updatedAt)` —
  import-only setter that writes both timestamps explicitly. Regular
  `updateNote` either bumps `updated_at` to wall-clock-now or leaves
  it untouched; neither lets the importer write a historical
  timestamp. Used so the round-trip preserves notes where
  `created_at ≠ updated_at`.
- `Store.syncAllWikilinks` lifted into the `Store` interface (was on
  `BunSqliteStore` only). The importer calls it once at the end to
  rebuild wikilink rows from `[[brackets]]` in content.

### CLI

- `parachute-vault import <dir>` autodetects portable-md vs legacy
  Obsidian via the presence of `.parachute/vault.yaml`. Lossless path
  takes over when present; legacy obsidian parser handles the rest.
  `--format <name>` and `--obsidian` flags retained as no-op hints.
- `parachute-vault import <dir> --blow-away [--yes] [--dry-run]` —
  the disaster-recovery path.
- `parachute-vault export <dir>` now wires `assetsDir(vault)` so
  attachment binaries are copied alongside the markdown. Output
  shows `notes / schemas / attachments` counts.

### Tests

- 8 new import tests covering: not-a-portable-md error path, upsert by
  id (new + existing), `--blow-away`, schema restoration, typed-link
  replay, missing-target skip, dry-run no-writes.
- **Round-trip byte-equivalent integration test** (PR 2 P3, the
  load-bearing pin for the format's whole pitch): realistic vault
  (multiple notes, schema-carrying tags, typed link, multi-line
  metadata, divergent created_at/updated_at) → export → blow-away
  import → re-export → recursively compare every file's bytes.
  Drift triggers a diff hint in console.error before the test fails,
  so future regressions are debuggable.

### Known limitation

- **Attachment IDs are re-minted on import.** `addAttachment` generates
  a fresh id; the Store interface doesn't yet expose a
  `restoreAttachment(id, ...)` import-only path. Frontmatter refs still
  resolve by `(note_id, path)` tuple, but a round-trip with
  attachments present produces byte-different `attachments[].id`
  values between original and re-export. The note-level round-trip
  test exercises this. Filed as a future enhancement; landing it
  requires the parallel surface to `restoreNoteTimestamps`.

### Reviewer fold (vault#319 F1 + F2 + F3)

- **F1 (safety)** — `--blow-away` confirm now defaults NO (was YES).
  Every other destructive confirm in the CLI defaults NO; a
  distracted Enter-press no longer wipes a vault. One-char fix.
- **F2 (doc)** — Pinned upsert merge policy in a comment block at
  `importPortableVault`'s update branch. Non-blow-away imports
  **always replace** content + tags, but **upsert-by-field** for
  metadata + path (absent fields preserve the vault's existing
  values). To force a clean replace-by-id, use `--blow-away`.
- **F3 (coverage)** — Folded the missing attachment-import tests:
  - Bytes survive vault → export → fresh-vault import (different
    `assetsDir`). Non-utf8 distinctive bytes verify the buffer
    round-trips honestly through the filesystem.
  - Adversarial frontmatter `attachments[].path` that resolves
    outside the destination `assetsDir` is skipped + recorded in
    `ImportStats.skipped_attachments` with a `path-traversal`
    reason; the would-be escape file never lands.

### Gates

- `bun test` (root) → 1394 pass / 3 skip / 0 fail (was 1392; +2 F3 tests)
- `bun test ./src/` → 919 pass / 0 fail (unchanged)
- `bun test ./core/src/` → 475 pass / 0 fail (was 473; +2 F3 tests)
- `bunx tsc --noEmit` clean

## [0.4.4-rc.10] — 2026-05-13

vault#317 reviewer fold — three critical bugs in the rc.9 portable-md
export. All caught before merge.

### Fixed

- **F1 (silent corruption)** — Multi-line strings in `metadata`
  silently truncated. The pre-fold `needsQuote` didn't detect embedded
  newlines, so a `metadata` value like `"line1\nline2"` got
  single-quoted and emitted across two physical YAML lines; the
  line-oriented parser then read line 0 as `'line1` (unclosed quote)
  and the second line as garbage. Vault metadata legitimately carries
  multi-line strings (transcripts, descriptions, body-as-metadata).
  Fix: `needsQuote` now detects `\n\r\t\v\f` and `\x00-\x08\x0e-\x1f`;
  `quoteString` switches to the **double-quoted** form with escape
  sequences (`\\n`, `\\xNN`) so the whole value stays on one physical
  line. `unquote` decodes the same escapes on parse. Pinned by two
  round-trip tests in `portable-md.test.ts`.
- **F2 (tautology test)** — The rc.9 "byte-identical re-emit"
  idempotency test called `toPortableMarkdown` twice on the same
  in-memory object and compared. That proves nothing about
  round-tripping through the on-disk bytes. The CHANGELOG claim was
  load-bearing for the format's whole pitch ("clean git diffs") and
  the test didn't prove it. Fix: parse the emitted markdown back
  through `parseFrontmatter`, reconstruct a `PortableNote`, re-emit,
  compare bytes. That's the real invariant.
- **F3 (path traversal)** — `exportVaultToDir` did
  `join(outDir, relPath)` without verifying the resolved path stayed
  under `outDir`. A note with `path: "../../escape"` would write
  outside the export directory. Self-inflicted at the vault level
  (operator owns the data) but a real surprise for programmatic
  callers (e.g. ingest from external systems). Fix: resolve both
  paths absolute, assert `candidate === root || candidate.startsWith(root + sep)`.
  Refuses the write with a `console.warn` rather than aborting the
  whole export — partial export is more useful than no export.
  Pinned by two tests (escape attempt skipped; nested path inside
  outDir permitted).

### Polished

- **F4** — `notetoPortable` renamed to `noteToPortable` (camelCase
  typo).
- **F5** — Added a code comment on the 1M-note bulk-load ceiling in
  `exportVaultToDir`. Cursor / streaming for very-large vaults is a
  PR 2 follow-up.
- **F6** — `unquote` now decodes the double-quoted YAML escapes the
  emitter produces (`\\\\`, `\\"`, `\\n`, `\\r`, `\\t`, `\\v`, `\\f`,
  `\\xNN`). TODO comment notes that YAML 1.2 defines additional
  escapes (`\\0`, `\\u<4hex>`, etc.) that the emitter never produces
  but legacy `.yaml` files might — to add when a real case lands.

### Gates

- `bun test` (root) → 1384 pass / 3 skip / 0 fail (was 1380; +4 fold tests)
- `bun test ./src/` → 919 pass / 0 fail (unchanged)
- `bun test ./core/src/` → 465 pass / 0 fail (was 461; +4 fold tests)
- `bunx tsc --noEmit` clean

## [0.4.4-rc.9] — 2026-05-13

Portable markdown knowledge-base export — PR 1 of 2 (closes part of
vault#308; PR 2 follows with attachments + `--blow-away` import for
full round-trip disaster recovery).

The current export at `core/src/obsidian.ts` produces Obsidian-
compatible markdown — but the format isn't Obsidian-specific. Markdown
+ frontmatter + folder hierarchy is the de-facto knowledge-base
interchange format, consumed by Obsidian, Logseq, Foam, Quartz,
Dendron, and most markdown-shaped static-site generators. Anchoring
the function name to the format (rather than to one consumer) opens
the door as other consumers adopt it. The legacy export is also
lossy: no IDs, no typed-link relationships, no tag schemas, no
attachments, no idempotency guarantee. Gitcoin Brain's vault-as-
primary + git-as-projection architecture (and any operator using
vault-as-primary) needs lossless round-trip.

### Added

- `core/src/portable-md.ts` — canonical home for the format.
  - `toPortableMarkdown(note)` — emits a fixed top-level frontmatter
    key order (`id` → `path` → `tags` → `metadata` → `links` →
    `attachments` → `created_at` → `updated_at`) with alpha-sorted
    keys in nested objects. Re-exporting an unchanged vault produces
    byte-identical files.
  - `exportVaultToDir(store, opts)` — writes
    `<dir>/.parachute/vault.yaml`, `.parachute/schemas/<tag>.yaml`
    per schema-carrying tag, and `<note.path>.md` per note.
  - Typed-link relationships (non-wikilink) serialized in the
    `links:` frontmatter block. Wikilinks stay in the content (their
    `[[brackets]]` are the source of truth).
  - Note IDs preserved in frontmatter (`id:` is the first key,
    durable across renames).
  - Hand-rolled YAML emitter — no new dep; strict string quoting
    for values that would round-trip as different types
    (`'true'`, `'42'`, `'null'`).
- CLI: `parachute-vault export <dir> [--since <iso>]`. The
  `--since` flag filters notes to those with `updated_at >= iso`,
  for incremental git-projection cadences.

### Changed

- `core/src/obsidian.ts` — now a back-compat shim. Re-exports the
  parser helpers (`parseFrontmatter`, `extractInlineTags`,
  `walkMarkdownFiles`) from `portable-md.ts`. The legacy lossy
  `toObsidianMarkdown` / `exportFilePath` are retained (marked
  `@deprecated`) for callers that intentionally want the flat
  frontmatter shape. All existing tests against `obsidian.ts` pass
  unchanged.

### Tests

- `core/src/portable-md.test.ts` — 32 tests covering:
  - YAML emitter (alpha-sort, scalar quoting, idempotency).
  - Frontmatter key order (fixed top-level, alpha-sorted nested).
  - `exportVaultToDir` (vault.yaml + schemas/<tag>.yaml + per-note
    .md files, with `--since` filter).
  - Byte-identical re-export of unchanged vault (idempotency pin).
  - Wikilinks excluded from `links:` block.

### Format change (callers that store the legacy `toObsidianMarkdown` output)

The new portable-md frontmatter shape **nests metadata** under a
`metadata:` block, where the legacy obsidian export flattened
metadata keys at the top level. Operators using the legacy
`parachute-vault export` for one-shot Obsidian copies will see a
shape change after upgrading to `parachute-vault export` (now the
new portable-md emitter). The legacy `toObsidianMarkdown` function
is still callable for callers that import it directly; the CLI
moves to the new format. Export output is *projection*, not
authoritative state — regeneratable, so the migration cost is
re-running the export.

### Coming in PR 2

- Attachments export/import (file copy under `.parachute/attachments/`).
- `parachute-vault import <dir> --blow-away` for disaster recovery.
- Full round-trip byte-equivalence test (vault → export → blow-away
  → import → vault state byte-equivalent).
- Cookbook entry for webhook-driven nightly git projection.

### Gates

- `bun test` (root) → 1380 pass / 3 skip / 0 fail
- `bun test ./src/` → 919 pass / 0 fail (unchanged)
- `bun test ./core/src/` → 461 pass / 0 fail (was 429; +32)
- `bunx tsc --noEmit` clean

## [0.4.4-rc.8] — 2026-05-12

HTTP create/update now attach `validation_status` — symmetry with MCP
(closes vault#287).

The MCP `create-note` and `update-note` tools wrap their responses in
`attachValidationStatus`: when a tag on the note declares `fields` (a
type / enum schema) on its `tags` row, the response carries a
`validation_status` block with the resolved schemas and any warnings
(type mismatch, enum mismatch). HTTP `POST /api/notes` and `PATCH
/api/notes/:id` did not — HTTP consumers of schema-validated vaults
had no signal that their write triggered a warning. They had to
re-read the note, cross-reference its tags, and replay validation
client-side. Defeats one of the load-bearing reasons validation runs
at write time.

### Changed

- `attachValidationStatus` is now exported from `core/src/mcp.ts` so
  both transports use the same recipe (single source of truth).
- HTTP `PATCH /api/notes/:idOrPath` attaches `validation_status` to
  the response, on both the default full-Note shape and the lean
  (`include_content: false`) shape. The lean-shape preservation
  mirrors the MCP recipe at `core/src/mcp.ts:751` — `toNoteIndex`
  drops unknown fields, so the field is re-attached after the
  conversion.
- HTTP `POST /api/notes` (single + batch) attaches
  `validation_status` to each created note. Mirrors the MCP
  `create-note` attach site at `core/src/mcp.ts:451`.

### Behavior

- No change for vaults without tag schemas: `attachValidationStatus`
  returns the note unchanged when no tag on it declares fields.
- No change for MCP — the validation-status surface was already
  there.
- HTTP consumers using tag schemas now see `validation_status` on
  every write response, matching the MCP contract.

### Tests

- 6 new tests in `src/vault.test.ts`:
  - PATCH attaches `enum_mismatch` warning on a schema-violating
    metadata update.
  - PATCH preserves `validation_status` on `include_content: false`
    (lean shape).
  - PATCH omits `validation_status` when no tag declares fields
    (back-compat).
  - POST attaches `type_mismatch` warning on schema-violating
    create.
  - POST batch attaches per-note `validation_status` (mixed
    valid/invalid entries each carry their own status).
  - POST omits `validation_status` when no tag declares fields.

### Gates

- `bun test` (root) → 1348 pass / 3 skip / 0 fail
- `bun test ./src/` → 919 pass / 0 fail (was 913)
- `bun test ./core/src/` → 429 pass / 0 fail
- `bunx tsc --noEmit` clean

## [0.4.4-rc.7] — 2026-05-12

`buildMcpEntryPlan` ⇄ `installMcpConfig` — close the URL invariant on the
writer side (vault#302, follow-up to vault#301).

vault#301 introduced `buildMcpEntryPlan` as the shared seam for the
preview ⇄ writer entry-key + URL invariant. But `entryKey` was the only
half closed: `installMcpConfig` still called `chooseMcpUrl(vaultName,
port)` directly inside the writer, reading `process.env` rather than the
`env` threaded through `InstallContext`. In production both branches
read `process.env`, so they agreed by accident — a future change that
introduced a non-process-env source (tests with in-memory env, alternate
config paths, anything using `InstallContext.env` differently) would
silently diverge between preview and writer.

### Internal

- `InstallMcpConfigOpts` now requires `url` from the caller. The
  writer is a pure file-writer; the URL decision lives in
  `buildMcpEntryPlan` alone.
- `installMcpConfig` returns `void` (was `{ url, source }`). Both
  call-sites already have `url` and `source` from
  `buildMcpEntryPlan`'s output — no need to round-trip.
- `executeMcpInstall` destructures `{ entryKey, url, source }` from
  `buildMcpEntryPlan` and passes `url` to `installMcpConfig`.
- The `init --add-mcp` bootstrap path (cli.ts:521) goes through
  `buildMcpEntryPlan` too, so init and `mcp-install` share the same
  URL-computation seam — a future URL-shape change can't drift
  between the two.
- `chooseMcpUrl` is no longer imported by `cli.ts` (only used inside
  `buildMcpEntryPlan` now).

### Tests

- `src/mcp-install.test.ts`: new end-to-end test pins that the URL on
  disk matches `buildMcpEntryPlan({ env: { PARACHUTE_HUB_ORIGIN: ... } })`
  for a non-default hub origin. A regression that reintroduces the
  direct `chooseMcpUrl` call inside `installMcpConfig` would drop the
  caller's env and read `process.env` — this test goes red on that
  shape.

### Gates

- `bun test` (root) → 1342 pass / 3 skip / 0 fail
- `bun test ./src/` → 913 pass / 0 fail (was 912)
- `bun test ./core/src/` → 429 pass / 0 fail
- `bunx tsc --noEmit` clean

No operator-visible behavior change.

## [0.4.4-rc.6] — 2026-05-12

`bun test` from the repo root now returns green (vault#294).

The 27 failures in `web/ui/` tests on `main` were misdiagnosed as a
`vi.mock` version incompatibility. Root cause: `bun test` walks the
entire repo for `*.test.*` files, including `web/ui/`'s React SPA
tests. Those tests import `vitest` and use `vi.mock("path")` in the
single-arg auto-stub form, which `bun:test` rejects with
`TypeError: mock(module, fn) requires a function`. The SPA tests are
written for vitest 4.x (its declared `npm test` runner) and pass
cleanly there — they were never broken; `bun test` was just trying to
run them with the wrong runner.

### Fix

- `bunfig.toml` adds `pathIgnorePatterns = ["web/ui/**"]` under
  `[test]`. `bun test` from the repo root now stops at the
  server + core boundary; the React SPA's tests stay green under
  their canonical `vitest run` command.

### Docs

- `CLAUDE.md` "Running" section documents the two-runner split
  explicitly: `bun test` for server + core, `bunx vitest run` (from
  `web/ui/`) for the SPA. Future contributors won't trip over the
  same mis-diagnosis.

### Gates

- `bun test` from repo root → 1341 pass / 3 skip / 0 fail (was
  1362 pass / 3 skip / 27 fail / 2 errors).
- `bun test ./src/` → 912 pass / 0 fail (unchanged).
- `bun test ./core/src/` → 429 pass / 0 fail (unchanged).
- `cd web/ui && bunx vitest run` → 61 pass / 0 fail (unchanged —
  always green under vitest).

No code change. Configuration + docs only.

## [0.4.4-rc.5] — 2026-05-12

`parachute-vault uninstall --skip-daemon` test-isolation flag (vault#296).

The CLI's `uninstall` command calls `uninstallAgent()`, which targets the
hardcoded launchd label `computer.parachute.vault`. That label ignores
`PARACHUTE_HOME`, so a naive subprocess test of `uninstall --yes` on a
developer's machine would `launchctl bootout` the real registered
daemon. We previously dodged this by avoiding subprocess tests entirely
for the uninstall flow — but that left the full path (wrapper removal,
MCP cleanup, ordering, exit codes) untested.

### Added

- Undocumented `--skip-daemon` flag on `parachute-vault uninstall`.
  Bypasses the launchd / systemd / backup-agent uninstall calls;
  everything else (wrapper removal, MCP cleanup, optional wipe) runs
  as normal. Tests use this to exercise the full flow against a
  sandbox `PARACHUTE_HOME` without touching real operator state.
  Intentionally absent from `usage()` — humans should never need it,
  and surfacing it would invite "I'll just skip the daemon step"
  misuse that leaves an orphaned daemon firing on a missing wrapper.

### Tests

- End-to-end uninstall coverage in `src/mcp-install.test.ts`:
  - wrapper + server-path pointer + MCP entry removed; daemon skip
    surfaces in stdout for CI log audit.
  - `--skip-daemon` alone leaves user data alone (no accidental wipe).
  - `--skip-daemon --wipe --yes` composes correctly — destructive
    path still removes vault data + .env.

### Docs

- Convention documented in `CLAUDE.md` under "Running".

No operator-visible behavior change in the default uninstall path.

## [0.4.4-rc.4] — 2026-05-12

`mcp-install` preview-accuracy regression pin (vault#293 follow-up to vault#292).

The interactive walkthrough's preview render and the writer
(`executeMcpInstall` → `installMcpConfig`) used to compute the entry
key and URL independently — identical by coincidence of template
strings. A future change to either path could silently mislead: the
operator confirms one JSON shape, a different shape lands on disk.

### Internal

- Extract `buildMcpEntryPlan` in `src/mcp-install.ts` as the single
  source of truth for `(entryKey, url)`. Both the preview render and
  the writer call it.
- Thread `port` + `env` through `InstallContext` so the preview
  resolves the URL through `chooseMcpUrl` (the same path the writer
  uses) rather than rebuilding the string from `${ctx.hubOrigin}/…`.
- Thread `existingEntryKey` from `InstallDecision` into
  `executeMcpInstall` so the writer keys the new entry at the same
  slot the preview promised when the walkthrough is updating an
  existing entry (instead of synthesizing a fresh key).
- Un-skip the F3 preview-accuracy test from vault#292 and replace it
  with a smaller-seam test: direct unit tests on `buildMcpEntryPlan`
  in `mcp-install.test.ts` (entry-key formula: singular vs per-vault
  vs update-existing; URL source: hub-origin vs loopback fallback),
  plus two walkthrough tests in `mcp-install-interactive.test.ts`
  that capture the preview's logged JSON and assert it matches
  `buildMcpEntryPlan(decision)`. Faster + sturdier than the previous
  walkthrough+spawn shape; no subprocess, no temp filesystem.

No operator-visible behavior change.

## [0.4.4-rc.3] — 2026-05-11

Two `parachute-vault mcp-install` fixes from real dogfood feedback —
operator ran the walkthrough from a plain directory (no `.git`, no
`package.json`) intending a directory-private install, and the
walkthrough decided unilaterally for them. Both fixes restore "always
let the operator pick the scope."

### Fix 1 — Add the `local` install scope

Claude Code has three MCP scopes; vault previously only supported two.
All three are now first-class:

| Scope | Where the entry lives | Visibility |
|---|---|---|
| `user` | `~/.claude.json` top-level `mcpServers` | every project, every directory |
| `local` | `~/.claude.json` under `projects[<absolute-cwd>].mcpServers` | private to this machine, scoped to this directory |
| `project` | `<cwd>/.mcp.json` | checked into the repo, shared with the team |

`local` matches Claude Code's own `claude mcp add --scope local` default
and is the right shape when the operator wants vault available in this
working directory only, without committing the entry to the repo or
exposing it from every other project.

Surfaces:

- New `--install-scope local` flag.
- Walkthrough's install-location prompt now offers all three scopes
  (see Fix 2).
- `parachute-vault doctor` reads local entries from `~/.claude.json`
  under `projects[<cwd>].mcpServers`.
- `parachute-vault uninstall` cleans local entries from every project
  slot it finds (not just the current `cwd`'s), so a single uninstall
  removes the vault server regardless of which directory the operator
  ran the install from.

### Fix 2 — Drop the marker gate; always prompt for install scope

The interactive walkthrough's install-location step used to silently
auto-pick **user** scope when no project markers (`.git`, `package.json`,
…) were detected — the operator never saw the prompt. The premise was
wrong: Claude Code reads `./.mcp.json` (project scope) and
`projects[<cwd>]` (local scope) regardless of git/package markers.
Skipping the prompt buried the operator's actual intent.

The walkthrough now always prompts with the three scopes laid out. The
default *tilts* on the marker signal — present → `project`, absent →
`local` — but the operator always sees and can override the choice.

### Breaking — non-interactive default changed from `user` to `local`

`parachute-vault mcp-install` with no `--install-scope` flag previously
wrote to `~/.claude.json` top-level (user scope). It now writes to
`~/.claude.json` under `projects[<absolute-cwd>].mcpServers` (local
scope). This mirrors Claude Code's own `claude mcp add` default. Two
things to know:

- **Scripted installs**: pass `--install-scope user` explicitly to keep
  the prior global-install behavior. (We recommend doing this in any
  automation that runs `mcp-install` non-interactively — the operator-
  intent prompt isn't there to surface the change.)
- **Non-interactive `local` install** prints a one-line consequence
  callout on stdout — "Installed locally for this directory only. To
  install globally, re-run with `--install-scope user`." — so a
  first-time operator who hits the new default doesn't wonder why
  vault works only from one directory.

### Tests

10 new tests across `src/mcp-install.test.ts` and
`src/mcp-install-interactive.test.ts`:

- `local` scope writer round-trip (writes to `~/.claude.json` under
  `projects[<cwd>]`, preserves pre-existing top-level entries and
  pre-existing sibling MCP servers).
- `--install-scope local` CLI flag accepted; default-when-no-flag
  changed to `local`; new default writes to the projects-keyed slot.
- Walkthrough always prompts for scope (no marker-gate skip);
  default-tilt logic (markers → `project`, no markers → `local`);
  operator can override either default.
- `detectExistingEntries` recognises local entries (and ignores
  local entries at *other* cwds).

## [0.4.4-rc.2] — 2026-05-11

Interactive default for `parachute-vault mcp-install`. Bare invocation
(no flags, TTY stdin) now walks the operator through a short, contextual
conversation instead of executing silent defaults. Each prompt picks a
smart default informed by ambient context — number of vaults, hub
reachability, project-directory detection, existing entries — and shows
the reason for the default so the operator can override informedly. The
final preview shows the actual JSON the install will write before any
network call or filesystem mutation.

### What changes for the operator

- **Bare `mcp-install`** (TTY, no flags) → walkthrough.
- **Any install-shaping flag** (`--mint` / `--token` / `--legacy-pat` /
  `--scope` / `--install-scope` / `--vault` / `--client`) → existing
  non-interactive path. Flag-passing semantics: "I know what I want."
- **Piped / CI stdin + no flags** → existing non-interactive defaults
  (`--mint`, `vault:read`, user-scope, default vault). Skips prompts
  rather than hanging on stdin no one can answer.

### Walkthrough shape

Each step has a smart default; pressing Enter accepts it. The default is
auto-selected when the choice is obvious:

1. **Vault target.** Skipped when there's exactly one vault, or when an
   existing entry already pins it. With 2+ vaults, prompts and defaults
   to `default_vault`.
2. **Install location.** Defaults to project-scope (`./.mcp.json`) when
   CWD has project markers (`.git`, `package.json`, `pyproject.toml`,
   `Cargo.toml`, `go.mod`, `deno.json`, `.parachute`); otherwise to
   user-scope (`~/.claude.json`). Project-marker detection is shallow —
   only the supplied directory, not its ancestors. Skipped when updating
   an existing entry.
3. **Auth mode + scope.** When hub-mint is available (hub origin
   configured + operator.token present), prompts with `mint` default and
   `vault:read` scope (least-privilege); accepts `write` / `admin` to
   widen, `paste` to use an existing bearer, or `legacy` to fall back to
   `pvt_*`. When hub-mint isn't available, prompts paste vs legacy
   directly with a one-line explanation of why mint is off.
4. **Preview + confirm.** Renders the exact JSON shape that will be
   written (with a `<hub-jwt>` placeholder for the bearer). The live
   mint runs *after* the confirm — a cancellation skips the network
   call entirely.

### Existing-entry detection

When the walkthrough finds a pre-existing parachute-vault entry at
`~/.claude.json` or `./.mcp.json`, it leads with "I see Parachute Vault
is already installed at X. Update it (recommended)?" — accepting the
default pins both install location and entry key from the existing entry,
skipping later prompts that would re-pick them. Operators can decline to
get the fresh-pick flow.

### Internals

- New module `src/mcp-install-interactive.ts` with `runInteractiveInstall`
  + an `InteractiveIO` seam (production wires to `prompt.ts`, tests mock).
- New helpers in `src/mcp-install.ts`: `detectInstallContext`,
  `detectProjectContext`, `detectExistingEntries`. Pure functions —
  test-driveable without monkey-patching globals.
- `cmdMcpInstall` refactored: dispatch front (TTY + flag-presence checks)
  → either flag path or interactive front-end; shared `executeMcpInstall`
  backend acquires bearer and writes (called by both paths).
- `resolveInstallTarget` now prefers `process.env.HOME` over cached
  `os.homedir()` so in-process HOME overrides apply (tests, exotic
  chrooting). `homedir()` remains the fallback.

### Tests

39 new tests across two files:

- `src/mcp-install-interactive.test.ts` (31 tests) — decision-tree
  coverage via `InteractiveIO` mock: single/multi-vault, project /
  non-project context, hub-reachable / not, existing-entry-leads-with-
  update, scope widening to write/admin, paste/legacy fallthrough, help
  reprompt, invalid-input retry, final-confirm abort, empty-vault-list
  bail. Plus context-detection helpers (`detectProjectContext`,
  `detectExistingEntries`, `detectInstallContext`) with positive +
  negative cases.
- `src/mcp-install.test.ts` (2 new tests) — subprocess-level dispatch:
  non-TTY no-flag falls through to flag-driven defaults (doesn't hang
  on prompts); any flag bypasses interactive.

All gates pass. Typecheck clean.

### Deferred from F3 (vault#292 review)

Preview-accuracy cross-check (preview entry-key/URL must match what
`executeMcpInstall` writes) was attempted in
`describe.skip("preview accuracy …")`. The initial in-process walkthrough
+ `Bun.spawnSync` shape looped on `askPersistent` when the inline mock's
coarse default-branch heuristic didn't match a prompt's default. Skipped
for this PR; the equivalence is worth pinning at a smaller seam (extract
shared entry-key/URL builder, pin it directly) rather than driving the
full walkthrough through ad-hoc IO. Tracked as a vault#292 follow-up.

### Out of scope (Phase C — still deferred)

- Cross-client support (Cursor, Claude Desktop, Codex, Zed, Goose, Cline).
- Client auto-detection.
- Token-masking on paste (decided against — security theater; most client
  configs store tokens in plain text anyway).

## [0.4.4-rc.1] — 2026-05-11

Rework `parachute-vault mcp-install` (Phase A + B of the install-flow audit).
Hub-mint becomes the canonical install path; `pvt_*` becomes the explicit
`--legacy-pat` opt-in. New flag surface gives operators control over auth
source, scope, install location, and target vault.

### New CLI shape

```
parachute-vault mcp-install
  [--mint | --token <bearer> | --legacy-pat]    # auth mode (mutually exclusive)
  [--scope vault:read|vault:write|vault:admin]  # default: vault:read
  [--install-scope user|project]                # default: user (~/.claude.json)
  [--vault <name>]                              # default: default_vault
  [--client claude-code]                        # only claude-code wired up
```

### Behavior changes

- **Default is now `--mint`** — install reads `~/.parachute/operator.token`,
  POSTs to `<hub>/api/auth/mint-token` with the requested scope, and writes
  the returned scope-narrow JWT into `Authorization: Bearer …`. Aligns with
  the hub-as-AS direction settled in vault#212. Requires the operator token
  + a configured hub origin; both failure modes have specific remediation
  messages.
- **`--token <bearer>`** — paste an existing bearer (any shape: hub JWT,
  `pvt_*`, legacy YAML key) instead of minting. Skips all token-mint logic.
- **`--legacy-pat`** — mints a vault-DB `pvt_*` token. Preserved for
  self-hosted-without-hub setups. Prints a deprecation notice on stderr;
  the canonical path going forward is hub-mint.
- **`--scope vault:read|vault:write|vault:admin`** — narrows the minted
  token's scope. Default `vault:read` (least-privilege). For `--mint`,
  expands to `vault:<vault-name>:<verb>` so the JWT can't be re-used
  against other vaults on the same hub. For `--legacy-pat`, narrows the
  on-disk token's scope set.
- **`--install-scope user|project`** — `user` writes `~/.claude.json` (old
  behavior); `project` writes `./.mcp.json` in CWD (Claude Code's
  project-local config). Doctor checks both locations now.
- **`--vault <name>`** — targets a specific vault; the entry is keyed as
  `parachute-vault-<name>` so multi-vault installs coexist. Without
  `--vault`, the singular `parachute-vault` slot is used (one install
  per file, default).

### Internals

- `installMcpConfig(apiKey?)` signature → `installMcpConfig(opts)` with
  `targetPath` / `entryKey` / `vaultName` / `bearer` fields. Init's
  bootstrap path continues to mint a `pvt_*` so a fresh standalone install
  still works without a hub; operators with a hub re-run `mcp-install`
  (now defaulting to hub-mint) to upgrade.
- `removeMcpConfig` cleans both `~/.claude.json` and `./.mcp.json` and
  honors the new `parachute-vault-<name>` per-vault keys (plus the legacy
  `parachute-vault/<name>` slash-form for backward cleanup).
- `readMcpEntry` (doctor) checks both target files, prefers user-level,
  and accepts singular + per-vault entry keys. Reports which file +
  entry-key the check matched.
- New helpers in `src/mcp-install.ts`: `chooseHubOrigin` (bare origin for
  hub API calls), `readOperatorToken` (reads `~/.parachute/operator.token`),
  `mintHubJwt` (test-seamed fetch wrapper for the mint-token endpoint),
  `resolveInstallTarget` (user/project file resolver).

### Tests

26 new tests in `src/mcp-install.test.ts` cover: hub-mint happy path with
mocked fetch, every API/network failure mode, operator-token read paths,
install-target resolution, every flag-parsing rejection (mutually
exclusive auth modes, bad `--scope`, bad `--install-scope`, bad
`--client`), missing operator token, no-hub-configured, end-to-end
`--token` / `--legacy-pat` / `--install-scope project` / `--vault <name>` /
overwrite-existing-bearer. Doctor tests updated for the new check-name
shape that includes the source file + entry key. 1281/1281 pass.

### Out of scope (Phase C — deferred)

- **Cross-client support** (Cursor, Claude Desktop, Codex, Zed, Goose,
  Cline) — `--client` flag accepts only `claude-code` and rejects others
  with a "Phase C" message so the surface is documented but not yet
  pluralized.
- **Client auto-detection** (probe installed clients, suggest defaults).
- **Interactive picker** when run from a TTY without explicit flags.

## [0.4.3] — 2026-05-10

Two release cuts (`0.4.3-rc.1` and `0.4.3-rc.2`) ship together as `0.4.3`
on `@latest`. Release-RC detail is preserved in the entries below; this
heading is the operator-facing summary.

Theme: closing the high-priority friction points from the [vault#285
field-input evaluation](https://github.com/ParachuteComputer/parachute-vault/issues/285).
Two PRs landed under the rc chain:

- **vault#286 (rc.1)** — `updated_at` filter (1.5) + `update-note`
  response-shape opt-out (2.response). Two small additive enhancements;
  no behavior change for existing callers.
- **vault#289 (rc.2)** — bracket-style HTTP metadata filter (1.3) with
  bridge for `created_at` / `updated_at` and a deprecation path for the
  flat date params. Closes the largest HTTP-side surface gap.

### Read path

- **`dateFilter` recognizes `updated_at`** (1.5 / vault#286). SSG
  incremental-rebuild flows ask "what changed since X" via
  `dateFilter: { field: "updated_at", from: lastBuildISO }`. No
  indexed-field declaration required — `updated_at` is a real column on
  `notes` and joins `created_at` as a recognized exemption from the
  indexed-field gate.
- **HTTP bracket-style metadata filter** (1.3 / vault#289). Exposes
  vault's full engine operator set — `eq` / `ne` / `gt` / `gte` / `lt` /
  `lte` / `in` / `not_in` / `exists` — to HTTP consumers via
  `?meta[field][op]=value`. Bracket-style is the canonical shape going
  forward; the flat `date_field=…&date_from=…&date_to=…` form is
  deprecated (planned removal 0.6.0, tracked at vault#288).

### Write path

- **`update-note` response-shape opt-out** (2.response / vault#286). New
  `include_content` parameter (default `true`). Set `false` and the
  response swaps the full `Note` for the lean `NoteIndex` shape (drops
  `content`, keeps `byteSize` / `preview` / `validation_status`).
  Order-of-magnitude smaller responses on big notes — the workflow that
  surfaced the friction.

### Discoverability

- **Cookbook section in `README.md`.** Patterns for path-subtree queries,
  sort-by-metadata, preview-only listings, incremental rebuilds, the new
  bracket-meta filter, surgical `content_edit`, atomic `append`, and the
  Funnel pointer for CI access. Distilled from the field-input thread.

### Out of scope (still deferred)

- **1.6 URL-safe slug** — design pending (stability under rename, derive
  from id vs path); deferred until a renderer concretely needs it.
- **Tunable preview length** — the 120-char default has held; revisit
  when a real consumer hits a wall.
- **Section / diff / line-range edits on `update-note`** — speculative
  given that `content_edit` + `append` cover the originating workflow.
- **OR composition across metadata filters** — engine doesn't expose OR
  through the `metadata` shape; future engine-level decision.

## [0.4.3-rc.2] — 2026-05-10

Closes the HTTP-side gap in vault's metadata-filter surface (vault#285
friction point 1.3). The engine has always supported the full operator set —
`eq`/`ne`/`gt`/`gte`/`lt`/`lte`/`in`/`not_in`/`exists` — and MCP exposes it.
Until this release, the HTTP route declared the surface "not practical in
query params" and dropped it entirely. Bracket-style filtering plumbs it
through with a consistent shape.

### Read path

- **Bracket-style metadata filter on `GET /notes` (vault#285 friction point 1.3).**
  Uses the Stripe / JSON:API / Strapi convention:

  ```
  ?meta[field][op]=value                 # eq, ne, gt, gte, lt, lte
  ?meta[field]=value                     # shorthand for eq (JSON-scan fallback;
                                         # no indexed-field declaration required)
  ?meta[field][in][]=v1&meta[field][in][]=v2   # array form
  ?meta[field][in]=v1,v2                 # comma-separated form
  ?meta[field][exists]=true              # presence check (true|false only)
  ```

  Multiple `meta[...]` params AND together. Same-field operators (e.g.
  `meta[score][gte]=5&meta[score][lt]=10`) merge into one operator object.
  Hand-rolled parser in `src/routes.ts` — vault doesn't ship the `qs`
  dependency, and the grammar is small enough that one regex + a couple of
  buckets is cleaner than pulling in a parser library.

- **Bridge for `created_at` / `updated_at` columns.** Bracket-style also
  accepts the real date columns:

  ```
  ?meta[created_at][gte]=2026-04-01
  ?meta[updated_at][gte]=2026-04-01
  ?meta[created_at][lt]=2026-05-01
  ```

  These route through `dateFilter` (not through `metadata`) because they're
  real columns on `notes`, not metadata fields — same exemption as the
  existing flat-param path. Only `gte` (→ inclusive `from`) and `lt` (→
  exclusive `to`) are accepted on these fields; other operators reject with
  a guiding error that names the supported ops. Matches the dateFilter
  contract exactly — `>= from AND < to` is half-open by design.

- **Tag-authorizes-index gate flows through.** Operator queries on a metadata
  field still require the field to be declared `indexed: true` in some tag
  schema (the engine's existing contract at
  `core/src/indexed-fields.ts:1-17`). Bracket-style errors surface as
  HTTP 400 with `code: "FIELD_NOT_INDEXED"`. Shorthand `?meta[field]=value`
  is the exception: it uses the json_extract fallback path and doesn't
  require an index, mirroring the engine's existing primitive-equality
  semantics.

### Deprecation

- **Flat date params are deprecated.** `?date_field=`, `?date_from=`,
  `?date_to=` (and the legacy bare-`date_from`/`date_to` shape) remain
  functional through the 0.5.x line — no behavior change for existing
  consumers — but bracket-style is canonical going forward. Planned removal
  in 0.6.0; tracked at vault#288. On overlap (a request that supplies both
  forms), bracket wins.

### Parser hardening (review folds on initial implementation)

The parser holds invariants that the engine doesn't enforce on its side,
because by the time bad input reaches the engine the parser has already
flattened things. Three classes of silent-data-loss caught in review:

- **Cross-column date filter rejection.** A request mixing
  `meta[created_at][gte]=…` and `meta[updated_at][lt]=…` previously
  flattened both onto a single column (whichever was parsed second won),
  silently applying one column's bound against the wrong column. Now
  rejects with INVALID_QUERY.
- **Shorthand-vs-operator on the same field is mutually exclusive.**
  `meta[field]=v` and `meta[field][gt]=w` in the same request used to
  silently stomp each other based on URL parameter order (insertion-order
  iteration). Both directions now reject with INVALID_QUERY.
- **`[]` array syntax is gated to `in` / `not_in`.** `meta[field][eq][]=v`
  is a shape error rather than a "happens to be an array passed to a
  scalar operator" — now caught at the parser layer with a clear message
  rather than via a generic engine-side INVALID_OPERATOR_VALUE.

Also: refactored the array-bucket keying from `${field}|${op}` string concat
to a nested `Map<field, Map<op, values>>` so field-name characters can't
collide with the delimiter.

### Test plan

- 23 new HTTP tests in `src/vault.test.ts` covering: every operator, both
  array forms, shorthand equality, compound AND on one field and across
  fields, the `created_at`/`updated_at` bridge, deprecation precedence
  (bracket wins), every rejection path (unsupported date-column op,
  non-boolean `exists`, non-indexed field, unknown operator), and the
  three silent-data-loss guards (cross-column date, shorthand+operator
  mix in both orderings, `[]` on non-array operator).
- 1255/1255 tests pass.

### Out of scope

- OR composition across `metadata` filters — the engine's `metadata` shape
  doesn't expose OR; left for a future engine-level decision.
- CLI bracket-style — CLI uses the MCP shape directly; not affected.
- Bumping the operator set on date columns past `gte`/`lt` — would require
  engine-side work and the half-open contract is intentional. Document
  rather than expand.

## [0.4.3-rc.1] — 2026-05-10

Two small additive enhancements distilled from the field-input evaluation in
vault#285. Neither changes existing behavior; both are opt-in conveniences for
agents and SSGs already hitting vault's query and write surfaces.

### Read path

- **`dateFilter` recognizes `updated_at` (vault#285 friction point 1.5).**
  Today `dateFilter.field` accepted only `created_at` or an indexed metadata
  field. `updated_at` joins them as a recognized real column — no indexed-field
  declaration required, no schema setup. Unblocks the incremental-rebuild
  pattern an SSG (or any syncing consumer) reaches for: ask vault "what
  changed since my last build" via
  `dateFilter: { field: "updated_at", from: lastBuildISO }`. Same API across
  MCP (`date_filter.field`) and HTTP (`?date_field=updated_at&date_from=…`).
  No B-tree index on `updated_at` today; a sequential scan is fine for the
  current sizes (file an issue if a real workload ever shows it).

### Write path

- **`update-note` response-shape opt-out (vault#285 friction point 2.response).**
  `update-note` accepts a new `include_content: boolean` parameter. Default
  is `true` for back-compat — existing callers see no change. Set to `false`
  and the response swaps the full `Note` for the lean `NoteIndex` shape
  (`id`, `path`, `createdAt`, `updatedAt`, `tags`, `metadata`, `byteSize`,
  `preview`); `validation_status` is preserved when present. Cuts the
  response cost on the agent workflow that motivated this — frequent
  `append` / `content_edit` edits to large notes — by an order of magnitude
  for big notes. Exposed via MCP `update-note` and HTTP `PATCH /notes/:id`.

### Notes on what stayed put

The wider vault#285 evaluation surfaced six other friction points. None ship
here; the framing is "small additive only, defer design choices":

- **1.1 path_prefix** — already shipped end-to-end (MCP + HTTP + storage).
- **1.2 sort by metadata** — already shipped via `order_by` on indexed fields.
- **1.3 metadata-value filters on HTTP REST** — engine + MCP have it; the
  HTTP query-string syntax is a design choice still pending.
- **1.4 tunable preview length** — `NoteIndex` already returns a 120-char
  preview; a knob is deferred until concretely needed.
- **1.6 URL-safe slug** — design pending (stability under rename, derive
  from id vs path); deferred until a renderer needs it.
- **1.7 Tailscale Funnel** — already documented in README §"Remote access
  via Tailscale Funnel."
- **Section 2 section/diff/line-range edits** — speculative; the
  `append`/`prepend`/`content_edit` primitives that already shipped in
  #200 cover the originating workflow; the response-side cost is what
  this release closes.

## [0.4.2] — 2026-05-10

Six release cuts (`0.4.1-rc.1` through `0.4.1-rc.6`) ship together as
`0.4.2` on `@latest`. Release-RC detail is preserved in the entries
below for granular history; this entry is the operator-facing summary.

### Auth

- **Hub revocation enforcement (hub#212 Phase 4, PR #281).** Hub-issued
  JWTs are checked against the hub's revocation list on every request.
  Bumps `@openparachute/scope-guard` from `^0.1.0` to `^0.2.0`. Revoked
  jtis are rejected with a `401`; client-facing messages for
  revocation-related codes (`revoked`, `revocation_unavailable`) are
  sanitized — full diagnostic stays in the server-side audit log via
  `console.warn`. The existing `pvt_*` opaque-token path is untouched.

### Schema & tags

- **Tag schema inheritance + `_default` universal parent (closes #270,
  rc.2).** A child tag's effective fields = its own ∪ all ancestors'
  (recursive walk, cycle-safe). Multi-inheritance via `parent_names`;
  conflict resolution is first-in-walk wins with a new
  `schema_conflict` advisory warning. A tag named `_default` is the
  implicit universal parent of every note (tagged or not).
- **Tag rename cascade (closes #240, #247, rc.4).** `renameTag(old,
  new)` now rewrites every surface where the old name was referenced
  — tags, sub-tags, `note_tags`, `parent_names` JSON arrays,
  `tokens.scoped_tags`, `indexed_fields.declarer_tags`, note body
  references (`#oldname` / `[[_tags/oldname]]`), and `_tags/<old>`
  config-note paths — in a single `BEGIN IMMEDIATE` transaction.
  **Breaking** for callers that relied on the old
  `tag_in_use_by_tokens` 409 on `POST /api/tags/:name/rename`; the
  cascade now rewrites token allowlists transparently and returns
  `200` with per-surface counts.
- **Migration v17: retire `note_schemas` + `schema_mappings` (closes
  #267, rc.1).** The parallel validation subsystem had zero rows in
  real vaults; the tables drop along with 6 MCP tools
  (`list-note-schemas`, `update-note-schema`, `delete-note-schema`,
  `list-schema-mappings`, `set-schema-mapping`,
  `delete-schema-mapping`) and `/api/note-schemas` REST endpoints.
  `tags.fields` is now the sole schema surface.

### vault-info

- **`vault-info` projection + structured connect-time MCP instruction
  (closes #271, rc.3).** Returns a comprehensive schema description —
  schema-bearing tags with effective inheritance, `indexed_fields`
  catalog, `query_hints` array — that an agent can use to self-orient.
  The MCP `initialize` response carries a markdown projection rendered
  from the same state. Filtered by tag-scoped tokens so the JSON tool
  and the connect-time brief stay in lockstep with the rest of the
  scope-aware surface. Token budget verified under ~5K at 50
  schema-bearing tags.
- **Stats line distinguishes note-usage from schema-bearing tag count
  (closes #274, rc.5).** Was `100 tags`; now `100 tags total, 5 with
  schemas`. Closes the ambiguity an agent or operator hit when many
  ad-hoc tags lived alongside few schema-bearing ones.

### Removed

- **`synthesize-notes` MCP tool retired (closes #268, rc.1).** The
  retirement is part of the same audit-driven cleanup as `note_schemas`
  removal — surfaces that weren't earning their keep.

### Migration notes

- Schema v17 runs idempotently on first boot of `0.4.2`. Existing
  `note_schemas` and `schema_mappings` rows drop; the data lived in
  parallel to `tags.fields` and was unused in real vaults.
- API callers that relied on the `tag_in_use_by_tokens` 409 from
  `POST /api/tags/:name/rename` will need to adapt — the cascade now
  rewrites token allowlists transparently and returns `200` with
  cascade stats. Existing callers using `result.renamed` continue to
  work; field semantics are unchanged.
- `schema_conflict` is a new `ValidationWarning.reason` value
  (rc.2). Strict-enum deserialization may see this on cross-ancestor
  field disagreement; the warning is advisory and safely ignorable by
  clients that don't recognize it.
- **`_default`-scoped auth tokens grant full-vault access.** Tag-scoped
  tokens compute their effective tag set via descendant expansion;
  because `_default` is the universal parent, expanding it returns the
  full tag list. Don't mint `_default`-scoped tokens thinking they
  restrict to a "default-only" tag.

## [0.4.1-rc.6] — 2026-05-10

### Changed

- **Hub-issued JWTs are now checked against the hub's revocation list on
  every request (hub#212 Phase 4).** Bumps `@openparachute/scope-guard`
  from `^0.1.0` to `^0.2.0`. The new version's `validateHubJwt` consults
  `<hub-origin>/.well-known/parachute-revocation.json` after sig/iss/aud/
  expiry pass; revoked jtis surface as `HubJwtError(code: "revoked")` and
  are rejected at `authenticateVaultRequest` with a 401. Without this,
  Aaron could revoke a token via the hub's mint API but vault would still
  honor it — this PR closes that gap from vault's side.

  The existing `pvt_*` opaque-token path is untouched. Phase 6 deprecates
  `pvt_*` separately.

  Failure semantics (live in scope-guard's revocation cache; vault just
  consumes the outcome):
  - 60s TTL matches the hub's `Cache-Control: max-age=60` on the endpoint.
  - Fail-open with last-good cache during a hub outage — a revoked token
    may be accepted up to ~60s past revocation when the hub is unreachable,
    matching the published convergence target.
  - Fail-closed only on first-fetch-failure (cold start, no last-good).
    Surfaces as `HubJwtError(code: "revocation_unavailable")` so operators
    can tell "list couldn't load" from "this token has been retired."

  Client-facing 401s for **all revocation-related codes** are sanitized:
  - `code: "revoked"` → client gets `"token has been revoked"`; the jti
    goes to the server-side audit log via `console.warn`.
  - `code: "revocation_unavailable"` → client gets
    `"token cannot be validated: revocation list unavailable"`; the
    implementation-detail phrasing (`"no last-good cache"`) goes to the
    server-side audit log.

  Sets the inheritable pattern across vault/scribe/agent: revocation
  diagnostics live in operator audit logs, never in the response body.
  Other failure modes (signature, audience, expired, etc.) forward the
  diagnostic message as before — they carry no jti and no implementation
  internals.

### Internal

- Test fixtures in `auth-hub-jwt.test.ts`, `hub-jwt.test.ts`, and
  `tokens-routes.test.ts` extended to serve `/.well-known/parachute-revocation.json`
  alongside the existing `/.well-known/jwks.json` mock. Default response
  is an empty list; `auth-hub-jwt.test.ts` adds explicit cases for revoked
  jtis, mixed-list happy path, and cold-start unreachable.

  scope-guard's own unit suite covers the cache mechanics (TTL refresh,
  fail-open with last-good, single-flight) — vault's tests pin the
  wire-up, the 401 response shapes, and the audit-log invariant
  (`console.warn` spy in the revoked-jti and cold-start cases asserts
  the full diagnostic routes server-side even though the client message
  is sanitized).

### Versioning note

Continues the `0.4.1-rc.N` chain (rc.5 → rc.6) per the pre-1.0 rule —
patch number bumps only on Aaron-confirmed releases.

## [0.4.1-rc.5] — 2026-05-09

### Fixed

- **`vault-info` connect-time stats line distinguishes note-usage tag
  count from schema-bearing count (closes #274).** Pre-fix, the line
  read `2280 notes, 100 tags` — conflating "tags any note carries"
  with "tags with schema declarations." An agent reading "100 tags"
  next to "5 tags with schemas" had to infer the relationship; in
  practice, vaults with many ad-hoc tags and few schema-bearing tags
  read the line as if every tag had a schema.

  New shape: `2280 notes, 100 tags total, 5 with schemas`. The
  schema-bearing count is dropped when zero (so an empty vault still
  reads cleanly as `0 notes, 0 tags total`). Pluralization preserved
  per the rc.3 fix.

  No JSON-schema change to `vault-info` — the stats object still
  carries `tagCount` (driven by `note_tags`) unchanged. The fix is
  purely in `projectionToMarkdown`.

## [0.4.1-rc.4] — 2026-05-09

### Added

- **Tag rename cascade (closes #240, #247).** `renameTag(old, new)` now
  rewrites every surface where the old name was referenced, in a single
  `BEGIN IMMEDIATE` transaction:

  1. `tags` PK row — and recursively for sub-tag rows whose name starts
     with `<old>/`.
  2. `note_tags.tag_name` FK references for every renamed name.
  3. `tags.parent_names` JSON arrays in OTHER tag rows (vault#247's
     specific piece — the inheritance resolver from #270 is now
     load-bearing on this integrity).
  4. `tokens.scoped_tags` JSON arrays — the rename→token cascade
     replaces the previous fail-closed 409 (`tag_in_use_by_tokens`) on
     `POST /api/tags/:name/rename`.

     > **Breaking** for API consumers who relied on that 409 to detect
     > token-referenced tags as rename-blockers. The cascade now
     > rewrites those tokens' allowlists transparently and returns 200
     > with cascade stats.
  5. `indexed_fields.declarer_tags` JSON arrays.
  6. Note body `content`: `#oldname` and `#oldname/...` references
     rewrite to `#newname` / `#newname/...`. `[[_tags/oldname]]`
     wikilinks rewrite to `[[_tags/newname]]`.
  7. `_tags/<oldname>...` config-note paths rewrite to `_tags/<newname>...`
     for vault hygiene (post-v14 these are inert breadcrumbs).

  Pre-flight collision check covers root + every sub-tag path so a
  partway-through abort can't happen on a UNIQUE-constraint violation.
  `target_exists` errors now carry a `conflicting: string[]` listing
  the colliding names.

  Return shape is augmented with per-surface counts:
  `{ renamed, sub_tags_renamed, parent_refs_updated, tokens_updated,
  indexed_field_declarers_updated, notes_rewritten, paths_renamed }`.
  REST `POST /api/tags/:name/rename` returns this shape on success.
  Existing callers using `result.renamed` continue to work; the field
  semantics are unchanged (count of `note_tags` rows repointed,
  cumulative across self + sub-tags).

  The store invalidates both `_tagHierarchy` and `_schemaConfig`
  caches after the cascade since parent_names and the tag set both
  change.

  Audit log: a single `[vault] tag rename cascade: <old> → <new>` line
  is emitted to stderr per cascade for forensic correlation.

### Fixed (folded from PR #275 review)

- **LIKE wildcards (`%`, `_`) inside tag names are now escaped at every
  pre-filter call site.** Pre-fold, a tag literally named `task_` would
  produce `LIKE '%"task_"%'` — and SQLite's LIKE engine treats `_` as
  "any single character," so `taskX` rows surfaced as false-positive
  candidates. The downstream JSON-array remap rejected the row so no
  data corruption — but the wasted scan + bad hygiene was worth
  closing. Each call site now uses `ESCAPE '\\'` paired with a
  pre-escaped pattern.
- **`indexed_fields.declarer_tags` filter gains an `IS NOT NULL`
  guard** to match the consistency of the parent_names + scoped_tags
  filters.

### Fixed (folded from PR #275 re-review)

- **Sub-tag discovery query escapes LIKE wildcards (load-bearing).**
  The upstream discovery query that populates the `renames` list
  (`SELECT name FROM tags WHERE name LIKE ? ORDER BY length(name) DESC`)
  was missed in the prior fold pass. With raw `oldName`, a tag named
  `task_` produced `LIKE 'task_/%'` which matches `taskX/sub` (because
  `_` is a single-char wildcard) — `taskX/sub` would have entered the
  rename transaction and been rewritten to `<new>/sub`, a write the
  caller never requested. Worse than downstream false-positives
  because this is what *populates* the rename set, not just a
  candidate filter. Now uses `escapeLikePattern(oldName)` + `ESCAPE
  '\\'`. Pinned by test #14.

### Notes

- **`name TEXT PRIMARY KEY` stays.** Aaron green-lit the multi-table
  cascade cost over a stable-ID rewrite (2026-05-09). The cascade is
  the load-bearing surface that makes natural-key tag identity
  workable across the schema.
- **Surfaces NOT touched.** Indexed-metadata column names derive from
  field names, not tag names, so `meta_<field>` stays stable across a
  tag rename. Cross-vault rename federation is out of scope.

## [0.4.1-rc.3] — 2026-05-09

### Added

- **`vault-info` projection + structured connect-time MCP instruction
  (closes #271).** `vault-info` now returns a comprehensive vault
  description that an agent can use to self-orient: `name`, `description`,
  `tags` (schema-bearing tag records with own `fields`/`parents` plus
  resolved `effective_fields`/`effective_parents` from the #270
  inheritance walk), `indexed_fields` catalog (one entry per
  `indexed_fields` row, listing every declarer tag), and a static
  `query_hints` array describing the `query-notes` interface. Stats
  remain gated by `include_stats: true` — when set, the existing
  `getVaultStats` shape is appended unchanged.

  The MCP `initialize` response now carries a markdown projection
  rendered from the same vault state (rather than just vault name +
  description). Agents see the schema landscape, the indexed-field
  catalog, and the query-hint catalog at session start, plus explicit
  pointers to call `vault-info` (full refresh) or `list-tags
  { include_schema: true }` (tag-only refresh) mid-session if state
  shifts. Token budget verified: under ~5K tokens at 50
  tags-with-schemas; ~600 for typical small vaults.

  Tool count stays at 9 — the projection rides on the existing
  `vault-info` surface; no new MCP tool added.

  Effective inheritance is computed by reusing #270's
  `resolveNoteSchemas` walk for each tag, so the per-tag projection's
  `effective_*` fields match runtime validation precedence (first-in-walk
  wins; `_default` is the implicit universal parent). Per-tag descriptions
  are surfaced in `vault-info` JSON only — the connect-time markdown
  brief lists tag *names* to keep the token budget tight.

### Fixed (folded from PR #273 review)

- **`vault-info` honors tag-scoped tokens (JSON tool + connect-time
  markdown).** Pre-fold, a token scoped to `task` got the full vault's
  `tags` catalog and `indexed_fields` table (every declarer surfaced).
  Now `vault-info` filters both arrays to entries an in-scope tag
  contributes to, and drops out-of-scope declarer names from each
  `indexed_fields` entry's `tags` field. The connect-time markdown brief
  rendered by `getServerInstruction` (sent via MCP `initialize`) is
  filtered to the token's allowlist via the same shared helper, so the
  JSON tool and the markdown brief stay in lockstep. Symmetric with the
  existing `list-tags` tag-scope wrapper. Aggregate stats (counts,
  monthly distribution) continue to flow through unchanged — pre-#271
  behavior.

## [0.4.1-rc.2] — 2026-05-09

### Added

- **Tag schema inheritance via `parent_names` + `_default` universal parent
  (closes #270).** A tag's `parent_names` column already drove query
  expansion (a query for `#manual` matched any descendant). It now also
  drives **schema inheritance**: a child tag's effective `fields` map = its
  own ∪ all ancestors' (recursive walk, cycle-safe). Multi-inheritance is
  supported — list multiple parents in `parent_names`.

  A tag named `_default` is treated as the implicit universal parent of
  every note, tagged or not. Its `fields` declarations apply everywhere.
  Modeling: magic at resolve time only — `tags.parent_names` is never
  auto-mutated. Removable by deleting the `_default` tag row. The
  symmetric query expansion: `query-notes { tag: "_default" }` returns
  every note in the vault (including untagged).

  Conflict resolution for multi-inheritance is **first-in-walk wins**:
  the child's own `fields` take precedence over inherited specs; among
  parents, earlier entries in `parent_names` outrank later ones. When
  ancestors disagree on a field's spec, the loser surfaces as a
  `schema_conflict` advisory warning on `validation_status` — no write
  blocking, consistent with the rest of the schema-validation model.
  Each `schema_conflict` warning carries `schema` (winner) and
  `loser_schema` (overridden) as structured fields so agents can resolve
  the disagreement without parsing `message`.

  Cache hygiene: the schema-config cache invalidates on `parent_names`
  changes (in addition to the existing `fields` mutations) since
  inheritance now walks parent chains.

### Notes

- **`schema_conflict` is a new `ValidationWarning.reason` value.** Existing
  reasons (`type_mismatch`, `enum_mismatch`) are unchanged. Downstream
  clients with strict-enum deserialization compiled against pre-`0.4.1-rc.2`
  `@openparachute/vault` types may see an unrecognized value if they hit
  vault rows where multiple ancestors declare the same field with diverging
  specs. The warning is advisory — clients can safely ignore unknown
  `reason` values.
- **`_default`-scoped auth tokens grant full-vault access.** Tag-scoped
  tokens (see `patterns/tag-scoped-tokens.md`) compute their effective tag
  set by expanding each input tag through `getTagDescendants`. Because
  `_default` is the universal parent of every tag, expanding it returns
  the full tag list — so a token scoped to `_default` is functionally
  equivalent to an unscoped token. **Do not mint `_default`-scoped tokens
  thinking they restrict to a "default-only" tag.** The semantic is
  intended (it's symmetric with the schema-inheritance model), but the
  wide blast radius is worth flagging explicitly.

### Fixed (folded from PR #272 review)

- **`tagMatch: "any"` + `_default` now drops the tag filter entirely.**
  Pre-fold, an `any`-match query like `tag: ["_default", "task"]` would
  strip `_default` and narrow to `task`-tagged notes only — wrong, since
  the OR-semantics with `_default` (which matches everything) should
  collapse to "every note." The `all`-match behavior (drop `_default`
  from the AND-set, keep the rest) was already correct and is unchanged.
- **`searchNotes` honors `_default` filter-strip.** The FTS-backed search
  path now short-circuits the tag filter when `_default` is requested,
  matching `queryNotes` semantics so untagged notes are reachable from
  search.

## [0.4.1-rc.1] — 2026-05-09

Audit-driven cleanup. The vault MCP surface had two subsystems that
weren't earning their keep — both retired in this RC.

### Removed

- **`note_schemas` + `schema_mappings` + 6 MCP tools (closes #267).** The
  v15 standalone validation subsystem turned out to be a parallel path to
  `tags.fields` with zero rows in the operator vault. Schema migration
  v17 drops both tables wholesale and the six MCP tools they backed
  (`list-note-schemas`, `update-note-schema`, `delete-note-schema`,
  `list-schema-mappings`, `set-schema-mapping`, `delete-schema-mapping`)
  retire alongside. REST endpoints under `/api/note-schemas` go away
  too. Validation now reads `tags.fields` exclusively — same shape
  (`{ type, enum, description }` per field), tag-axis only, advisory
  warnings only. The standalone `required` field-list concept retires
  with the table; declarations are guidance, not enforcement.

  *Migration note.* If your vault used path-prefix-mapped schemas (e.g.
  `match_kind: 'path_prefix'`), file an issue against vault#267
  describing the use case. Tag-mapped schemas continue working as
  `tags.fields` (unchanged for the operator). The migration logs a
  warning naming any dropped schemas/mappings if rows existed so the
  operator can re-create on `tags.fields` if needed.

  *Pre-v15 vault upgrade caveat.* A vault created before v15 shipped
  that never upgraded to v15 will skip the `_schemas/*` notes-as-config
  port path when migrating to v17 (the v14→v15 step ran the port; v17
  drops the destination tables). Any `_schemas/*` config notes in such
  a vault remain as harmless data but are no longer interpreted by
  validation. Operators with such vaults can recreate schemas on
  `tags.fields` directly via `update-tag`.

- **`synthesize-notes` MCP tool (closes #268).** 229 LOC + 160 test LOC,
  zero production invocations. Replicable with `query-notes(near={...})`
  + `find-path` + agent-side aggregation.

  *Migration note.* Agents wanting a ranked-neighborhood view can
  compose `query-notes(near={ note_id, depth: 2 })` + `find-path` +
  their own aggregation. If the optimization (one call vs. multiple)
  becomes load-bearing for a real use case, file an issue.

### Surface

- **MCP tool count: 16 → 9.** Remaining tools: `query-notes`,
  `create-note`, `update-note`, `delete-note`, `list-tags`, `update-tag`,
  `delete-tag`, `find-path`, `vault-info`.

## [0.4.0] — 2026-05-05

First minor bump since `0.3.3` on `@latest`. The work that accumulated across
the `0.3.6-rc.*` line plus the two `0.4.0-rc.*` cuts ships together. Release-RC
detail is preserved in the entries below for granular history; this entry is
the operator-facing summary.

### Schema

- **v14 — single-row tag identity (#244, #245).** Tag schemas (description,
  fields, relationships, parent_names) are columns on `tags` rather than
  `_tags/<name>` notes. One name = one row.
- **v15 — `note_schemas` + `schema_mappings` (#249).** Retire `_schemas/*` notes
  for first-class tables; clearer ownership, cheaper queries.
- **v16 — per-vault token storage (#258).** `tokens.vault_name` column +
  `idx_tokens_vault_name`. Legacy `NULL`-bound rows continue to authenticate as
  server-wide for back-compat; new mints default to vault-bound.

All three migrations idempotent under `BEGIN IMMEDIATE` / `COMMIT` /
`ROLLBACK` (#251 pinned the v14 wrap; v15 + v16 follow the same shape).

### Admin SPA

- **Scaffold + Phase A/B/C — vault detail, tokens, permissions** (#218 chain,
  #222, others). Per-vault dashboard is now a real surface — no more
  shell-only token administration.
- **Per-vault mount at `/vault/<name>/admin/`** (#252, #254, #255, #256).
  SPA boots under a runtime basename matching the mount; `module.json`'s
  `managementUrl` carries a trailing slash so hub-issued JWT fragments survive
  the click-through (browsers drop `#fragment` across 301s).

### Auth

- **Cross-vault token rejection at the auth boundary** (#258). When a `pvt_*`
  resolves to a different `vault_name` than the request's vault, `403` with
  both names in the message. Closes the implicit cross-vault listing surface.
- **JWT audience: per-vault `aud: vault.<name>`** (was hardcoded `"hub"`).
  Hub-issued JWTs scope-bind to the vault they were minted for, so a token
  for `vault.work` can't be replayed at `vault.personal`.
- **`config.yaml` scope-field parsing fix (priv-esc)** (#233). Pre-fix,
  legacy `permissions` keys silently inflated effective scope.

### Correctness

- **Batch operations transactionally atomic (vault#236, PR #260).**
  Multi-item batch entry points (`POST /api/notes`, `create-note`,
  `update-note`) wrap loops in `BEGIN` / `COMMIT` / `ROLLBACK`. A mid-batch
  failure no longer leaves prefix items written. Single-item paths skip the
  wrap to avoid colliding with concurrent callers on the shared bun:sqlite
  connection.
- **`.changes`-based conflict detection migrated to `RETURNING`
  (vault#261, PR #262).** Inside a multi-statement transaction with
  intervening writes, `Statement.run().changes` could carry stale values,
  silently bypassing the `if_updated_at` precondition check. Six sites
  migrated to detect row presence via SQLite's `RETURNING` clause.

### Smaller fixes worth naming

- `query-notes` routes FTS through `store.searchNotes` (#231) and accepts
  camelCase / singular aliases (#224); generalized `date_filter` on indexed
  metadata (#230).
- Empty-note pre-validation + 500-cap batches (#235, vault#213) — closes the
  "7,453 empty pathless rows in one MCP burst" runaway-client surface.
- Tag-scoped tokens Phase 1 (#241).
- `cli init` autostart opt-out via `--no-autostart` (#207, #211).
- `parachute-vault create` re-registers vaults in `services.json` (#209).
- `bun run typecheck` canonical script (#232).
- Hub-issued scope-guard adoption (#212) — common scope-narrowing primitive
  shared with `parachute-hub`.
- `web/ui` per-vault mount routing fixes (#252, #253, #254 — see SPA section).

### Migration notes

- Schema v14, v15, v16 run in sequence on first boot of `0.4.0`. Each is
  idempotent and self-rolls-back on failure.
- Existing tokens minted before v16 carry `vault_name = NULL` and
  authenticate as server-wide. New mints default to vault-bound; pass
  `--all` to `tokens create` to opt back into a server-wide mint (warning
  printed).
- Hub-issued JWTs with the old `aud: "hub"` claim continue to validate
  during the rolling-update window; new mints emit per-vault `aud`.

### Closed without code change

- vault#102 (publish `@openparachute/core` to npm) — `core/` ships bundled
  in the vault tarball; no external consumer needs the standalone package.

## [0.4.0-rc.2] — 2026-05-04

A correctness fix on top of rc.1. The atomicity wrap landed in rc.1 made a
latent bun:sqlite quirk reachable through `if_updated_at`-based optimistic
concurrency; this RC migrates conflict / existence detection off
`Statement.run().changes` to `UPDATE...RETURNING` / `DELETE...RETURNING`
across every site that reads it.

### Fixed

- **vault#261 — `.changes`-based conflict detection migrated to
  `RETURNING`.** Inside a multi-statement transaction with intervening
  writes, `Statement.run().changes` could carry stale values, silently
  skipping the `if_updated_at` precondition check in `noteOps.updateNote`.
  Six sites migrated to detect row presence via SQLite's `RETURNING` clause
  instead of row-count: `core/src/notes.ts` (main + sets-empty conditional
  UPDATE, `renameTag` count), `core/src/note-schemas.ts` (`deleteNoteSchema`,
  `deleteSchemaMapping`), `src/token-store.ts` (`revokeToken`).

### Tests

- `core/src/core.test.ts` — MCP `update-note` batch where item 1's stale
  `if_updated_at` triggers a `ConflictError`: assert item 0's prefix
  mutation rolled back. Pre-fix this test silently passes (the bug class);
  post-fix it asserts the conflict surfaces and the batch unwinds.

## [0.4.0-rc.1] — 2026-05-04

Release-prep cut for the `0.4.0` `@latest` publish. The minor bump signals
the meaningful surface change accumulated across 39 RCs on `0.3.6`: admin
SPA mounted per-vault, per-vault token storage with cross-vault binding,
schema migrations through v16, and the auth-boundary rewrite. This RC
itself folds one correctness fix — vault#236 — and clears housekeeping.

### Fixed

- **vault#236 — batch operations are now transactionally atomic.** Wrap
  multi-item batch loops in `BEGIN` / `COMMIT` / `ROLLBACK` at the three
  public batch entry points (`src/routes.ts` `POST /api/notes`,
  `core/src/mcp.ts` `create-note`, `core/src/mcp.ts` `update-note`). Mirrors
  the existing `core/src/notes.ts:createNotes` pattern. Without this, a
  mid-batch failure (path conflict, conditional-update conflict) left the
  prefix items already written. Single-item calls skip the wrap so
  concurrent callers don't collide on the shared bun:sqlite connection —
  single-note paths are already atomic at the store layer.

### Tests

- `src/vault.test.ts` — HTTP `POST /notes` batch where mid-item triggers
  `PATH_CONFLICT`: assert nothing from the prefix lands.
- `core/src/core.test.ts` — MCP `create-note` batch + `update-note` batch
  with mid-batch `PATH_CONFLICT`: assert prefix items rolled back.

### Closed without code change

- vault#102 (publish `@openparachute/core` to npm) — mooted; `core/` is
  bundled into the vault tarball via `package.json` `files`. No external
  consumer needs the standalone publish today; revisit if that changes.

## [0.3.6-rc.39] — 2026-05-04

vault#257 — per-vault token storage migration. Tokens now bind to the vault they were minted from, and cross-vault use is rejected at the auth layer. Pre-v16 tokens carry a `NULL` `vault_name` and remain server-wide (legacy compatibility), so existing deployments keep working unchanged; new mints default to vault-bound. The cross-vault leak surface was small in practice (per-vault DBs already scope storage; only `authenticateGlobalRequest` at `/mcp` iterated across vaults), but the explicit `vault_name` column closes the gap with defense-in-depth at every per-vault auth path.

### Changed

- **Schema v15 → v16: `tokens` table grows `vault_name TEXT` + `idx_tokens_vault_name` index.** `core/src/schema.ts:migrateToV16` runs an idempotent `ALTER TABLE … ADD COLUMN` inside `BEGIN IMMEDIATE` / `COMMIT` (ROLLBACK on failure) — same shape as v14/v15 from vault#251. Lenient backfill: existing rows get `NULL` (= legacy server-wide). New rows default to the minting vault's name. Index keeps the per-vault `WHERE vault_name = ? OR vault_name IS NULL` filter cheap on large token sets.
- **`src/auth.ts:authenticateVaultRequest` rejects cross-vault token use with 403.** When a `pvt_*` resolves to `vault_name = <other>` and the request is for `<this>`, the response is `403 Unauthorized` with a message naming both vaults. `NULL`-bound (legacy) tokens still pass — the migration is additive, not breaking. Hub-issued JWTs continue to use `vault:<name>:<verb>` scope narrowing as the audience-binding mechanism (JWTs aren't per-token-DB rows, so `vault_name` doesn't apply).
- **`src/token-store.ts` surfaces `vault_name` end-to-end.** `Token` and `ResolvedToken` carry the field; `createToken` accepts an optional `vault_name` (default null = server-wide); `listTokens` accepts `{ vaultName }` and filters with `WHERE vault_name = ? OR vault_name IS NULL` so legacy NULL-bound rows remain visible alongside the bound set.
- **`src/tokens-routes.ts` per-vault endpoints filter by `vault_name`.** `GET /vault/<name>/tokens` returns vault-bound + legacy NULL-bound rows; `POST` mints with `vault_name = <name>`; `DELETE` only revokes rows that belong to the calling vault (or are NULL-bound). The implicit cross-vault listing surface in the SPA is now closed at the route layer, not just the SPA layer.
- **`src/cli.ts tokens` gains `--vault <name>` and `--all` flags.** `tokens list --vault <name>` mirrors the SPA's per-vault filter from the command line. `tokens create --all` is the explicit opt-in for a server-wide mint (prints a warning since that's no longer the default); `tokens create --vault <name>` binds explicitly; `tokens create` with neither defaults to the active vault. List output annotates legacy rows with `[server-wide]` so operators can spot pre-v16 tokens at a glance.
- **`web/ui/src/lib/tokens-api.ts:TokenSummary` adds `vault_name: string | null`.** The SPA's wire-shape interface mirrors the server's `tokens-routes.ts` response. `web/ui/src/routes/VaultTokens.tsx` renders a `server-wide` badge next to NULL-bound rows so legacy tokens are visually distinct from per-vault mints — matches the issue's UI guidance.

### Tests

- `src/token-store.test.ts` — new `per-vault binding (v16)` describe (3 cases): NULL when `vault_name` omitted, binding when set, `listTokens({ vaultName })` returns vault-bound + legacy NULL but excludes other-vault-bound rows. Doubles as a v16-migration pin since the test creates fresh DBs through `initSchema` (current SCHEMA_VERSION) and operates on the new column.
- `src/auth.test.ts` — new `auth — cross-vault isolation` describe (3 cases): cross-vault binding rejects 403, matched binding accepts, NULL-bound legacy tokens still authenticate.
- `src/tokens-routes.test.ts` — new v16 list-filter case: plants a token in another vault's DB and a legacy NULL-bound row in the calling vault's DB; asserts the foreign-vault row is excluded from the response, the legacy row is present, and the response surfaces the new `vault_name` field.
- `web/ui/src/routes/VaultTokens.test.tsx` — fixture migrated to include `vault_name: "work"` so the typecheck pins the field's presence on the wire.

## [0.3.6-rc.38] — 2026-05-04

vault#252 third follow-up — fix the empty-stats render Aaron caught after rc.37 unblocked the auth flow. The Stats section on the per-vault detail page rendered all four labels (Notes / Tags / Attachments / Links) but the values next to them were blank. Two contributing bugs: the SPA's `VaultStats` interface used short names (`notes`, `tags`, `attachments`, `links`) that don't exist in the wire payload, and the server-side `VaultStats` had no attachment count at all. Every read coerced `undefined` → `""` and rendered blank.

### Changed

- **`core/src/types.ts:VaultStats` adds `attachmentCount: number`.** Single `SELECT COUNT(*) FROM attachments` in `core/src/notes.ts:getVaultStats`. Cheap query against a small table — same shape as the existing `tagCount` / `linkCount` adjacent counters. Non-breaking addition: `vault-info` MCP tool, `/api/vault?include_stats=true`, and the bare `/vault/<name>/` detail endpoint all surface the new field automatically. Fills the gap between the documented four-stat UI and the previously-three-stat server payload.
- **`web/ui/src/lib/api.ts:VaultStats` field names align with the server.** `notes` → `totalNotes`, `tags` → `tagCount`, `attachments` → `attachmentCount`, `links` → `linkCount`. The wire payload's keys are the canonical source — the SPA used to shadow them with shorter names, which silently failed. New JSDoc documents the contract: SPA's interface mirrors `core/src/types.ts:VaultStats` byte-for-byte for the fields it reads.
- **`web/ui/src/routes/VaultDetail.tsx` reads the wire-shape field names directly.** No transform layer — the server returns what the SPA renders, so a future field rename trips the typechecker, not the user.

### Tests

- `core/src/core.test.ts` — new `getVaultStats counts attachments` case (creates two notes, attaches three files across them, asserts `attachmentCount === 3`); existing `getVaultStats returns correct stats` case extended to assert `attachmentCount === 0` for the no-attachments baseline.
- `web/ui/src/App.test.tsx` — new `renders the actual stat counts from the wire payload` case under per-vault mount: mocks `getVaultDetail` with `{totalNotes: 12, tagCount: 3, attachmentCount: 1, linkCount: 4}` and asserts every value renders. Explicit regression pin against the field-name drift that motivated this fix; future rename on either side trips this test.
- `web/ui/src/lib/api.test.ts` — fixture migrated to wire-shape names (was the source of the silent drift — the test passed even when the SPA was reading nonexistent keys, because the test fixture matched the SPA's reads, not the server's writes).

## [0.3.6-rc.37] — 2026-05-04

vault#252 second follow-up — fix the actual root cause of Aaron's no-token error after rc.36 closed the URL-doubling bug. Browsers drop URL fragments when following a 301 redirect (RFC 7231 says SHOULD preserve, but Chrome/Firefox/Safari behavior is inconsistent in practice — WebKit historically drops, Chrome sometimes preserves). The hub-issued JWT travels in `#token=…`, so the redirect rc.35 added (`/vault/<name>/admin` → `/vault/<name>/admin/`) was dropping the token before the SPA could capture it. The SPA then booted unauthenticated and rendered the no-token error — even though the operator clicked through hub correctly.

### Fixed

- **`.parachute/module.json` `managementUrl: "/admin"` → `"/admin/"`.** Hub's `resolveManagementUrl` (parachute-hub `web/ui/src/lib/api.ts`) joins the per-vault module URL with this string verbatim. With the trailing slash the canonical click target is `/vault/<name>/admin/` directly — no redirect, no fragment loss, browser preserves `#token=…` end-to-end. The server-side 301 from rc.35 stays as defense-in-depth (covers manual URL typing and old bookmarks), but it's no longer load-bearing for the hub flow. Establishes the contract: SPA-style `managementUrl`s should end with `/` so the URL the operator's browser sees is the same URL the server serves.

### Tests

- `src/admin-spa.test.ts` (2 new) — pin the hub↔vault `managementUrl` contract: (a) `module.json`'s `managementUrl` ends with `/`, (b) the canonical hub-emitted URL (per-vault module URL joined with `managementUrl` à la `resolveManagementUrl`) serves the SPA shell with status 200 and no `Location` header. The "no Location header" assertion is the explicit regression pin — if a future change re-introduces a 301 on the canonical form, fragments would silently drop again.

## [0.3.6-rc.36] — 2026-05-04

vault#252 follow-up — fix URL doubling under per-vault mount. The rc.35 SPA used `<Navigate to="/vault/<name>" replace />` from the `/` route to jump operators landing at `/vault/<name>/admin/` straight to the vault detail page. Under React Router v6 with `<BrowserRouter basename="/vault/<name>/admin">`, paths in `<Navigate to>` and `<Link to>` are basename-relative absolute paths — so the redirect resolved to `/vault/<name>/admin/vault/<name>` (basename + path), and the operator landed on a doubled URL with no matching route, falling through to the auth-required shell. The redirect was the wrong shape: the SPA needs different routes per mount mode, not a clever redirect.

### Fixed

- **`web/ui/src/App.tsx` switches the route table on mount mode instead of redirecting.** When `getMountedVaultName()` returns a name (per-vault mount), the route table is `{ "/" → VaultDetail, "/tokens" → VaultTokens }` with the mounted vault name passed as a prop. When it returns null (legacy `/admin/*` or stand-alone), the table is the original picker tree (`{ "/" → VaultsList, "/vault/:name" → VaultDetail, "/vault/:name/tokens" → VaultTokens }`). No `<Navigate>` anywhere — the route table answers the URL directly. Nav-bar's vault-name link points at `/` under per-vault mount (was `/vault/<name>` — the same doubling).
- **`VaultDetail` and `VaultTokens` accept an optional `vaultName` prop, fall back to `useParams()`.** Per-vault mount passes the prop straight through (no `:name` segment exists under `basename="/vault/<name>/admin"`); stand-alone reads it from the URL params. The presence of the prop also picks the inner-Link shape — `/tokens` vs `/vault/<name>/tokens` from VaultDetail's Manage section, `/` vs `/vault/<name>` for VaultTokens's "← Vault detail" back-link. Picking the wrong shape re-introduces the doubled-URL bug, so the choice is local to where the link is emitted.
- **Back-to-vaults links suppressed under per-vault mount.** The hub doesn't proxy `/vaults/list`, so a "← Back to vaults" link under per-vault mount would land on a broken picker. The auth-required banner already directs the operator back to the hub directory; that's the actual remediation path.

### Tests

- `web/ui/src/App.test.tsx` (new) — 8 cases pinning the mount-mode split: per-vault mount renders `VaultDetail` directly at `/` (no redirect, no doubled URL), emits the Tokens link as `/tokens` (NOT `/vault/<name>/tokens`), and renders `VaultTokens` at `/tokens`; stand-alone mount keeps the picker-then-detail tree with the full `/vault/<name>` shape. The Tokens-link href assertion is the explicit regression pin — under `<BrowserRouter basename="/vault/<name>/admin">` the wrong shape would re-introduce the bug.

## [0.3.6-rc.35] — 2026-05-03

vault#252 — remount the admin SPA from origin-rooted `/admin/*` to per-vault `/vault/<name>/admin/*` so it's reachable through hub's `/vault/<name>/*` proxy. The hub doesn't proxy origin-rooted paths, which left an operator clicking "Manage Vault" on the hub directory landing on a 401-walled vault metadata endpoint instead of the SPA. Three layers move in lockstep — the server's static-file dispatch, the React Router runtime basename, and Vite's asset-base — so the same compiled bundle works at any per-vault mount without a rebuild.

### Changed

- **`src/admin-spa.ts:isAdminSpaPath` regex + `serveAdminSpa` strip.** New mount regex `/^\/vault\/([^/]+)\/admin(?=\/|$)/` matches `/vault/<name>/admin` and any subpath under it (assets, client-routed paths). The strip-prefix collapses to `pathname.replace(MOUNT_RE, "")` so `/vault/foo/admin/assets/x.js` maps to `/assets/x.js` against the same `dist/` directory. Bare `/vault/<name>/admin-foo` and `/vault/<name>` (the metadata endpoint) explicitly do not trigger the SPA — only the mount root and its true subpaths. Routing test `/vault/<name>/api/notes` still reaches the per-vault API (regression pin).
- **`src/routing.ts` admin-spa dispatch must fire BEFORE per-vault dispatch.** Already the case, but the comment block now spells out why — the per-vault auth wall would otherwise short-circuit static-asset responses with a 401 JSON body. The legacy origin-rooted `/admin/*` no longer matches anything; falls through to the catch-all 404. Hub's directory page links to `/vault/<name>/admin#token=…` post-hub#162-realignment.
- **`web/ui/src/lib/mount.ts` (new): runtime basename detection.** `getMountedVaultName()` extracts `<name>` from `window.location.pathname`; `getBasename()` returns the matching React Router basename (`/vault/<name>/admin`, with percent-encoding preserved so it matches the URL byte-for-byte). Legacy fallback to `/admin` for dev served at the old mount; empty string for stand-alone root. Mirrors hub#173's dual-mount basename detection on the hub side.
- **`web/ui/src/main.tsx` BrowserRouter basename pulled from `getBasename()`.** No longer reads `import.meta.env.BASE_URL` since the build base is now relative — and the runtime mount is per-vault anyway, which can't be baked at build time.
- **`web/ui/src/App.tsx` redirects `/` to `/vault/<name>` when mounted under a specific vault.** The generic vault picker (`VaultsList`) calls `/vaults/list`, which hub doesn't proxy — so when reached via the hub proxy the picker would show an empty/erroring list. Per-vault mount jumps straight to the detail page using `<Navigate to="/vault/<name>" replace />`. Nav-bar label switches to the vault name (`<code>boulder</code>`) under per-vault mount instead of the generic "Vaults" link. Legacy `/admin/*` and stand-alone root mounts still get the picker.
- **`web/ui/vite.config.ts` `base: "./"` (was `/admin/`).** Asset URLs resolve relative to wherever `index.html` was served, so the same bundle works at any `/vault/<name>/admin/` mount without a rebuild. `VITE_BASE_PATH` override still works for stand-alone dev (`VITE_BASE_PATH=/`).
- **`web/ui/scripts/verify-base.mjs` asserts `./assets/` (was `/admin/assets/`).** Same drift check, adapted to the new relative-base contract; the override skip-condition now matches `VITE_BASE_PATH=./`.
- **`web/ui/CLAUDE.md` mount-aware contract section + lib/auth.ts JSDoc** updated to document the per-vault mount, runtime basename detection, and the new "Manage" link shape (`<hub-origin>/vault/<name>/admin#token=…`).

### Fixed

- **`serveAdminSpa` redirects bare `/vault/<name>/admin` → `/vault/<name>/admin/` (301).** Browsers resolve relative URLs against the **directory** of the current document, not the document URL itself — so Vite's `./assets/index-abc.js` resolves correctly only when the SPA is loaded with a trailing slash. Hub's `resolveManagementUrl` (`web/ui/src/lib/api.ts`) generates the bare form (strip trailing slash, append `/admin`), which means without this canonicalization the SPA bundle's asset URLs would resolve to `/vault/<name>/assets/...` and 404 against the per-vault auth wall — the SPA would never boot. Same shape the notes-server uses for its `--mount` canonicalization. Reviewer-caught blocker on the initial #252 push; the redirect ships in the same PR. New regression test in `admin-spa.test.ts` pins the 301 + Location header so future refactors can't silently regress the asset-resolution contract.

### Tests

- `src/admin-spa.test.ts` — 8 new cases for the per-vault regex (matches `/vault/<name>/admin[/...]`, rejects `/vault/<name>/admin-foo`, `/vault/<name>`, origin-rooted `/admin/*`, percent-encoded vault names strip cleanly).
- `src/routing.test.ts` — 7 new cases for the dispatch (per-vault SPA mount fires before per-vault dispatch, even when the vault doesn't exist — the SPA shell is static; POST 405; `/vault/<name>/admin-foo` falls through to per-vault auth wall; legacy `/admin/*` returns 404; `/vault/<name>/api/notes` regression pin).
- `web/ui/src/lib/mount.test.ts` — 11 new cases covering vault-name extraction (per-vault mount, deep client-routed paths, percent-decoded names), null cases (legacy `/admin/`, stand-alone root, per-vault metadata path, `/vault/<name>/admin-foo`), and basename construction (preserves percent-encoding for byte-for-byte React Router matching).

## [0.3.6-rc.34] — 2026-05-04

vault#248 — wrap the v13 → v14 migration in an explicit `BEGIN IMMEDIATE / COMMIT` transaction so a crash mid-migration leaves the DB in either pre-v14 or post-v14 state, never half-migrated. Surfaced during review of vault#245: every step in `migrateToV14` is individually idempotent (ALTER TABLE adds are guarded by `hasColumn`, data copies are upsert-and-update, the final `DROP TABLE tag_schemas` is guarded by `hasTable`), but the failure mode wasn't specified — a future reader could remove the guards thinking "we have transactions now." Wrapping the body makes the guarantee explicit; the idempotent guards become belt-and-suspenders.

### Fixed

- **`migrateToV14` body wrapped in `BEGIN IMMEDIATE / COMMIT` with try/catch ROLLBACK.** Mirrors the v15 transaction wrap that landed in rc.32. The early-return guard (`if (!hasTable(db, "tags")) return`) stays outside the envelope — if there's no `tags` table at all, there's nothing to roll back. Inside: ALTERs, two data copies (`tag_schemas` → `tags`; `_tags/<name>` notes → `tags.parent_names`), the timestamp backfill, and the final `DROP TABLE tag_schemas` all live inside one envelope; a thrown exception in any step rolls back the whole migration. Modern SQLite (3.6+ via bun:sqlite) supports DDL inside transactions, so ALTER and DROP both honor the rollback. New regression test (`crash mid-migration rolls back to pre-migration state, then retry succeeds`) injects a throw on `DROP TABLE tag_schemas`, asserts the DB returns to pre-v13 shape (tag_schemas table present with rows intact, tags has `(name)` only, `_tags/voice` note untouched), then drops the injection and re-runs `initSchema` — convergence to the same final post-v14 state as a clean run.

## [0.3.6-rc.33] — 2026-05-03

vault#249 reviewer-fold pass: tighten the auth boundary on the new `/api/note-schemas` (+ matching MCP tools) so tag-scoped tokens can't enumerate or write `tag`-kind `schema_mappings` outside their allowlist, fix the `migrateToV15` short-circuit to use `||` instead of `&&` (a vault with schemas but zero mappings is a valid state — the buggy condition re-scanned `_schema_defaults` on every boot), and refresh the `resolveApplicableSchemas` JSDoc to point at `note_schemas` instead of the retired `_schemas/<name>` convention. No data shape or version-bump trigger; rc.33 carries the reviewer feedback only.

### Fixed

- **`handleNoteSchemas` threads `tagScope` through every read and write.** Mirrors the `handleTags` precedent (vault#241): list/get of `schema_mappings` filters `tag`-kind rows whose `match_value` falls outside the token's expanded allowlist (path_prefix mappings carry no tag-axis information and stay visible). `POST` and `DELETE` on `/api/note-schemas/:name/mappings` reject out-of-scope `tag` writes with the standard `403 {error_type: "tag_scope_violation"}` envelope. The MCP wrappers in `src/mcp-tools.ts` get matching guards on `list-note-schemas`, `set-schema-mapping`, and `delete-schema-mapping` so the auth boundary is consistent across HTTP and MCP. The string-form fallback in patterns/tag-scoped-tokens.md §Storage details is honored end-to-end via `tagsWithinScope([match_value], allowed, raw)`.
- **`migrateToV15` short-circuit `hasSchemas && hasMappings` → `hasSchemas || hasMappings`.** A vault that has schemas but no mappings (or — structurally impossible today, but defensively correct — mappings but no schemas) is a valid post-v15 state. The previous `&&` would re-scan `_schemas/*` and `_schema_defaults` notes on every boot when one table was empty, even though `INSERT OR IGNORE` made the result safe. One-character fix; new regression test asserts the migration no-ops when `note_schemas` is non-empty and `schema_mappings` is empty.
- **`resolveApplicableSchemas` JSDoc refresh.** Comment said "names that don't have a backing `_schemas/<name>` definition are dropped" (pre-v15 vocabulary). Updated to "names that don't have a row in `note_schemas`."

## [0.3.6-rc.32] — 2026-05-03

`_schemas/*` notes-as-config retirement — closes the convention-vs-table loop that the rc.31 tag-identity reshape opened. Two new SQLite tables — `note_schemas` (definition: name, description, fields JSON, required JSON, timestamps) and `schema_mappings` (binding: schema_name FK, match_kind ∈ {`path_prefix`, `tag`}, match_value, composite PK, ON DELETE CASCADE) — replace the `_schemas/<name>` and `_schema_defaults` notes-as-config convention. Validation (`validation_status` on create-note / update-note responses) is unchanged in behavior; the resolver just reads from the new tables instead of scanning notes. Authoring moves to a proper API: six new MCP tools (`list-note-schemas`, `update-note-schema`, `delete-note-schema`, `list-schema-mappings`, `set-schema-mapping`, `delete-schema-mapping`) and a matching REST surface (`/api/note-schemas[/:name]` + nested `/mappings`). The legacy notes are LEFT IN PLACE post-v15 — inert (no resolver reads them), preserved as audit trail. Schema bumped 14 → 15.

### Added

- **`note_schemas` and `schema_mappings` tables (schema v15).** `note_schemas` is the definition row: `name TEXT PRIMARY KEY, description TEXT, fields TEXT` (JSON object keyed by field name, each value `{type, enum?, description?}` — same shape the legacy `_schemas/<name>.metadata` carried), `required TEXT` (JSON array of field names that must be present, or NULL when no field is required), `created_at TEXT, updated_at TEXT`. `schema_mappings` is the binding row: `schema_name TEXT NOT NULL REFERENCES note_schemas(name) ON DELETE CASCADE, match_kind TEXT CHECK (match_kind IN ('path_prefix','tag')), match_value TEXT NOT NULL, PRIMARY KEY (schema_name, match_kind, match_value)`. The composite PK makes `setSchemaMapping` idempotent — re-setting the same triple is a no-op. ON DELETE CASCADE means `deleteNoteSchema('foo')` automatically clears every `(foo, *, *)` mapping, so the two tables stay coherent without a separate cleanup step. Index `idx_schema_mappings_match` on `(match_kind, match_value)` keeps validation lookups O(log n) as the mapping table grows.
- **`note-schemas.ts` CRUD module + Store interface.** Seven typed entry points on `Store`: `listNoteSchemas()`, `getNoteSchema(name)`, `upsertNoteSchema(name, patch)` (partial-upsert mirroring `upsertTagRecord` — undefined preserves, null clears, empty `required: []` collapses to null), `deleteNoteSchema(name)`, `listSchemaMappings(opts?)` (filter by `schema_name` and/or `match_kind`), `setSchemaMapping(schema, kind, value)`, `deleteSchemaMapping(schema, kind, value)`. The schema-config cache (`BunSqliteStore._schemaConfig`) is invalidated synchronously inside the writers so reads after writes always see the post-write state — invalidation moved off the note-write hook (where it was a stale O(write) tax for vaults that never used `_schemas/*`) onto the table-write hook.
- **MCP authoring surface — six new tools.** `list-note-schemas` (with optional `name` for single-fetch + nested mappings, or `include_mappings: true` to inline mappings on every entry), `update-note-schema` (partial-upsert; routes through `store.upsertNoteSchema` so the cache invalidates), `delete-note-schema` (drops the row; FK CASCADE clears mappings), `list-schema-mappings` (filter by `schema_name` and/or `match_kind`), `set-schema-mapping` (validates `match_kind` against `MAPPING_KINDS = ['path_prefix','tag']` at the boundary), `delete-schema-mapping`. Tool count goes 10 → 16. Same shape as `update-tag` / `delete-tag` for consistency.
- **REST authoring surface — `/api/note-schemas`.** `GET /api/note-schemas[?include_mappings=true]` lists all schemas (optionally inlining each schema's mappings); `GET /api/note-schemas/:name` returns a single schema with its mappings (404 when missing); `PUT /api/note-schemas/:name` partial-upserts (auto-creates the row if missing, accepts `description`/`fields`/`required`, returns the post-write row); `DELETE /api/note-schemas/:name` drops the schema (FK CASCADE clears mappings). Mappings are nested under `:name`: `GET /api/note-schemas/:name/mappings` lists, `POST /api/note-schemas/:name/mappings` adds (body `{match_kind, match_value}`; returns 201; pre-validates the FK as 404 rather than letting SQLite throw 500 on a missing schema), `DELETE /api/note-schemas/:name/mappings?match_kind=...&match_value=...` removes (query parameters, not URL segments — `match_value` for `path_prefix` mappings can contain slashes, which would break path-segment routing). Bad `match_kind` returns `400 {error_type: "invalid_match_kind"}`.
- **`loadSchemaConfig` resolver swapped from notes-scan to table-scan.** `core/src/schema-defaults.ts` now queries `note_schemas` + `schema_mappings` instead of scanning `_schemas/<name>` and `_schema_defaults` notes; the same `ResolvedSchemas` shape is returned, so `resolveApplicableSchemas` and `validateMetadata` are untouched. `SCHEMA_CONFIG_PREFIX = "_schemas/"` and `SCHEMA_DEFAULTS_PATH = "_schema_defaults"` remain exported for any historical caller that still references them, but no resolver code reads notes-as-config post-v15.

### Storage / migration

- **Schema bumped 14 → 15.** The two new tables are `CREATE TABLE IF NOT EXISTS` so a fresh vault picks them up directly; existing vaults get the same `IF NOT EXISTS` adds plus a one-shot data fold. `migrateToV15(db)` short-circuits when the destination tables already have data (no re-scan on every boot), wraps the fold in `BEGIN IMMEDIATE / COMMIT / ROLLBACK` so a crash mid-migration leaves the DB in pre-v15 or post-v15 state (never partial — stronger guarantee than v14, where the missing transaction is the subject of vault#248), then: (1) copies every `_schemas/<name>` note's `metadata.{description, fields, required}` into a `note_schemas` row keyed by the path suffix; (2) copies the `_schema_defaults` note's `metadata.path_prefixes` and `metadata.tags` into matching `schema_mappings` rows. When a `_schema_defaults` mapping references a schema name that has no `_schemas/<name>` definition, an `INSERT OR IGNORE` stub `note_schemas` row is auto-created so the FK on `schema_mappings.schema_name` holds. The legacy notes are **left in place** post-v15 — inert (no resolver reads them) and preserved as audit trail; users can delete them at their convenience. Verified safe on byte-identical copies of three production vault DBs: default (0 `_schemas/*`, no `_schema_defaults` — no-op fold, idempotent), techne (same), boulder (same). All three idempotent on second `initSchema` call. Note counts unchanged across the migration in every case.
- **Cache-invalidation hook moved off note writes.** Pre-v15 the `BunSqliteStore` invalidated `_schemaConfig` on every `_schemas/<name>` or `_schema_defaults` note write; post-v15 the same hook fires on `upsertNoteSchema` / `setSchemaMapping` / `deleteNoteSchema` / `deleteSchemaMapping` instead. Vaults that never use schemas pay zero invalidation tax on the note-write path.

### Deferred

- **Renaming a `_schemas/<name>` note no longer carries the schema with it.** The legacy convention had path-rename semantics for free (a Finder-style move of a `_schemas/foo` note to `_schemas/bar` would rename the schema); the new authoring surface has explicit `update-note-schema` + `delete-note-schema`. Acceptable for v15 — the rename use case is rare and surfaces clearly in the new API. If demand emerges, a future `rename-note-schema` MCP/REST verb can land additively.

## [0.3.6-rc.31] — 2026-05-03

Tag identity reshape — Phase 1 per `parachute-patterns/patterns/tag-data-model.md` (#29). The `tags` table goes from a name-only enrolment row to the single source of truth for everything *about* a tag: description, indexed metadata field schema, typed-link declarations (relationships), parent tag(s), and timestamps. The hierarchy resolver swaps from reading `_tags/<name>` notes-as-config to reading `tags.parent_names` directly, retiring the sidecar-note convention without rewriting history (the legacy `_tags/*` notes are left in place as a harmless audit trail). The `tag_schemas` sidecar table is dropped; its rows fold into the `tags` row of the same name. `update-tag` (MCP) and `PUT /api/tags/:name` (REST) now accept the full record shape — partial upsert, undefined preserves, null clears. `list-tags` and `GET /api/tags` return the full record on every entry. `_schemas/*` notes-as-config retirement is explicitly deferred to vault#246; the `_schema_defaults.path_prefix` shape isn't 1:1 with what `tags` carries today, so collapsing it warrants its own design pass.

### Added

- **`tags` table carries the full tag record (schema v14).** Six new columns layered onto the existing `(name)` row: `description TEXT`, `fields TEXT` (JSON array of `{name, type, indexed?, description?}` schema entries — same shape as the old `tag_schemas.fields_json`), `relationships TEXT` (JSON object keyed by relationship name, each value `{target_tag, cardinality, description?}` — Phase 1 informational, no enforcement yet), `parent_names TEXT` (JSON array of parent tag names — the hierarchy declaration), `created_at TEXT`, `updated_at TEXT`. Cardinality vocabulary is a closed set: `"one" | "optional" | "many" | "many-required"` — named, AI-legible, validated at the API boundary. The single-row identity model lets `update-tag` patch any subset of fields without touching the rest; clearing a field is `null`, omitting it preserves the prior value, and an empty `parent_names` array collapses to `null` so hierarchy enforcement stays consistent (no-parents and unset-parents are the same case).
- **`upsertTagRecord(tag, patch)` on `Store` — partial upsert with hierarchy-cache invalidation.** `Store.listTagRecords()`, `Store.getTagRecord(tag)`, and `Store.upsertTagRecord(tag, patch)` are the new tag-record API on the store interface. The upsert handles row creation (auto-creates the tag if absent, mirroring how `note_tags` already auto-creates), partial patching (only the fields named in `patch` are written), and timestamps (`created_at` set on insert, `updated_at` on every write). When `patch.parent_names !== undefined`, the in-memory `_tagHierarchy` cache is invalidated so the next `loadTagHierarchy()` reflects the change — same invalidation hook is wired on `deleteTag`, `renameTag`, and `mergeTags` so any path that mutates parent-bearing rows stays coherent. The schema-only facade (`listTagSchemas`, `getTagSchema`, `upsertTagSchema`, `deleteTagSchema`) routes through the same row — a `deleteTagSchema` clears the schema columns but preserves the row, since tag identity persists independent of whether anyone has declared a schema.
- **`update-tag` MCP + `PUT /vault/<name>/api/tags/:name` accept the full record shape.** Both surfaces gain `relationships?: Record<string, {target_tag, cardinality, description?}>` and `parent_names?: string[] | null` alongside the existing `description?` and `fields?`. Validation is at the boundary: `validateRelationships(raw)` throws a user-readable error on malformed shape (non-object value, missing `target_tag`, unknown cardinality) — MCP returns the standard `isError: true` envelope, REST returns `400 {error, error_type: "invalid_relationships"}` with the same message. `parent_names` is accepted as an array of strings (collapsed to `null` when empty) or explicit `null` to clear. Partial-patch semantics: omitting a field preserves it, `null` clears, an array/object replaces. `delete-tag` (MCP + REST) no longer makes a redundant schema-clear call — dropping the `tags` row is the single operation now.
- **`list-tags` MCP + `GET /vault/<name>/api/tags` return the full record.** Each entry now includes `description`, `fields`, `relationships`, `parent_names`, `created_at`, `updated_at` alongside `name` and `noteCount`. Single-tag fetch (`GET /api/tags/:name`) returns the same shape. The `noteCount` aggregation is unchanged. Tag-scoped tokens still filter the list to the allowlist root + descendants — the swap to `tags.parent_names` for hierarchy resolution preserves the same `expandTagsWithDescendants` behavior on the read path, with a regression test pinning the post-v14 expansion against the v13 expansion result.

### Storage / migration

- **Schema bumped 13 → 14.** Migration is additive `ALTER TABLE tags ADD COLUMN <col> <type>` for each of the six new columns (idempotent via `hasColumn` introspection — re-running the migration on an already-v14 DB is a no-op), followed by a one-shot data fold: `tag_schemas` rows copy their `description` and `fields_json` into the matching `tags` row (creating the row if absent), `_tags/<name>` notes copy `metadata.parents` into `tags.parent_names` (creating the row if absent), `created_at` is backfilled from the legacy sources where available, and finally `DROP TABLE tag_schemas`. The `_tags/*` notes themselves are **left in place** — they are inert after v14 (no resolver reads them) and serve as a historical audit trail; users can delete them at their convenience or wait for vault#246's `_schemas/*` retirement work to sweep both. Verified safe on byte-identical copies of three production vault DBs: default vault (10 schemas → 10 tag rows with description, 4 with fields, hierarchy preserved; 28ms), techne (clean baseline, no v13 sidecars to migrate; 2.7ms), boulder (clean baseline; 16ms). All three idempotent on second `initSchema` call. Tag counts and note counts unchanged across the migration in every case.
- **Hierarchy resolver swap from `_tags/<name>` notes to `tags.parent_names` column.** `loadTagHierarchy` in `core/src/tag-hierarchy.ts` now queries `SELECT name, parent_names FROM tags WHERE parent_names IS NOT NULL` and parses the JSON array into the in-memory `Map<child, parents[]>` — same `TagHierarchy` shape, same `getTagDescendants` public API, same in-memory cache (lazy-built per process, invalidated on writes that touch parents). `TAG_CONFIG_PREFIX = "_tags/"` remains exported as a constant for any historical caller that still references it, but no resolver code reads notes-as-config anymore. The string-form sub-tag fallback for tag-scoped tokens (per tag-scoped-tokens.md §Storage) coexists with `parent_names` as before — schema-driven matches still win first, the string-form fallback only runs when the expanded set misses, so a token allowlisted for `health` continues to see `#health/food` whether or not anyone has declared the hierarchy.

### Deferred

- **`_schemas/*` notes-as-config retirement → vault#246.** The investigation surfaced a counterexample: `_schema_defaults` carries `path_prefix` (a default-tag-by-path-prefix declaration), which has no clean column on the `tags` row — collapsing it would either mean a new generic `defaults` table or a redesign of how default-tagging is declared. Out of scope for this reshape; tracked as vault#246 for a focused design pass.

## [0.3.6-rc.30] — 2026-05-03

Tag-scoped tokens land — Phase 1 per `parachute-patterns/patterns/tag-scoped-tokens.md` (#24, merged 2026-05-02). A `pvt_*` token can now carry an immutable root-tag allowlist; once set, the token only sees and writes notes whose tags (after `_tags/<name>` hierarchy expansion) intersect that allowlist. Mint, REST, and MCP all enforce the allowlist; the admin SPA gains a tag-picker on the mint form. Use case: per-purpose paraclaw bots — a `#health` Claw, a `#work` Claw — slicing one vault rather than spinning up separate vaults per surface.

### Added

- **`tokens.scoped_tags TEXT NULL` on the per-vault tokens DB (schema v13).** Migration is additive; all existing rows pick up `NULL` (= unscoped, current behavior). The column stores a JSON-encoded array of root tag names, validated at the API boundary — no schemaless mush in SQLite. `core/src/store.ts` exposes a new async `expandTagsWithDescendants(tags: string[]): Promise<Set<string>>` that walks the existing `_tags/<name>` hierarchy cache and returns `{root} ∪ descendants(root)` for each input — call-sites just intersect with a note's actual tag set, no per-tag `rootOf` walk needed at the boundary. The token-store layer (`src/token-store.ts`) parses, persists, and surfaces `scoped_tags` on `Token`, `ResolvedToken`, and `AuthResult`; legacy code paths and hub-issued JWTs always carry `scoped_tags: null` (per the pattern doc — tag-scope is a vault-internal concern, not an OAuth claim).
- **REST: tag-scope enforcement on every `/vault/<name>/api/*` read and write.** `src/routing.ts` computes a per-request `TagScopeCtx` from `auth.scoped_tags` (lazy: only built when the token actually carries a scope) and threads it into `handleNotes`, `handleTags`, and `handleFindPath`. Read paths filter results to the allowlist (single-by-id, single-by-path, search, structured query, near-anchor, attachments list, tag list, tag detail). Out-of-scope reads return `404` rather than `403` — same "no existence leak" stance the pattern doc names. Write paths gate at create/update/delete: `POST /api/notes` pre-validates the entire batch atomically (mirrors the `#213` empty-note guard), `PATCH` projects the post-update tag set before allowing the write, `DELETE` rejects out-of-scope ids as 404. Tag operations (`POST /tags/merge`, `POST /tags/:name/rename`, `PUT /tags/:name`, `DELETE /tags/:name`) require every involved tag — sources + target, old + new — to be inside the allowlist.
- **MCP: tool-execute wrappers in `src/mcp-tools.ts` (`applyTagScopeWrappers`).** The 10 vault tools see the same allowlist semantics as REST. Read tools — `query-notes`, `list-tags`, `find-path`, `synthesize-notes` — wrap their `execute()` to filter results (single-note returns, list returns, neighbor lists, path hops). Write tools — `create-note` (single + batch), `update-note`, `delete-note`, `update-tag`, `delete-tag` — wrap to gate on the prospective tag set; tag operations gate on the tag name itself. Wrappers are no-ops when `auth.scoped_tags === null`, preserving identical pre-tag-scope behavior for unscoped sessions. Out-of-scope reads return the standard `{error: "Note not found", id}` shape; write rejections return `{error: "Forbidden", error_type: "tag_scope_violation", message, scoped_tags}` — same envelope as the REST 403.
- **Mint endpoint accepts `tags?: string[]` with subset validation (`POST /vault/<name>/tokens`).** When present, every entry must be a non-empty string with no `/` (root tags only — sub-tags reach via `_tags/<name>` at enforcement time) and exist in the vault's tag list. The minted allowlist must be a subset of the caller's: a tag-scoped admin minting outside their allowlist returns `403 tag_scope_violation`, and a tag-scoped admin omitting `tags` entirely returns `403` (cannot widen to unscoped — explicit > implicit at a security boundary). Unscoped admins retain back-compat: omitting `tags` mints an unscoped token. The list endpoint (`GET /vault/<name>/tokens`) surfaces `scoped_tags` on each entry.
- **SPA tag-picker on the mint form (`web/ui/src/routes/VaultTokens.tsx`).** The mint form fetches root tags from `/vault/<name>/api/tags` (filtered to entries without `/`), renders a checkbox list, and posts the selection as `tags`. When nothing is selected the field is omitted (= unscoped, server back-compat). When the vault has no root tags yet, the picker shows "No root tags in this vault yet — token will see the full vault." Each token row in the list now displays `scoped_tags` as `#tag` pills next to the scope set.

### Storage / migration

- **Schema bumped 12 → 13.** Migration is `ALTER TABLE tokens ADD COLUMN scoped_tags TEXT` on every per-vault DB. Existing rows are untouched (= unscoped). Verified safe on byte-identical copies of three production vault DBs — idempotent, all existing tokens migrated cleanly with `NULL scoped_tags`.

### Fixed (post-PR fold)

- **Orphan sub-tag fail-open: a token allowlisted for `health` now sees `#health/food` even when no `_tags/health/food` schema declares the hierarchy.** The Phase 1 enforcement only matched via the schema-driven `expandTagsWithDescendants` set, which fails closed for the common case where a sub-tag exists in the wild without an explicit `_tags/<sub>` config note. `noteWithinTagScope` and `tagsWithinScope` now take a third parameter, the raw root allowlist, and check `tagOnNote.split("/")[0] ∈ rawRoots` as a fallback. Schema-driven matches still win first (cheap `Set.has`); the string-form fallback only runs when the expanded set misses. Mirrors patterns#26's §Storage canonical contract.
- **Tag-delete, tag-merge, and tag-rename now fail closed (409) when a tag-scoped token references the doomed tag.** Previously a successful `DELETE /vault/<name>/api/tags/:name` (or a `POST /api/tags/merge` consuming the source, or a `POST /api/tags/:name/rename` away from the referenced name) would silently orphan the token's allowlist — the row would still match the tag string but no notes would carry it. New `findTokensReferencingTag(db, tag)` helper walks the tokens table; the REST DELETE handler, the `/tags/merge` handler (per source), the REST `/tags/:name/rename` handler, and the MCP `delete-tag` wrapper return `{error: "TagInUseByTokens", error_type: "tag_in_use_by_tokens", tag, referenced_by: [{id, label}, ...]}` with a `409`. The MCP wrapper runs unconditionally (not gated on the deleter being scoped) — any token deleting a referenced tag is the orphan case. Operator must revoke or re-mint the offending tokens before retrying. The rename guard is a Phase-1 interim — vault#240 will replace it with an automatic cascade per patterns#26 §Lifecycle.

## [0.3.6-rc.1] — 2026-04-26

Vault becomes a pure OAuth resource server: hub-issued JWTs are now accepted alongside legacy `pvt_*` opaque tokens. RC track — promotion to `@latest` follows validation against a real hub.

### Added

- **Hub-issued JWT validation alongside `pvt_*` tokens.** Vault now dual-validates bearer tokens. Tokens whose first three characters are `eyJ` (the base64url encoding of a JWT header's `{"`) route through the new `src/hub-jwt.ts` validator: `jose.createRemoteJWKSet` fetches the hub's `/.well-known/jwks.json` (cached 5min, with a 30s cooldown between failed fetches), `jwtVerify` checks the RS256 signature and claims, and the `iss` claim MUST equal the configured hub origin — the load-bearing trust check that prevents anyone from minting a token against any RSA key. The hub origin comes from `PARACHUTE_HUB_ORIGIN` (set by the hub's `expose` / `start` flow when vault runs behind it) with a `http://127.0.0.1:1939` loopback fallback for dev. The JWT's `scope` claim becomes the granted scopes; `permission` is derived for back-compat with code paths that still branch on `permission` (MCP tool gating, view auth). Audience is parsed but accepted broadly today — the hub issues `aud="operator"` for operator tokens and `aud=<client_id>` for user OAuth tokens, both legitimate vault callers; tightening to a strict allow-list is reserved for the post-cli#59 scope-guard work. Existing `pvt_*` callers (CLI-created tokens, OAuth-minted access tokens, legacy YAML keys) continue to work unchanged — JWT-shaped tokens commit to JWT validation (no fallthrough to `pvt_*` lookup on failure, since a malformed JWT was never going to be a valid local token), and non-JWT tokens follow the existing per-vault DB → vault.yaml → config.yaml resolution chain. `legacyDerived` is `false` for JWT-issued scopes — they're explicit, never inferred. Companion to the hub's Phase B JWKS plumbing; together they make hub-as-issuer Phase B2 functional end-to-end.



The rename-aware release. The upstream hub repo was renamed `parachute-cli` → `parachute-hub` and its npm package `@openparachute/cli` → `@openparachute/hub` on 2026-04-26; this release refreshes vault's docs and inline comments to match. No functional changes — `parachute-vault` binary, schemas, source code, and on-disk layout are unchanged. Promoted directly to `@latest` so new installs land on docs that match the current ecosystem naming.

### Changed

- **Stale `@openparachute/cli` / `parachute-cli` references updated to `@openparachute/hub` / `parachute-hub`** in `src/cli.ts` (one source comment, two usage-help blocks) and the `[Unreleased]` CHANGELOG entries that named the forthcoming dispatcher by its old name. Bin name (`parachute-vault`), the `parachute vault <cmd>` alias, and every code path are unchanged.

### Added

- **Vault is now the scribe context provider: triggers + worker can enrich transcription POSTs with vault notes.** Two surfaces, one shape. (1) Every trigger's `action` gains an `include_context` list — `[{tag, exclude_tag?, include_metadata?}]` — whose predicates pre-fetch matching notes at fire time. `send: "attachment"` attaches them as a multipart `context` JSON part (`{entries: [{name, ...metadata}]}`); `send: "json"` inlines the same payload under a top-level `context` field. `send: "content"` (TTS-out) ignores context. (2) The dedicated transcription worker gains the same surface via a per-vault `transcription.context` section in `vault.yaml`; the worker attaches the resulting `context` multipart part to each scribe POST. In both paths the `name` is the note path's basename (stem) and only whitelisted `include_metadata` keys are surfaced — unrelated metadata (including secrets a vault might carry) never leaks. Fetch failures are isolated per-predicate and logged, so a single bad tag can't block a whole fire or tick. Existing configs without `include_context` / `transcription.context` see no behavior change. (Scribe will drop its own vault client in a follow-up — vault is now the single reader.)
- **`SCRIBE_AUTH_TOKEN` env var — canonical name for the scribe bearer token.** Matches the CLI's install-time auto-wire. `SCRIBE_TOKEN` is retained as a deprecated alias for one release: when only the legacy name is set, the worker reads it and logs a one-time boot warning. Both unset means no `Authorization` header is sent (back-compat with loopback-trust deployments). When a webhook trigger points at the same host as `SCRIBE_URL` while the dedicated worker is enabled, vault now logs a soft-deprecation warning at boot — the trigger's `missing_metadata` guard keeps it idempotent, but running both against the same scribe endpoint is noise and the worker is the preferred path.
- **`PARACHUTE_HUB_ORIGIN` env var — vault can advertise a hub as the OAuth issuer.** When set (e.g. `https://hub.example`) *and* the incoming request arrives via the hub origin (matched against `X-Forwarded-Host` / request `Host`), vault's authorization-server metadata publishes `issuer = $HUB` and rewrites the `authorization_endpoint`, `token_endpoint`, and `registration_endpoint` to `${HUB}/oauth/{authorize,token,register}`; protected-resource metadata lists the hub as the authorization server; and the token response includes `iss = $HUB`. When the same vault is reached via a non-matching origin (typically direct loopback, `http://127.0.0.1:<port>/...`), the discovery document describes *that* origin instead — `issuer = <origin>/vault/<name>` and vault-rooted endpoints — so RFC 8414 §2 issuer/origin consistency holds on both views concurrently. The CLI is responsible for routing `${HUB}/oauth/*` to the vault's internal `/vault/<name>/oauth/*` endpoints at the reverse-proxy layer. Phase 0 of the hub-as-OAuth-issuer design; future phases will introduce per-service scope enforcement. When the env is unset, behavior is unchanged — vault advertises itself as the issuer for every request.
- **Token response includes a `services` catalog.** `POST /vault/<name>/oauth/token` now includes a `services` object alongside `access_token`, sourced from `~/.parachute/services.json` (the CLI-owned manifest). Each entry's `paths[0]` is rewritten into an absolute URL rooted at the origin the client used to reach vault — hub origin for tokens minted via the hub reverse proxy, vault request origin otherwise — so clients get externally-reachable URLs for the same origin they're already talking to, not internal paths or a mismatched host. Shape: `{vault: {url: "...", version: "0.3.0"}, notes: {url: "...", version: "0.1.0"}}`. Additive field — older clients that don't expect it ignore the key. Unreadable manifest logs a warning and returns an empty catalog rather than failing the token exchange.
- **`parachute-vault mcp-install` picks the URL matching vault's advertised issuer.** The URL written into `~/.claude.json` previously always pointed at loopback (`http://127.0.0.1:<port>/vault/<name>/mcp`). Now it prefers, in order: `PARACHUTE_HUB_ORIGIN` env (hub-rooted URL), then `~/.parachute/expose-state.json`'s `canonicalFqdn` when an active tailnet/public exposure is configured (`https://<fqdn>/vault/<name>/mcp`), then the loopback fallback. This is the visible behavior Aaron hit: with a hub exposure live, strict MCP clients (Claude Code) were hitting a loopback URL whose discovery issuer pointed at the hub — the command now writes a URL that matches the discovery issuer for that origin. Logs which URL was chosen and why.
- **`scopes_supported` publishes the final vault-scoped shape.** Discovery metadata now advertises `["vault:read", "vault:write", "full", "read"]` — the new names alongside the legacy ones for back-compat with 0.2.x clients. Vault does not yet *enforce* per-scope distinctions (all tokens continue to grant full-or-read access); this just publishes the shape so hub/CLI tooling can plan for the Phase 2 enforcement cutover.
- **Scope enforcement at the HTTP and MCP boundary (`vault:read`, `vault:write`, `vault:admin`).** Tokens now carry an OAuth-standard whitespace-separated `scopes` string on the row (schema v12), and every request is gated by the scope required for its target. HTTP: `GET/HEAD/OPTIONS /vault/<name>/api/*` requires `vault:read`; `POST/PATCH/PUT/DELETE` requires `vault:write`; `GET /vault/<name>/.parachute/config` requires `vault:admin` (flipping from public — hub keeps working loopback via the admin-scoped token minted at setup). Inheritance is `admin ⊇ write ⊇ read`, so a single higher-scoped token still works everywhere below it. MCP: tools are partitioned (`query-notes`, `list-tags`, `find-path`, `vault-info` → `vault:read`; `create-note`, `update-note`, `delete-note`, `update-tag`, `delete-tag` → `vault:write`) — read-only tokens only see the read tools in `tools/list`, and a direct `tools/call` of a mutation tool returns an error naming the missing scope rather than silently succeeding. Forbidden responses carry `{error_type: "insufficient_scope", required_scope, granted_scopes}` so agents can diagnose without tracing. OAuth token responses now emit the OAuth-standard `scope` string (`"vault:read vault:write vault:admin"` for full-access consent) instead of the legacy `"full"`/`"read"` shorthand; the consent page radio buttons are unchanged. `parachute-vault tokens create --read` is now enforcement-real: the token it mints is rejected on writes with 403. Back-compat: pre-v12 rows (NULL `scopes` column) continue to work for one release by falling back to `legacyPermissionToScopes(permission)`; on first use they log a one-time deprecation warning, and the shim will be removed after the next release. `vault:<name>:<verb>` is accepted as a synonym for `vault:<verb>` today (Phase 2+ per-vault narrowing is reserved but not yet enforced). Additive migration — no data rewrite, no client churn on the hot path.
- **`kind: "api"` on `/vault/<name>/.parachute/info`.** The service-info card now includes a `kind` field so the hub can render API services (no browser UI, JSON at root) differently from frontend services (launch-in-tab). Additive to the locked card shape; versioned hub renderers that don't know about `kind` will keep treating the card as a default tile.
- **`GET /vault/<name>/.parachute/config/schema` + `/.parachute/config` — module configuration endpoints.** Phase 2 of the module architecture: every module exposes a JSON Schema (draft-07) describing its configurable settings, and a paired endpoint returning the current effective values. Hub reads both and renders a configuration form without any hub-side knowledge of vault's settings. The schema describes `audio_retention` (enum, per-vault), `scribe_url` (uri, env-backed until Phase 3), `scribe_token` (`writeOnly` — never returned by GET), and `port` (read-only informational, from global config). The config endpoint returns effective values with `writeOnly` fields stripped; the token never appears in any response. Both endpoints are public during Phase 0–2 while the hub is loopback-only; the `vault:admin` scope will gate `/config` once scope enforcement lands in Phase 3. `PUT /.parachute/config` is explicitly Phase 3 — non-GET methods return 405 so clients that already speak the full contract discover the gap.

### Fixed

- **OAuth discovery issuer is now origin-aware, not globally hub-rooted (RFC 8414 §2).** The Phase 0 seam previously published `issuer = $PARACHUTE_HUB_ORIGIN` for every discovery request — so a client fetching `/.well-known/oauth-authorization-server` via `http://127.0.0.1:<port>/...` would get back `issuer: https://hub.example`, an origin mismatch that strict RFC 8414 clients (including Claude Code's MCP OAuth SDK) reject. The same vault now concurrently exposes two self-consistent issuer views: tokens minted and discovery served over the hub reverse-proxy origin return `issuer = $HUB`; requests that arrive directly on any other origin (loopback in practice) return `issuer = <origin>/vault/<name>` with vault-rooted endpoints. Match is against the incoming request's base URL (honoring `X-Forwarded-Host` / `X-Forwarded-Proto`). The token response's `iss` claim follows the same resolution, so tokens minted on one origin validate against that origin's discovery doc. Companion to the `mcp-install` URL picker above — together they close the RFC 8414 violation without per-origin configuration.
- **Optimistic concurrency made safe-by-default and legible end-to-end.** Four bundled fixes so an agent client can never accidentally clobber a concurrent write and always has the token + structured error needed to recover. (1) `update-note` now **requires** `if_updated_at` (or an explicit `force: true` override) — previous behavior allowed unconditional writes when the field was omitted, which is exactly the footgun the field exists to prevent. MCP returns a JSON-RPC `InvalidParams` error with `data: {error_type: "precondition_required", note_id, path}`; REST returns 428 Precondition Required with the same body shape. `force: true` is the documented escape hatch for bulk migrations and scripted writes where concurrency is known-safe. (2) Conflict errors now carry a structured shape — `{error_type: "conflict", current_updated_at, your_updated_at, path, note_id}` — surfaced in the MCP error `data` field and the REST 409 body. Clients can branch on `error_type` and immediately re-arm a retry with `current_updated_at` rather than parsing the human-readable message. REST 409 is additive: new fields sit alongside the previous `{error: "conflict", expected_updated_at}` shape so existing lens clients keep working. (3) `query-notes` single-note fetches (by `id` or `path`) now return `updatedAt` — previously only `createdAt` came back, which left the caller with no concurrency token to arm a subsequent `update-note`. (4) `create-note` returns `updatedAt` on fresh notes (same value as `createdAt`, matching the insert-time invariant from PR #70), so a client that creates and immediately updates can thread the token through without a second fetch. Existing in-band `isError: true` tool results remain the fallback for unstructured errors.
- **OAuth discovery served at RFC 8414 §3.1 / RFC 9728 §3 path-insertion URLs for the `/vault/<name>/` URL shape.** For a resource at `/vault/<name>/mcp`, the spec-mandated metadata URLs are `/.well-known/oauth-authorization-server/vault/<name>[/mcp]` and `/.well-known/oauth-protected-resource/vault/<name>[/mcp]` — path-insertion, with `.well-known` above the issuer path — not the path-append `/vault/<name>/.well-known/<type>` shape that the 0.3 URL migration shipped alone. Strict clients including Claude Code's MCP OAuth SDK probe only the insertion form; without these routes they 404 on discovery and can't complete the authorization handshake. PR #124 originally implemented this for the pre-migration `/vaults/<name>/` URL shape; the `/vaults/` → `/vault/` rename in the breaking URL migration dropped the insertion routes and this restores them. Both URL shapes now return deep-equal JSON via the shared handlers, so mixed-toolchain clients can't observe drift. Unknown-vault requests on the insertion form return 404 rather than phantom metadata.

### Changed

- **Filesystem hygiene inside `~/.parachute/vault/`: `vaults/` → `data/`, and logs moved into `logs/`.** Two internal moves with the same target-wins, idempotent, auto-migrating shape as the 0.3 ecosystem-root move. Per-vault SQLite state now lives at `~/.parachute/vault/data/<name>/` (was `vaults/<name>/`) — matches the Postgres/Redis convention and avoids the doubled "vault/vaults" path. Daemon logs now live at `~/.parachute/vault/logs/vault.log` and `~/.parachute/vault/logs/vault.err` (were flat in `~/.parachute/vault/`) — matches the `~/.parachute/<svc>/logs/<svc>.log` convention the CLI uses for every sibling service. On first post-upgrade run the vault auto-migrates `vault/vaults/` → `vault/data/` and `vault/vault.log`/`vault.err` → `vault/logs/`, logging each move to stderr. Target-wins on conflict: if both `vault/data/` and `vault/vaults/` exist (or both log locations), the new one is kept and the legacy copy is left in place with a warning. No user action required — any `parachute-vault` invocation triggers the migration. Note: vault does not use `~/.parachute/tokens.db` (no code references it), so it is not part of this move; the CLI will archive that file separately.

### Added

- **`GET /vault/<name>/.parachute/info` + `/.parachute/icon.svg` for the CLI hub page.** Two public (no auth), CORS-`*` endpoints so the ecosystem-root hub rendered by the CLI can aggregate service cards. `info` returns a locked card shape — `name`, `displayName`, `tagline`, `version` (from `package.json`), `iconUrl` — and `icon.svg` returns a small placeholder monogram inline. Zero PII, read-only. Non-GET methods return 405.

### Changed

- **Vault state moved from `~/.parachute/` into `~/.parachute/vault/`.** The ecosystem root (`~/.parachute/`) now hosts multiple sibling services — `services.json` and `well-known/` stay at the root (CLI-owned), and everything vault owns (`.env`, `config.yaml`, `vault.log`, `vault.err`, `start.sh`, `server-path`, `vaults/`, `assets/`, `backup-last.json`, top-level `*.db` snapshots) has moved under `~/.parachute/vault/`. `PARACHUTE_HOME` still points at the ecosystem root; the vault subdir is derived as `${PARACHUTE_HOME}/vault`. On first post-upgrade run, any legacy paths still at the root are auto-migrated into `vault/` — the CLI logs each moved path to stderr and the migration is idempotent (double-runs are a no-op). If a legacy path and its new counterpart both exist, the new one wins and the legacy copy is left in place with a warning so users can inspect before removing. The launchd plist + systemd unit both point `WorkingDirectory` at the new `vault/` subdir, and the generated `start.sh` wrapper now sources `~/.parachute/vault/.env`. No user action is required — running any `parachute-vault` command (including `doctor` and `url`) triggers the migration.

### Added

- **`query-notes` gains operator objects on `metadata` fields and top-level `order_by`.** Metadata values can now be operator objects — `{metadata: {priority: {gte: 3, lt: 10}, status: {in: ["open", "in_progress"]}}}` — instead of only exact-match scalars. Supported operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `not_in`, `exists` (boolean). Multiple ops on one field compose as AND. `order_by: "<field>"` sorts results by a metadata field, using the existing `sort` param (`asc` / `desc`) for direction and appending `created_at` as a stable tiebreaker. Both paths require the field to be declared `indexed: true` in some tag schema (via `update-tag`) — operator queries and `order_by` route through the `meta_<field>` generated column + B-tree index shipped in the previous release, so they stay O(log n) instead of O(notes). Errors are loud: unknown operator → `UNKNOWN_OPERATOR`; non-indexed field → `FIELD_NOT_INDEXED`; type-mismatched operator value (`in` expecting array, `exists` expecting boolean) → `INVALID_OPERATOR_VALUE`; REST returns 400 with `{error, code}`. `ne` preserves "unset AND differs" semantics via `(col IS NULL OR col <> ?)` so rows missing the field aren't silently excluded. Empty `in: []` contradicts; empty `not_in: []` is a no-op — both avoid SQLite's `IN ()` syntax error. Existing primitive-value metadata filters (`{metadata: {status: "open"}}`) still JSON-exact-match and work on un-indexed fields; the shape of the value — scalar vs. object — picks the path. REST exposes `order_by` via the `order_by` query param on `GET /vault/<name>/api/notes`.
- **`query-notes` gains `has_tags` and `has_links` presence filters.** Two new booleans on the `query-notes` MCP tool and the `GET /vault/<name>/api/notes` REST endpoint: `has_tags` (true = tagged-only, false = untagged-only) and `has_links` (true = notes with any inbound or outbound link, false = orphans in either direction). Composable with each other and with existing filters; `has_tags: false, has_links: false` returns the true loners. When `tag` is already set, `has_tags` is ignored — the tag filter is strictly narrower and wins. Implemented as correlated `EXISTS` / `NOT EXISTS` subqueries against `note_tags` and `links`, which lets SQLite use the existing indexes and stay O(rows) rather than O(rows × tags).

### Changed

- **Breaking: every vault-touching route moved to `/vault/<name>/...`; unscoped routes removed.** There is one URL shape for every client, same layout whether you have one vault or ten. The API lives at `/vault/<name>/api/...`, MCP at `/vault/<name>/mcp`, OAuth at `/vault/<name>/oauth/{register,authorize,token}`, discovery at `/vault/<name>/.well-known/oauth-*`, published notes at `/vault/<name>/view/:id`. The old unscoped `/api`, `/mcp`, `/oauth/*`, `/view/*` paths — and the previous `/vaults/<name>/...` prefix — are gone; requests to them return 404. Cross-vault endpoints (`GET /vaults`, `GET /vaults/list`, `GET /health`) are unchanged. The unified MCP endpoint that fanned tool calls across vaults via a `vault` param has been dropped — each MCP session now pins to one vault by the URL and the `list-vaults` tool is no longer exposed. A new `WWW-Authenticate: Bearer resource_metadata="..."` header decorates every MCP 401 so OAuth-capable clients can discover the right authorization server directly from the challenge (RFC 9728).

#### Upgrading from 0.2.x

- **Claude Code**: run `parachute-vault mcp-install` (or re-run `parachute-vault init`) to rewrite `~/.claude.json` with the new `/vault/<name>/mcp` URL. Existing `pvt_` tokens are kept; no re-auth needed.
- **Claude Desktop / Parachute Daily / any OAuth client**: remove the integration and add it back pointing at `https://<your-host>/vault/<name>/mcp`. The OAuth handshake will re-run and mint a fresh per-vault token. Pasted bearer-token integrations need only the URL updated.
- **curl / scripts**: rewrite hardcoded URLs. Old `/api/notes` → `/vault/default/api/notes`; old `/vaults/work/api/...` → `/vault/work/api/...`; old unscoped `/mcp` → `/vault/default/mcp`. Tokens keep working.
- **Published-note permalinks**: `/view/<id>` and `/vaults/<name>/view/<id>` now 404. Update to `/vault/<name>/view/<id>`.

### Fixed

- **Fresh notes now have `updated_at = created_at` instead of `NULL`.** Clients that fall back to `createdAt` when computing an optimistic-concurrency token (the common `updatedAt ?? createdAt` pattern, used by the Lens editor) were being rejected with a `409 CONFLICT` on the very first edit of a just-created note, because the stored `updated_at IS NULL` never matched the sent timestamp. The insert path now writes both columns at once; a one-time idempotent migration backfills `updated_at = created_at` for any existing rows with `NULL`. Rows that already had a real `updated_at` are untouched. Hook-style writes with `skipUpdatedAt` continue to preserve the column, so `updated_at > created_at` still means "user-touched since creation."

### Changed

- **CLI renamed: `parachute` → `parachute-vault`.** The published `@openparachute/vault` package now exposes its binary as `parachute-vault`, freeing the `parachute` name for the forthcoming `@openparachute/hub` dispatcher that will front this service alongside sibling Parachute Computer services. Direct invocations become `parachute-vault init`, `parachute-vault status`, etc. Users installing the upcoming dispatcher can keep typing `parachute vault <cmd>` — the dispatcher forwards to `parachute-vault <cmd>` transparently. The CLI's own arg-parser still accepts a leading `vault` prefix (`parachute-vault vault init` works), so existing launchd / systemd wrappers that hardcode the full form continue to work across the upgrade.

### Added

- **`update-tag` field specs gain `indexed: boolean`; declared-indexed fields get a generated column + B-tree index on `notes`.** When any tag schema declares a field with `indexed: true`, vault adds a VIRTUAL generated column `meta_<field>` computed from `json_extract(notes.metadata, '$."<field>"')` and indexes it. The tag authorizes the index; the index is universal across all notes, not partitioned by tag — so once `#project` declares `status: indexed`, any note with `status` in its metadata is indexed regardless of tags. `type` and `indexed` are global — all declarers must agree; mismatches at `update-tag` throw a loud error naming the conflicting tag. `description` and `enum` remain per-tag. A new `indexed_fields` table (`field`, `sqlite_type`, `declarer_tags` JSON) is the single source of truth; the column + index drop when the last declarer releases the flag or is removed via `delete-tag`. Type map: `string`→TEXT, `integer`/`boolean`→INTEGER. Field names are restricted to `[A-Za-z_][A-Za-z0-9_]{0,62}` for SQL-identifier safety. Indexes are rebuilt idempotently from `indexed_fields` on every vault init. The query surface — operator objects on `metadata` and `order_by` — lands separately; this release just puts the indexes in place.
- **`parachute-vault init` registers the service in `~/.parachute/services.json`.** An `upsertService` call writes `{name: "parachute-vault", port, paths: ["/vault/<default_vault>"], health: "/health", version}` into the shared manifest that the `@openparachute/hub` dispatcher consumes for discovery, health probes, and routing. `paths[0]` is the canonical mount point — the hub uses it to build the `.well-known/parachute.json` URL and for `parachute expose`. When no default vault is set (multi-vault, no fallback), `paths` falls back to `["/"]` and the operator is expected to fix the config. The write is upsert-by-name and preserves entries from other services (notes, scribe, channel) that share the file. Malformed-manifest errors are logged and init proceeds — the manifest is advisory, not a blocker.
- **Atomic tag rename + merge endpoints.** `POST /api/tags/{name}/rename` with `{new_name}` rewrites the tag across `tags`, `note_tags`, and the schema row in a single transaction; `POST /api/tags/merge` with `{sources, target}` retags every note carrying any source tag onto the target (creating it if missing), preserves the target's schema, and drops the sources. Rename returns `409 {error: "target_exists"}` when `new_name` is already a tag, pointing clients at the merge endpoint instead of the previous N+1 client-side PATCH stopgap.
- **Server-side transcription on attachment upload.** `POST /api/notes/{id}/attachments` now accepts `{transcribe: true}`. The attachment is stamped with `transcribe_status: "pending"` and the note with `transcribe_stub: true`. A background worker (enabled by setting `SCRIBE_URL` / optional `SCRIBE_TOKEN` in the server environment) drains the queue FIFO, POSTs the audio to `${SCRIBE_URL}/v1/audio/transcriptions`, and on success replaces the `_Transcript pending._` placeholder (or the whole body, if absent) with the transcript. If the user cleared the stub marker before the transcript arrived, the note is left alone — but the transcript is still recorded on the attachment. Retries use exponential backoff up to three attempts before flipping to `transcribe_status: "failed"`. The queue is the `attachments` table, so a restart resumes pending work. Per-vault `audio_retention: "until_transcribed"` (in `vault.yaml`) unlinks the audio file after success while keeping the attachment row (and transcript) addressable; `"keep"` (default) preserves the file.
- **Audio retention API: `GET` + `PATCH /api/vault` expose `config.audio_retention`.** The previously file-only setting is now mutable at runtime without hand-editing `vault.yaml`. `GET` reports the active mode (defaulting to `"keep"` for vaults created before the setting existed); `PATCH {config: {audio_retention: ...}}` sets it and validates against the allowed set `"keep"` / `"until_transcribed"` / `"never"`. The new `"never"` mode unlinks audio on *any* terminal state — including failure — for users who want to guarantee no audio persists after processing, trading off the ability to retry a failed transcription. The file is still kept during mid-queue retries so in-flight attempts have something to send. Invalid modes return `400 {error: "invalid_audio_retention"}`.

## [0.2.4] — 2026-04-18

### Added

- `link_count` surfaced in the vault stats response (REST + MCP `vault-info`), matching the existing note and tag counts.

## [0.2.3] — 2026-04-17

### Fixed

- **OAuth discovery endpoints now served at RFC-compliant path-insertion URLs (`/.well-known/oauth-authorization-server/{path}`) in addition to the existing path-append form.** Restores Claude Code's MCP OAuth SDK compatibility, which follows RFC 8414 §3.1 and RFC 9728 §3 strictly and probes only the path-insertion shape. Before 0.2.3, the SDK's AS-metadata fetch 404'd, leaving it without a `registration_endpoint` and cascading into a 404 on the `/register` fallback. Both scoped forms now work: `/.well-known/oauth-authorization-server/vaults/<name>` and the longer `/.well-known/oauth-authorization-server/vaults/<name>/mcp`; same shapes on `/.well-known/oauth-protected-resource/...`. Path-append routes (`/vaults/<name>/.well-known/<type>`) are unchanged so lax clients keep working.

## [0.2.2] — 2026-04-17

### Fixed

- **`start.sh` daemon wrapper no longer crashes on user shell profiles that reference unbound variables.** The generated wrapper ran `source ~/.zprofile` and `source ~/.zshrc` under `set -u`, so a zsh plugin framework or any conditional profile setup that touched an unset variable would abort the wrapper with exit 1. The `2>/dev/null` redirect swallowed the error, launchd saw repeated exit 1s, and the daemon silently refused to start with an empty `vault.err`. The wrapper now brackets the profile-source lines with `set +u` / `set -u` so -u is only active for code the wrapper owns. Run `parachute vault init` once on 0.2.2 to rewrite `~/.parachute/start.sh` — the rewrite is idempotent.

### Added

- **`parachute --version` / `parachute -v` / `parachute version`** print the installed package version to stdout. Works at the root and with the `vault` prefix (`parachute vault --version`, etc.). Reads from the installed `package.json` at module load, not a hardcoded string.

## [0.2.1] — 2026-04-17

### Fixed

- OAuth discovery now works against Claude Code's MCP SDK (and any other strict RFC 9728 client): 401 responses from the MCP endpoint carry a `WWW-Authenticate: Bearer resource_metadata="…"` header pointing at the scoped or unscoped protected-resource metadata document, matching the URL the client actually hit. Previously, clients with no pointer fell back to probing the root `/.well-known/oauth-protected-resource`, got `resource: <base>/mcp`, and rejected any connection to `/vaults/<name>/mcp` as a resource mismatch.

## [0.2.0] — 2026-04-17

First tagged public release. Ships the auth, backup, and onboarding surface the project needs for first-wave users.

### Authentication

- **OAuth 2.1 + PKCE** with Dynamic Client Registration (RFC 7591). Claude Desktop, Parachute Daily, and any OAuth-capable MCP client can connect with no manual token paste — user clicks "Add integration", browser opens to the vault's consent page, done.
- **Owner password** (bcrypt-hashed, min 12 characters) for the OAuth consent page. Prompt fires at `vault init`; manage later with `parachute vault set-password` / `--clear`.
- **TOTP 2FA with single-use backup codes**. `parachute vault 2fa enroll` prints a QR and one-time backup codes; `status` / `disable` / `backup-codes` subcommands for lifecycle.
- **Per-vault OAuth scope** — discovery at `/vaults/{name}/.well-known/oauth-authorization-server` returns vault-scoped endpoints. Tokens minted there authenticate only against that vault.
- **Cross-vault substitution blocked**: an OAuth code issued for one vault cannot be redeemed at another vault's token endpoint (schema-enforced via a `vault_name` column on `oauth_codes`).
- **Honest token response**: `/oauth/token` returns `{ access_token, token_type, scope, vault }` so the client knows which vault it just connected to.
- **Two permission tiers**: `full` (CRUD + delete + token management) and `read` (query / list / find-path / vault-info). Tokens default to `full`; pass `--read` to `tokens create` for read-only.
- **Token CLI**: `parachute vault tokens` (list), `tokens create [--vault] [--read] [--expires <N{h|d|w|m|y}>] [--label]`, `tokens revoke <id> [--vault]`. Tokens are SHA-256 hashed at rest.
- **Query-param auth for `/view`**: `?key=pvt_...` works alongside `Authorization: Bearer` and `X-API-Key` headers, convenient for browsers.

### Backup

- **`parachute vault backup`** — one-shot snapshot: atomic `VACUUM INTO` of every vault's `vault.db`, plus `config.yaml` and each vault's `vault.yaml`, bundled as a timestamped `.tar.gz`. Safe under concurrent reads/writes.
- **Scheduled runs** via `parachute vault backup --schedule hourly|daily|weekly|manual` (macOS launchd). Linux systemd-timer support is a follow-up; wire cron yourself for now.
- **`backup status`** shows schedule, last run, destinations, next run, and per-destination tier breakdown.
- **Tiered (grandfather-father-son) retention**. Default: `daily: 7 / weekly: 4 / monthly: 12 / yearly: null` (unbounded). Set any tier to `0` to disable. Local-timezone bucketing.
- **Pluggable destinations**. `local` (any filesystem path — iCloud Drive, external disk, rsync/Syncthing folder) ships in 0.2.0. `s3`, `rsync`, and `cloud` destinations designed but not yet implemented.
- **`vault uninstall` tears down the backup agent too** on macOS, so scheduled backups don't keep firing on a removed install.

### Reliability

- **`parachute vault doctor`** — diagnostic suite covering server-path pointer, wrapper script, launchd agent (macOS) / systemd service (Linux), bun-on-PATH, MCP entry in `~/.claude.json` (presence + URL port match + reachability), port-collision (free / ours / foreign via `lsof` or `ss`), and — when scheduled backups are configured — backup agent + per-destination writability. Exits 1 on any `fail`.
- **`vault status`** is healthcheck-aware and reports live daemon state, not just service registration.
- **`vault restart`** blocks until `/health` returns 200, with a sensible budget and progress indicator.
- **Path-resilient `start.sh`** — the wrapper launchd/systemd executes embeds an absolute `bun` path + points at `~/.parachute/server-path`, which resolves to the current repo location. Move the repo, re-run `vault init`, and the daemon follows you.
- **Idempotent `vault init`** — safe to re-run after a folder move or config edit; refreshes the pointer, wrapper, and service registration without touching user data.
- **Graceful shutdown**: in-flight webhook triggers get a 5 s drain window before the daemon exits on SIGTERM/SIGINT.

### Multi-vault

- **Public `GET /vaults/list`** — unauthenticated discovery endpoint returning only vault names (no descriptions, timestamps, counts, or keys). Lets a client populate a vault picker before OAuth. Operators who want to hide vault existence can set `discovery: disabled` in `~/.parachute/config.yaml` to make the endpoint return 404.
- **Single-vault auto-default** — when the server has exactly one vault, the unscoped `/mcp`, `/api/*`, and `/oauth/*` paths transparently resolve to it regardless of its name. A lone vault named `journal` works at `/mcp` with no vault-in-URL needed.
- **Vault-management CLI**: `parachute vault create <name>`, `list` (alias `ls`), `remove <name> --yes` (alias `rm`).
- **Automatic `default_vault` management** — `vault create` promotes a new vault to default when none is set or the configured default points at a missing vault. `vault remove` promotes the sole survivor when you delete the default and one vault remains.

### Install / uninstall

- **`vault uninstall`** — removes the daemon registration, the `start.sh` wrapper, the `~/.parachute/server-path` pointer, and the `parachute-vault` entry in `~/.claude.json`. On macOS, tears down both the main vault agent and the backup agent. Preserves all user data.
- **`vault uninstall --wipe`** — additionally removes `vaults/`, `.env`, `config.yaml`, `vault.log`, and `vault.err` after a second interactive confirm (default NO).
- **`vault uninstall --yes --wipe`** — scripted destructive path. Skips both confirms and prints an ISO-timestamped audit line to stdout naming the target paths.
- **`vault url`** prints the local server URL in a script-friendly form.

### API / primitives

- **Optimistic concurrency on `update-note`** via an `if_updated_at` parameter. When supplied and it doesn't match the note's current `updated_at`, the update is rejected (MCP: `ConflictError`; HTTP: 409). Batch updates fail fast on the first conflict.
- **Link expansion on `query-notes`** — new `expand_links` / `expand_depth` (0–3) / `expand_mode` (`"full"` | `"summary"`) parameters inline `[[wikilink]]` targets directly into the returned content. Works on the MCP tool and the HTTP routes (single-note, search, and structured-list).
- **9 composable MCP tools** (was 30): `query-notes`, `create-note`, `update-note`, `delete-note`, `list-tags`, `update-tag`, `delete-tag`, `find-path`, `vault-info`. Every note parameter accepts either an ID or a path.
- **Webhook triggers** — declarative config-driven webhooks fire on note mutations matching tag / metadata predicates. Three send modes: `json` (general), `attachment` (Whisper-compatible transcription), `content` (OpenAI-compatible TTS).

### Documentation

- Entirely overhauled onboarding path: OAuth walkthrough, doctor + troubleshooting, first-run narrative (what `vault init` does on disk), multi-vault subsection, Tailscale Funnel walkthrough, prerequisites block.
- Honest token-shape documentation (`pvt_` is modern; `pvk_` is legacy and still accepted).
- README tells the truth about what `vault init` writes to `~/.claude.json` — a vault-scoped URL with a baked-in `pvt_` bearer, not OAuth.

### Removed

- **Semantic / vector search** — the embeddings path (`sqlite-vec`, `semantic-search` tool, embedding-provider setup wizard, `/api/ingest` endpoint). Full-text search via `query-notes` `search=` remains.
- **`parachute vault keys` subcommand** — superseded by `parachute vault tokens`. Legacy `pvk_...` keys in `config.yaml` are still honored at runtime.

### For contributors

- **Async `Store` interface**, renamed to `BunSqliteStore`. Paves the way for Durable Object SQLite and R2 blob backends (in flight).
- **`src/routing.ts`** extracted from `src/server.ts` so the request dispatcher is unit-testable without spinning up `Bun.serve()`.
- **`core/src/test-preload.ts`** isolates `PARACHUTE_HOME` for tests so `bun test` never touches a user's real `~/.parachute/`.
- Test suite at release cut: **538 passing / 0 failing / 3 skipped** across 22 files (541 tests total).

[0.2.3]: https://github.com/ParachuteComputer/parachute-vault/releases/tag/v0.2.3
[0.2.2]: https://github.com/ParachuteComputer/parachute-vault/releases/tag/v0.2.2
[0.2.1]: https://github.com/ParachuteComputer/parachute-vault/releases/tag/v0.2.1
[0.2.0]: https://github.com/ParachuteComputer/parachute-vault/releases/tag/v0.2.0
