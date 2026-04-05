import { describe, test, expect } from "bun:test";
import { mkdirSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  writeVaultConfig,
  readVaultConfig,
  generateApiKey,
  hashKey,
  verifyKey,
} from "./config.ts";
import type { VaultConfig } from "./config.ts";

describe("config", () => {
  test("generates and verifies API keys", () => {
    const { fullKey, keyId } = generateApiKey();
    expect(fullKey).toMatch(/^pvk_/);
    expect(keyId).toMatch(/^k_/);

    const hash = hashKey(fullKey);
    expect(hash).toMatch(/^sha256:/);
    expect(verifyKey(fullKey, hash)).toBe(true);
    expect(verifyKey("wrong_key_here_1234567890123456", hash)).toBe(false);
  });

  test("round-trips vault config", () => {
    const tmpDir = join(tmpdir(), `config-test-${Date.now()}`);
    mkdirSync(join(tmpDir, "testvault"), { recursive: true });

    // Monkey-patch vaultDir for this test
    const original = require("./config.ts");
    const origVaultDir = original.vaultDir;
    const origVaultConfigPath = original.vaultConfigPath;

    const config: VaultConfig = {
      name: "testvault",
      description: "A test vault for testing",
      api_keys: [
        {
          id: "k_abc123",
          label: "default",
          scope: "write",
          key_hash: "sha256:fakehash",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      created_at: "2026-01-01T00:00:00.000Z",
    };

    writeVaultConfig(config);

    const loaded = readVaultConfig("testvault");
    expect(loaded).not.toBeNull();
    expect(loaded!.name).toBe("testvault");
    expect(loaded!.description).toBe("A test vault for testing");
    expect(loaded!.api_keys.length).toBe(1);
    expect(loaded!.api_keys[0].id).toBe("k_abc123");

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
