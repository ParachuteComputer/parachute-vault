/**
 * Integration tests for the backup module.
 *
 * Strategy mirrors `doctor.test.ts`: spin up an isolated `PARACHUTE_HOME`
 * tempdir, populate it with fake vaults / DBs / config, run backup end-to-
 * end, then unpack the resulting tarball and assert on contents. This
 * exercises the full pipeline — SQLite VACUUM INTO, tar assembly, local
 * destination copy, retention pruning — without requiring a live daemon.
 *
 * We also unit-test the pure helpers (filename round-tripping, retention
 * ordering, tilde expansion) so regressions don't hide behind the
 * integration harness.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "fs";
import { join, resolve } from "path";
import { tmpdir, homedir } from "os";
import { Database } from "bun:sqlite";
import { $ } from "bun";

import {
  backupFilename,
  parseBackupFilename,
  expandTilde,
  stageSnapshot,
  assembleTarball,
  pruneRetention,
  computeKeepSet,
  listSnapshots,
  tierTally,
  runBackup,
  readLastBackup,
  nextRunEstimate,
  checkDestinationWritable,
} from "./backup.ts";
import type { BackupConfig, RetentionPolicy } from "./config.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a small SQLite DB with one row, for snapshot-contents assertions. */
function makeFakeDb(path: string, marker: string) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const db = new Database(path);
  db.run("CREATE TABLE marker (v TEXT)");
  db.run("INSERT INTO marker VALUES (?)", [marker]);
  db.close();
}

/** Extract a tar.gz into a fresh tempdir and return that dir. */
async function untar(tarball: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "untar-"));
  await $`tar -xzf ${tarball} -C ${dir}`.quiet();
  return dir;
}

/** Write a minimal vault.yaml so `listVaultsIn` picks up the vault. */
function makeFakeVault(vaultsDir: string, name: string, marker: string) {
  const dir = join(vaultsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "vault.yaml"), `name: ${name}\ncreated_at: "2026-01-01T00:00:00.000Z"\napi_keys:\n`);
  makeFakeDb(join(dir, "vault.db"), marker);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("backup — pure helpers", () => {
  test("backupFilename uses timestamp with colons replaced by hyphens", () => {
    const ts = "2026-04-17T08:30:00.000Z";
    expect(backupFilename(ts)).toBe("parachute-backup-2026-04-17T08-30-00.000Z.tar.gz");
  });

  test("parseBackupFilename round-trips with backupFilename", () => {
    const ts = "2026-04-17T08-30-00.000Z";
    const name = `parachute-backup-${ts}.tar.gz`;
    expect(parseBackupFilename(name)).toEqual({ timestamp: ts });
  });

  test("parseBackupFilename returns null for unrelated files", () => {
    expect(parseBackupFilename("something.tar.gz")).toBeNull();
    expect(parseBackupFilename("parachute-backup.tar")).toBeNull(); // missing .gz
    expect(parseBackupFilename("README.md")).toBeNull();
  });

  test("expandTilde expands leading ~/ but leaves absolute paths alone", () => {
    expect(expandTilde("~/foo")).toBe(join(homedir(), "foo"));
    expect(expandTilde("~")).toBe(homedir());
    expect(expandTilde("/absolute/path")).toBe("/absolute/path");
    expect(expandTilde("relative/path")).toBe("relative/path"); // not expanded — by design
  });

  test("nextRunEstimate returns null for manual, forward-moving Date otherwise", () => {
    const base = new Date("2026-04-17T00:00:00Z");
    expect(nextRunEstimate("manual", base)).toBeNull();
    const daily = nextRunEstimate("daily", base)!;
    expect(daily.getTime()).toBeGreaterThan(base.getTime());
    // Weekly is strictly later than daily.
    const weekly = nextRunEstimate("weekly", base)!;
    expect(weekly.getTime()).toBeGreaterThan(daily.getTime());
  });
});

// ---------------------------------------------------------------------------
// Tiered retention pruning (grandfather / father / son)
// ---------------------------------------------------------------------------

/**
 * Touch a synthetic snapshot file with the given Date as its embedded
 * timestamp. We produce a filename in the exact format runBackup would
 * produce so the parse/bucket pipeline sees a realistic input.
 */
function makeSnapshot(dir: string, d: Date): string {
  const name = backupFilename(d.toISOString());
  writeFileSync(join(dir, name), "x");
  return name;
}

/** Build a dense sequence of daily snapshots across a UTC date range. */
function dailySnapshots(dir: string, startUtc: string, days: number): Date[] {
  const start = new Date(startUtc);
  const out: Date[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86400_000);
    // Fix to 12:00 UTC so every timestamp lands in the middle of the day —
    // avoids local-midnight edge cases in test assertions.
    d.setUTCHours(12, 0, 0, 0);
    makeSnapshot(dir, d);
    out.push(d);
  }
  return out;
}

/** Full policy: helper so tests read naturally. */
function policy(p: Partial<RetentionPolicy>): RetentionPolicy {
  return { daily: 0, weekly: 0, monthly: 0, yearly: 0, ...p };
}

describe("backup — tiered retention pruning", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "backup-prune-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("daily tier: keeps last N snapshots unconditionally", () => {
    // 10 consecutive days, keep daily=3 — the 3 most recent survive.
    dailySnapshots(dir, "2026-01-01T00:00:00Z", 10);
    const pruned = pruneRetention(dir, policy({ daily: 3 }));
    expect(pruned).toBe(7);
    const left = readdirSync(dir).filter((n) => n.startsWith("parachute-backup-")).sort();
    expect(left.length).toBe(3);
    // Chronological order: last 3 days are Jan 8, 9, 10.
    expect(left[0]).toMatch(/2026-01-08T/);
    expect(left[2]).toMatch(/2026-01-10T/);
  });

  test("daily: 0 disables tier but other tiers still apply", () => {
    dailySnapshots(dir, "2026-01-01T00:00:00Z", 30);
    // Only the monthly tier: one snapshot from January kept (the last),
    // everything else pruned.
    pruneRetention(dir, policy({ monthly: 1 }));
    const left = readdirSync(dir).filter((n) => n.startsWith("parachute-backup-")).sort();
    expect(left.length).toBe(1);
    expect(left[0]).toMatch(/2026-01-30T/);
  });

  test("weekly tier: one snapshot per ISO week, N most recent weeks", () => {
    // 4 weeks of daily snapshots — 28 entries across 4 weeks plus overflow.
    dailySnapshots(dir, "2026-01-05T00:00:00Z", 28); // Mon Jan 5 → Sun Feb 1
    // Weekly=2 alone: keep last-of-week for the last 2 ISO weeks only.
    pruneRetention(dir, policy({ weekly: 2 }));
    const left = readdirSync(dir).filter((n) => n.startsWith("parachute-backup-")).sort();
    // 2 survivors: the Sunday of each of the two most recent weeks.
    expect(left.length).toBe(2);
  });

  test("monthly tier: last snapshot of each of N months", () => {
    // One snapshot per day across 3 full months.
    dailySnapshots(dir, "2026-01-01T00:00:00Z", 90);
    pruneRetention(dir, policy({ monthly: 2 }));
    const left = readdirSync(dir).filter((n) => n.startsWith("parachute-backup-")).sort();
    expect(left.length).toBe(2);
    // Last-of-Feb (Feb 28, 2026 — not leap year) and last-of-Mar (Mar 31).
    expect(left[0]).toMatch(/2026-02-28T/);
    expect(left[1]).toMatch(/2026-03-31T/);
  });

  test("yearly: null means unbounded — keeps last-of-year for every year in history", () => {
    // One snapshot per year across 5 years. Every year survives because
    // yearly is null.
    for (const y of [2022, 2023, 2024, 2025, 2026]) {
      makeSnapshot(dir, new Date(Date.UTC(y, 5, 15, 12, 0, 0)));
    }
    const pruned = pruneRetention(dir, policy({ yearly: null }));
    expect(pruned).toBe(0);
    const left = readdirSync(dir).filter((n) => n.startsWith("parachute-backup-")).sort();
    expect(left.length).toBe(5);
  });

  test("sparse data: alternate-day snapshots across 3 years, full policy", () => {
    // Build roughly 550 snapshots spread every other day across three years.
    // The union tier selection should degrade gracefully across the gaps.
    const entries: Date[] = [];
    for (let y = 2024; y <= 2026; y++) {
      for (let day = 0; day < 365; day += 2) {
        const d = new Date(Date.UTC(y, 0, 1 + day, 12, 0, 0));
        makeSnapshot(dir, d);
        entries.push(d);
      }
    }
    // The full default-shaped policy with unbounded yearly.
    pruneRetention(dir, policy({ daily: 7, weekly: 4, monthly: 12, yearly: null }));
    const left = readdirSync(dir).filter((n) => n.startsWith("parachute-backup-")).sort();

    // Assertions — exact membership:
    //  - daily: the last 7 entries in the ascending list.
    //  - weekly: at most 4 weeks; each contributes one keeper.
    //  - monthly: the 12 most recent calendar months with data.
    //  - yearly (null): every year with data — 2024, 2025, 2026 → 3 keepers
    //    (some of which overlap with the monthly/daily tiers; union dedupes).
    // A loose but informative check: the keep count falls well under the
    // full 550-ish and comfortably above the bare daily=7.
    expect(left.length).toBeGreaterThanOrEqual(7);
    // Union of tiers cannot exceed: 7 daily + 4 weekly + 12 monthly + 3 yearly
    // = 26 at the absolute upper bound, minus overlap. We just bound it here.
    expect(left.length).toBeLessThanOrEqual(26);

    // At least one keeper per year — the yearly tier guarantees this.
    const years = new Set(
      left.map((n) => n.match(/parachute-backup-(\d{4})-/)?.[1]).filter(Boolean),
    );
    expect(years.has("2024")).toBe(true);
    expect(years.has("2025")).toBe(true);
    expect(years.has("2026")).toBe(true);

    // The most recent snapshot is always kept (it's in the daily tier).
    const mostRecent = backupFilename(entries[entries.length - 1].toISOString());
    expect(left).toContain(mostRecent);
  });

  test("year-boundary overlap: Dec 31 vs Jan 1 land in different yearly buckets", () => {
    // Snapshots on two consecutive days straddling the year boundary.
    // The yearly tier should keep BOTH — one for each year.
    makeSnapshot(dir, new Date(Date.UTC(2025, 11, 31, 12, 0, 0))); // Dec 31 2025
    makeSnapshot(dir, new Date(Date.UTC(2026, 0, 1, 12, 0, 0))); // Jan 1 2026
    pruneRetention(dir, policy({ yearly: null }));
    const left = readdirSync(dir).filter((n) => n.startsWith("parachute-backup-")).sort();
    expect(left.length).toBe(2);
  });

  test("end-of-week rollover: Sunday and Monday cross ISO-week boundary", () => {
    // 2026-01-04 is Sun (ISO week 1), 2026-01-05 is Mon (ISO week 2).
    // Weekly=2 should keep one from each week. Noon UTC → most timezones
    // put both on the expected local calendar day.
    const sun = new Date(Date.UTC(2026, 0, 4, 12, 0, 0));
    const mon = new Date(Date.UTC(2026, 0, 5, 12, 0, 0));
    makeSnapshot(dir, sun);
    makeSnapshot(dir, mon);
    const keep = computeKeepSet(listSnapshots(dir), policy({ weekly: 2 }));
    expect(keep.size).toBe(2);
  });

  test("no-op when every snapshot is kept by some tier", () => {
    dailySnapshots(dir, "2026-01-01T00:00:00Z", 5);
    const pruned = pruneRetention(dir, policy({ daily: 7 }));
    expect(pruned).toBe(0);
    expect(readdirSync(dir).filter((n) => n.startsWith("parachute-backup-")).length).toBe(5);
  });

  test("ignores non-backup files in the destination directory", () => {
    // iCloud sometimes drops .DS_Store / .icloud placeholder files into a
    // sync dir. Retention must only touch parachute-backup-*.tar.gz.
    writeFileSync(join(dir, ".DS_Store"), "x");
    writeFileSync(join(dir, "README.md"), "x");
    dailySnapshots(dir, "2026-01-01T00:00:00Z", 5);
    pruneRetention(dir, policy({ daily: 1 }));
    // The non-backup files are untouched.
    expect(existsSync(join(dir, ".DS_Store"))).toBe(true);
    expect(existsSync(join(dir, "README.md"))).toBe(true);
    // Only 1 backup file survives.
    expect(readdirSync(dir).filter((n) => n.startsWith("parachute-backup-")).length).toBe(1);
  });

  test("all tiers 0 / null yearly=0: everything pruned", () => {
    dailySnapshots(dir, "2026-01-01T00:00:00Z", 5);
    const pruned = pruneRetention(dir, policy({}));
    expect(pruned).toBe(5);
    expect(readdirSync(dir).filter((n) => n.startsWith("parachute-backup-")).length).toBe(0);
  });

  test("a snapshot satisfying multiple tiers is kept once, not duplicated", () => {
    // A single snapshot at year-end/month-end/week-end satisfies all four
    // tiers. Deletion count is 0, on-disk count stays at 1.
    makeSnapshot(dir, new Date(Date.UTC(2026, 11, 31, 12, 0, 0)));
    const pruned = pruneRetention(dir, policy({ daily: 7, weekly: 4, monthly: 12, yearly: null }));
    expect(pruned).toBe(0);
    const left = readdirSync(dir).filter((n) => n.startsWith("parachute-backup-"));
    expect(left.length).toBe(1);
  });
});

describe("backup — tierTally", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "backup-tally-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("reports per-tier contribution counts for `backup status`", () => {
    dailySnapshots(dir, "2026-01-01T00:00:00Z", 60);
    const t = tierTally(dir, policy({ daily: 7, weekly: 4, monthly: 2, yearly: null }));
    expect(t.total).toBe(60);
    expect(t.daily).toBe(7);
    // 60 daily snapshots span ~9 ISO weeks; cap at 4.
    expect(t.weekly).toBe(4);
    // 60 days straddles Jan + Feb + 1 day into March → monthly cap at 2.
    expect(t.monthly).toBe(2);
    // All 60 days are in 2026 → yearly is 1.
    expect(t.yearly).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// stageSnapshot — SQLite VACUUM INTO + config copy
// ---------------------------------------------------------------------------

describe("backup — stageSnapshot", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "backup-stage-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  test("snapshots top-level *.db files and mirrors vaults/", async () => {
    // Top-level legacy-style DB.
    makeFakeDb(join(home, "daily.db"), "top-level-marker");
    // Per-vault DBs with yaml config.
    const vaultsDir = join(home, "vaults");
    makeFakeVault(vaultsDir, "default", "default-marker");
    makeFakeVault(vaultsDir, "work", "work-marker");
    // Global config.yaml.
    writeFileSync(join(home, "config.yaml"), "port: 1940\n");

    const stage = mkdtempSync(join(tmpdir(), "stage-"));
    try {
      const { stagingDir, contents } = await stageSnapshot({
        configDir: home,
        vaultsDir,
        stagingDir: stage,
      });
      expect(stagingDir).toBe(stage);

      // DB snapshots are at expected paths
      expect(contents.dbSnapshots).toContain("config-daily.db");
      expect(contents.dbSnapshots).toContain(join("vaults", "default", "vault.db"));
      expect(contents.dbSnapshots).toContain(join("vaults", "work", "vault.db"));

      // Config files are all there
      expect(contents.configFiles).toContain("config.yaml");
      expect(contents.configFiles).toContain(join("vaults", "default", "vault.yaml"));
      expect(contents.configFiles).toContain(join("vaults", "work", "vault.yaml"));

      // Snapshot preserves DB contents — open a snapshot and verify the
      // marker row round-tripped (proves VACUUM INTO actually ran, not
      // just a zero-byte file).
      const defaultSnap = new Database(join(stage, "vaults", "default", "vault.db"), {
        readonly: true,
      });
      const row = defaultSnap.query("SELECT v FROM marker").get() as { v: string };
      expect(row.v).toBe("default-marker");
      defaultSnap.close();
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  test("empty parachute home: no DBs, no configs, no crash", async () => {
    const stage = mkdtempSync(join(tmpdir(), "stage-empty-"));
    try {
      const { contents } = await stageSnapshot({
        configDir: home,
        vaultsDir: join(home, "vaults"),
        stagingDir: stage,
      });
      expect(contents.dbSnapshots).toEqual([]);
      expect(contents.configFiles).toEqual([]);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// assembleTarball
// ---------------------------------------------------------------------------

describe("backup — assembleTarball", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "backup-tar-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("produces a readable .tar.gz containing the staging contents", async () => {
    const stage = mkdtempSync(join(tmpdir(), "stage-tar-"));
    try {
      writeFileSync(join(stage, "hello.txt"), "hi");
      mkdirSync(join(stage, "subdir"), { recursive: true });
      writeFileSync(join(stage, "subdir", "nested.txt"), "nested");

      const tarball = join(dir, "out.tar.gz");
      await assembleTarball(stage, tarball);

      expect(existsSync(tarball)).toBe(true);
      const extracted = await untar(tarball);
      try {
        expect(readFileSync(join(extracted, "hello.txt"), "utf-8")).toBe("hi");
        expect(readFileSync(join(extracted, "subdir", "nested.txt"), "utf-8")).toBe("nested");
      } finally {
        rmSync(extracted, { recursive: true, force: true });
      }
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });

  test("produces a valid empty tarball when staging dir is empty", async () => {
    const stage = mkdtempSync(join(tmpdir(), "stage-empty-tar-"));
    try {
      const tarball = join(dir, "empty.tar.gz");
      await assembleTarball(stage, tarball);
      expect(existsSync(tarball)).toBe(true);
      // tar still extracts cleanly — just produces an empty dir.
      const extracted = await untar(tarball);
      try {
        expect(readdirSync(extracted).length).toBe(0);
      } finally {
        rmSync(extracted, { recursive: true, force: true });
      }
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// runBackup — end-to-end
// ---------------------------------------------------------------------------

describe("backup — runBackup end-to-end", () => {
  let home: string;
  let destDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "backup-e2e-"));
    destDir = mkdtempSync(join(tmpdir(), "backup-dest-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(destDir, { recursive: true, force: true });
  });

  test("writes a tarball with DB snapshots + configs to a local destination", async () => {
    // Populate: one top-level DB, one vault, global config.
    makeFakeDb(join(home, "daily.db"), "daily-marker");
    const vaultsDir = join(home, "vaults");
    makeFakeVault(vaultsDir, "default", "default-marker");
    writeFileSync(join(home, "config.yaml"), "port: 1940\n");

    const cfg: BackupConfig = {
      schedule: "manual",
      retention: { daily: 7, weekly: 4, monthly: 12, yearly: null },
      destinations: [{ kind: "local", path: destDir }],
    };

    const now = "2026-04-17T08:30:00.000Z";
    const result = await runBackup({
      configDir: home,
      vaultsDir,
      backup: cfg,
      now,
    });

    // Tarball landed at the destination with the expected filename.
    const expectedName = backupFilename(now);
    expect(result.destinations.length).toBe(1);
    expect(result.destinations[0].writtenPath).toBe(join(destDir, expectedName));
    expect(existsSync(join(destDir, expectedName))).toBe(true);

    // Tarball contents include the vault DB + yaml + top-level DB + config.
    const extracted = await untar(join(destDir, expectedName));
    try {
      expect(existsSync(join(extracted, "config.yaml"))).toBe(true);
      expect(existsSync(join(extracted, "config-daily.db"))).toBe(true);
      expect(existsSync(join(extracted, "vaults", "default", "vault.db"))).toBe(true);
      expect(existsSync(join(extracted, "vaults", "default", "vault.yaml"))).toBe(true);

      // Verify the snapshotted DB is readable and contains the marker row.
      const snap = new Database(join(extracted, "vaults", "default", "vault.db"), {
        readonly: true,
      });
      const row = snap.query("SELECT v FROM marker").get() as { v: string };
      expect(row.v).toBe("default-marker");
      snap.close();
    } finally {
      rmSync(extracted, { recursive: true, force: true });
    }

    // runBackup wrote a last-backup metadata file for `status`.
    const last = readLastBackup(home);
    expect(last).not.toBeNull();
    expect(last!.timestamp).toBe(now);
    expect(last!.destinations[0].path).toBe(join(destDir, expectedName));
  });

  test("retention pruning runs end-to-end: daily=3 leaves 3 most recent", async () => {
    makeFakeDb(join(home, "daily.db"), "m");
    const cfg: BackupConfig = {
      schedule: "manual",
      // Pure daily tier so this test stays focused on pipeline integration
      // rather than tier bucketing (unit-tested above).
      retention: { daily: 3, weekly: 0, monthly: 0, yearly: 0 },
      destinations: [{ kind: "local", path: destDir }],
    };

    // Simulate 5 runs with monotonically increasing timestamps.
    for (let i = 1; i <= 5; i++) {
      const now = `2026-04-${String(i).padStart(2, "0")}T08:30:00.000Z`;
      await runBackup({
        configDir: home,
        vaultsDir: join(home, "vaults"),
        backup: cfg,
        now,
      });
    }

    // Only the 3 most recent remain.
    const survivors = readdirSync(destDir).filter((n) => n.startsWith("parachute-backup-")).sort();
    expect(survivors.length).toBe(3);
    // The earliest (Apr 1, Apr 2) are gone; Apr 3/4/5 are kept.
    expect(survivors[0]).toMatch(/2026-04-03T/);
    expect(survivors[2]).toMatch(/2026-04-05T/);
  });

  test("per-destination failure doesn't abort other destinations", async () => {
    makeFakeDb(join(home, "daily.db"), "m");
    // Use an unwritable path alongside a working one. `/` is a classic
    // unwritable-root target that mkdirSync(recursive: true) on a normal
    // user account will reject with EACCES.
    const cfg: BackupConfig = {
      schedule: "manual",
      retention: { daily: 7, weekly: 4, monthly: 12, yearly: null },
      destinations: [
        { kind: "local", path: "/this/path/should/definitely/not/exist/and/be/unwritable" },
        { kind: "local", path: destDir },
      ],
    };
    const result = await runBackup({
      configDir: home,
      vaultsDir: join(home, "vaults"),
      backup: cfg,
      now: "2026-04-17T08:30:00.000Z",
    });

    expect(result.destinations.length).toBe(2);
    // Either the mkdirSync throws (expected) or it somehow succeeds. Assert
    // only on the second destination's success — that's the contract:
    // one bad destination must not poison the other.
    const good = result.destinations[1];
    expect(good.error).toBeUndefined();
    expect(good.writtenPath).toBe(join(destDir, backupFilename("2026-04-17T08:30:00.000Z")));
  });
});

// ---------------------------------------------------------------------------
// checkDestinationWritable
// ---------------------------------------------------------------------------

describe("backup — checkDestinationWritable", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "dest-writable-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("writable path: passes + creates missing directory", () => {
    const sub = join(dir, "nested", "dest");
    const res = checkDestinationWritable({ kind: "local", path: sub });
    expect(res.ok).toBe(true);
    expect(res.path).toBe(sub);
    expect(existsSync(sub)).toBe(true);
  });

  test("unwritable path: fails with error detail", () => {
    const res = checkDestinationWritable({
      kind: "local",
      path: "/nonexistent/and/root-only/destination",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// CLI integration — `parachute vault backup` + `backup status`
// ---------------------------------------------------------------------------

describe("CLI — vault backup", () => {
  const CLI = resolve(import.meta.dir, "cli.ts");

  function runCli(
    args: string[],
    parachuteHome: string,
  ): { exitCode: number; stdout: string; stderr: string } {
    const proc = Bun.spawnSync({
      cmd: ["bun", CLI, ...args],
      env: { ...process.env, PARACHUTE_HOME: parachuteHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: proc.exitCode ?? -1,
      stdout: new TextDecoder().decode(proc.stdout),
      stderr: new TextDecoder().decode(proc.stderr),
    };
  }

  let home: string;
  let destDir: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cli-backup-"));
    destDir = mkdtempSync(join(tmpdir(), "cli-backup-dest-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(destDir, { recursive: true, force: true });
  });

  test("exits non-zero with a clear message when no destinations are configured", () => {
    writeFileSync(join(home, "config.yaml"), "port: 1940\n");
    const res = runCli(["backup"], home);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toMatch(/No backup destinations configured/);
  });

  test("`vault backup` writes a tarball when a local destination is configured", async () => {
    // Populate a minimal vault + config with a local destination.
    writeFileSync(
      join(home, "config.yaml"),
      [
        "port: 1940",
        "default_vault: default",
        "backup:",
        "  schedule: manual",
        "  retention:",
        "    daily: 7",
        "    weekly: 4",
        "    monthly: 12",
        "    yearly: null",
        "  destinations:",
        "    - kind: local",
        `      path: ${destDir}`,
      ].join("\n") + "\n",
    );
    // A minimal vault so stageSnapshot has a DB to snapshot.
    makeFakeVault(join(home, "vaults"), "default", "cli-marker");

    const res = runCli(["backup"], home);
    expect(res.exitCode, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/Running backup/);
    expect(res.stdout).toMatch(/local →/);

    const tarballs = readdirSync(destDir).filter((n) => n.startsWith("parachute-backup-"));
    expect(tarballs.length).toBe(1);

    // Unpack and verify the vault DB + vault.yaml are in there.
    const extracted = await untar(join(destDir, tarballs[0]));
    try {
      expect(existsSync(join(extracted, "vaults", "default", "vault.db"))).toBe(true);
      expect(existsSync(join(extracted, "vaults", "default", "vault.yaml"))).toBe(true);
      expect(existsSync(join(extracted, "config.yaml"))).toBe(true);
    } finally {
      rmSync(extracted, { recursive: true, force: true });
    }
  });

  test("`vault backup status` prints schedule / destinations / last run", () => {
    writeFileSync(
      join(home, "config.yaml"),
      [
        "port: 1940",
        "backup:",
        "  schedule: daily",
        "  retention:",
        "    daily: 7",
        "    weekly: 4",
        "    monthly: 12",
        "    yearly: null",
        "  destinations:",
        "    - kind: local",
        `      path: ${destDir}`,
      ].join("\n") + "\n",
    );
    const res = runCli(["backup", "status"], home);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/Schedule:\s+daily/);
    // Tiered retention line: "7 daily / 4 weekly / 12 monthly / ∞ yearly"
    expect(res.stdout).toMatch(/Retention:\s+7 daily \/ 4 weekly \/ 12 monthly \/ ∞ yearly/);
    expect(res.stdout).toMatch(new RegExp(`local:\\s+${destDir.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}`));
    // No backup has been run yet — assert on the "never" line.
    expect(res.stdout).toMatch(/Last run:\s+\(never\)/);
  });
});
