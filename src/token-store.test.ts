/**
 * Tests for the token store — scoped tokens with permissions.
 * Tokens now live inside each vault's SQLite database (schema v7).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { initSchema } from "../core/src/schema.ts";
import {
  generateToken,
  createToken,
  resolveToken,
  listTokens,
  revokeToken,
} from "./token-store.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  initSchema(db);
});

afterEach(() => {
  db.close();
});

describe("token CRUD", () => {
  test("create and resolve a token", () => {
    const { fullToken } = generateToken();
    createToken(db, fullToken, { label: "test-token", permission: "admin" });

    const resolved = resolveToken(db, fullToken);
    expect(resolved).not.toBeNull();
    expect(resolved!.permission).toBe("admin");
    expect(resolved!.scope_tag).toBeNull();
    expect(resolved!.scope_path_prefix).toBeNull();
  });

  test("token with tag scope", () => {
    const { fullToken } = generateToken();
    createToken(db, fullToken, {
      label: "publish-reader",
      permission: "read",
      scope_tag: "publish",
    });

    const resolved = resolveToken(db, fullToken);
    expect(resolved!.permission).toBe("read");
    expect(resolved!.scope_tag).toBe("publish");
  });

  test("token with path prefix scope", () => {
    const { fullToken } = generateToken();
    createToken(db, fullToken, {
      label: "projects-writer",
      permission: "write",
      scope_path_prefix: "Projects/",
    });

    const resolved = resolveToken(db, fullToken);
    expect(resolved!.permission).toBe("write");
    expect(resolved!.scope_path_prefix).toBe("Projects/");
  });

  test("expired token is rejected", () => {
    const { fullToken } = generateToken();
    createToken(db, fullToken, {
      label: "expired",
      permission: "admin",
      expires_at: "2020-01-01T00:00:00.000Z", // in the past
    });

    const resolved = resolveToken(db, fullToken);
    expect(resolved).toBeNull();
  });

  test("non-expired token is accepted", () => {
    const { fullToken } = generateToken();
    const future = new Date(Date.now() + 86400000).toISOString(); // +1 day
    createToken(db, fullToken, {
      label: "valid",
      permission: "read",
      expires_at: future,
    });

    const resolved = resolveToken(db, fullToken);
    expect(resolved).not.toBeNull();
    expect(resolved!.permission).toBe("read");
  });

  test("invalid token returns null", () => {
    const resolved = resolveToken(db, "pvt_does_not_exist");
    expect(resolved).toBeNull();
  });

  test("list tokens shows all tokens", () => {
    const { fullToken: t1 } = generateToken();
    const { fullToken: t2 } = generateToken();
    createToken(db, t1, { label: "first", permission: "admin" });
    createToken(db, t2, { label: "second", permission: "read" });

    const tokens = listTokens(db);
    expect(tokens.length).toBe(2);
    expect(tokens.some((t) => t.label === "first")).toBe(true);
    expect(tokens.some((t) => t.label === "second")).toBe(true);
    // Each token should have a display ID
    expect(tokens.every((t) => t.id.startsWith("t_"))).toBe(true);
  });

  test("revoke token by display ID", () => {
    const { fullToken } = generateToken();
    createToken(db, fullToken, { label: "to-revoke" });

    const tokens = listTokens(db);
    expect(tokens.length).toBe(1);

    const revoked = revokeToken(db, tokens[0].id);
    expect(revoked).toBe(true);

    const after = listTokens(db);
    expect(after.length).toBe(0);

    // Token should no longer resolve
    expect(resolveToken(db, fullToken)).toBeNull();
  });

  test("revoke non-existent token returns false", () => {
    expect(revokeToken(db, "t_doesnotexist")).toBe(false);
  });

  test("resolve updates last_used_at", () => {
    const { fullToken } = generateToken();
    createToken(db, fullToken, { label: "usage-tracking" });

    // Before first use
    const before = listTokens(db);
    expect(before[0].last_used_at).toBeNull();

    // Resolve (which should update last_used_at)
    resolveToken(db, fullToken);

    const after = listTokens(db);
    expect(after[0].last_used_at).not.toBeNull();
  });
});

describe("token generation", () => {
  test("generated tokens have pvt_ prefix", () => {
    const { fullToken, tokenHash } = generateToken();
    expect(fullToken.startsWith("pvt_")).toBe(true);
    expect(tokenHash.startsWith("sha256:")).toBe(true);
  });

  test("generated tokens are unique", () => {
    const t1 = generateToken();
    const t2 = generateToken();
    expect(t1.fullToken).not.toBe(t2.fullToken);
    expect(t1.tokenHash).not.toBe(t2.tokenHash);
  });
});

describe("token with combined scopes", () => {
  test("token with both tag and path prefix scope", () => {
    const { fullToken } = generateToken();
    createToken(db, fullToken, {
      label: "double-scoped",
      permission: "write",
      scope_tag: "publish",
      scope_path_prefix: "Blog/",
    });

    const resolved = resolveToken(db, fullToken);
    expect(resolved!.permission).toBe("write");
    expect(resolved!.scope_tag).toBe("publish");
    expect(resolved!.scope_path_prefix).toBe("Blog/");
  });
});
