/**
 * Integration tests for `parachute-vault add-pack <pack> [--vault <name>]`.
 *
 * Spawns the CLI in a temp `PARACHUTE_HOME` (same harness shape as
 * vault-create.test.ts). Covers: listing on no-arg / unknown pack, applying
 * `surface-starter` onto a default-seeded vault, idempotent re-runs, the
 * missing-vault error, and `--vault` targeting.
 *
 * No in-test `Bun.serve` is involved, so `Bun.spawnSync` is fine here (see
 * CLAUDE.md "Subprocess tests + Bun.serve").
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { resolve } from "path";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = resolve(import.meta.dir, "cli.ts");

function runCli(
  args: string[],
  env: Record<string, string>,
): { exitCode: number; stdout: string; stderr: string } {
  // Hermetic: don't inherit the dev/CI box's PARACHUTE_HUB_ORIGIN (see
  // vault-create.test.ts for the rationale).
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  delete baseEnv.PARACHUTE_HUB_ORIGIN;
  const proc = Bun.spawnSync({
    cmd: ["bun", CLI, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...baseEnv, ...env },
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

/** Read all note paths from a vault's SQLite DB inside the temp home. */
function readNotePaths(home: string, name: string): (string | null)[] {
  const db = new Database(join(home, "vault", "data", name, "vault.db"), {
    readonly: true,
  });
  try {
    return (db.query("SELECT path FROM notes").all() as { path: string | null }[]).map(
      (r) => r.path,
    );
  } finally {
    db.close();
  }
}

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "add-pack-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("add-pack — listing + errors", () => {
  test("no arguments → usage + the three packs, exit 1", () => {
    const { exitCode, stderr } = runCli(["add-pack"], { PARACHUTE_HOME: home });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Usage: parachute-vault add-pack");
    expect(stderr).toContain("Available packs:");
    expect(stderr).toContain("welcome");
    expect(stderr).toContain("getting-started");
    expect(stderr).toContain("surface-starter");
  });

  test("unknown pack → error + listing, exit 1", () => {
    const { exitCode, stderr } = runCli(["add-pack", "does-not-exist"], {
      PARACHUTE_HOME: home,
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Unknown pack: "does-not-exist"');
    expect(stderr).toContain("Available packs:");
  });

  test("missing vault → actionable error, exit 1", () => {
    const { exitCode, stderr } = runCli(
      ["add-pack", "surface-starter", "--vault", "ghost"],
      { PARACHUTE_HOME: home },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Vault "ghost" not found');
    expect(stderr).toContain("parachute-vault create ghost");
  });
});

describe("add-pack surface-starter", () => {
  test("applies onto a default-seeded vault and reports what was added", () => {
    expect(runCli(["create", "packed", "--json"], { PARACHUTE_HOME: home }).exitCode).toBe(0);
    // Default seed does NOT include Surface Starter.
    expect(readNotePaths(home, "packed")).not.toContain("Surface Starter");

    const { exitCode, stdout } = runCli(
      ["add-pack", "surface-starter", "--vault", "packed"],
      { PARACHUTE_HOME: home },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Pack "surface-starter" applied to vault "packed"');
    expect(stdout).toContain("+ note  Surface Starter");
    expect(readNotePaths(home, "packed")).toContain("Surface Starter");
  });

  test("idempotent: a re-run skips (exit 0) and doesn't duplicate", () => {
    runCli(["create", "packed", "--json"], { PARACHUTE_HOME: home });
    runCli(["add-pack", "surface-starter", "--vault", "packed"], { PARACHUTE_HOME: home });

    const { exitCode, stdout } = runCli(
      ["add-pack", "surface-starter", "--vault", "packed"],
      { PARACHUTE_HOME: home },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("= note  Surface Starter (already exists — left untouched)");
    expect(stdout).not.toContain("+ note");

    const paths = readNotePaths(home, "packed");
    expect(paths.filter((p) => p === "Surface Starter")).toHaveLength(1);
  });

  test("re-applying a default pack is a clean no-op-style run (welcome on a fresh vault)", () => {
    runCli(["create", "packed", "--json"], { PARACHUTE_HOME: home });
    const { exitCode, stdout } = runCli(
      ["add-pack", "welcome", "--vault", "packed"],
      { PARACHUTE_HOME: home },
    );
    expect(exitCode).toBe(0);
    // Notes were already default-seeded → all skipped; tags re-upsert.
    expect(stdout).not.toContain("+ note");
    expect(stdout).toContain("= note  Welcome to your vault 🪂 (already exists — left untouched)");
    expect(stdout).toContain("~ tag   capture (upserted)");
  });
});

describe("add-pack — tag description preservation on re-apply (Aaron-ratified 2026-07-17)", () => {
  test("a hand-edited description survives a re-apply and is reported 'kept', not 'upserted'", () => {
    expect(runCli(["create", "packed", "--json"], { PARACHUTE_HOME: home }).exitCode).toBe(0);

    // Simulate an operator/AI hand-editing the capture tag's constitution.
    const dbPath = join(home, "vault", "data", "packed", "vault.db");
    const editedDescription = "Our house rules for capture — not the default text.";
    const writeDb = new Database(dbPath);
    writeDb.query("UPDATE tags SET description = ? WHERE name = ?").run(
      editedDescription,
      "capture",
    );
    writeDb.close();

    const { exitCode, stdout } = runCli(
      ["add-pack", "welcome", "--vault", "packed"],
      { PARACHUTE_HOME: home },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("~ tag   capture (kept user description)");
    // guide wasn't edited, so it still reports the old vocabulary.
    expect(stdout).toContain("~ tag   guide (upserted)");

    const readDb = new Database(dbPath, { readonly: true });
    const row = readDb
      .query("SELECT description FROM tags WHERE name = ?")
      .get("capture") as { description: string };
    readDb.close();
    expect(row.description).toBe(editedDescription);
  });
});
