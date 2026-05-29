/**
 * Tests for the surviving token-store surface (vault#282 Stage 2).
 *
 * Vault no longer mints (`generateToken`/`createToken`) or validates
 * (`resolveToken`) opaque pvt_* tokens — it's a pure hub resource-server. What
 * remains in token-store.ts is the vestigial-row cleanup surface
 * (`listTokens` / `revokeToken` / `findTokensReferencingTag`) and the legacy
 * YAML-import landing zone (`migrateVaultKeys`, raw INSERT). These tests seed
 * rows the way the surviving code does (migrateVaultKeys + raw INSERT) rather
 * than via the removed mint path.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../core/src/schema.ts";
import { hashKey } from "./config.ts";
import {
  listTokens,
  revokeToken,
  findTokensReferencingTag,
  migrateVaultKeys,
} from "./token-store.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
});

afterEach(() => {
  db.close();
});

/** Seed a row the way migrateVaultKeys does — raw INSERT, no mint path. */
function seedRow(
  label: string,
  opts: { permission?: string; vault_name?: string | null; scoped_tags?: string[] | null } = {},
): string {
  const hash = hashKey(`legacy-${label}-${Math.random()}`);
  db.prepare(
    `INSERT INTO tokens (token_hash, label, permission, scoped_tags, created_at, vault_name)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    hash,
    label,
    opts.permission ?? "full",
    opts.scoped_tags ? JSON.stringify(opts.scoped_tags) : null,
    new Date().toISOString(),
    opts.vault_name ?? null,
  );
  return `t_${hash.slice(7, 19)}`;
}

describe("listTokens", () => {
  test("lists all rows with display IDs and normalized permission", () => {
    seedRow("first", { permission: "full" });
    seedRow("second", { permission: "read" });

    const tokens = listTokens(db);
    expect(tokens.length).toBe(2);
    expect(tokens.some((t) => t.label === "first")).toBe(true);
    expect(tokens.some((t) => t.label === "second")).toBe(true);
    expect(tokens.every((t) => t.id.startsWith("t_"))).toBe(true);
  });

  test("legacy admin/write permission normalizes to full", () => {
    seedRow("legacy-admin", { permission: "admin" });
    seedRow("legacy-write", { permission: "write" });

    const tokens = listTokens(db);
    expect(tokens.every((t) => t.permission === "full")).toBe(true);
  });
});

describe("per-vault filter (v16, vestigial)", () => {
  test("vaultName filter returns matching + legacy NULL rows", () => {
    seedRow("boulder", { vault_name: "boulder" });
    seedRow("default-vault", { vault_name: "default" });
    seedRow("server-wide", { vault_name: null });

    const boulderTokens = listTokens(db, { vaultName: "boulder" });
    expect(boulderTokens.map((t) => t.label).sort()).toEqual(["boulder", "server-wide"]);

    const defaultTokens = listTokens(db, { vaultName: "default" });
    expect(defaultTokens.map((t) => t.label).sort()).toEqual(["default-vault", "server-wide"]);

    // No filter → everything.
    expect(listTokens(db).length).toBe(3);
  });
});

describe("revokeToken", () => {
  test("revokes by display ID", () => {
    const id = seedRow("to-revoke");
    expect(listTokens(db).length).toBe(1);

    expect(revokeToken(db, id)).toBe(true);
    expect(listTokens(db).length).toBe(0);
  });

  test("returns false for a non-existent id", () => {
    expect(revokeToken(db, "t_doesnotexist")).toBe(false);
  });
});

describe("findTokensReferencingTag", () => {
  test("matches rows whose scoped_tags allowlist names the root tag", () => {
    seedRow("health-scoped", { scoped_tags: ["health"] });
    seedRow("work-scoped", { scoped_tags: ["work"] });
    seedRow("unscoped");

    const matches = findTokensReferencingTag(db, "health");
    expect(matches.map((m) => m.label)).toEqual(["health-scoped"]);
  });
});

describe("migrateVaultKeys — legacy YAML import landing zone", () => {
  test("imports per-vault + global YAML keys via raw INSERT (idempotent)", () => {
    const vaultKeys = [
      { key_hash: hashKey("yaml-vault-key"), label: "vault-key", scope: "read", created_at: "2026-01-01T00:00:00Z" },
    ];
    const globalKeys = [
      { key_hash: hashKey("yaml-global-key"), label: "global-key", created_at: "2026-01-01T00:00:00Z" },
    ];

    const migrated = migrateVaultKeys(db, vaultKeys, globalKeys);
    expect(migrated).toBe(2);

    const tokens = listTokens(db);
    expect(tokens.map((t) => t.label).sort()).toEqual(["global-key", "vault-key"]);
    // Per-vault read key keeps read permission; global key becomes full.
    expect(tokens.find((t) => t.label === "vault-key")?.permission).toBe("read");
    expect(tokens.find((t) => t.label === "global-key")?.permission).toBe("full");

    // Re-running skips already-imported hashes (idempotent).
    expect(migrateVaultKeys(db, vaultKeys, globalKeys)).toBe(0);
    expect(listTokens(db).length).toBe(2);
  });
});
