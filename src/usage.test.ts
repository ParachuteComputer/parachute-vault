/**
 * Unit tests for the usage helpers (src/usage.ts).
 *
 * Everything here runs against the injectable `UsageFs` seam — no real disk
 * I/O — so we can (a) synthesize trees with symlinks/missing dirs and (b)
 * count how many times the dir-walk actually runs, which is how we prove the
 * TTL cache skips the walk on a hit.
 *
 * The path helpers (`vaultDir`, `assetsDir`, mirror resolution) DO read
 * `process.env.PARACHUTE_HOME`; we point it at a tmp dir so the resolved paths
 * are deterministic, but no files are written there — the fake fs intercepts
 * every stat/readdir.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { join } from "path";
import { tmpdir } from "os";

const testDir = join(
  tmpdir(),
  `vault-usage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);
process.env.PARACHUTE_HOME = testDir;

const {
  dbBytes,
  dirSize,
  UsageCache,
  buildUsageReport,
} = await import("./usage.ts");
const { vaultDir } = await import("./config.ts");
const { assetsDir } = await import("./routes.ts");

import type { UsageFs } from "./usage.ts";
import type { VaultStats } from "../core/src/types.ts";
import type { Dirent } from "fs";

// ---------------------------------------------------------------------------
// Fake filesystem builder
//
// A node is either a file (number = size in bytes), a dir (object mapping
// names → nodes), or a symlink (special marker, never followed).
// ---------------------------------------------------------------------------

type FileNode = { kind: "file"; size: number };
type DirNode = { kind: "dir"; children: Record<string, FsNode> };
type LinkNode = { kind: "link" };
type FsNode = FileNode | DirNode | LinkNode;

const file = (size: number): FileNode => ({ kind: "file", size });
const dir = (children: Record<string, FsNode>): DirNode => ({ kind: "dir", children });
const link = (): LinkNode => ({ kind: "link" });

function makeDirent(name: string, node: FsNode): Dirent {
  return {
    name,
    isFile: () => node.kind === "file",
    isDirectory: () => node.kind === "dir",
    isSymbolicLink: () => node.kind === "link",
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  } as unknown as Dirent;
}

/**
 * Build a fake `UsageFs` rooted at a set of absolute paths. `roots` maps an
 * absolute path → the node that lives there. Lookups resolve a requested
 * absolute path by walking from the matching root prefix. `readCount` exposes
 * how many `readDir` calls happened (for cache assertions).
 */
function makeFakeFs(roots: Record<string, FsNode>): UsageFs & { readCount: number } {
  function resolve(path: string): FsNode | undefined {
    // Exact root match first.
    if (roots[path]) return roots[path];
    // Otherwise find the root that's a prefix and descend by segment.
    for (const [rootPath, rootNode] of Object.entries(roots)) {
      if (path === rootPath) return rootNode;
      if (path.startsWith(rootPath + "/")) {
        const rest = path.slice(rootPath.length + 1).split("/");
        let cur: FsNode | undefined = rootNode;
        for (const seg of rest) {
          if (!cur || cur.kind !== "dir") return undefined;
          cur = cur.children[seg];
        }
        return cur;
      }
    }
    return undefined;
  }

  const fs = {
    readCount: 0,
    statFile(path: string) {
      const node = resolve(path);
      if (!node) throw new Error(`ENOENT: ${path}`);
      return {
        size: node.kind === "file" ? node.size : 0,
        isDirectory: () => node.kind === "dir",
        isSymbolicLink: () => node.kind === "link",
      };
    },
    readDir(path: string): Dirent[] {
      fs.readCount++;
      const node = resolve(path);
      if (!node || node.kind !== "dir") throw new Error(`ENOTDIR: ${path}`);
      return Object.entries(node.children).map(([name, child]) => makeDirent(name, child));
    },
  };
  return fs;
}

// ---------------------------------------------------------------------------
// dbBytes — sums the WAL trio (vault.db + -wal + -shm)
// ---------------------------------------------------------------------------

describe("dbBytes (WAL-aware DB file sizing)", () => {
  const VAULT = "journal";
  const dbBase = join(vaultDir(VAULT), "vault.db");

  test("sums vault.db + vault.db-wal + vault.db-shm", () => {
    const fs = makeFakeFs({
      [dbBase]: file(4096),
      [`${dbBase}-wal`]: file(800),
      [`${dbBase}-shm`]: file(32),
    });
    expect(dbBytes(VAULT, fs)).toBe(4096 + 800 + 32);
  });

  test("tolerates missing -wal/-shm (checkpointed at rest)", () => {
    const fs = makeFakeFs({ [dbBase]: file(4096) });
    // -wal and -shm absent → contribute 0, not an error.
    expect(dbBytes(VAULT, fs)).toBe(4096);
  });

  test("missing DB entirely → 0", () => {
    const fs = makeFakeFs({});
    expect(dbBytes(VAULT, fs)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// dirSize — recursive, missing-dir tolerant, symlink-safe
// ---------------------------------------------------------------------------

describe("dirSize (recursive directory byte sum)", () => {
  const ROOT = "/fake/assets";

  test("sums files across nested directories", () => {
    const fs = makeFakeFs({
      [ROOT]: dir({
        "a.png": file(100),
        "2026-06-03": dir({
          "x.jpg": file(250),
          nested: dir({ "y.pdf": file(50) }),
        }),
      }),
    });
    expect(dirSize(ROOT, fs)).toBe(100 + 250 + 50);
  });

  test("empty directory → 0", () => {
    const fs = makeFakeFs({ [ROOT]: dir({}) });
    expect(dirSize(ROOT, fs)).toBe(0);
  });

  test("missing directory → 0 (no throw)", () => {
    const fs = makeFakeFs({});
    expect(dirSize(ROOT, fs)).toBe(0);
  });

  test("does NOT follow symlinks (file or dir)", () => {
    const fs = makeFakeFs({
      [ROOT]: dir({
        "real.png": file(100),
        "linked-file": link(), // would be a file if followed
        "linked-dir": link(), // would be a dir if followed
      }),
      // A target tree the symlink "points at" — if dirSize followed the link
      // it would walk this and add 9999. It must NOT.
      [join(ROOT, "linked-dir")]: dir({ "huge.bin": file(9999) }),
    });
    expect(dirSize(ROOT, fs)).toBe(100);
  });

  test("symlink loop does not hang (link is skipped, never descended)", () => {
    // The classic infinite-walk trap: a dir containing a symlink to itself.
    // Because we skip symlinks outright, this terminates immediately.
    const fs = makeFakeFs({
      [ROOT]: dir({
        "f.png": file(10),
        loop: link(),
      }),
    });
    expect(dirSize(ROOT, fs)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// UsageCache — 60s TTL, fresh bypass, invalidation, call-count proof
// ---------------------------------------------------------------------------

describe("UsageCache (dir-walk TTL cache)", () => {
  const VAULT = "journal";
  const assets = assetsDir(VAULT);

  function fsWith(assetsBytes: number) {
    return makeFakeFs({ [assets]: dir({ "a.png": file(assetsBytes) }) });
  }

  test("first read walks (cached:false); second read within TTL is cached (no walk)", () => {
    const fs = fsWith(500);
    let clock = 1_000;
    const cache = new UsageCache(fs, () => clock, 60_000);

    const first = cache.get(VAULT);
    expect(first.cached).toBe(false);
    expect(first.result.assets).toBe(500);
    const afterFirst = fs.readCount;
    expect(afterFirst).toBeGreaterThan(0);

    clock += 30_000; // within the 60s TTL
    const second = cache.get(VAULT);
    expect(second.cached).toBe(true);
    expect(second.result.assets).toBe(500);
    // The cache MUST NOT have re-walked — call count is unchanged.
    expect(fs.readCount).toBe(afterFirst);
  });

  test("entry expires after TTL → re-walks (cached:false)", () => {
    const fs = fsWith(500);
    let clock = 1_000;
    const cache = new UsageCache(fs, () => clock, 60_000);

    cache.get(VAULT); // prime
    const afterPrime = fs.readCount;

    clock += 60_001; // just past TTL
    const stale = cache.get(VAULT);
    expect(stale.cached).toBe(false);
    expect(fs.readCount).toBeGreaterThan(afterPrime);
  });

  test("fresh:true bypasses a valid cache entry and re-walks", () => {
    const fs = fsWith(500);
    let clock = 1_000;
    const cache = new UsageCache(fs, () => clock, 60_000);

    cache.get(VAULT); // prime
    const afterPrime = fs.readCount;

    clock += 1_000; // well within TTL — a normal read would be cached
    const forced = cache.get(VAULT, { fresh: true });
    expect(forced.cached).toBe(false);
    expect(fs.readCount).toBeGreaterThan(afterPrime);
  });

  test("invalidate() forces the next read to re-walk", () => {
    const fs = fsWith(500);
    let clock = 1_000;
    const cache = new UsageCache(fs, () => clock, 60_000);

    cache.get(VAULT); // prime
    const afterPrime = fs.readCount;

    cache.invalidate(VAULT);
    clock += 1_000; // within TTL, but the entry is gone
    const after = cache.get(VAULT);
    expect(after.cached).toBe(false);
    expect(fs.readCount).toBeGreaterThan(afterPrime);
  });

  test("no mirror configured → mirror:null (omitted from report)", () => {
    // No mirror-config.yaml written for this vault → resolveVaultMirrorDir
    // returns null → mirror is null.
    const fs = fsWith(500);
    const cache = new UsageCache(fs, () => 1_000, 60_000);
    const { result } = cache.get(VAULT);
    expect(result.mirror).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildUsageReport — shape + total math + mirror handling
// ---------------------------------------------------------------------------

describe("buildUsageReport", () => {
  const VAULT = "journal";
  const dbBase = join(vaultDir(VAULT), "vault.db");
  const assets = assetsDir(VAULT);

  function makeStats(overrides: Partial<VaultStats> = {}): VaultStats {
    return {
      totalNotes: 12,
      earliestNote: null,
      latestNote: null,
      notesByMonth: [],
      topTags: [],
      tagCount: 4,
      attachmentCount: 3,
      linkCount: 7,
      contentBytes: 1234,
      ...overrides,
    };
  }

  test("full shape: counts, bytes, total = db + assets, mirror omitted when none", () => {
    const fs = makeFakeFs({
      [dbBase]: file(4096),
      [`${dbBase}-wal`]: file(900),
      [assets]: dir({ "a.png": file(2000) }),
    });
    const cache = new UsageCache(fs, () => 1_000, 60_000);
    const report = buildUsageReport(VAULT, makeStats(), { cache, fs, now: () => 1_700_000_000_000 });

    expect(report.counts).toEqual({ notes: 12, attachments: 3, links: 7, tags: 4 });
    expect(report.bytes.content).toBe(1234);
    expect(report.bytes.db).toBe(4096 + 900);
    expect(report.bytes.assets).toBe(2000);
    // total = db + assets only. NOT content (logical, already inside db) and
    // NOT mirror (projection).
    expect(report.bytes.total).toBe(4096 + 900 + 2000);
    expect(report.bytes).not.toHaveProperty("mirror");
    expect(report.cached).toBe(false);
    expect(report.computedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  test("mirror is a separate line item, NOT added to total", () => {
    // Configure an internal mirror so resolveVaultMirrorDir returns a dir.
    const { writeMirrorConfigForVault, defaultMirrorConfig } = require("./mirror-config.ts");
    writeMirrorConfigForVault(VAULT, { ...defaultMirrorConfig(), location: "internal", enabled: true });
    const mirrorDir = join(vaultDir(VAULT), "mirror");

    const fs = makeFakeFs({
      [dbBase]: file(1000),
      [assets]: dir({ "a.png": file(500) }),
      [mirrorDir]: dir({ "note.md": file(8000) }),
    });
    const cache = new UsageCache(fs, () => 1_000, 60_000);
    const report = buildUsageReport(VAULT, makeStats(), { cache, fs });

    expect(report.bytes.mirror).toBe(8000);
    // total stays db + assets — the 8000-byte mirror does not inflate it.
    expect(report.bytes.total).toBe(1000 + 500);
  });

  test("cached flag reflects a cache hit", () => {
    const fs = makeFakeFs({
      [dbBase]: file(100),
      [assets]: dir({}),
    });
    let clock = 1_000;
    const cache = new UsageCache(fs, () => clock, 60_000);

    const first = buildUsageReport(VAULT, makeStats(), { cache, fs });
    expect(first.cached).toBe(false);

    clock += 5_000;
    const second = buildUsageReport(VAULT, makeStats(), { cache, fs });
    expect(second.cached).toBe(true);
  });
});
