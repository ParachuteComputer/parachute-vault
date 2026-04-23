/**
 * Unit tests for scope primitives — parse, match, inheritance, legacy
 * permission fallback. Integration tests for scope enforcement at the
 * HTTP boundary live in routing.test.ts + vault.test.ts.
 */

import { describe, test, expect } from "bun:test";
import {
  SCOPE_READ,
  SCOPE_WRITE,
  SCOPE_ADMIN,
  parseScopes,
  parseScopeFlags,
  resolveCreateTokenFlags,
  hasScope,
  scopeForMethod,
  legacyPermissionToScopes,
  serializeScopes,
} from "./scopes.ts";

describe("parseScopes", () => {
  test("returns [] for null or empty input", () => {
    expect(parseScopes(null)).toEqual([]);
    expect(parseScopes(undefined)).toEqual([]);
    expect(parseScopes("")).toEqual([]);
    expect(parseScopes("   ")).toEqual([]);
  });

  test("splits on whitespace and trims", () => {
    expect(parseScopes("vault:read vault:write")).toEqual([SCOPE_READ, SCOPE_WRITE]);
    expect(parseScopes("  vault:read   vault:write  ")).toEqual([SCOPE_READ, SCOPE_WRITE]);
    expect(parseScopes("vault:read\tvault:write\nvault:admin")).toEqual([
      SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN,
    ]);
  });

  test("collapses vault:<name>:<verb> synonym to vault:<verb>", () => {
    expect(parseScopes("vault:journal:read")).toEqual([SCOPE_READ]);
    expect(parseScopes("vault:journal:write vault:work:admin")).toEqual([
      SCOPE_WRITE, SCOPE_ADMIN,
    ]);
  });

  test("preserves unrecognized scopes verbatim", () => {
    expect(parseScopes("profile email")).toEqual(["profile", "email"]);
    expect(parseScopes("vault:unknown:frob")).toEqual(["vault:unknown:frob"]);
  });

  test("empty name segment does NOT collapse (vault::read stays literal)", () => {
    // Guard against a hand-crafted DB row with `vault::read` satisfying a
    // `vault:read` check by accident. Only reachable via direct DB write,
    // not API input, but the parser stays honest.
    expect(parseScopes("vault::read")).toEqual(["vault::read"]);
    expect(hasScope(parseScopes("vault::read"), SCOPE_READ)).toBe(false);
  });
});

describe("hasScope — inheritance admin ⊇ write ⊇ read", () => {
  test("exact match succeeds", () => {
    expect(hasScope([SCOPE_READ], SCOPE_READ)).toBe(true);
    expect(hasScope([SCOPE_WRITE], SCOPE_WRITE)).toBe(true);
    expect(hasScope([SCOPE_ADMIN], SCOPE_ADMIN)).toBe(true);
  });

  test("vault:write satisfies vault:read", () => {
    expect(hasScope([SCOPE_WRITE], SCOPE_READ)).toBe(true);
  });

  test("vault:admin satisfies vault:read and vault:write", () => {
    expect(hasScope([SCOPE_ADMIN], SCOPE_READ)).toBe(true);
    expect(hasScope([SCOPE_ADMIN], SCOPE_WRITE)).toBe(true);
  });

  test("vault:read does NOT satisfy vault:write or vault:admin", () => {
    expect(hasScope([SCOPE_READ], SCOPE_WRITE)).toBe(false);
    expect(hasScope([SCOPE_READ], SCOPE_ADMIN)).toBe(false);
  });

  test("vault:write does NOT satisfy vault:admin", () => {
    expect(hasScope([SCOPE_WRITE], SCOPE_ADMIN)).toBe(false);
  });

  test("empty granted list fails", () => {
    expect(hasScope([], SCOPE_READ)).toBe(false);
    expect(hasScope([], SCOPE_WRITE)).toBe(false);
    expect(hasScope([], SCOPE_ADMIN)).toBe(false);
  });

  test("non-vault scopes require exact match — no inheritance", () => {
    expect(hasScope(["profile"], "profile")).toBe(true);
    expect(hasScope(["profile"], "email")).toBe(false);
    expect(hasScope([SCOPE_ADMIN], "profile")).toBe(false);
  });
});

describe("scopeForMethod", () => {
  test("read methods → vault:read", () => {
    expect(scopeForMethod("GET")).toBe(SCOPE_READ);
    expect(scopeForMethod("HEAD")).toBe(SCOPE_READ);
    expect(scopeForMethod("OPTIONS")).toBe(SCOPE_READ);
    expect(scopeForMethod("get")).toBe(SCOPE_READ); // case-insensitive
  });

  test("write methods → vault:write", () => {
    expect(scopeForMethod("POST")).toBe(SCOPE_WRITE);
    expect(scopeForMethod("PATCH")).toBe(SCOPE_WRITE);
    expect(scopeForMethod("PUT")).toBe(SCOPE_WRITE);
    expect(scopeForMethod("DELETE")).toBe(SCOPE_WRITE);
  });

  test("unknown method falls back to vault:write (default-deny)", () => {
    expect(scopeForMethod("TRACE")).toBe(SCOPE_WRITE);
  });
});

describe("legacyPermissionToScopes", () => {
  test("'read' → [vault:read]", () => {
    expect(legacyPermissionToScopes("read")).toEqual([SCOPE_READ]);
  });

  test("'full' and anything else → [read, write, admin]", () => {
    expect(legacyPermissionToScopes("full")).toEqual([SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN]);
    expect(legacyPermissionToScopes("admin")).toEqual([SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN]);
    expect(legacyPermissionToScopes("write")).toEqual([SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN]);
  });
});

describe("parseScopeFlags", () => {
  test("returns null scopes when --scope is absent", () => {
    expect(parseScopeFlags([])).toEqual({ scopes: null, error: null });
    expect(parseScopeFlags(["--vault", "default", "--label", "x"]))
      .toEqual({ scopes: null, error: null });
  });

  test("single --scope with one value", () => {
    expect(parseScopeFlags(["--scope", "vault:read"]))
      .toEqual({ scopes: [SCOPE_READ], error: null });
  });

  test("single --scope with comma-separated values", () => {
    expect(parseScopeFlags(["--scope", "vault:read,vault:write"]))
      .toEqual({ scopes: [SCOPE_READ, SCOPE_WRITE], error: null });
  });

  test("repeated --scope flags", () => {
    expect(parseScopeFlags(["--scope", "vault:read", "--scope", "vault:write"]))
      .toEqual({ scopes: [SCOPE_READ, SCOPE_WRITE], error: null });
  });

  test("dedupes while preserving first-occurrence order", () => {
    expect(parseScopeFlags(["--scope", "vault:write,vault:read,vault:write"]))
      .toEqual({ scopes: [SCOPE_WRITE, SCOPE_READ], error: null });
  });

  test("trims whitespace around each scope", () => {
    expect(parseScopeFlags(["--scope", "  vault:read ,  vault:write  "]))
      .toEqual({ scopes: [SCOPE_READ, SCOPE_WRITE], error: null });
  });

  test("rejects unknown scopes with a helpful error", () => {
    const result = parseScopeFlags(["--scope", "vault:frob"]);
    expect(result.scopes).toBeNull();
    expect(result.error).toContain("Unknown scope");
    expect(result.error).toContain("vault:frob");
    expect(result.error).toContain("vault:read, vault:write, vault:admin");
  });

  test("rejects a mixed list with one invalid scope", () => {
    const result = parseScopeFlags(["--scope", "vault:read,admin"]);
    expect(result.scopes).toBeNull();
    expect(result.error).toContain("admin");
  });

  test("rejects --scope with no value (end of argv)", () => {
    const result = parseScopeFlags(["--scope"]);
    expect(result.scopes).toBeNull();
    expect(result.error).toContain("--scope requires a value");
  });

  test("rejects --scope followed by another flag", () => {
    const result = parseScopeFlags(["--scope", "--label", "x"]);
    expect(result.scopes).toBeNull();
    expect(result.error).toContain("--scope requires a value");
  });

  test("rejects --scope with an empty value", () => {
    const result = parseScopeFlags(["--scope", ""]);
    expect(result.scopes).toBeNull();
    expect(result.error).toContain("empty");
  });

  test("rejects --scope with only commas", () => {
    const result = parseScopeFlags(["--scope", ",,"]);
    expect(result.scopes).toBeNull();
    expect(result.error).toContain("empty");
  });
});

describe("resolveCreateTokenFlags", () => {
  test("no flags → full scope, full permission (historical default)", () => {
    expect(resolveCreateTokenFlags([]))
      .toEqual({ scopes: undefined, permission: "full", error: null });
  });

  test("--read alone → [vault:read], read permission", () => {
    expect(resolveCreateTokenFlags(["--read"]))
      .toEqual({ scopes: [SCOPE_READ], permission: "read", error: null });
  });

  test("--scope vault:read alone → read permission", () => {
    expect(resolveCreateTokenFlags(["--scope", "vault:read"]))
      .toEqual({ scopes: [SCOPE_READ], permission: "read", error: null });
  });

  test("--scope vault:write,vault:read → full permission (any write surface → full)", () => {
    expect(resolveCreateTokenFlags(["--scope", "vault:write,vault:read"]))
      .toEqual({ scopes: [SCOPE_WRITE, SCOPE_READ], permission: "full", error: null });
  });

  test("--scope vault:admin alone → full permission", () => {
    expect(resolveCreateTokenFlags(["--scope", "vault:admin"]))
      .toEqual({ scopes: [SCOPE_ADMIN], permission: "full", error: null });
  });

  test("--permission read → no scopes (token-store default), read permission", () => {
    expect(resolveCreateTokenFlags(["--permission", "read"]))
      .toEqual({ scopes: undefined, permission: "read", error: null });
  });

  test("--permission full → no scopes, full permission", () => {
    expect(resolveCreateTokenFlags(["--permission", "full"]))
      .toEqual({ scopes: undefined, permission: "full", error: null });
  });

  test("--scope + --read errors and mentions both flags", () => {
    const result = resolveCreateTokenFlags(["--scope", "vault:write", "--read"]);
    expect(result.scopes).toBeUndefined();
    expect(result.error).toContain("--scope");
    expect(result.error).toContain("--read");
    expect(result.error).toContain("cannot be combined");
  });

  test("--scope + --permission errors", () => {
    const result = resolveCreateTokenFlags(["--scope", "vault:read", "--permission", "full"]);
    expect(result.scopes).toBeUndefined();
    expect(result.error).toContain("--scope");
    expect(result.error).toContain("--permission");
    expect(result.error).toContain("cannot be combined");
  });

  test("--read + --permission errors", () => {
    const result = resolveCreateTokenFlags(["--read", "--permission", "full"]);
    expect(result.scopes).toBeUndefined();
    expect(result.error).toContain("--read");
    expect(result.error).toContain("--permission");
    expect(result.error).toContain("cannot be combined");
  });

  test("invalid --permission value errors with prefer-scope hint", () => {
    const result = resolveCreateTokenFlags(["--permission", "admin"]);
    expect(result.scopes).toBeUndefined();
    expect(result.error).toContain("admin");
    expect(result.error).toContain("full");
    expect(result.error).toContain("read");
    expect(result.error).toContain("--scope");
  });

  test("--permission with no value errors", () => {
    expect(resolveCreateTokenFlags(["--permission"]).error).toContain("requires a value");
    expect(resolveCreateTokenFlags(["--permission", "--label", "x"]).error).toContain("requires a value");
  });

  test("surfaces parseScopeFlags errors unchanged", () => {
    const result = resolveCreateTokenFlags(["--scope", "vault:frob"]);
    expect(result.error).toContain("Unknown scope");
  });

  test("ignores unrelated flags", () => {
    const result = resolveCreateTokenFlags(["--vault", "journal", "--label", "r", "--read"]);
    expect(result).toEqual({ scopes: [SCOPE_READ], permission: "read", error: null });
  });
});

describe("serializeScopes — round-trips with parseScopes", () => {
  test("joins with spaces", () => {
    expect(serializeScopes([SCOPE_READ, SCOPE_WRITE])).toBe("vault:read vault:write");
    expect(serializeScopes([])).toBe("");
  });

  test("serialize then parse is the identity (for known scopes)", () => {
    const scopes = [SCOPE_READ, SCOPE_WRITE, SCOPE_ADMIN];
    expect(parseScopes(serializeScopes(scopes))).toEqual(scopes);
  });
});
