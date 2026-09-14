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
| Tag membership changes / link mutations alone | None |
| Schema migrations, derived FTS/vector/index work | None |
| Tag identity/metadata and reference-field maintenance | None unless it enters a captured note mutation |

`encoding` is the seam for PR 2. Ordinary rows use NULL and reference a whole
blob. The only non-NULL value written in v29 is `overflow`: an oversized
note's deletion records size, metadata and existence with a NULL hash, but
no recoverable content. Updates of prior content larger than 2,000,000 UTF-8
bytes fail atomically; deletion is never blocked by that ceiling.

Legacy NULL content normalizes to the empty string for hashing, so
`hashContent("")` is shared with an actual empty body. History does not
preserve the distinction between SQL NULL and empty content.

## Retention and recovery

Defaults: enabled, minimum 20 versions, maximum 100, maximum age 180 days;
the floor wins over both age and ceiling, and maximum is clamped upward to
the minimum. Pruning never renumbers surviving indices and never removes a
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
uses the same id, the tombstone path, no tags, and deletion time as
`created_at`. The last two are accepted PR 1 limitations; preserving original
creation time is a follow-up. Path collisions roll back the whole restore.

Deleted history is available only over unscoped REST. MCP requires a live
note; its wrapper explicitly scopes the new object result. Doctor's deleted
history census is likewise **unscoped only**, resolving the earlier design's
scope inconsistency under §11.3. Its byte total is an upper bound because
blobs may also be referenced by live-note histories.

PR 1 changes no mirror code. The existing mirror remains the only pre-v29
record; launch retirement and import belong to PR 3.
