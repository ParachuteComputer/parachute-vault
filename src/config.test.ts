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

  test("round-trips tag_schemas in vault config", () => {
    const config: VaultConfig = {
      name: "testvault",
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
      tag_schemas: {
        person: {
          description: "A person in Aaron's life",
          fields: {
            first_appeared: {
              type: "string",
              description: "When this person first appeared",
            },
            relationship: {
              type: "string",
              description: "How they relate to Aaron",
            },
          },
        },
        project: {
          description: "A project",
          fields: {
            status: {
              type: "string",
              enum: ["active", "completed", "abandoned"],
              description: "Current project status",
            },
          },
        },
        "summary/monthly": {
          description: "Monthly summary note",
        },
      },
    };

    writeVaultConfig(config);

    const loaded = readVaultConfig("testvault");
    expect(loaded).not.toBeNull();
    expect(loaded!.tag_schemas).toBeDefined();

    const person = loaded!.tag_schemas!.person;
    expect(person.description).toBe("A person in Aaron's life");
    expect(person.fields!.first_appeared.type).toBe("string");
    expect(person.fields!.first_appeared.description).toBe("When this person first appeared");
    expect(person.fields!.relationship.type).toBe("string");

    const project = loaded!.tag_schemas!.project;
    expect(project.fields!.status.enum).toEqual(["active", "completed", "abandoned"]);

    const monthly = loaded!.tag_schemas!["summary/monthly"];
    expect(monthly.description).toBe("Monthly summary note");
    expect(monthly.fields).toBeUndefined();
  });

  test("vault config without tag_schemas loads cleanly", () => {
    const config: VaultConfig = {
      name: "testvault",
      api_keys: [],
      created_at: "2026-01-01T00:00:00.000Z",
    };

    writeVaultConfig(config);

    const loaded = readVaultConfig("testvault");
    expect(loaded).not.toBeNull();
    expect(loaded!.tag_schemas).toBeUndefined();
  });
});
