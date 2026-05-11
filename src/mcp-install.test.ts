/**
 * Tests for `mcp-install` — three concerns:
 *
 *   1. Pure helpers in `mcp-install.ts` (URL picking, operator-token reading,
 *      install-target resolution, hub-mint client with mocked fetch).
 *   2. CLI flag parsing on `parachute-vault mcp-install` — mutual exclusion,
 *      validation of `--scope` / `--install-scope` / `--client`.
 *   3. End-to-end behavior for the modes that don't require a hub: `--token`
 *      paste, `--legacy-pat` mint, `--install-scope project` write,
 *      `--vault <name>` per-vault keying. The `--mint` default's happy path
 *      needs a hub, so we only assert on its failure modes (no operator
 *      token, no hub configured).
 *
 * The URL picker was the only piece with prior coverage; everything else
 * lands in this PR alongside the cmdMcpInstall rewrite.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chooseHubOrigin,
  chooseMcpUrl,
  mintHubJwt,
  readOperatorToken,
  resolveInstallTarget,
} from "./mcp-install.ts";

const CLI = path.resolve(import.meta.dir, "cli.ts");

/**
 * Spawn the CLI under an isolated `PARACHUTE_HOME` and `HOME`. Cwd defaults
 * to a tempdir too so `--install-scope project` writes don't leak into the
 * real working tree.
 */
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

// ---------------------------------------------------------------------------
// Unit tests: pure helpers
// ---------------------------------------------------------------------------

describe("chooseMcpUrl", () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    origHome = process.env.PARACHUTE_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "vault-mcp-install-"));
    process.env.PARACHUTE_HOME = tmpHome;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.PARACHUTE_HOME;
    else process.env.PARACHUTE_HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test("prefers PARACHUTE_HUB_ORIGIN when set", () => {
    const res = chooseMcpUrl("default", 1940, {
      PARACHUTE_HUB_ORIGIN: "https://hub.example",
    });
    expect(res).toEqual({
      url: "https://hub.example/vault/default/mcp",
      source: "hub-origin",
    });
  });

  test("strips trailing slash on PARACHUTE_HUB_ORIGIN", () => {
    const res = chooseMcpUrl("default", 1940, {
      PARACHUTE_HUB_ORIGIN: "https://hub.example/",
    });
    expect(res.url).toBe("https://hub.example/vault/default/mcp");
  });

  test("falls back to tailnet/public FQDN from expose-state.json when hub env unset", () => {
    fs.writeFileSync(
      path.join(tmpHome, "expose-state.json"),
      JSON.stringify({
        version: 1,
        layer: "tailnet",
        mode: "path",
        canonicalFqdn: "parachute.taildf9ce2.ts.net",
        port: 1940,
        funnel: false,
        entries: [],
      }),
    );
    const res = chooseMcpUrl("default", 1940, {});
    expect(res).toEqual({
      url: "https://parachute.taildf9ce2.ts.net/vault/default/mcp",
      source: "expose-state",
    });
  });

  test("uses public FQDN from expose-state.json when layer is public", () => {
    fs.writeFileSync(
      path.join(tmpHome, "expose-state.json"),
      JSON.stringify({
        version: 1,
        layer: "public",
        mode: "subdomain",
        canonicalFqdn: "vault.parachute.computer",
        port: 1940,
        funnel: true,
        entries: [],
      }),
    );
    const res = chooseMcpUrl("default", 1940, {});
    expect(res.url).toBe("https://vault.parachute.computer/vault/default/mcp");
    expect(res.source).toBe("expose-state");
  });

  test("falls back to loopback when no hub env and no expose-state", () => {
    const res = chooseMcpUrl("default", 1940, {});
    expect(res).toEqual({
      url: "http://127.0.0.1:1940/vault/default/mcp",
      source: "loopback",
    });
  });

  test("hub env wins over an active exposure", () => {
    fs.writeFileSync(
      path.join(tmpHome, "expose-state.json"),
      JSON.stringify({
        version: 1,
        layer: "tailnet",
        mode: "path",
        canonicalFqdn: "parachute.taildf9ce2.ts.net",
        port: 1940,
        funnel: false,
        entries: [],
      }),
    );
    const res = chooseMcpUrl("default", 1940, {
      PARACHUTE_HUB_ORIGIN: "https://hub.example",
    });
    expect(res.source).toBe("hub-origin");
    expect(res.url).toBe("https://hub.example/vault/default/mcp");
  });

  test("falls back to loopback on a malformed expose-state.json", () => {
    fs.writeFileSync(path.join(tmpHome, "expose-state.json"), "{ not json");
    const res = chooseMcpUrl("default", 1940, {});
    expect(res.source).toBe("loopback");
  });

  test("honors the passed-in vault name in the URL path", () => {
    const res = chooseMcpUrl("work", 1940, {
      PARACHUTE_HUB_ORIGIN: "https://hub.example",
    });
    expect(res.url).toBe("https://hub.example/vault/work/mcp");
  });
});

describe("chooseHubOrigin", () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    origHome = process.env.PARACHUTE_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "vault-hub-origin-"));
    process.env.PARACHUTE_HOME = tmpHome;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.PARACHUTE_HOME;
    else process.env.PARACHUTE_HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test("returns the bare origin (no /vault/<name>/mcp suffix)", () => {
    const res = chooseHubOrigin(1940, { PARACHUTE_HUB_ORIGIN: "https://hub.example" });
    expect(res).toEqual({ url: "https://hub.example", source: "hub-origin" });
  });

  test("returns loopback origin when nothing is configured (caller treats as no-hub)", () => {
    const res = chooseHubOrigin(1940, {});
    expect(res).toEqual({ url: "http://127.0.0.1:1940", source: "loopback" });
  });

  test("derives the hub origin from an active expose-state FQDN", () => {
    // Tailnet/public exposure with no hub env: hub origin uses the
    // exposure's canonical FQDN (no /vault/<name>/mcp suffix — that's
    // chooseMcpUrl's job, this returns the bare origin for the
    // mint-token API call).
    fs.writeFileSync(
      path.join(tmpHome, "expose-state.json"),
      JSON.stringify({
        version: 1,
        layer: "tailnet",
        mode: "path",
        canonicalFqdn: "parachute.taildf9ce2.ts.net",
        port: 1940,
        funnel: false,
        entries: [],
      }),
    );
    const res = chooseHubOrigin(1940, {});
    expect(res).toEqual({
      url: "https://parachute.taildf9ce2.ts.net",
      source: "expose-state",
    });
  });

  test("malformed expose-state.json gracefully falls through to loopback", () => {
    fs.writeFileSync(path.join(tmpHome, "expose-state.json"), "{ not json");
    const res = chooseHubOrigin(1940, {});
    expect(res.source).toBe("loopback");
  });
});

describe("readOperatorToken", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "vault-op-token-"));
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test("returns null when operator.token doesn't exist", () => {
    expect(readOperatorToken({ PARACHUTE_HOME: tmpHome })).toBeNull();
  });

  test("reads and trims the operator.token file when present", () => {
    fs.writeFileSync(path.join(tmpHome, "operator.token"), "  eyJabc.def.ghi  \n");
    expect(readOperatorToken({ PARACHUTE_HOME: tmpHome })).toBe("eyJabc.def.ghi");
  });

  test("returns null for an empty operator.token", () => {
    fs.writeFileSync(path.join(tmpHome, "operator.token"), "   \n");
    expect(readOperatorToken({ PARACHUTE_HOME: tmpHome })).toBeNull();
  });
});

describe("resolveInstallTarget", () => {
  test("user scope → ~/.claude.json", () => {
    const res = resolveInstallTarget("user");
    expect(res.path).toBe(path.resolve(os.homedir(), ".claude.json"));
    expect(res.scope).toBe("user");
  });

  test("project scope → <cwd>/.mcp.json", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-target-"));
    try {
      const res = resolveInstallTarget("project", tmp);
      expect(res.path).toBe(path.resolve(tmp, ".mcp.json"));
      expect(res.scope).toBe("project");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("mintHubJwt", () => {
  test("happy path returns parsed JWT payload", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const mockFetch: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          jti: "jti-abc",
          token: "eyJ.signed.jwt",
          expires_at: "2026-08-09T00:00:00.000Z",
          scope: "vault:default:read",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const res = await mintHubJwt({
      hubOrigin: "https://hub.example",
      operatorToken: "operator-bearer",
      scope: "vault:default:read",
      fetchImpl: mockFetch,
    });
    expect("token" in res).toBe(true);
    if (!("token" in res)) return; // narrow for TS
    expect(res.token).toBe("eyJ.signed.jwt");
    expect(res.scope).toBe("vault:default:read");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://hub.example/api/auth/mint-token");
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer operator-bearer");
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.scope).toBe("vault:default:read");
    expect(body.expires_in).toBeGreaterThan(0);
  });

  test("network error returns { kind: 'network' } with the origin and cause", async () => {
    const mockFetch: typeof fetch = async () => {
      throw new Error("connection refused");
    };
    const res = await mintHubJwt({
      hubOrigin: "https://hub.example",
      operatorToken: "bearer",
      scope: "vault:default:read",
      fetchImpl: mockFetch,
    });
    expect(res).toEqual({ kind: "network", cause: "connection refused", origin: "https://hub.example" });
  });

  test("API error surfaces hub error + error_description", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({ error: "insufficient_scope", error_description: "bearer lacks parachute:host:auth" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );
    const res = await mintHubJwt({
      hubOrigin: "https://hub.example",
      operatorToken: "bearer",
      scope: "vault:default:read",
      fetchImpl: mockFetch,
    });
    expect(res).toEqual({
      kind: "api-error",
      status: 403,
      error: "insufficient_scope",
      description: "bearer lacks parachute:host:auth",
    });
  });

  test("malformed success response degrades to api-error rather than crashing", async () => {
    const mockFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ token: "x" }), { status: 200, headers: { "Content-Type": "application/json" } });
    const res = await mintHubJwt({
      hubOrigin: "https://hub.example",
      operatorToken: "bearer",
      scope: "vault:default:read",
      fetchImpl: mockFetch,
    });
    expect("kind" in res && res.kind === "api-error").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CLI flag-parsing tests — these don't need a vault DB
// ---------------------------------------------------------------------------

describe("mcp-install flag parsing", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-mcp-flags-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("rejects mutually exclusive --mint and --token", () => {
    const res = runCli(["mcp-install", "--mint", "--token", "abc"], tmp);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/mutually exclusive/);
  });

  test("rejects mutually exclusive --token and --legacy-pat", () => {
    const res = runCli(["mcp-install", "--token", "abc", "--legacy-pat"], tmp);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/mutually exclusive/);
  });

  test("rejects --token without a value", () => {
    const res = runCli(["mcp-install", "--token"], tmp);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/--token requires a value/);
  });

  test("rejects an unknown --scope value", () => {
    const res = runCli(["mcp-install", "--scope", "vault:bogus", "--token", "t"], tmp);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/--scope must be one of/);
  });

  test("rejects an unknown --install-scope value", () => {
    const res = runCli(
      ["mcp-install", "--install-scope", "system-wide", "--token", "t"],
      tmp,
    );
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/--install-scope must be "user" or "project"/);
  });

  test("rejects a --client other than claude-code (Phase C is future work)", () => {
    const res = runCli(
      ["mcp-install", "--client", "cursor", "--token", "t"],
      tmp,
    );
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/not yet supported|Phase C/);
  });

  test("rejects an unknown vault", () => {
    const res = runCli(
      ["mcp-install", "--vault", "ghost", "--token", "t"],
      tmp,
    );
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/Vault "ghost" not found/);
  });

  test("rejects --mint when there's no operator.token", () => {
    // Pre-create a vault directory so the existence check passes — the
    // operator.token check fires before any network hit.
    setupBareVault(tmp, "default");
    const res = runCli(["mcp-install"], tmp);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/No operator token found/);
    expect(res.stderr).toMatch(/parachute auth rotate-operator/);
  });

  test("rejects --mint when no hub is configured (loopback-only)", () => {
    setupBareVault(tmp, "default");
    fs.writeFileSync(path.join(tmp, "operator.token"), "operator-bearer-stub");
    // No PARACHUTE_HUB_ORIGIN, no expose-state.json — chooseHubOrigin
    // returns loopback, which is correctly rejected.
    const res = runCli(["mcp-install"], tmp, { PARACHUTE_HUB_ORIGIN: "" });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/No hub origin configured/);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: modes that don't need a hub (--token, --legacy-pat,
// --install-scope project, --vault per-vault keying)
// ---------------------------------------------------------------------------

describe("mcp-install end-to-end", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-mcp-e2e-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("--token writes the supplied bearer into ~/.claude.json", () => {
    setupBareVault(tmp, "default");
    const res = runCli(
      ["mcp-install", "--token", "pasted-bearer"],
      tmp,
    );
    expect(res.exitCode).toBe(0);
    const config = readJson(path.join(tmp, ".claude.json"));
    const entry = config.mcpServers["parachute-vault"];
    expect(entry.type).toBe("http");
    expect(entry.headers.Authorization).toBe("Bearer pasted-bearer");
    expect(entry.url).toContain("/vault/default/mcp");
  });

  test("--install-scope project writes <cwd>/.mcp.json instead of ~/.claude.json", () => {
    setupBareVault(tmp, "default");
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-mcp-project-"));
    try {
      const res = runCli(
        ["mcp-install", "--install-scope", "project", "--token", "pasted"],
        tmp,
        {},
        projectDir,
      );
      expect(res.exitCode).toBe(0);
      // Wrote into the project, not the user.
      expect(fs.existsSync(path.join(projectDir, ".mcp.json"))).toBe(true);
      expect(fs.existsSync(path.join(tmp, ".claude.json"))).toBe(false);
      const config = readJson(path.join(projectDir, ".mcp.json"));
      expect(config.mcpServers["parachute-vault"].headers.Authorization).toBe(
        "Bearer pasted",
      );
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("--vault <name> keys the entry as parachute-vault-<name>", () => {
    setupBareVault(tmp, "default");
    setupBareVault(tmp, "work");
    // Install for the second vault — singular slot stays free for the
    // default. Multi-vault is the motivation.
    const res = runCli(
      ["mcp-install", "--vault", "work", "--token", "work-bearer"],
      tmp,
    );
    expect(res.exitCode).toBe(0);
    const config = readJson(path.join(tmp, ".claude.json"));
    expect(config.mcpServers["parachute-vault-work"]).toBeDefined();
    expect(config.mcpServers["parachute-vault-work"].url).toContain("/vault/work/mcp");
    expect(config.mcpServers["parachute-vault-work"].headers.Authorization).toBe(
      "Bearer work-bearer",
    );
    // The singular slot is untouched — we'd preserve a pre-existing entry,
    // but here there was none so it's just absent.
    expect(config.mcpServers["parachute-vault"]).toBeUndefined();
  });

  test("--vault without an explicit name uses the default and keys the singular slot", () => {
    setupBareVault(tmp, "default");
    const res = runCli(["mcp-install", "--token", "default-bearer"], tmp);
    expect(res.exitCode).toBe(0);
    const config = readJson(path.join(tmp, ".claude.json"));
    expect(config.mcpServers["parachute-vault"]).toBeDefined();
    // Per-vault key for the default vault is NOT written when --vault wasn't
    // explicit; the singular slot is the canonical single-install shape.
    expect(config.mcpServers["parachute-vault-default"]).toBeUndefined();
  });

  test("--legacy-pat mints a vault-DB pvt_* token and prints deprecation warning", () => {
    setupBareVault(tmp, "default");
    const res = runCli(["mcp-install", "--legacy-pat"], tmp);
    expect(res.exitCode).toBe(0);
    // Deprecation warning lands on stderr (we used `console.error` for the
    // notice so it's visible without polluting stdout). The message names
    // the tracking issue + planned-removal milestone so operators can
    // see what they're opting into.
    expect(res.stderr).toMatch(/--legacy-pat mints a vault-DB pvt_/);
    expect(res.stderr).toMatch(/canonical install going forward/);
    expect(res.stderr).toMatch(/vault#288/);
    expect(res.stderr).toMatch(/planned removal 0\.6\.0/);
    const config = readJson(path.join(tmp, ".claude.json"));
    const bearer = config.mcpServers["parachute-vault"].headers.Authorization;
    expect(bearer).toMatch(/^Bearer pvt_/);
  });

  test("subsequent --token install on top of an existing entry overwrites the bearer", () => {
    setupBareVault(tmp, "default");
    runCli(["mcp-install", "--token", "first"], tmp);
    const res = runCli(["mcp-install", "--token", "second"], tmp);
    expect(res.exitCode).toBe(0);
    const config = readJson(path.join(tmp, ".claude.json"));
    expect(config.mcpServers["parachute-vault"].headers.Authorization).toBe("Bearer second");
  });
});

// ---------------------------------------------------------------------------
// Interactive dispatch — CLI-level (subprocess) regression tests
// ---------------------------------------------------------------------------

describe("mcp-install interactive dispatch", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-mcp-dispatch-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("no flags + non-TTY stdin (piped) falls through to flag-driven path with defaults", () => {
    // Subprocess with stdin piped from /dev/null: process.stdin.isTTY is
    // false, so interactive must NOT engage. Defaults push us to --mint,
    // which fails (no operator.token in the isolated PARACHUTE_HOME).
    // The point of this test isn't the failure mode per se — it's that
    // we exit on the existing non-interactive code path, not stall
    // waiting for a prompt no one can answer.
    setupBareVault(tmp, "default");
    const res = runCli(["mcp-install"], tmp);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/No operator token found/);
    // Crucial: no prompt-shaped output. If we'd accidentally dispatched
    // to interactive, we'd see "Setting up Parachute Vault" before
    // hanging on a prompt.
    expect(res.stdout).not.toMatch(/Setting up Parachute Vault/);
  });

  test("any install-shaping flag bypasses the walkthrough", () => {
    // --legacy-pat triggers the flag-driven path even on a TTY. The
    // walkthrough mustn't fire when a flag is present, so its
    // "Setting up…" banner must not appear in output.
    setupBareVault(tmp, "default");
    const res = runCli(["mcp-install", "--legacy-pat"], tmp);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toMatch(/Setting up Parachute Vault/);
    // The deprecation banner *should* show — confirms flag-driven path
    // ran end-to-end.
    expect(res.stderr).toMatch(/--legacy-pat mints a vault-DB pvt_/);
  });
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Create the minimum vault state that `cmdMcpInstall` validates against:
 * the vault directory + vault.yaml that `readVaultConfig` reads. Also seeds
 * `config.yaml` so `default_vault` points at the named vault. Avoids the
 * full `parachute-vault init` subprocess (slow + heavy) when all we need
 * is "the vault exists by name."
 */
function setupBareVault(parachuteHome: string, name: string): void {
  // Vault layout: <PARACHUTE_HOME>/vault/data/<name>/vault.yaml.
  // `readVaultConfig` and `listVaults` both look here.
  const vaultsDir = path.join(parachuteHome, "vault", "data");
  fs.mkdirSync(path.join(vaultsDir, name), { recursive: true });
  fs.writeFileSync(
    path.join(vaultsDir, name, "vault.yaml"),
    `name: ${name}\napi_keys: []\n`,
  );
  // First vault written becomes default_vault; subsequent vaults leave it
  // alone. Keeps test setup terse — no separate global config writes.
  // (The DB file gets created on first open by bun:sqlite, so we don't
  // pre-seed it; --legacy-pat opens it lazily.)
  const globalPath = path.join(parachuteHome, "vault", "config.yaml");
  if (!fs.existsSync(globalPath)) {
    fs.mkdirSync(path.dirname(globalPath), { recursive: true });
    fs.writeFileSync(globalPath, `default_vault: ${name}\nport: 1940\n`);
  }
}

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}
