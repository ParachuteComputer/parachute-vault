/**
 * Per-vault usage monitoring — a cheap, read-scoped "how big is this vault"
 * report (data footprint). Built for running many vaults for many users: the
 * operator needs to see each vault's size, and a vault's own user should be
 * able to see their own vault's footprint.
 *
 * The endpoint that consumes these helpers lives in `routing.ts` at
 * `GET /vault/<name>/.parachute/usage` (read-scoped). This module owns the
 * filesystem arithmetic and the dir-walk cache.
 *
 * Cost model:
 *   - counts + contentBytes come from `getVaultStats` (a handful of indexed
 *     COUNT/SUM queries) — cheap, computed on every request.
 *   - `dbBytes` is three `statSync` calls (the WAL trio) — cheap, every request.
 *   - the two recursive directory walks (`assets`, `mirror`) can traverse
 *     thousands of files, so they go through a 60s TTL cache keyed by vault
 *     name. `?fresh=1` bypasses the cache; an attachment upload invalidates it.
 *
 * Everything I/O-touching goes through an injectable `UsageFs` seam + an
 * injectable clock so tests can assert call counts and TTL behavior without
 * touching the real disk.
 */

import {
  statSync as realStatSync,
  readdirSync as realReaddirSync,
  type Dirent,
} from "fs";
import { join } from "path";
import { vaultDir } from "./config.ts";
import { assetsDir } from "./routes.ts";
import { readMirrorConfigForVault, resolveMirrorPath } from "./mirror-config.ts";
import type { VaultStats } from "../core/src/types.ts";

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

/**
 * The minimal filesystem surface the usage helpers depend on. Injecting it
 * lets tests count how many times the dir-walk runs (to prove the cache
 * actually skips it) and synthesize a tree without writing real files.
 *
 * `lstatSync` semantics for `statFile` are deliberate: we DON'T follow
 * symlinks when summing directory contents, so a symlink-loop or a symlink
 * pointing at a huge tree elsewhere can't inflate the count or hang the walk.
 */
export interface UsageFs {
  /** `lstatSync`-style: returns the size of a file (or 0 / throws if absent). */
  statFile(path: string): { size: number; isDirectory(): boolean; isSymbolicLink(): boolean };
  /** `readdirSync(path, { withFileTypes: true })`. */
  readDir(path: string): Dirent[];
}

/** Monotonic-enough clock seam: returns epoch millis. */
export type Clock = () => number;

/** Real filesystem implementation (production default). */
export const realUsageFs: UsageFs = {
  statFile: (path) => realStatSync(path),
  readDir: (path) => realReaddirSync(path, { withFileTypes: true }),
};

// ---------------------------------------------------------------------------
// Primitive byte counters
// ---------------------------------------------------------------------------

/**
 * Physical bytes of a vault's SQLite database, WAL-aware: `vault.db` +
 * `vault.db-wal` + `vault.db-shm`. The WAL (write-ahead log) and shared-memory
 * index files hold committed-but-not-yet-checkpointed pages; ignoring them
 * undercounts a busy vault. A missing `-wal`/`-shm` (the common case at rest,
 * after a checkpoint) contributes 0 rather than erroring.
 *
 * This is the PHYSICAL DB-file size — it includes SQLite page overhead, free
 * pages from deletes, etc. It is intentionally distinct from the LOGICAL
 * `contentBytes` in `VaultStats` (sum of note-content UTF-8 bytes).
 */
export function dbBytes(vaultName: string, fs: UsageFs = realUsageFs): number {
  const base = join(vaultDir(vaultName), "vault.db");
  const candidates = [base, `${base}-wal`, `${base}-shm`];
  let total = 0;
  for (const path of candidates) {
    total += safeFileSize(path, fs);
  }
  return total;
}

/** Size of a single file, or 0 if it's missing / unreadable. */
function safeFileSize(path: string, fs: UsageFs): number {
  try {
    return fs.statFile(path).size;
  } catch {
    return 0;
  }
}

/**
 * Recursively sum the size of every regular file under `dirPath`.
 *
 *   - Missing directory → 0 (never throws; a vault may have no assets / no
 *     mirror yet).
 *   - Symlinks are NOT followed — a symlink (file or dir) is skipped entirely.
 *     This guards against symlink loops (which would hang an infinite walk)
 *     and against a symlink that points at a large tree outside the vault
 *     inflating the reported footprint.
 *
 * Uses an explicit stack (not recursion) so a deep tree can't blow the call
 * stack, and reads dirents with types so we avoid an extra `stat` per entry
 * just to learn directory-ness.
 */
export function dirSize(dirPath: string, fs: UsageFs = realUsageFs): number {
  let total = 0;
  const stack: string[] = [dirPath];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = fs.readDir(current);
    } catch {
      // Missing/unreadable dir (including the root) → contributes 0.
      continue;
    }
    for (const entry of entries) {
      // Never follow symlinks — neither symlinked files nor symlinked dirs.
      if (entry.isSymbolicLink()) continue;
      const childPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(childPath);
      } else if (entry.isFile()) {
        total += safeFileSize(childPath, fs);
      }
      // Sockets/FIFOs/devices: ignored.
    }
  }
  return total;
}

/**
 * Resolve a vault's mirror directory on disk, or `null` when no mirror is
 * configured / resolvable (never configured, or external-without-path). The
 * usage endpoint reports `mirror: 0` (and omits it from the total) in that
 * case.
 */
export function resolveVaultMirrorDir(vaultName: string): string | null {
  const config = readMirrorConfigForVault(vaultName);
  if (!config) return null;
  return resolveMirrorPath(vaultDir(vaultName), config);
}

// ---------------------------------------------------------------------------
// Dir-walk cache (the only expensive part)
// ---------------------------------------------------------------------------

export interface DirWalkResult {
  /** Bytes under the vault's assets directory. */
  assets: number;
  /**
   * Bytes under the vault's mirror directory, or `null` when no mirror is
   * configured. `null` → omit `mirror` from the response (or report 0).
   */
  mirror: number | null;
}

interface CacheEntry {
  value: DirWalkResult;
  /** Epoch millis when this entry was computed. */
  computedAt: number;
}

/** Default cache lifetime for the dir-walk numbers. */
export const DIR_WALK_TTL_MS = 60_000;

/**
 * In-process, per-vault cache of the two dir-walk numbers. Module-level so it
 * survives across requests within a server process. Tests construct their own
 * `UsageCache` to get isolation + a controllable clock.
 */
export class UsageCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly fs: UsageFs = realUsageFs,
    private readonly now: Clock = Date.now,
    private readonly ttlMs: number = DIR_WALK_TTL_MS,
  ) {}

  /**
   * Get the dir-walk numbers for a vault. Returns whether the numbers came
   * from cache (`cached: true`) or were freshly walked (`cached: false`).
   *
   *   - `fresh: true` always recomputes (and refreshes the cache entry).
   *   - Otherwise a non-expired entry is returned as-is (no walk); an absent
   *     or expired entry triggers a walk + store.
   */
  get(vaultName: string, opts: { fresh?: boolean } = {}): { result: DirWalkResult; cached: boolean } {
    const existing = this.entries.get(vaultName);
    const ts = this.now();
    if (!opts.fresh && existing && ts - existing.computedAt < this.ttlMs) {
      return { result: existing.value, cached: true };
    }
    const value = this.compute(vaultName);
    this.entries.set(vaultName, { value, computedAt: ts });
    return { result: value, cached: false };
  }

  /** Drop a vault's cached dir-walk so the next read recomputes. */
  invalidate(vaultName: string): void {
    this.entries.delete(vaultName);
  }

  /** Run the (expensive) walks. */
  private compute(vaultName: string): DirWalkResult {
    const assets = dirSize(assetsDir(vaultName), this.fs);
    const mirrorDir = resolveVaultMirrorDir(vaultName);
    const mirror = mirrorDir === null ? null : dirSize(mirrorDir, this.fs);
    return { assets, mirror };
  }
}

/**
 * The process-wide cache the live HTTP route uses. A single instance shared
 * across requests gives the 60s TTL its meaning. `invalidateUsageCache` is the
 * write-path hook (attachment upload, post-export).
 */
export const usageCache = new UsageCache();

/** Invalidate the process-wide usage cache for a vault (write-path hook). */
export function invalidateUsageCache(vaultName: string): void {
  usageCache.invalidate(vaultName);
}

// ---------------------------------------------------------------------------
// Report assembly (consumed by the HTTP route)
// ---------------------------------------------------------------------------

export interface UsageReport {
  counts: {
    notes: number;
    attachments: number;
    links: number;
    tags: number;
  };
  bytes: {
    /** Logical: sum of note-content UTF-8 bytes (from VaultStats). */
    content: number;
    /** Physical: vault.db + WAL + shm. */
    db: number;
    /** Bytes under the vault's assets directory (dir-walk, cached). */
    assets: number;
    /**
     * Bytes under the vault's mirror directory (dir-walk, cached), present
     * only when a mirror is configured. The mirror is a git PROJECTION of the
     * same notes/attachments — it is NOT added to `total` (that would
     * double-count the data); it's reported as a separate line item.
     */
    mirror?: number;
    /**
     * The vault's footprint: `db + assets`. Mirror is excluded on purpose
     * (projection of the same data); content is excluded because it's the
     * logical size already physically counted inside `db`.
     */
    total: number;
  };
  /** ISO-8601 timestamp of when this report was assembled. */
  computedAt: string;
  /** Whether the dir-walk numbers (assets/mirror) came from cache. */
  cached: boolean;
}

/**
 * Assemble the usage report for a vault. `stats` is the already-computed
 * `getVaultStats()` result (counts + contentBytes); the cache supplies the two
 * dir-walk numbers and reports whether they were cached.
 *
 * `total = db + assets` — the physical footprint. Mirror is a separate line
 * item (projection of the same data; adding it double-counts). Content is the
 * logical note size, already inside `db` physically.
 */
export function buildUsageReport(
  vaultName: string,
  stats: VaultStats,
  opts: { fresh?: boolean; cache?: UsageCache; fs?: UsageFs; now?: Clock } = {},
): UsageReport {
  const cache = opts.cache ?? usageCache;
  const { result, cached } = cache.get(vaultName, { fresh: opts.fresh });
  const db = dbBytes(vaultName, opts.fs ?? realUsageFs);
  const total = db + result.assets;

  const bytes: UsageReport["bytes"] = {
    content: stats.contentBytes,
    db,
    assets: result.assets,
    total,
  };
  if (result.mirror !== null) bytes.mirror = result.mirror;

  return {
    counts: {
      notes: stats.totalNotes,
      attachments: stats.attachmentCount,
      links: stats.linkCount,
      tags: stats.tagCount,
    },
    bytes,
    computedAt: new Date((opts.now ?? Date.now)()).toISOString(),
    cached,
  };
}
