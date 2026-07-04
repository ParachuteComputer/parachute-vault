> Moved from parachute-patterns/cookbook/vault-portable-export.md (2026-07-04) — see the patterns-archive decision. This repo enforces this contract.

# Vault portable-markdown export

> One-line summary: a lossless portable-markdown export of a parachute-vault that round-trips by design — same format every Obsidian/Logseq/Foam/Quartz/Dendron-shaped tool already consumes, but with IDs, typed links, tag schemas, and indexed metadata preserved so re-import reconstructs byte-equivalent vault state.

This entry is a cookbook recipe — concrete patterns for using the export primitive in the wild. For the format spec, the [vault README's *Portable markdown export* section](https://github.com/ParachuteComputer/parachute-vault/blob/main/CLAUDE.md) and the code at [`core/src/portable-md.ts`](https://github.com/ParachuteComputer/parachute-vault/blob/main/core/src/portable-md.ts) are authoritative.

## When to reach for it

- **Git-as-projection.** Vault is the source of truth; a git repo of the export is a deterministic projection (audit, time-travel, browseable, code-review-able). Mutation in vault → re-run export → commit. Mutation in git is a one-way fork.
- **Disaster-recovery snapshot.** Periodic full export to a separate disk (or off-host) gives a tool-independent restore path. Pair with `parachute-vault import <dir> --blow-away --yes` to replay back to byte-equivalent state.
- **Vault migration.** Moving from one parachute-vault host to another (local → VPS, or vice versa). Export from source, blow-away-import on the destination.
- **Offline editing.** Drop the export into Obsidian/Logseq/Quartz/Dendron, edit, re-import. Round-trip preserves IDs and typed links — the consumer doesn't need to know about either.
- **Sharing a knowledge graph as static files.** Hand someone a directory. They can read it with `less` or open it in any markdown tool. No vault required.
- **Static-site generation.** Quartz, Hugo, Eleventy. The export is just markdown + YAML.

Use the legacy `core/src/obsidian.ts` only if you specifically need the flat-frontmatter shape (no IDs, no `metadata:` block). It's deprecated — preserved for callers that were already wired into it.

## CLI surface

```bash
# Full export — every note, every schema-carrying tag.
parachute-vault export <dir>

# Pick a non-default vault. (Defaults to the vault named `default` — use
# `--vault <name>` if your vault has a different name.)
parachute-vault export <dir> --vault <name>

# Incremental — only notes whose updated_at >= ISO timestamp.
# Useful as the "since-cursor" half of a projection cadence.
parachute-vault export <dir> --since 2026-05-12T00:00:00Z
```

Output (per [`exportVaultToDir`](https://github.com/ParachuteComputer/parachute-vault/blob/main/core/src/portable-md.ts) in `core/src/portable-md.ts`):

```
<dir>/
  .parachute/
    vault.yaml                # vault meta + export_format_version
    schemas/<tag>.yaml        # one file per schema-carrying tag
    attachments/<id>/...      # binary files, keyed by export-time att.id
  <note.path>.md              # one file per pathed note
  _unpathed/<note-id>.md      # one file per pathless note
```

The sidecar directory is named `.parachute` so that walkers which skip dot-prefixed directories (including vault's own `walkMarkdownFiles`, Obsidian, Logseq, most SSGs) won't accidentally treat schemas or vault-meta as notes.

**Both export and import shipped.** rc.10 added export; rc.11 closed the round-trip with lossless import:

```bash
parachute-vault import <dir>                     # upsert notes/tags/schemas by ID
parachute-vault import <dir> --blow-away         # drop + replay → byte-equivalent state
parachute-vault import <dir> --blow-away --yes   # same; skip the confirm prompt (CI / cron)
```

`--blow-away` confirms by default — a yes/no prompt that defaults NO, so an accidental Enter cancels rather than proceeds. Pass `--yes` for unattended runs. The wipe deletes through the public Store API (`deleteNote`, `deleteTag`) so attachment-deleted and tag-deleted hooks fire and orphan-attachment cleanup runs the same way as a manual delete.

## Per-note frontmatter

Fixed top-level key order, alpha-sorted nested keys — byte-identical re-emit of an unchanged vault is a guarantee, not a coincidence:

```yaml
---
id: 01HGZ9...                      # ULID — durable across path renames
path: Inbox/2026-05-12-meeting     # omit for pathless notes (filed under _unpathed/<id>.md)
tags:
  - donor-pipeline
  - meeting
metadata:                          # nested alpha-sorted
  priority: high
  state: drafted
links:                             # typed (non-wikilink) relationships
  - relationship: derived-from
    target: 01HGZA...
attachments:                       # ref by basename; binary copied to .parachute/attachments/<id>/
  - id: att_01HGZB...
    mime_type: audio/mp4
    path: 2026-05-12/audio.m4a
created_at: 2026-05-12T10:00:00.000Z
updated_at: 2026-05-12T11:23:45.123Z
---

Note body. [[Wikilinks]] are preserved verbatim — they're the source of
truth for that link kind, so re-imports recover them from the content.
```

Key-order is fixed in [`FRONTMATTER_KEY_ORDER`](https://github.com/ParachuteComputer/parachute-vault/blob/main/core/src/portable-md.ts): `id` → `path` → `tags` → `metadata` → `links` → `attachments` → `created_at` → `updated_at`. Empty collections are omitted (no `metadata: {}` noise, no `tags: []`).

## Per-tag sidecar schemas

For every tag that declares at least one of `description` / `fields` / `relationships` / `parent_names`, the export writes `.parachute/schemas/<tag>.yaml`:

```yaml
description: A donor pipeline opportunity. State machine: prospect → engaged → committed.
fields:
  amount:
    type: number
  state:
    type: enum
    values: [prospect, engaged, committed]
name: donor-pipeline
parent_names:
  - workspace-root
relationships:
  derived-from:
    target_tag: meeting
```

Just-a-name tags (no schema content) don't get a file. Tag names containing `/` (sub-tag hierarchy) get `/` replaced with `__` in the filename only — the canonical name lives inside the file's `name:` key, so the round-trip recovers the slash form.

## What round-trips losslessly

Exporting a vault, blowing it away, and re-importing the export reproduces byte-equivalent vault state across:

- **IDs.** ULIDs survive. Wikilinks resolve by path or ID; typed `links` resolve by ID. Renaming a note's path doesn't break inbound links.
- **Typed links.** Non-wikilink relationships (`derived-from`, `cites`, anything custom) serialized in the `links:` block. Sorted by `(relationship, target)` for stable output.
- **Tag schemas.** Description, fields, relationships, parent_names — the full schema layer reconstructs from the sidecar.
- **Indexed metadata.** Whatever your tag schemas index, the values come back in the same shape (booleans as `true`/`false`, numbers bare, strings quoted only when ambiguous).
- **Multi-line strings.** Metadata values that contain newlines/tabs/control characters are double-quoted with YAML escape sequences (`\n`, `\xNN`) so the whole value stays on one physical YAML line. Single-quoted multi-line splits the parser — caught and pinned in vault#317 F1.
- **Wikilinks in content.** Preserved verbatim. They're the content's job; the parser does not strip or rewrite them.
- **Attachments.** Frontmatter `attachments[].path` carries the original vault-internal path (relative to `assetsDir`); the binary is copied under `.parachute/attachments/<att-id>/<basename>`. Import restores the binary to the original path. *Caveat:* attachment IDs re-mint on import (no `restoreAttachment(id, ...)` Store surface yet), so round-trip with attachments produces byte-different `attachments[].id` values between original and re-export. Refs still resolve by `(note_id, path)`; operators expecting strict byte-equivalence including att-IDs should know.
- **Idempotency.** Re-export an unchanged vault → byte-identical bytes (modulo `exported_at` in `vault.yaml`, which callers wanting strict byte-equivalence can pin via the `exportedAt` API option). Clean git diffs.

## Recipe: nightly git projection

The webhook-driven version of Gitcoin Brain's vault-as-primary / git-as-projection architecture. One trigger, one cron, one git repo.

**1.** In `~/.parachute/vault/config.yaml`, register a webhook trigger that fires on every note mutation in the namespaces you want projected. (Vault's [trigger framework](https://github.com/ParachuteComputer/parachute-vault/blob/main/README.md#webhook-triggers) is declarative — see the README for predicate fields.)

```yaml
triggers:
  - name: git-projection-nudge
    events: [created, updated]
    when:
      tags: [commitment, decision, donor-pipeline]  # high-stakes tags
    action:
      webhook: http://localhost:7777/projection-nudge
      send: json
```

The receiver doesn't have to do work synchronously — it just records "vault dirty since T" in a small state file. Sub-second response keeps vault's two-phase trigger marker cycling promptly: `<name>_pending_at` is written on entry and cleared once `<name>_rendered_at` is written on success.

**2.** Wire the projection itself as a cron job (or a debounced consumer of the nudge endpoint, your call) that exports the vault since the last cursor and commits the diff:

```bash
#!/usr/bin/env bash
set -euo pipefail
PROJECTION_DIR="$HOME/projections/team-brain"
CURSOR_FILE="$PROJECTION_DIR/.parachute/.last-cursor"
mkdir -p "$PROJECTION_DIR/.parachute"

SINCE="$(cat "$CURSOR_FILE" 2>/dev/null || echo '1970-01-01T00:00:00Z')"
NOW="$(date -u +%FT%TZ)"

parachute-vault export "$PROJECTION_DIR" --since "$SINCE"

cd "$PROJECTION_DIR"
git add -A
if ! git diff --cached --quiet; then
  git commit -m "projection: vault changes since $SINCE"
  git push
fi
echo "$NOW" > "$CURSOR_FILE"
```

Notes on this shape:

- The cursor lives *inside* the projection's sidecar so it's co-located with the export but excluded from re-imports (its filename starts with `.`, so the directory walker skips it).
- `--since` is best-effort incremental — a tombstone (deleted note) doesn't surface here; full periodic exports (weekly) catch deletions and orphan files. Schedule a `parachute-vault export <dir>` (no `--since`) on top of the incremental cadence for that reason.
- A full export with the `git add -A` shape above will also produce deletions in the git tree for any note removed from vault, which is the projection-correct behavior.
- For multi-vault servers, run one projection per vault into one repo each. Mixing vaults in one projection directory loses the 1:1 correspondence.

## Recipe: cold-storage backup

Disaster-recovery snapshot. Run on a different schedule than git projection (e.g. weekly) so the backup isn't a chain of incremental diffs — each backup is a self-contained restore point.

```bash
SNAPSHOT="$HOME/backups/vault-$(date -u +%Y%m%d).tar.zst"
TMP="$(mktemp -d)"
parachute-vault export "$TMP"
tar --zstd -cf "$SNAPSHOT" -C "$TMP" .
rm -rf "$TMP"
```

Restore: untar somewhere, then `parachute-vault import <untarred-dir> --blow-away --yes`. The format is also human-recoverable without vault — every note is a markdown file with YAML frontmatter, so even a worst-case "we lost the vault binary too" recovers manually.

## Edge cases / gotchas

- **Case-insensitive filesystems silently collide notes whose paths differ only by case.** macOS APFS (default) and Windows NTFS (default) treat `Foo/Bar.md` and `Foo/bar.md` as the same file — export writes both, but the second overwrites the first on disk, silently losing one note. Affects ~1 note per case-collision pair, on those filesystems only. Linux ext4 and macOS APFS-CS (case-sensitive variant) unaffected. Tracked at [vault#327](https://github.com/ParachuteComputer/parachute-vault/issues/327) — fix lands in vault 0.4.5; until then, audit your vault for case-only-differing paths before relying on a round-trip on a case-insensitive disk.
- **Path traversal is refused, not aborted.** A note with `path: "../../escape"` would otherwise write outside the export directory. `exportVaultToDir` resolves the candidate path against the export root and refuses the write with a `console.warn`, then keeps going. Partial export beats no export. Self-inflicted at the vault level (operator owns the data), but real for programmatic callers ingesting from external systems. See [`isWithinDir`](https://github.com/ParachuteComputer/parachute-vault/blob/main/core/src/portable-md.ts) and the F3 fix in vault#317.
- **Pathless notes land in `_unpathed/`.** Notes without a `path:` go to `_unpathed/<note-id>.md` so they don't collide with each other and so a user importing into Obsidian sees them in one folder rather than scattered at the root.
- **`exported_at` is the one timestamp that won't be byte-identical across runs.** It lives in `.parachute/vault.yaml`. Callers wanting strict byte-equivalence (tests, fixture diffing) pass `exportedAt` to the `exportVaultToDir` API; the CLI always stamps live. If you're git-projecting and want minimal diff noise, the `vault.yaml` file changing every run is the cost.
- **Schema drift on import.** `import` without `--blow-away` warns on schema conflicts (export claims `fields.amount.type: number`, vault already has `fields.amount.type: string`). `--blow-away` replays the export's schemas exactly. Choose the verb that matches your intent.
- **`--since` regenerates schemas every run, even if no tag schema changed.** The filter only narrows the *notes* set; schema sidecars are always written fully. For a git-projection cadence that produces tight diffs, expect schema files to surface in incremental commits even when the underlying schemas are unchanged.
- **The hand-rolled YAML parser is intentionally narrow.** It handles the subset of YAML the emitter produces plus the legacy Obsidian shapes the importer needs. It does *not* handle anchors, references, multi-document streams, or YAML 1.2 `\u<4hex>`/`\U<8hex>` escapes — none of which the emitter produces. If you hand-edit sidecar `.yaml` files, stay inside that subset.
- **The 1M-note bulk-load ceiling.** `exportVaultToDir` materializes the full vault in memory before iterating. Defensive — the cap is a follow-up at vault#317 F5 if a real >>100k-note workload surfaces.

## Worked example — Gitcoin Brain

The Gitcoin Brain build (week-1 architecture, `from_parachute_round_2.md` Ask 1) is the load-bearing use case this primitive was reframed and extended for. Their model: vault is the source of truth for live state; a git repo of the export is the projection. Audit, recovery, time-travel, browseable code-review-style diff history — every property of "the team brain in git" without paying the dual-write tax of git-as-primary.

Concretely, the Gitcoin team:

1. Run vault as the primary write surface (REST + MCP + Notes + Telegram).
2. Wire a webhook trigger on high-stakes tags (commitments, decisions, donor pipeline) that nudges a projection daemon.
3. Run `parachute-vault export "$PROJECTION_DIR" --since "$CURSOR"` on the nudge (debounced) and a full export weekly.
4. Commit + push to a private git repo. Diffs are reviewable; history is the audit trail; restoration is `parachute-vault import "$PROJECTION_DIR" --blow-away --yes`.

When the export primitive isn't right for them — when a Gitcoin-specific format or a richer drift signal matters — they build a sidecar and contribute the pattern back. Generic patterns extracted up to parachute; specific dashboards stay in Gitcoin's app code. The Round-2 reply spells the boundary out.

## Cross-references

- **Format spec** — [`core/src/portable-md.ts`](https://github.com/ParachuteComputer/parachute-vault/blob/main/core/src/portable-md.ts) (emitter + parser), [`core/src/portable-md.test.ts`](https://github.com/ParachuteComputer/parachute-vault/blob/main/core/src/portable-md.test.ts) for behavior examples.
- **CLI** — `parachute-vault export <dir>` in [`src/cli.ts`](https://github.com/ParachuteComputer/parachute-vault/blob/main/src/cli.ts).
- **Vault changelog** — `0.4.4-rc.9` through `0.4.4-rc.11` in [`CHANGELOG.md`](https://github.com/ParachuteComputer/parachute-vault/blob/main/CHANGELOG.md) cover PR 1, the reviewer fold, and PR 2 (lossless import + `--blow-away`).
- **Webhook triggers** — [vault README §Webhook triggers](https://github.com/ParachuteComputer/parachute-vault/blob/main/README.md#webhook-triggers).
- **Tag data model** — [`patterns/tag-data-model.md`](../patterns/tag-data-model.md). What gets serialized into `.parachute/schemas/<tag>.yaml`.
- **Multi-writer workspace guide** — [`guides/multi-writer-workspace.md`](../guides/multi-writer-workspace.md). The operator's-side view of how a team-shape vault accumulates the content the export then projects.
- **Tracking issue** — [vault#308](https://github.com/ParachuteComputer/parachute-vault/issues/308) (umbrella; PR 1 = vault#317, PR 2 = vault#319).

_Last updated: 2026-05-15 — current with vault 0.4.4 stable (vault#308 fully shipped; export + lossless import on `main`)._

_0.4.5 will close [vault#327](https://github.com/ParachuteComputer/parachute-vault/issues/327) (case-collision silent note loss on case-insensitive filesystems) and add [vault#328](https://github.com/ParachuteComputer/parachute-vault/issues/328) (non-markdown file types — CSV, YAML, JSON, MDX, etc. as first-class notes with sidecar metadata)._
