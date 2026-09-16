# Vault scale — synthetic fixture harness + documented ceiling

The load-bearing scenario for Parachute Vault is **single-owner self-hosting**:
one person, one machine, often a large Obsidian import landing all at once.
This doc records (a) how to run the synthetic scale harness and (b) where the
vault starts to slow — so "is my vault going to stay fast?" has a real answer,
not a guess. (vault#325 Part 3, consolidating #338.)

## Running the harness

The harness is a **standalone script** — it is NOT part of the `bun test` gate,
so the default test run stays fast. Run it explicitly:

```bash
bun scripts/scale-bench.ts                 # default sizes: 10000 50000 100000
bun scripts/scale-bench.ts 10000           # one size
bun scripts/scale-bench.ts 1000 5000       # custom sizes (quick smoke)
```

It seeds a synthetic vault (realistic distribution: top-level + sub-tag
namespaces, one indexed metadata field, ~25% of notes carrying a wikilink,
~5% carrying an attachment) into an on-disk `bun:sqlite` DB via the same
`BunSqliteStore` the daemon uses, then times the hot query / index / export
paths. Each size runs in its own tempdir and is cleaned up after.

There is also an **opt-in `bun:test` smoke** that runs a tiny size end-to-end
so the harness can't bit-rot — skipped by default, enabled with an env flag:

```bash
VAULT_SCALE_BENCH=1 bun test ./src/scale.bench.test.ts
```

Without `VAULT_SCALE_BENCH=1`, `src/scale.bench.test.ts` is `describe.skipIf`'d
and contributes zero runtime to CI.

## Observed ceiling

Numbers below: Bun 1.3.13, Apple Silicon (M-series), SSD, WAL +
`synchronous=NORMAL`. Treat them as **shape**, not absolutes — the
takeaway is which curves are flat, which are linear, and where the first
wall is.

| Operation (limit 100 unless noted)          | 10k    | 50k    | 100k    | scaling |
|---------------------------------------------|--------|--------|---------|---------|
| seed (bulk `createNotes`, batches of 2000)  | 0.53s  | 2.91s  | 6.33s   | ~linear (~63µs/note) |
| `query-notes { tag }`                       | 1.9ms  | 7.9ms  | 15.0ms  | ~linear, fast |
| `query-notes { status eq }` (gen. column)   | 1.1ms  | 5.0ms  | 10.6ms  | ~linear, fast |
| `query-notes orderBy status` (indexed sort) | 2.3ms  | 11.9ms | 23.5ms  | ~linear, fast |
| `searchNotes("…")` (content scan)           | 8.0ms  | 52.9ms | **107.7ms** | linear — **first wall** |
| single-note fetch by id                     | 0.1ms  | 0.1ms  | 0.1ms   | **flat** |
| 100-id batch fetch (link hydration)         | 0.6ms  | 0.7ms  | 0.8ms   | **flat** — no N+1 |
| `exportVaultToDir` (full bulk-load)         | 0.93s  | 4.42s  | 10.01s  | ~linear (~100µs/note) |
| db size on disk                             | 7.1 MB | 36.2 MB| 71.1 MB | ~linear (~0.7 KB/note) |

### What this says about the ceiling

- **Interactive single-owner use stays fast well past 100k notes.** Every
  per-request read path — tag filter, indexed-equality (`meta_<field>`
  generated column), indexed sort, single-note fetch, and batched link
  hydration — stays at or under ~25ms at 100k. The #485 batch link-hydration
  work holds: the 100-id batch fetch is flat at sub-ms across all sizes, i.e.
  **no N+1 in link hydration** at scale.
- **`searchNotes` is the first hot path to feel it.** Content search is a
  linear scan (no FTS index today), ~108ms at 100k. That's still
  interactive, but it's the steepest grower and the practical ceiling for
  search-as-you-type. If a workload makes full-text search central at
  100k+, an FTS5 index is the next lever (out of scope here).
- **`exportVaultToDir` holds at 100k but materializes the whole corpus.**
  The `limit: 1_000_000` bulk-load query in `core/src/portable-md.ts`
  (lines ~776, ~1600) does **not** break at 100k — export completes in ~10s,
  scaling linearly. But the whole result set is loaded into memory at once;
  for vaults pushing *well* past 100k this is the place to switch to a
  cursor / streaming query (already flagged in-code as vault#317 F5). At
  100k on a typical machine the in-memory load is fine.
- **Seed / import is the bounded one-time cost.** A 100k-note import is
  ~6s of writes plus ~10s if it round-trips through export — single-digit
  seconds, well within "one large Obsidian import" tolerance.

### Practical ceiling

For the single-owner case the vault is **comfortably fast to ~100k notes**.
The first thing a user would *feel* is content search latency creeping toward
~100ms in the high-tens-of-thousands; indexed/equality/tag queries and
per-note reads stay snappy throughout. Beyond ~100k the levers, in order, are:
(1) FTS index for content search, (2) cursor/streaming export to drop the
full-corpus in-memory load. Concurrent-writer / WAL tuning and
distributed/sharded vaults are explicitly out of scope (vault#326).

## Note version history (v29, #524)

The [v2 design](https://parachute.techne.coop/v/parachute/n/01M2GNER9X0KVTKX14GK98JNYC)
estimates **35–37 MB** for `unforced` at 20/100/180d under full snapshots,
about **15 MB** with content-addressing, against the mirror's **172.8 MB
note-history portion**. These are design estimates, not measurements of the
new database; the mirror's 1.16 GiB total also includes attachments.
Nine notes account for 84% of all historical versions; the hottest has
15,085. At one write per minute a ceiling of 100 covers **about 100 minutes,
not 180 days**. The v30 compactor reduces stored history with byte deltas; capture still stores
whole bodies. Metadata-only changes share the content blob
from the second capture onward; changing content still creates new blobs.

Every `skipUpdatedAt` metadata write now versions, so one audio upload
produces 3–4 version rows. An additive (non-blow-away) re-import captures each
upserted note: roughly 3,646 captures and 19 MB for `unforced`, outside any
single transaction. Delete tombstones are not pruned by the ordinary version
ceiling; repeated delete/recreate cycles can grow retained history until
explicit erasure or a configured deleted-history sweep.

### Compaction (v30)

A prototype on this box reduced 5,705,987 to 369,015 blob bytes (**15.5×**)
on two synthetic notes: a 20 KB log with 100 versions and 116 KB prose with
30 versions. These are prototype measurements, not production-vault savings.
The prototype measured 24 base64 bytes for a one-line log append versus about
21 KB whole, and 11,168 delta bytes versus 2,872,822 whole for 24 prose versions.
The specification's repeated measurements put prose compaction near 108 ms,
99 log deltas at 14–74 ms across four shapes, and deltified reads at p95
4.2–4.6 ms. Tail maxima varied between runs.

Compaction runs synchronously at first vault open. Its time budget is checked
between notes, so one note can overshoot. Incompressible candidates can recur
and consume the note budget before smaller notes. Compression is deliberately
not used: the measured markdown compression gain was 2.6×, versus the prototype
compaction gain above, and asynchronous CompressionStream cannot run inside a
Durable Object synchronous transaction.

A clean re-measure on this mini (2026-09-15, no `bun test`, `vitest` or `tsc`
processes reported by `pgrep` before the run) produced the following single
samples. Wall time includes SQL and encoding; reads are of the oldest version.

| Synthetic fixture | Compact wall time | Codec time | Blob bytes before → after | Read p95 |
| --- | ---: | ---: | ---: | ---: |
| 1 KB, 30 versions | 8.96 ms | 5.90 ms | 38,740 → 3,239 | 0.22 ms |
| 20 KB log, 100 versions | 495.21 ms | 462.55 ms | 2,093,105 → 108,214 | 0.71 ms |
| 119,641-byte prose, 30 versions | 59.68 ms | 39.85 ms | 3,571,668 → 263,189 | 2.98 ms |

The log sample exceeded the default 250 ms budget by **245 ms** (about 2×).
An independent clean review run measured 212 ms for that fixture; the earlier
loaded-mini run took 2,597 ms, **2,347 ms over budget** (about 10.4×). These are
observations, not a universal bound. The integrity review also measured a
1.84 MB × 9-version note at 5.2 seconds during boot, **4.95 seconds over budget**.
A multi-MB note over the byte ceiling can therefore hold the first open for seconds.
The first candidate is attempted even if selecting candidates consumes the budget;
subsequent candidates honor the note cap first, then the elapsed-time budget.

The exact candidate SELECT over 100 synthetic notes took 4.98 ms in this run.
A production `unforced` database copy migrated from v28 in 580 ms; it had no
history tables before migration and zero history blobs afterward. Production
compaction savings therefore remain unmeasured.

## Offline git-history importer bounds

The importer stages observations in temporary SQLite and walks first-parent trees in commit order. Limits are 100,000 note identities, 100,000 commits, 10,000,000 tree entries across the walk, 2 GiB of distinct decoded source objects, 32 MiB per git command output, and 64 MiB of staged observations per note. Limits fail loudly; they never truncate history. A single body above the existing 2,000,000-byte ceiling quarantines its note. Temporary storage must accommodate the source staging, target DB copy, and private bundle/object database. Projection and apply process notes in the same ID order, using identical retention/compaction rules and a frozen policy time.

A diagnostic projection on a consistent copy of the uni vault completed in **799.96 seconds (13.33 minutes)** on the loaded mini, using implementation `bc6918df2d25ba77f7515df2ff4f2295075efbd7` and frozen archive tip `4f96cdb0cb7b21b7ab5b7c32e735cf508e7e2a94` (2026-09-16). This is one measured sample, not an import-time bound. Other test processes ran during part of the measurement.

| Copied archive / projection | Count |
| --- | ---: |
| First-parent commits | 2,224 |
| Tree entries visited across commits | 817,867 |
| Distinct decoded source bytes | 23,539,286 |
| Eligible live notes | 624 |
| Imported observations before retention | 2,183 |
| Imported observations retained | 1,736 |
| Native versions pruned | 0 |
| Quarantined identities | 11 |
| Historical identities without a live note (skipped) | 18 |
| Live identities absent at source tip | 1 |
| Unidentified source issues | 0 |

Projection runs the actual writer, retention/compaction and retained-content verification on the copy. It is not a production cutover or a benchmark of every prepare/apply/retire command. No waivers were supplied; quarantine and coverage findings block apply until explicitly resolved or waived. The earlier development-source sample took 731.90 seconds and produced the same counts; it is not attributed to a commit. The compactor prototype measurements above are unrelated to importer timing.


Explicit duplicate selections add a bounded per-tree candidate buffer and a canonical input map (at most 100,000 entries / 32 MiB). The candidate census at frozen tip `4f96cdb0cb7b21b7ab5b7c32e735cf508e7e2a94` covered 2,224 trees and 801,331 parsed candidates across 653 identities, identifying 22,623 duplicate-tree sets for 11 identities. This census licenses proposed exact selections; it is not a measurement of the extension's retention outcome. A projection with selections must report newly eligible notes and their native deletion sets separately.
