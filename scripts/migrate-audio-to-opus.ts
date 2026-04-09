#!/usr/bin/env bun
/**
 * scripts/migrate-audio-to-opus.ts
 *
 * One-shot migration: convert existing WAV / MP3 audio attachments into
 * OGG Opus in-place. Resolves the second half of issue #43 — the first
 * half (new TTS output encoded as Opus) ships in the tts-provider.ts hook
 * change; this script rewrites everything already on disk.
 *
 * What it does
 * ------------
 * For each vault (all vaults by default, or `--vault <name>` for one):
 *   1. Opens the vault SQLite DB.
 *   2. Finds every `attachments` row whose mime_type starts with `audio/`
 *      and whose path ends in .wav or .mp3.
 *   3. Runs ffmpeg on the file on disk to produce a sibling .ogg.
 *   4. Updates the attachment row's `path` and `mime_type` using raw SQL
 *      (NOT via store.updateNote — we don't want to touch updated_at on
 *      the parent note, since this is a pure storage-format migration).
 *   5. Unlinks the original WAV/MP3.
 *
 * Idempotency
 * -----------
 * If a sibling .ogg already exists AND the DB row already points at it,
 * we skip the row entirely. Re-running the script is safe.
 *
 * Dry run
 * -------
 * `--dry-run` reports what would change without touching anything (no
 * ffmpeg, no DB writes, no unlinks).
 *
 * Error handling
 * --------------
 * Per-attachment errors are logged and the script continues with the next
 * attachment. The per-vault summary at the end reports converted / skipped
 * / errors + total bytes saved.
 *
 * Not run automatically
 * ---------------------
 * Aaron invokes this by hand when he's ready:
 *   bun scripts/migrate-audio-to-opus.ts              # all vaults
 *   bun scripts/migrate-audio-to-opus.ts --dry-run
 *   bun scripts/migrate-audio-to-opus.ts --vault default
 */

import { Database } from "bun:sqlite";
import { existsSync, statSync, unlinkSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { encodeOggOpus } from "../src/audio-encoding.ts";
import { readFileSync, writeFileSync } from "fs";

// ---------------------------------------------------------------------------
// Config resolution — keep this script self-contained so it can run against
// any machine with a `~/.parachute/` (or $PARACHUTE_HOME) without pulling in
// server startup side effects.
// ---------------------------------------------------------------------------

// Read PARACHUTE_HOME lazily so tests (and any embedder) can override it
// via process.env after the module has loaded.
function configDir(): string {
  return process.env.PARACHUTE_HOME ?? join(homedir(), ".parachute");
}

function vaultsDir(): string {
  return join(configDir(), "vaults");
}

function vaultDir(name: string): string {
  return join(vaultsDir(), name);
}

function vaultDbPath(name: string): string {
  return join(vaultDir(name), "vault.db");
}

function vaultAssetsDir(name: string): string {
  return process.env.ASSETS_DIR ?? join(vaultDir(name), "assets");
}

function listVaultNames(): string[] {
  const root = vaultsDir();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface Args {
  vault?: string;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--vault") {
      out.vault = argv[i + 1];
      i++;
    } else if (a.startsWith("--vault=")) {
      out.vault = a.slice("--vault=".length);
    }
  }
  return out;
}

function printHelp(): void {
  console.log(
    `Usage: bun scripts/migrate-audio-to-opus.ts [options]

Options:
  --vault <name>    Migrate only the named vault (default: all vaults)
  --dry-run         Report what would change without touching anything
  --help, -h        Show this help

Converts existing audio attachments (.wav / .mp3) into OGG Opus in-place.
Idempotent: safe to re-run. Does not bump updated_at on parent notes.
`,
  );
}

// ---------------------------------------------------------------------------
// Attachment row shape
// ---------------------------------------------------------------------------

interface AttachmentRow {
  id: string;
  note_id: string;
  path: string;
  mime_type: string;
  metadata: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Per-vault migration
// ---------------------------------------------------------------------------

interface VaultSummary {
  vault: string;
  converted: number;
  skipped: number;
  errors: number;
  bytesBefore: number;
  bytesAfter: number;
  dryRunCandidates: number;
}

function shouldMigrate(mime: string, path: string): boolean {
  if (!mime.toLowerCase().startsWith("audio/")) return false;
  const p = path.toLowerCase();
  return p.endsWith(".wav") || p.endsWith(".mp3");
}

function inputMimeFromPath(path: string, stored: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  return stored;
}

async function migrateVault(
  vault: string,
  dryRun: boolean,
): Promise<VaultSummary> {
  const summary: VaultSummary = {
    vault,
    converted: 0,
    skipped: 0,
    errors: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    dryRunCandidates: 0,
  };

  const dbPath = vaultDbPath(vault);
  if (!existsSync(dbPath)) {
    console.error(`[${vault}] vault db not found at ${dbPath}, skipping`);
    return summary;
  }

  const assetsBase = vaultAssetsDir(vault);
  const db = new Database(dbPath);

  // Count the rows up-front so per-row logs can show [N/total] progress.
  // Matches the SELECT below so the denominator is meaningful even when
  // most rows turn out to be already-migrated and get fast-skipped.
  let total = 0;
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS c FROM attachments WHERE mime_type LIKE 'audio/%'",
      )
      .get() as { c: number } | undefined;
    total = row?.c ?? 0;
  } catch {
    total = 0;
  }

  // Running count of rows we've touched in any terminal way (converted,
  // errored, or skipped). Used to prefix per-row logs with [N/total].
  // Only emitted when total > 0 — for empty vaults the prefix is noise.
  let processed = 0;
  const progress = (): string =>
    total > 0 ? `[${processed + 1}/${total}] ` : "";

  // One-shot notice about missing original_size_bytes metadata on fixup
  // rows (see the fixup branch below). We log this at most once per vault
  // so partially-migrated vaults don't spam the summary.
  let warnedUnknownOriginalSize = false;

  // Caveat: the fixup branch (DB stale, .ogg already exists on disk) can
  // only credit bytesBefore from the attachment's metadata
  // (`original_size_bytes`, written by tts-provider.ts). Rows encoded by an
  // earlier pass of this migration script never had that metadata written,
  // so their pre-migration size is unknowable and the "saved X%" summary
  // will undercount on those rows. The summary is cosmetic; the data is
  // correct.

  try {
    const rows = db
      .prepare(
        "SELECT id, note_id, path, mime_type, metadata, created_at FROM attachments WHERE mime_type LIKE 'audio/%'",
      )
      .all() as AttachmentRow[];

    const updateStmt = db.prepare(
      "UPDATE attachments SET path = ?, mime_type = ? WHERE id = ?",
    );

    for (const row of rows) {
      // Already-migrated rows (audio/ogg + .ogg path) count as skipped so
      // re-runs produce a meaningful "nothing to do" summary.
      if (
        row.mime_type.toLowerCase() === "audio/ogg" &&
        row.path.toLowerCase().endsWith(".ogg")
      ) {
        summary.skipped++;
        processed++;
        continue;
      }

      if (!shouldMigrate(row.mime_type, row.path)) {
        processed++;
        continue;
      }

      const absIn = join(assetsBase, row.path);
      // Build the target path: same directory, same stem, .ogg extension.
      const lastDot = row.path.lastIndexOf(".");
      const stem = lastDot === -1 ? row.path : row.path.slice(0, lastDot);
      const relOut = `${stem}.ogg`;
      const absOut = join(assetsBase, relOut);

      // Idempotency: DB row already points to .ogg and file exists.
      if (row.path === relOut && existsSync(absOut)) {
        summary.skipped++;
        processed++;
        continue;
      }

      // If a sibling .ogg already exists AND the DB is stale (still points
      // to the WAV/MP3), fix up the DB row and drop the original source
      // file — don't re-run ffmpeg.
      if (existsSync(absOut) && row.path !== relOut) {
        if (dryRun) {
          console.log(
            `${progress()}[${vault}] DRY-RUN fixup (ogg exists, db stale): ${row.path} -> ${relOut}`,
          );
          summary.dryRunCandidates++;
          processed++;
          continue;
        }
        try {
          updateStmt.run(relOut, "audio/ogg", row.id);
          if (existsSync(absIn) && absIn !== absOut) {
            unlinkSync(absIn);
          }
          summary.converted++;
          let outSize = 0;
          try {
            outSize = statSync(absOut).size;
            summary.bytesAfter += outSize;
          } catch {
            // ignore
          }
          // Credit bytesBefore from the attachment's metadata if the
          // encoding path recorded it. Historically the old in-process
          // encoder wrote `original_size_bytes` alongside each OGG
          // attachment; the narrate-era hook (tts-hook.ts) does NOT —
          // narrate doesn't surface the pre-encode size. So going forward,
          // this field will be absent on all new rows; it only exists on
          // legacy rows from before the narrate swap. For rows without it
          // we log a one-time notice per vault and skip the credit. The
          // summary's "saved X%" will undercount; treat it as a lower bound.
          let originalBytes: number | undefined;
          if (row.metadata) {
            try {
              const meta = JSON.parse(row.metadata) as Record<string, unknown>;
              const v = meta.original_size_bytes;
              if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
                originalBytes = v;
              }
            } catch {
              // malformed metadata JSON — treat as unknown
            }
          }
          if (originalBytes !== undefined) {
            summary.bytesBefore += originalBytes;
          } else if (!warnedUnknownOriginalSize) {
            warnedUnknownOriginalSize = true;
            console.log(
              `[${vault}] note: one or more fixup rows have unknown original size (no original_size_bytes in metadata); summary savings will undercount`,
            );
          }
          console.log(
            `${progress()}[${vault}] fixup ${row.path} -> ${relOut}${
              originalBytes !== undefined
                ? ` (${fmtBytes(originalBytes)} -> ${fmtBytes(outSize)})`
                : ` (${fmtBytes(outSize)}, original size unknown)`
            }`,
          );
        } catch (err) {
          console.error(`[${vault}] fixup failed for ${row.id}:`, err);
          summary.errors++;
        }
        processed++;
        continue;
      }

      if (!existsSync(absIn)) {
        console.error(
          `${progress()}[${vault}] source file missing for attachment ${row.id}: ${absIn} — skipping`,
        );
        summary.errors++;
        processed++;
        continue;
      }

      if (dryRun) {
        let inSize = 0;
        try {
          inSize = statSync(absIn).size;
        } catch {
          // ignore
        }
        summary.bytesBefore += inSize;
        summary.dryRunCandidates++;
        console.log(
          `${progress()}[${vault}] DRY-RUN convert: ${row.path} (${fmtBytes(inSize)}, ${row.mime_type}) -> ${relOut}`,
        );
        processed++;
        continue;
      }

      try {
        const inBytes = readFileSync(absIn);
        const beforeSize = inBytes.byteLength;
        const ogg = await encodeOggOpus(
          Buffer.from(inBytes),
          inputMimeFromPath(row.path, row.mime_type),
        );
        writeFileSync(absOut, ogg);

        // Raw SQL update — deliberately bypasses store.updateNote so we do
        // NOT bump updated_at on the parent note. This is a pure storage
        // format change; the note content hasn't changed. See parachute-
        // vault#44 for the related "hooks shouldn't bump updated_at" work.
        updateStmt.run(relOut, "audio/ogg", row.id);

        if (absIn !== absOut) {
          try {
            unlinkSync(absIn);
          } catch (err) {
            console.error(
              `[${vault}] converted but failed to unlink original ${absIn}:`,
              err,
            );
          }
        }

        summary.converted++;
        summary.bytesBefore += beforeSize;
        summary.bytesAfter += ogg.byteLength;

        console.log(
          `${progress()}[${vault}] converted ${row.path} -> ${relOut} (${fmtBytes(beforeSize)} -> ${fmtBytes(ogg.byteLength)})`,
        );
      } catch (err) {
        console.error(
          `${progress()}[${vault}] error converting attachment ${row.id} (${row.path}):`,
          err,
        );
        summary.errors++;
      }
      processed++;
    }
  } finally {
    db.close();
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtBytes(n: number): string {
  if (n === 0) return "0B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let val = n;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(val < 10 && i > 0 ? 2 : 0)}${units[i]}`;
}

function printSummary(s: VaultSummary, dryRun: boolean): void {
  if (dryRun) {
    console.log(
      `[${s.vault}] DRY-RUN summary: ${s.dryRunCandidates} candidate(s), ${fmtBytes(
        s.bytesBefore,
      )} current total, ${s.errors} errors`,
    );
    return;
  }
  const savedBytes = s.bytesBefore - s.bytesAfter;
  const savedLabel =
    s.bytesBefore > 0
      ? ` (saved ${fmtBytes(savedBytes)}, ${((savedBytes / s.bytesBefore) * 100).toFixed(1)}%)`
      : "";
  console.log(
    `[${s.vault}] done: ${s.converted} converted, ${s.skipped} skipped, ${s.errors} errors, ${fmtBytes(
      s.bytesBefore,
    )} -> ${fmtBytes(s.bytesAfter)}${savedLabel}`,
  );
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function runMigration(argv: string[]): Promise<VaultSummary[]> {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return [];
  }

  const vaults = args.vault ? [args.vault] : listVaultNames();
  if (vaults.length === 0) {
    console.error(`No vaults found under ${vaultsDir()}`);
    return [];
  }

  console.log(
    `Migrating audio attachments to OGG Opus${args.dryRun ? " (DRY RUN)" : ""}`,
  );
  console.log(`Vaults: ${vaults.join(", ")}`);

  const summaries: VaultSummary[] = [];
  for (const v of vaults) {
    try {
      const s = await migrateVault(v, args.dryRun);
      summaries.push(s);
      printSummary(s, args.dryRun);
    } catch (err) {
      console.error(`[${v}] fatal error:`, err);
    }
  }

  return summaries;
}

// Only auto-run when invoked directly (`bun scripts/migrate-audio-to-opus.ts`),
// not when imported from a test.
if (import.meta.main) {
  runMigration(process.argv.slice(2))
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("fatal:", err);
      process.exit(1);
    });
}
