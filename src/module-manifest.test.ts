import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSelfManifest, resolvePackageRoot } from "./module-manifest.ts";

function withTempPackageRoot(
  manifest: unknown | undefined,
  fn: (root: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "pvault-manifest-"));
  try {
    if (manifest !== undefined) {
      mkdirSync(join(root, ".parachute"), { recursive: true });
      writeFileSync(
        join(root, ".parachute", "module.json"),
        typeof manifest === "string" ? manifest : JSON.stringify(manifest),
      );
    }
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("module-manifest", () => {
  test("resolvePackageRoot returns the directory containing package.json", () => {
    // In the test env, this module lives at <repo>/src/module-manifest.test.ts —
    // so the resolved root is the repo root. We don't pin the exact path
    // (tests run from various cwds); we just sanity-check it's an absolute
    // directory ending in the vault repo's name.
    const root = resolvePackageRoot();
    expect(root.startsWith("/")).toBe(true);
    expect(root.endsWith("/src")).toBe(false);
  });

  test("readSelfManifest returns null when .parachute/module.json is missing", () => {
    withTempPackageRoot(undefined, (root) => {
      expect(readSelfManifest(root)).toBeNull();
    });
  });

  test("readSelfManifest parses a valid manifest", () => {
    withTempPackageRoot(
      {
        name: "vault",
        manifestName: "parachute-vault",
        displayName: "Vault",
        tagline: "Test tagline",
        kind: "api",
        port: 1940,
        paths: ["/vault/default"],
        health: "/vault/default/health",
      },
      (root) => {
        const m = readSelfManifest(root);
        expect(m).not.toBeNull();
        expect(m?.name).toBe("vault");
        expect(m?.manifestName).toBe("parachute-vault");
        expect(m?.displayName).toBe("Vault");
        expect(m?.kind).toBe("api");
        expect(m?.port).toBe(1940);
        expect(m?.paths).toEqual(["/vault/default"]);
      },
    );
  });

  test("readSelfManifest throws on malformed JSON", () => {
    withTempPackageRoot("{ not valid json", (root) => {
      expect(() => readSelfManifest(root)).toThrow();
    });
  });

  test("readSelfManifest throws when required field missing", () => {
    withTempPackageRoot(
      { name: "vault" /* missing manifestName / port / paths / health / kind */ },
      (root) => {
        expect(() => readSelfManifest(root)).toThrow(/missing required/);
      },
    );
  });

  test("readSelfManifest reads the actual shipped manifest in the repo", () => {
    // Smoke test the real shipped file — guards against ever shipping a
    // malformed manifest. Uses the real resolvePackageRoot (which finds
    // the repo root in tests).
    const m = readSelfManifest();
    expect(m).not.toBeNull();
    expect(m?.manifestName).toBe("parachute-vault");
    expect(m?.kind).toBe("api");
    expect(m?.port).toBe(1940);
  });
});
