/**
 * Tests for `parachute-vault mcp-config <vault-name>` — the JSON synthesizer
 * for `claude -p --mcp-config '<json>'` runners. Three concerns:
 *
 *   1. Pure helper: `buildMcpConfigJson` — shape correctness for both literal
 *      and `--env-vars` template modes.
 *   2. CLI flag parsing: required vault arg, --token / PARACHUTE_VAULT_TOKEN
 *      precedence, --base-url override, --env-vars short-circuit (no vault
 *      lookup, no bearer required).
 *   3. End-to-end stdout — verify pipe-to-jq usability (valid JSON, exact
 *      shape claude consumes).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildMcpConfigJson } from "./mcp-install.ts";

const CLI = path.resolve(import.meta.dir, "cli.ts");

function runCli(
  args: string[],
  parachuteHome: string,
  extraEnv: Record<string, string | undefined> = {},
  cwd?: string,
): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: ["bun", CLI, ...args],
    cwd: cwd ?? parachuteHome,
    env: {
      ...process.env,
      PARACHUTE_HOME: parachuteHome,
      HOME: parachuteHome,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

function setupBareVault(parachuteHome: string, name: string): void {
  const vaultsDir = path.join(parachuteHome, "vault", "data");
  fs.mkdirSync(path.join(vaultsDir, name), { recursive: true });
  fs.writeFileSync(
    path.join(vaultsDir, name, "vault.yaml"),
    `name: ${name}\napi_keys: []\n`,
  );
  const globalPath = path.join(parachuteHome, "vault", "config.yaml");
  if (!fs.existsSync(globalPath)) {
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(globalPath, `default_vault: ${name}\nport: 1940\n`);
  }
}

// ---------------------------------------------------------------------------
// Unit: buildMcpConfigJson
// ---------------------------------------------------------------------------

describe("buildMcpConfigJson", () => {
  test("literal mode embeds the bearer and URL verbatim", () => {
    const json = buildMcpConfigJson({
      vaultName: "gitcoin",
      baseUrl: "http://127.0.0.1:1940",
      bearer: "pvt_abc123",
    });
    const parsed = JSON.parse(json);
    expect(parsed.mcpServers["parachute-vault-gitcoin"]).toEqual({
      type: "http",
      url: "http://127.0.0.1:1940/vault/gitcoin/mcp",
      headers: { Authorization: "Bearer pvt_abc123" },
    });
  });

  test("env-var mode emits placeholders that survive JSON parsing", () => {
    const json = buildMcpConfigJson({
      vaultName: "gitcoin",
      baseUrl: "",
      bearer: "",
      useEnvVars: true,
    });
    // The placeholders must come through verbatim — `${...}` is a normal
    // string value to JSON, and that's what shell expansion later acts on.
    const parsed = JSON.parse(json);
    expect(parsed.mcpServers["parachute-vault-gitcoin"].url).toBe(
      "${PARACHUTE_HUB_URL}/vault/gitcoin/mcp",
    );
    expect(parsed.mcpServers["parachute-vault-gitcoin"].headers.Authorization).toBe(
      "Bearer ${PARACHUTE_VAULT_TOKEN}",
    );
  });

  test("strips trailing slash from baseUrl (no double slashes in the path)", () => {
    const json = buildMcpConfigJson({
      vaultName: "default",
      baseUrl: "https://hub.example.com/",
      bearer: "t",
    });
    const parsed = JSON.parse(json);
    expect(parsed.mcpServers["parachute-vault-default"].url).toBe(
      "https://hub.example.com/vault/default/mcp",
    );
  });

  test("entry key always uses parachute-vault-<name> (multi-vault-ready)", () => {
    const json = buildMcpConfigJson({
      vaultName: "work",
      baseUrl: "http://127.0.0.1:1940",
      bearer: "t",
    });
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed.mcpServers)).toEqual(["parachute-vault-work"]);
  });
});

// ---------------------------------------------------------------------------
// CLI end-to-end
// ---------------------------------------------------------------------------

describe("mcp-config CLI", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-mcp-config-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("emits well-formed JSON to stdout with --token", () => {
    setupBareVault(tmp, "gitcoin");
    const res = runCli(
      ["mcp-config", "gitcoin", "--token", "pvt_test123"],
      tmp,
    );
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.mcpServers["parachute-vault-gitcoin"].type).toBe("http");
    expect(parsed.mcpServers["parachute-vault-gitcoin"].headers.Authorization).toBe(
      "Bearer pvt_test123",
    );
    expect(parsed.mcpServers["parachute-vault-gitcoin"].url).toContain(
      "/vault/gitcoin/mcp",
    );
  });

  test("reads PARACHUTE_VAULT_TOKEN env var when --token absent", () => {
    setupBareVault(tmp, "gitcoin");
    const res = runCli(
      ["mcp-config", "gitcoin"],
      tmp,
      { PARACHUTE_VAULT_TOKEN: "pvt_envvar" },
    );
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.mcpServers["parachute-vault-gitcoin"].headers.Authorization).toBe(
      "Bearer pvt_envvar",
    );
  });

  test("--token wins over PARACHUTE_VAULT_TOKEN when both are present", () => {
    setupBareVault(tmp, "gitcoin");
    const res = runCli(
      ["mcp-config", "gitcoin", "--token", "from-flag"],
      tmp,
      { PARACHUTE_VAULT_TOKEN: "from-env" },
    );
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.mcpServers["parachute-vault-gitcoin"].headers.Authorization).toBe(
      "Bearer from-flag",
    );
  });

  test("exits 1 with a clear error when no token is supplied", () => {
    setupBareVault(tmp, "gitcoin");
    // Explicitly unset PARACHUTE_VAULT_TOKEN (test env may have it).
    const res = runCli(
      ["mcp-config", "gitcoin"],
      tmp,
      { PARACHUTE_VAULT_TOKEN: "" },
    );
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/No bearer token/);
    expect(res.stderr).toMatch(/--token/);
    expect(res.stderr).toMatch(/PARACHUTE_VAULT_TOKEN/);
    // The error message points operators at the workaround paths so they
    // can recover without re-reading the docs. (vault#282 Stage 2: tokens are
    // hub-issued JWTs now, so the hint names mcp-install, not the removed
    // `tokens create`.)
    expect(res.stderr).toMatch(/parachute-vault mcp-install/);
    expect(res.stderr).toMatch(/--env-vars/);
  });

  test("exits 1 when the vault doesn't exist (literal mode)", () => {
    setupBareVault(tmp, "default");
    const res = runCli(
      ["mcp-config", "ghost", "--token", "t"],
      tmp,
    );
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/Vault "ghost" not found/);
  });

  test("--env-vars short-circuits — no vault lookup, no token required", () => {
    // Deliberately no setupBareVault: --env-vars mode emits the template
    // shape without resolving anything. Operators commit the template from
    // machines that may not have the target vault.
    const res = runCli(
      ["mcp-config", "gitcoin", "--env-vars"],
      tmp,
      { PARACHUTE_VAULT_TOKEN: "" },
    );
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.mcpServers["parachute-vault-gitcoin"].url).toBe(
      "${PARACHUTE_HUB_URL}/vault/gitcoin/mcp",
    );
    expect(parsed.mcpServers["parachute-vault-gitcoin"].headers.Authorization).toBe(
      "Bearer ${PARACHUTE_VAULT_TOKEN}",
    );
  });

  test("--base-url overrides the auto-detected origin", () => {
    setupBareVault(tmp, "gitcoin");
    const res = runCli(
      [
        "mcp-config",
        "gitcoin",
        "--token",
        "t",
        "--base-url",
        "https://hub.taildf9ce2.ts.net",
      ],
      tmp,
    );
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.mcpServers["parachute-vault-gitcoin"].url).toBe(
      "https://hub.taildf9ce2.ts.net/vault/gitcoin/mcp",
    );
  });

  test("missing vault-name arg prints usage and exits 1", () => {
    const res = runCli(["mcp-config"], tmp);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/Usage:/);
    expect(res.stderr).toMatch(/mcp-config <vault-name>/);
  });

  test("flag passed in place of vault-name (e.g. --help) is rejected", () => {
    // Guards against `parachute-vault mcp-config --token foo` being
    // silently misparsed as vault-name="--token".
    const res = runCli(["mcp-config", "--help"], tmp);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/Usage:/);
  });
});
