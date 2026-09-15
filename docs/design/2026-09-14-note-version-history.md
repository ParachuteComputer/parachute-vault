# Note version history core — v29

Refs #524. PR 1 establishes capture and recovery on the self-hosted door.
The train continues with compaction (PR 2), mirror import/retirement (PR 3),
hosted support (PR 4), and app consumers (PR 5).

## Storage and atomicity

`note_versions` records superseded states, indexed by note id and a per-note
`version_ix`. `note_blobs` stores UTF-8 content once per SHA-256 hash. Version
rows retain raw metadata TEXT, path, extension, attribution, operation and
supersession time. There is no FK to the live notes table: deletion must not
erase history. The blob FK and guarded GC prevent deletion of referenced
content. No backfill runs; creation captures nothing.

Capture reads the prior row and hashes it synchronously inside the mutation
transaction. It inserts the blob/version, then prunes. It opens no transaction
of its own. Append/prepend still use SQL concatenation; capture adds the old
body read needed to preserve their preimage. Metadata/path updates retain
the existing pre-transaction read as well as the new narrow transactional
read. Restore loads its source before capture/pruning can evict it.

| Mutation | Capture |
|---|---|
| Store update, including metadata and `skipUpdatedAt` | `update` |
| Append / prepend | `append` / `prepend` |
| Store delete | `delete`, except importer blow-away opt-out |
| Linked-note path rename cascade | `cascade-rename` on rewritten sources |
| Tag rename content/path rewrites | `tag-rename` |
| Live restore | `restore` holding the prior live state |
| Deleted-note restore | `restore` marker copying the tombstone |
| Create | None |
| Direct tag/link-table mutations with no note-row update | None |
| Schema migrations, derived FTS/vector/index work | None |
| Tag identity/metadata and reference-field maintenance | None unless it enters a captured note mutation |

A REST tag/link write that also updates the note row captures that row, but
versions do not preserve tag membership or the link tables themselves.

In v30, ordinary version rows keep NULL `encoding`; storage encoding lives on
the shared blob. Whole blobs use NULL and delta blobs use `fossil-delta`. The only non-NULL value written in v29 is `overflow`: an oversized
note's deletion records size, metadata and existence with a NULL hash, but
no recoverable content. A restore marker copied from that tombstone retains
`overflow` and its NULL hash, even on a recreated live note. Updates of prior content larger than 2,000,000 UTF-8
bytes fail atomically; deletion is never blocked by that ceiling.

Legacy NULL content normalizes to the empty string for hashing, so
`hashContent("")` is shared with an actual empty body. History does not
preserve the distinction between SQL NULL and empty content.

## Retention and recovery

Defaults: enabled, minimum 20 versions, maximum 100, maximum age 180 days;
the floor wins over both age and ceiling, and maximum is clamped upward to
the minimum and at least 1. Both age settings are capped at 36,500 days. Pruning never renumbers surviving indices and never removes a
delete tombstone. Repeated delete/recreate cycles therefore accumulate
unprunable tombstones until explicit erasure or deleted-history sweeping.
`deleted_retention_days: null` disables that sweep without even querying;
a numeric setting sweeps absent notes whose latest history predates the
cutoff on the next store open. Erasure and sweeping each transact their
version removal and orphan-blob GC. NULL hashes are excluded from the GC
subquery so overflow tombstones cannot poison `NOT IN`.

An erase ends the lineage and permits the next version index to restart at
zero. Blow-away import deliberately deletes live notes without tombstones,
then recreates exported ids; existing history chains reattach to those ids.
Ordinary additive import captures each upsert independently.

Live restore keeps today's path and tags, restores content/metadata/extension,
and uses ordinary update validation and optimistic concurrency. REST checks
today's strict schemas first; migration bypass is logged. Deleted restore
uses the same id and tombstone path, without restoring tags. Original creation
time is restored from v30 captures (#735); legacy NULL timestamps retain the
tombstone-time fallback. Tag membership remains a limitation. Path collisions roll back the whole restore.

Deleted history is available only over unscoped REST. MCP requires a live
note; its wrapper explicitly scopes the new object result. Doctor's deleted
history census is likewise **unscoped only**, resolving the earlier design's
scope inconsistency under §11.3. Its byte total is an upper bound because
blobs may also be referenced by live-note histories.

PR 1 changes no mirror code. The existing mirror remains the only pre-v29
record; launch retirement and import belong to PR 3.

## Compaction (v30)

Encoding belongs to `note_blobs`, because multiple version rows share each
content-addressed blob. The hash continues to identify the reconstructed UTF-8
body; `byte_size` now measures stored bytes, while `note_versions.content_len`
measures logical bytes. Deltas are base64 Fossil byte deltas, without compression.
A depth-1 star points children at a whole base, with runs capped at 24 versions.
Prototype star reads measured p95 around 4.2–4.6 ms; avoiding chained decoding
keeps read cost independent of the number of retained versions.

Payloads at least 90% of the original stored size are refused. Encoding savings
depend on shared byte windows; independent random bodies generally expand under
base64 and remain whole. Such notes remain candidates on later opens and can
consume the budget before smaller candidates. This scheduling limitation is deferred.

Count, age and stored-byte ceilings share the newest-row floor, including
protected tombstones. The byte pass compacts before dropping oldest eligible
rows. Blob GC protects both version references and delta-base references.
Missing or non-whole bases, unknown encoding and failed reconstruction raise a
history delta-orphan error; external reads and restores use `history_unrecoverable`.
Doctor's unscoped storage census is structural, not a content audit. Its per-note
attribution excludes indirect bases and can count a shared blob for multiple notes.

The boot pass is synchronous and budgeted (250 ms, 50 notes by default), checks
bounds between notes, and may overshoot by one note. A failed note transaction
rolls back and increments `notes_failed`; other candidates continue. The admin
POST can run without bounds. Disabling compaction also disables the byte ceiling.
