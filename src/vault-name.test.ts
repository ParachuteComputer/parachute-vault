/**
 * Unit tests for `validateVaultName` — the rule enforced by the `init`
 * prompt, the `--vault-name` flag, and the `PARACHUTE_VAULT_NAME` env var
 * at server first-boot. Covers each rejection branch (empty, length,
 * regex, reserved) plus the happy paths the prompt has to accept (default,
 * hyphens, underscores, length boundaries).
 */

import { describe, test, expect } from "bun:test";
import { validateVaultName, decideInitVaultName, resolveFirstBootVaultName } from "./vault-name.ts";

describe("validateVaultName", () => {
  describe("accepts", () => {
    test.each([
      "default",
      "aaron",
      "personal",
      "work",
      "ab", // 2-char boundary (min length)
      "vault-1",
      "my_vault",
      "a-b_c-1",
      "abc123",
      "a".repeat(32), // 32-char boundary (max length)
    ])("%s", (name) => {
      const result = validateVaultName(name);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.name).toBe(name);
    });

    test("trims surrounding whitespace before validating", () => {
      const result = validateVaultName("  aaron  ");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.name).toBe("aaron");
    });
  });

  describe("rejects", () => {
    test("empty string", () => {
      const result = validateVaultName("");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("empty");
    });

    test("whitespace-only", () => {
      const result = validateVaultName("   ");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("empty");
    });

    test.each([
      ["uppercase", "Aaron"],
      ["mixed case", "MyVault"],
      ["space inside", "my vault"],
      ["slash", "team/work"],
      ["dot", "vault.1"],
      ["backslash", "team\\work"],
      ["question mark", "vault?"],
      ["hash", "vault#1"],
      ["leading symbol disallowed by regex", "@aaron"],
      ["unicode", "café"],
    ])("%s (%s)", (_label, name) => {
      const result = validateVaultName(name);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain(
          "lowercase alphanumeric with hyphens or underscores",
        );
      }
    });

    test("reserved name 'list'", () => {
      const result = validateVaultName("list");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("reserved");
    });

    test("single character (below 2-char min)", () => {
      const result = validateVaultName("a");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("2");
    });

    test("33 characters (above 32-char max)", () => {
      const result = validateVaultName("a".repeat(33));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("32");
    });

    test("200 characters (well above max)", () => {
      const result = validateVaultName("a".repeat(200));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("32");
    });
  });
});

describe("decideInitVaultName", () => {
  test("--vault-name=aaron resolves to name 'aaron'", () => {
    const d = decideInitVaultName(["--vault-name", "aaron"], { isTTY: true });
    expect(d).toEqual({ kind: "name", name: "aaron" });
  });

  test("--vault-name=default preserves the existing default", () => {
    const d = decideInitVaultName(["--vault-name", "default"], { isTTY: false });
    expect(d).toEqual({ kind: "name", name: "default" });
  });

  test("--vault-name with no value errors out", () => {
    const d = decideInitVaultName(["--vault-name"], { isTTY: true });
    expect(d.kind).toBe("error");
    if (d.kind === "error") expect(d.message).toContain("requires a value");
  });

  test("--vault-name=My Vault errors out (uppercase + space)", () => {
    const d = decideInitVaultName(["--vault-name", "My Vault"], { isTTY: true });
    expect(d.kind).toBe("error");
    if (d.kind === "error") {
      expect(d.message).toContain("--vault-name:");
      expect(d.message).toContain("lowercase alphanumeric");
    }
  });

  test("--vault-name=list errors out (reserved)", () => {
    const d = decideInitVaultName(["--vault-name", "list"], { isTTY: true });
    expect(d.kind).toBe("error");
    if (d.kind === "error") expect(d.message).toContain("reserved");
  });

  test("no flag + non-TTY falls back to 'default' (piped install)", () => {
    const d = decideInitVaultName(["--no-mcp"], { isTTY: false });
    expect(d).toEqual({ kind: "name", name: "default" });
  });

  test("no flag + TTY signals the caller to prompt", () => {
    const d = decideInitVaultName([], { isTTY: true });
    expect(d).toEqual({ kind: "prompt" });
  });

  test("--vault-name with leading whitespace is trimmed and accepted", () => {
    const d = decideInitVaultName(["--vault-name", "  aaron  "], { isTTY: true });
    expect(d).toEqual({ kind: "name", name: "aaron" });
  });
});

describe("resolveFirstBootVaultName", () => {
  test("env var unset → fallback to default", () => {
    const r = resolveFirstBootVaultName(undefined);
    expect(r).toEqual({ source: "default", name: "default" });
  });

  test("env var empty string → fallback to default", () => {
    const r = resolveFirstBootVaultName("");
    expect(r).toEqual({ source: "default", name: "default" });
  });

  test("env var whitespace-only → fallback to default", () => {
    const r = resolveFirstBootVaultName("   ");
    expect(r).toEqual({ source: "default", name: "default" });
  });

  test("env var set to a valid name → that name (positive path)", () => {
    const r = resolveFirstBootVaultName("smoke-1939");
    expect(r).toEqual({ source: "env", name: "smoke-1939" });
  });

  test("env var set to a valid name with underscores → that name", () => {
    const r = resolveFirstBootVaultName("my_vault");
    expect(r).toEqual({ source: "env", name: "my_vault" });
  });

  test("env var set with surrounding whitespace → trimmed + accepted", () => {
    const r = resolveFirstBootVaultName("  aaron  ");
    expect(r).toEqual({ source: "env", name: "aaron" });
  });

  test("env var set to invalid (uppercase + spaces + special) → fallback to default + record raw + reason", () => {
    const r = resolveFirstBootVaultName("Bad Name!!");
    expect(r.source).toBe("env-invalid");
    expect(r.name).toBe("default");
    if (r.source === "env-invalid") {
      expect(r.rawValue).toBe("Bad Name!!");
      expect(r.reason).toContain("lowercase alphanumeric");
    }
  });

  test("env var set to reserved name 'list' → fallback to default", () => {
    const r = resolveFirstBootVaultName("list");
    expect(r.source).toBe("env-invalid");
    expect(r.name).toBe("default");
    if (r.source === "env-invalid") {
      expect(r.reason).toContain("reserved");
    }
  });

  test("env var set to slash-containing name → fallback to default", () => {
    const r = resolveFirstBootVaultName("team/work");
    expect(r.source).toBe("env-invalid");
    expect(r.name).toBe("default");
  });

  test("env var set to a 200-char name → fallback to default (over max-length)", () => {
    const r = resolveFirstBootVaultName("a".repeat(200));
    expect(r.source).toBe("env-invalid");
    expect(r.name).toBe("default");
    if (r.source === "env-invalid") {
      expect(r.reason).toContain("32");
    }
  });

  test("env var set to a single character → fallback to default (under min-length)", () => {
    const r = resolveFirstBootVaultName("a");
    expect(r.source).toBe("env-invalid");
    expect(r.name).toBe("default");
    if (r.source === "env-invalid") {
      expect(r.reason).toContain("2");
    }
  });
});
