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
