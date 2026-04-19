/**
 * Vault backup — atomic SQLite snapshots + tarball assembly + destination
 * dispatch + retention pruning.
 *
 * The pipeline is intentionally split into small, composable stages so that
 * later destinations (`s3`, `rsync`, `cloud`) can be plugged in without
 * rewriting the snapshot/tarball/prune layers. A future encryption hook
 * would slot between `assembleTarball` and `writeToDestinations`.
 *
 * Why `VACUUM INTO` instead of the SQLite Online Backup API: `VACUUM INTO`
 * produces a defragmented copy of the database in a single atomic operation
 * and is safe against concurrent readers and writers under WAL journaling
 * mode — exactly our use case. It is a synchronous server-side SQLite
 * primitive, so we don't need a separate backup thread or library. The only
 * caveat is that it copies the whole DB; at vault sizes we care about
 * (single-digit GB), that's faster than we'd save by doing an incremental
 * backup, and simpler is better for MVP.
 */

import { homedir } from "os";
import { join, basename, resolve } from "path";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, copyFileSync, statSync } from "fs";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { $ } from "bun";
import {
  CONFIG_DIR,
  VAULTS_DIR,
  GLOBAL_CONFIG_PATH,
  listVaults,
  vaultDir,
  vaultDbPath,
  vaultConfigPath,
  readGlobalConfig,
  writeGlobalConfig,
  defaultBackupConfig,
  defaultRetentionPolicy,
} from "./config.ts";
import type { BackupConfig, BackupDestination, BackupSchedule, RetentionPolicy } from "./config.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BackupResult {
  /** Absolute path of the assembled tarball on disk (temp staging). */
  tarballPath: string;
  /** ISO8601 timestamp used in the tarball filename. */
  timestamp: string;
  /** Size of the tarball on disk, in bytes. */
  bytes: number;
  /** Per-destination outcome. One destination's failure does not stop others. */
  destinations: DestinationResult[];
  /** What the tarball contained — for verification in tests and `status`. */
  contents: TarballContents;
}

export interface DestinationResult {
  destination: BackupDestination;
  /** Absolute path the tarball ended up at, or null on failure. */
  writtenPath: string | null;
  /** Number of old snapshots pruned after retention was applied. */
  pruned: number;
  /** Non-fatal error, if any. */
  error?: string;
}

export interface TarballContents {
  dbSnapshots: string[];  // filenames inside the tarball
  configFiles: string[];  // filenames inside the tarball
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Expand a leading `~/` or bare `~` in a config path. No-op for absolute. */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Build the backup filename for a given timestamp. Separated so tests can
 * pass a frozen timestamp and assert the format.
 */
export function backupFilename(timestamp: string): string {
  // ISO8601 has colons — not portable on filesystems (FAT/Windows mounts,
  // some iCloud edge cases). Replace them with hyphens. The result still
  // sorts lexicographically in chronological order.
  const safe = timestamp.replace(/:/g, "-");
  return `parachute-backup-${safe}.tar.gz`;
}

/** Inverse of `backupFilename` for parsing filenames during retention prune. */
export function parseBackupFilename(name: string): { timestamp: string } | null {
  const m = name.match(/^parachute-backup-(.+)\.tar\.gz$/);
  if (!m) return null;
  return { timestamp: m[1] };
}

// ---------------------------------------------------------------------------
// Snapshot stage — produces SQLite copies + config files in a staging dir
// ---------------------------------------------------------------------------

/**
 * Take a `VACUUM INTO` snapshot of every `.db` file we can find in
 * `CONFIG_DIR`:
 *
 *   1. Top-level `~/.parachute/*.db` — covers legacy pre-multi-vault installs
 *      (e.g. `daily.db`) and any user-placed sidecar DBs. Hits include `.bak`
 *      copies, which we intentionally skip since they're already static
 *      snapshots that `cp` would duplicate faster than VACUUM.
 *   2. Per-vault `vaults/<name>/vault.db` via `listVaults()`.
 *
 * Returns the staging directory so the next stage can tar it up.
 */
export async function stageSnapshot(opts?: {
  /** Override config dir. Tests point this at a tempdir. */
  configDir?: string;
  /** Override vaults dir. Tests point this at a tempdir's vaults/. */
  vaultsDir?: string;
  /** Override staging dir. Tests pass a tempdir to inspect contents. */
  stagingDir?: string;
}): Promise<{ stagingDir: string; contents: TarballContents }> {
  const configDir = opts?.configDir ?? CONFIG_DIR;
  const vaultsDir = opts?.vaultsDir ?? VAULTS_DIR;
  const stagingDir = opts?.stagingDir ?? mkdtempSync(join(tmpdir(), "parachute-backup-"));

  const dbSnapshots: string[] = [];
  const configFiles: string[] = [];

  // 1. Top-level *.db files in CONFIG_DIR. Skip .bak and other non-live files.
  if (existsSync(configDir)) {
    for (const entry of readdirSync(configDir)) {
      if (!entry.endsWith(".db")) continue;
      const src = join(configDir, entry);
      // Skip symlinks-to-dirs, subdirs, etc. A `.db` extension on a directory
      // is exotic; `statSync` isolates us from it.
      try {
        const st = statSync(src);
        if (!st.isFile()) continue;
      } catch {
        continue;
      }
      const destName = `config-${entry}`;
      const dest = join(stagingDir, destName);
      vacuumInto(src, dest);
      dbSnapshots.push(destName);
    }
  }

  // 2. Per-vault DBs. We mirror the vaults/<name>/ layout inside the tarball
  // so a restore can drop the whole directory back in place without renaming.
  // vault.yaml is included alongside vault.db for the same reason.
  if (existsSync(vaultsDir)) {
    const vaultNames = listVaultsIn(vaultsDir);
    for (const name of vaultNames) {
      const dbSrc = join(vaultsDir, name, "vault.db");
      const cfgSrc = join(vaultsDir, name, "vault.yaml");

      if (existsSync(dbSrc)) {
        const mirrorDir = join(stagingDir, "vaults", name);
        mkdirSync(mirrorDir, { recursive: true });
        const dbDest = join(mirrorDir, "vault.db");
        vacuumInto(dbSrc, dbDest);
        dbSnapshots.push(join("vaults", name, "vault.db"));
      }
      if (existsSync(cfgSrc)) {
        const mirrorDir = join(stagingDir, "vaults", name);
        mkdirSync(mirrorDir, { recursive: true });
        copyFileSync(cfgSrc, join(mirrorDir, "vault.yaml"));
        configFiles.push(join("vaults", name, "vault.yaml"));
      }
    }
  }

  // 3. Global config.yaml — the heart of "restore my setup" for a new machine.
  const globalCfgSrc = opts?.configDir ? join(opts.configDir, "config.yaml") : GLOBAL_CONFIG_PATH;
  if (existsSync(globalCfgSrc)) {
    copyFileSync(globalCfgSrc, join(stagingDir, "config.yaml"));
    configFiles.push("config.yaml");
  }

  return { stagingDir, contents: { dbSnapshots, configFiles } };
}

/** Take a VACUUM INTO snapshot. Atomic against concurrent writers under WAL. */
function vacuumInto(srcDbPath: string, destPath: string): void {
  // VACUUM INTO requires the destination file NOT to exist — SQLite enforces
  // this to avoid clobbering a live DB with a partial vacuum output. Staging
  // dirs are fresh, so this should always hold; belt-and-braces guard below.
  if (existsSync(destPath)) rmSync(destPath);
  // readwrite=true is required — VACUUM INTO is considered a write by SQLite
  // (it creates the output file), so read-only handles are rejected.
  const db = new Database(srcDbPath, { readwrite: true });
  try {
    // Parameter binding: SQLite does NOT allow bound parameters for the
    // VACUUM INTO target path, so we must splice it in. The path comes
    // from our own staging tempdir — no user-controlled input — so
    // string interpolation is safe. We still escape single quotes
    // defensively in case a username contains one.
    const escaped = destPath.replace(/'/g, "''");
    db.run(`VACUUM INTO '${escaped}'`);
  } finally {
    db.close();
  }
}

/**
 * Small internal helper so tests can point us at a vaults dir that isn't
 * the global VAULTS_DIR without plumbing the override through `listVaults()`.
 */
function listVaultsIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((entry) => {
      const cfg = join(dir, entry, "vault.yaml");
      return existsSync(cfg);
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Tarball stage
// ---------------------------------------------------------------------------

/**
 * Wrap a staging directory into a gzip'd tarball at `outPath`. Uses `tar`
 * from PATH — macOS and every Linux distro we target ships bsdtar or GNU
 * tar. We could reimplement the tar format in pure TypeScript, but that's
 * a maintenance tax for no user-visible benefit.
 *
 * The tar is rooted at the staging dir (via `-C`) so the archive contains
 * `config.yaml`, `vaults/...`, and `config-*.db` at the top level rather
 * than burying them under a random tempdir prefix.
 */
export async function assembleTarball(stagingDir: string, outPath: string): Promise<void> {
  mkdirSync(resolve(outPath, ".."), { recursive: true });
  const entries = readdirSync(stagingDir);
  if (entries.length === 0) {
    // `tar` on some platforms errors on an empty input list; we'd rather
    // produce an empty-but-valid tarball. An empty staging dir means the
    // user has no DBs yet — a legitimate state on a fresh install.
    await $`tar -czf ${outPath} -C ${stagingDir} --files-from /dev/null`.quiet();
    return;
  }
  await $`tar -czf ${outPath} -C ${stagingDir} ${entries}`.quiet();
}

// ---------------------------------------------------------------------------
// Destination stage
// ---------------------------------------------------------------------------

/**
 * Write the tarball to each configured destination. Per-destination errors
 * are captured, not thrown — a dead S3 bucket shouldn't prevent the local
 * iCloud copy from succeeding. Callers surface results.
 */
export async function writeToDestinations(
  tarballPath: string,
  destinations: BackupDestination[],
  retention: RetentionPolicy,
): Promise<DestinationResult[]> {
  const results: DestinationResult[] = [];
  for (const dest of destinations) {
    try {
      const res = await writeToDestination(tarballPath, dest, retention);
      results.push(res);
    } catch (err: any) {
      results.push({
        destination: dest,
        writtenPath: null,
        pruned: 0,
        error: String(err?.message ?? err),
      });
    }
  }
  return results;
}

async function writeToDestination(
  tarballPath: string,
  dest: BackupDestination,
  retention: RetentionPolicy,
): Promise<DestinationResult> {
  switch (dest.kind) {
    case "local": {
      const target = expandTilde(dest.path);
      mkdirSync(target, { recursive: true });
      const outName = basename(tarballPath);
      const out = join(target, outName);
      copyFileSync(tarballPath, out);
      const pruned = pruneRetention(target, retention);
      return { destination: dest, writtenPath: out, pruned };
    }
    // Exhaustiveness guard — if a future destination kind is added to the
    // type union but not handled here, the compiler fails the build.
    default: {
      const _exhaustive: never = dest;
      throw new Error(`Unsupported destination kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Tiered retention — grandfather / father / son
// ---------------------------------------------------------------------------

/**
 * Parse a backup filename's timestamp component back into a Date. We wrote the
 * timestamp as ISO-8601 with colons swapped for hyphens (for filesystem
 * portability), so we have to swap back before handing to `new Date()`.
 *
 * The hyphen-for-colon swap is position-specific: the ISO-8601 date-time
 * separator is `T`, after which there are three hyphens we introduced (HH-MM-SS)
 * but also possibly real hyphens in the timezone offset (…+00:00 → +00-00).
 * We undo every hyphen that appears AFTER the `T`, preserving the three
 * leading hyphens in the YYYY-MM-DD portion.
 */
function timestampToDate(stamp: string): Date | null {
  const tIdx = stamp.indexOf("T");
  if (tIdx < 0) return null;
  const head = stamp.slice(0, tIdx);
  const tail = stamp.slice(tIdx).replace(/-/g, ":");
  const iso = head + tail;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

/**
 * Bucket key for the daily tier: ISO calendar date in the local timezone
 * (YYYY-MM-DD). We lean on `Intl.DateTimeFormat` with the system's default
 * timezone because it handles DST transitions correctly, unlike hand-rolling
 * with `getDate()` from a UTC Date that's been shifted by offset math.
 */
function localDateKey(d: Date): string {
  // `en-CA` gives us ISO-like `YYYY-MM-DD` by default — a happy accident that
  // saves us from assembling the pieces ourselves.
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function localYearKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric" }).format(d);
}

function localYearMonthKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
  }).format(d);
}

/**
 * ISO week bucket: (ISO week year, ISO week number). We compute both in the
 * local timezone so "end-of-week rollover" aligns with what the user sees on
 * their calendar. The ISO week year can differ from the calendar year at
 * year boundaries (a Dec 31 Monday belongs to next year's week 1; a Jan 1
 * Friday belongs to last year's week 53) — we handle that with the standard
 * "week containing the year's first Thursday is week 1" rule.
 */
function isoWeekKey(d: Date): string {
  // Pull out local-tz Y/M/D so week math stays aligned to the user's calendar
  // instead of UTC.
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const yStr = parts.find((p) => p.type === "year")?.value ?? "1970";
  const mStr = parts.find((p) => p.type === "month")?.value ?? "01";
  const dStr = parts.find((p) => p.type === "day")?.value ?? "01";
  const year = parseInt(yStr, 10);
  const month = parseInt(mStr, 10);
  const day = parseInt(dStr, 10);

  // Work in a UTC Date that carries our local Y/M/D, so further arithmetic
  // doesn't get perturbed by DST.
  const target = new Date(Date.UTC(year, month - 1, day));
  // Shift target to the Thursday of its week (ISO weeks are anchored there).
  // getUTCDay(): 0=Sun, 1=Mon, …, 6=Sat. ISO wants Mon=1, so (day+6)%7 maps
  // Sun→6, Mon→0, …, Sat→5, which is the "days since Monday."
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  // Week 1 is the one containing Jan 4 (equivalently, the year's first Thursday).
  const week1 = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(
    ((target.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7,
  );
  const isoYear = target.getUTCFullYear();
  // Pad week to 2 digits so string-sort matches chronological order.
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

export interface SnapshotEntry {
  name: string;
  timestamp: string;
  date: Date;
}

/**
 * Enumerate the `parachute-backup-*.tar.gz` files in a directory, parse each
 * timestamp, and return them sorted ascending (oldest first) — the order we
 * rely on for bucket-last-wins and for test determinism.
 */
export function listSnapshots(dir: string): SnapshotEntry[] {
  if (!existsSync(dir)) return [];
  const entries: SnapshotEntry[] = [];
  for (const name of readdirSync(dir)) {
    const parsed = parseBackupFilename(name);
    if (!parsed) continue;
    const d = timestampToDate(parsed.timestamp);
    if (!d) continue;
    entries.push({ name, timestamp: parsed.timestamp, date: d });
  }
  // Because our filename timestamps are lexicographically sortable, sorting
  // by name and sorting by date yield the same order. We sort by timestamp
  // string because it's cheaper and deterministic across clock skew.
  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return entries;
}

/**
 * Compute the subset of snapshots that the tiered policy keeps. Public for
 * testability — `pruneRetention` is the mutating variant.
 *
 * Algorithm:
 *   1. Group entries by bucket key for each tier (daily / weekly / monthly /
 *      yearly). Since inputs are sorted ascending, the last entry overwriting
 *      a given bucket key is the most-recent-in-bucket — exactly the one we
 *      want to keep for that tier.
 *   2. For weekly/monthly/yearly, take the N most recent bucket keys (or all
 *      of them if yearly is null) and union their keepers.
 *   3. For daily, skip the bucketing step — just keep the last N entries.
 *   4. Return the union as a Set of filenames.
 *
 * A tier set to 0 contributes no keepers but doesn't disable the others.
 * Sparse data (gaps) just means fewer buckets; no special-casing required.
 */
export function computeKeepSet(
  entries: SnapshotEntry[],
  policy: RetentionPolicy,
): Set<string> {
  const keep = new Set<string>();

  // Daily: take the last N entries outright. No bucketing by day needed;
  // if two backups land on the same day, they both count toward the daily
  // tier's "last N" — this is the intuitive "keep my 7 most recent" promise.
  if (policy.daily > 0) {
    for (const entry of entries.slice(-policy.daily)) keep.add(entry.name);
  }

  // Weekly / monthly / yearly — all follow the same pattern: bucket by key,
  // take the most recent entry per bucket, then cap to the N most recent
  // buckets. Implemented once here with a small helper to avoid drift.
  const tierByBucket = (
    keyFn: (d: Date) => string,
    limit: number | null,
  ) => {
    if (limit === 0) return;
    const buckets = new Map<string, SnapshotEntry>();
    for (const entry of entries) {
      // Last-write-wins: because entries are sorted ascending, the final
      // overwrite for a given key IS the most recent entry in that bucket.
      buckets.set(keyFn(entry.date), entry);
    }
    // Sort bucket keys descending (most recent first) then cap. Our keys
    // are all lex-sortable (ISO-like), so string compare == chronological.
    const keysDesc = [...buckets.keys()].sort().reverse();
    const chosen = limit === null ? keysDesc : keysDesc.slice(0, limit);
    for (const k of chosen) keep.add(buckets.get(k)!.name);
  };

  tierByBucket(isoWeekKey, policy.weekly);
  tierByBucket(localYearMonthKey, policy.monthly);
  tierByBucket(localYearKey, policy.yearly);

  return keep;
}

/**
 * Per-tier breakdown of a destination's current keep set — how many snapshots
 * each tier contributes. Sums are with respect to the un-pruned contents of
 * `dir` (i.e., snapshot-of-current-state, not "what would we prune next"),
 * which is what `backup status` wants to render.
 *
 * `total` is the number of snapshot files present on disk. Per-tier counts
 * sum to the size of the union; because a single snapshot can satisfy
 * multiple tiers, they can sum to more than `total`.
 */
export interface TierTally {
  total: number;
  daily: number;
  weekly: number;
  monthly: number;
  yearly: number;
}

export function tierTally(dir: string, policy: RetentionPolicy): TierTally {
  const entries = listSnapshots(dir);
  const total = entries.length;
  // Re-run each tier in isolation to count its individual contribution.
  // Tiny N (usually < 100 snapshots), so the duplicated bucketing is fine.
  const isolate = (tier: Partial<RetentionPolicy>): number => {
    const p: RetentionPolicy = { daily: 0, weekly: 0, monthly: 0, yearly: 0, ...tier };
    return computeKeepSet(entries, p).size;
  };
  return {
    total,
    daily: isolate({ daily: policy.daily }),
    weekly: isolate({ weekly: policy.weekly }),
    monthly: isolate({ monthly: policy.monthly }),
    yearly: isolate({ yearly: policy.yearly }),
  };
}

/**
 * Tiered retention: keep the union of daily/weekly/monthly/yearly tiers,
 * delete everything else. Returns the number of files deleted.
 *
 * Uses filename-embedded timestamps (NOT file mtime — mtime is unreliable
 * after move/sync, especially under iCloud which rewrites timestamps).
 */
export function pruneRetention(dir: string, policy: RetentionPolicy): number {
  if (!existsSync(dir)) return 0;
  const entries = listSnapshots(dir);
  const keep = computeKeepSet(entries, policy);
  let deleted = 0;
  for (const entry of entries) {
    if (keep.has(entry.name)) continue;
    try {
      rmSync(join(dir, entry.name));
      deleted++;
    } catch {
      // Prune failure is non-fatal; we'd rather keep making new backups
      // than abort because one stale file is locked.
    }
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Top-level orchestration
// ---------------------------------------------------------------------------

/**
 * Run a single backup end-to-end: stage, tar, ship to destinations. This is
 * what `parachute-vault backup` and the launchd-scheduled job both invoke.
 *
 * The staging dir is cleaned up on exit; the tarball itself is kept (copied
 * to each destination) and also left behind in the staging dir's parent —
 * actually, no: we drop the staging dir entirely and rely on the
 * destination-side copy as the durable artifact.
 */
export async function runBackup(opts?: {
  configDir?: string;
  vaultsDir?: string;
  backup?: BackupConfig;
  /** Freeze "now" for deterministic tests. ISO8601 string. */
  now?: string;
}): Promise<BackupResult> {
  const backup = opts?.backup ?? readGlobalConfig().backup ?? defaultBackupConfig();
  const timestamp = opts?.now ?? new Date().toISOString();

  const { stagingDir, contents } = await stageSnapshot({
    configDir: opts?.configDir,
    vaultsDir: opts?.vaultsDir,
  });

  try {
    const tarName = backupFilename(timestamp);
    const tarballPath = join(stagingDir, "__out__", tarName);
    await assembleTarball(stagingDir, tarballPath);
    const bytes = statSync(tarballPath).size;

    const results = await writeToDestinations(tarballPath, backup.destinations, backup.retention);

    // Record last-backup metadata for `status`. Stored in a small JSON file
    // inside CONFIG_DIR so it survives across daemons and doesn't require
    // plumbing through config.yaml (which is hand-edited by users).
    recordLastBackup({
      timestamp,
      bytes,
      destinations: results.map((r) => ({
        path: r.writtenPath,
        error: r.error ?? null,
      })),
    }, opts?.configDir);

    return { tarballPath, timestamp, bytes, destinations: results, contents };
  } finally {
    // The staging dir has the only copy of the tarball that isn't at a
    // destination; destinations have already been written. Safe to clean.
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Last-run metadata (for `status`)
// ---------------------------------------------------------------------------

export interface LastBackupMeta {
  timestamp: string;
  bytes: number;
  destinations: Array<{ path: string | null; error: string | null }>;
}

export function lastBackupPath(configDir?: string): string {
  return join(configDir ?? CONFIG_DIR, "backup-last.json");
}

function recordLastBackup(meta: LastBackupMeta, configDir?: string): void {
  try {
    mkdirSync(configDir ?? CONFIG_DIR, { recursive: true });
    Bun.write(lastBackupPath(configDir), JSON.stringify(meta, null, 2) + "\n");
  } catch {
    // Non-fatal — losing last-run metadata is a UX regression, not a data loss.
  }
}

export function readLastBackup(configDir?: string): LastBackupMeta | null {
  const p = lastBackupPath(configDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(require("fs").readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Config ergonomics
// ---------------------------------------------------------------------------

/**
 * Atomically update the `backup` section of global config. Creates the
 * section with defaults if missing, then applies `patch`. Used by the
 * `--schedule` flag and by tests.
 */
export function updateBackupConfig(patch: Partial<BackupConfig>): BackupConfig {
  const cfg = readGlobalConfig();
  const next: BackupConfig = { ...defaultBackupConfig(), ...(cfg.backup ?? {}), ...patch };
  cfg.backup = next;
  writeGlobalConfig(cfg);
  return next;
}

/**
 * Probe whether a destination is ready to receive a backup. For `local`,
 * this is a mkdir + write-probe roundtrip. Used by `doctor` so users learn
 * about an unwritable iCloud path BEFORE the scheduled run silently fails.
 */
export function checkDestinationWritable(dest: BackupDestination): {
  ok: boolean;
  path: string;
  error?: string;
} {
  if (dest.kind !== "local") {
    // Other destination kinds don't exist yet. When they do, each will
    // implement its own writability probe (e.g., an S3 bucket HeadBucket).
    return { ok: false, path: JSON.stringify(dest), error: "unsupported destination kind" };
  }
  const target = expandTilde(dest.path);
  try {
    mkdirSync(target, { recursive: true });
    const probe = join(target, `.parachute-write-probe-${process.pid}`);
    Bun.write(probe, "");
    // Clean up the probe. Failure to remove it is not a writability failure
    // — the directory is writable or the probe write above would have thrown.
    try { rmSync(probe); } catch {}
    return { ok: true, path: target };
  } catch (err: any) {
    return { ok: false, path: target, error: String(err?.message ?? err) };
  }
}

/**
 * Calendar-arithmetic "next run" estimate for `status`. This is deliberately
 * approximate — launchd is our source of truth for actual firing — but it's
 * what every cron-style UI shows and it's better than "unknown."
 */
export function nextRunEstimate(schedule: BackupSchedule, lastRun?: Date): Date | null {
  if (schedule === "manual") return null;
  const base = lastRun ?? new Date();
  const next = new Date(base);
  switch (schedule) {
    case "hourly": next.setHours(next.getHours() + 1); break;
    case "daily": next.setDate(next.getDate() + 1); break;
    case "weekly": next.setDate(next.getDate() + 7); break;
  }
  return next;
}
