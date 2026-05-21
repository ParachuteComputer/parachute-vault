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
  buildMcpEntryPlan,
  chooseHubOrigin,
  chooseMcpUrl,
  mintHubJwt,
  readOperatorToken,
  removeMcpConfig,
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

// vault#293 — pin that the preview-render and the writer go through the same
// helper. If either side stops calling `buildMcpEntryPlan` (or the helper's
// shape changes), the preview can disagree with what lands on disk; these
// tests catch the helper-shape drift directly. The walkthrough/preview test
// in mcp-install-interactive.test.ts asserts the consumer-side cross-check
// (preview's logged entry-key/url match `buildMcpEntryPlan`'s output).
describe("buildMcpEntryPlan", () => {
  test("singular key + per-vault key + URL match what the writer would land", () => {
    const env = { PARACHUTE_HUB_ORIGIN: "https://hub.example" };

    const singular = buildMcpEntryPlan({ vaultName: "default", vaultExplicit: false, port: 1940, env });
    expect(singular.entryKey).toBe("parachute-vault");
    expect(singular.url).toBe("https://hub.example/vault/default/mcp");

    const perVault = buildMcpEntryPlan({ vaultName: "work", vaultExplicit: true, port: 1940, env });
    expect(perVault.entryKey).toBe("parachute-vault-work");
    expect(perVault.url).toBe("https://hub.example/vault/work/mcp");
  });

  test("existingEntryKey wins over the synthesized key (preserves an in-place update)", () => {
    // The walkthrough's update-existing branch pins the slot the entry
    // already occupies — even if `vaultExplicit` would otherwise produce a
    // different synthesized key, the plan must honor the existing slot or
    // the writer lands at a different key than the preview promised.
    const env = { PARACHUTE_HUB_ORIGIN: "https://hub.example" };
    const res = buildMcpEntryPlan({
      vaultName: "default",
      vaultExplicit: false,
      port: 1940,
      env,
      existingEntryKey: "parachute-vault-legacy-name",
    });
    expect(res.entryKey).toBe("parachute-vault-legacy-name");
  });

  test("URL shape tracks chooseMcpUrl's source order (loopback when nothing configured)", () => {
    // Mirror chooseMcpUrl's contract: empty env + no expose-state ⇒ loopback.
    // Using a separate PARACHUTE_HOME so the real one's expose-state doesn't leak in.
    const origHome = process.env.PARACHUTE_HOME;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "vault-build-plan-"));
    process.env.PARACHUTE_HOME = tmpHome;
    try {
      const res = buildMcpEntryPlan({ vaultName: "default", vaultExplicit: false, port: 1940, env: {} });
      expect(res.source).toBe("loopback");
      expect(res.url).toBe("http://127.0.0.1:1940/vault/default/mcp");
    } finally {
      if (origHome === undefined) delete process.env.PARACHUTE_HOME;
      else process.env.PARACHUTE_HOME = origHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
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
    expect(res.localProjectKey).toBeUndefined();
  });

  test("project scope → <cwd>/.mcp.json", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-target-"));
    try {
      const res = resolveInstallTarget("project", tmp);
      expect(res.path).toBe(path.resolve(tmp, ".mcp.json"));
      expect(res.scope).toBe("project");
      expect(res.localProjectKey).toBeUndefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("local scope → ~/.claude.json with absolute-cwd project key", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-target-local-"));
    try {
      const res = resolveInstallTarget("local", tmp);
      // Same file as user scope — what differs is where inside the JSON
      // the entry lands (top-level vs projects[<cwd>].mcpServers).
      expect(res.path).toBe(path.resolve(os.homedir(), ".claude.json"));
      expect(res.scope).toBe("local");
      // Absolute path → matches Claude Code's own convention.
      expect(res.localProjectKey).toBe(path.resolve(tmp));
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
    expect(res.stderr).toMatch(/--install-scope must be "local", "user", or "project"/);
  });

  test("accepts --install-scope local", () => {
    setupBareVault(tmp, "default");
    const res = runCli(
      ["mcp-install", "--install-scope", "local", "--token", "t"],
      tmp,
    );
    expect(res.exitCode).toBe(0);
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

  test("rejects --mint --scope vault:admin pre-flight (hub policy: per-vault admin is non-requestable)", () => {
    // Regression for the symptom Aaron hit on hub 0.5.12-rc.2 / vault
    // 0.4.7-rc.1: `parachute vault mcp-install` with the "admin" mint
    // option sent `vault:default:admin` to `POST /api/auth/mint-token`,
    // and hub responded:
    //
    //   Hub mint-token rejected (HTTP 400, invalid_scope):
    //   scope vault:default:admin is not requestable via mint-token;
    //   use OAuth flow or operator rotation
    //
    // The combination is invalid by hub policy (see
    // `parachute-hub/src/scope-explanations.ts:VAULT_ADMIN_RE` and
    // `api-mint-token.ts`'s non-requestable guard) — per-vault admin
    // is operator-only, mintable only through the session-cookie-gated
    // `/admin/vault-admin-token/:name` SPA path.
    //
    // The fix rejects the combination pre-flight in vault's mcp-install
    // with a clear remediation pointing at `--legacy-pat --scope vault:admin`
    // (which mints a vault-DB pvt_* with admin scope — the right shape
    // for a local MCP entry needing schema management).
    setupBareVault(tmp, "default");
    fs.writeFileSync(path.join(tmp, "operator.token"), "operator-bearer-stub");
    const res = runCli(
      ["mcp-install", "--mint", "--scope", "vault:admin"],
      tmp,
      { PARACHUTE_HUB_ORIGIN: "https://hub.example.org" },
    );
    expect(res.exitCode).toBe(1);
    // Surface the policy reason so the operator knows why this combo is
    // rejected (not a transient bug).
    expect(res.stderr).toMatch(/not requestable via mint-token/);
    // Point at the working remediation.
    expect(res.stderr).toMatch(/--legacy-pat --scope vault:admin/);
    // Pre-flight must fire BEFORE the operator-token / hub-origin checks
    // pass the request to the network — no "Hub unreachable" / "No hub
    // origin configured" leak.
    expect(res.stderr).not.toMatch(/No hub origin configured/);
    expect(res.stderr).not.toMatch(/Hub unreachable/);
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

  test("--install-scope user writes top-level mcpServers in ~/.claude.json", () => {
    setupBareVault(tmp, "default");
    const res = runCli(
      ["mcp-install", "--install-scope", "user", "--token", "pasted-bearer"],
      tmp,
    );
    expect(res.exitCode).toBe(0);
    const config = readJson(path.join(tmp, ".claude.json"));
    const entry = config.mcpServers["parachute-vault"];
    expect(entry.type).toBe("http");
    expect(entry.headers.Authorization).toBe("Bearer pasted-bearer");
    expect(entry.url).toContain("/vault/default/mcp");
    // No projects[*] entry written.
    expect(config.projects).toBeUndefined();
  });

  test("default (no --install-scope) writes ~/.claude.json under projects[<cwd>].mcpServers (local)", () => {
    setupBareVault(tmp, "default");
    // CLI runs with cwd=tmp (the parachute-home temp dir). Local-scope
    // default keys the entry under projects[<cwd>] in the same file
    // user-scope uses (~/.claude.json). On macOS /tmp is a symlink to
    // /private/tmp, so the spawned process's cwd resolves through —
    // use fs.realpathSync to compute the same key the CLI will write.
    const res = runCli(
      ["mcp-install", "--token", "local-bearer"],
      tmp,
    );
    expect(res.exitCode).toBe(0);
    const config = readJson(path.join(tmp, ".claude.json"));
    // The new default is `local` — top-level mcpServers should be empty
    // or absent; the entry lives under projects[<absolute-cwd>].
    const flatEntry = config.mcpServers?.["parachute-vault"];
    expect(flatEntry).toBeUndefined();
    const projectKey = fs.realpathSync(tmp);
    const localServers = config.projects?.[projectKey]?.mcpServers ?? {};
    expect(localServers["parachute-vault"]).toBeDefined();
    expect(localServers["parachute-vault"].headers.Authorization).toBe("Bearer local-bearer");
    expect(localServers["parachute-vault"].url).toContain("/vault/default/mcp");
    // Stdout surfaces the consequence so operators know the install is
    // scoped to this directory (and how to widen if they wanted global).
    expect(res.stdout).toMatch(/this directory only/);
    expect(res.stdout).toMatch(/--install-scope user/);
    // Headless-flow heads-up: local-scope entries don't propagate to
    // claude -p subprocesses; operators wiring up runners need to know.
    expect(res.stdout).toMatch(/Headless flows/);
    expect(res.stdout).toMatch(/claude -p/);
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

  test("writer URL on disk matches buildMcpEntryPlan(env) — non-default PARACHUTE_HUB_ORIGIN (vault#302)", () => {
    // The preview ⇄ writer invariant introduced in vault#301 closed
    // `entryKey` but left `url` only-coincidentally-coherent: production
    // both branches read `process.env`, so they agreed by accident.
    // vault#302 closes the URL half too — `installMcpConfig` now receives
    // the URL from the caller's `buildMcpEntryPlan({ env, ... })` rather
    // than re-computing via a direct `chooseMcpUrl(vaultName, port)`. This
    // test exercises a non-default env so a regression that reintroduces
    // the direct `chooseMcpUrl` call (which would re-read `process.env`,
    // possibly without the test's intended override) goes red.
    setupBareVault(tmp, "default");
    const hubOrigin = "https://hub-302.example";
    const res = runCli(
      ["mcp-install", "--install-scope", "user", "--token", "pasted-302"],
      tmp,
      { PARACHUTE_HUB_ORIGIN: hubOrigin },
    );
    expect(res.exitCode).toBe(0);

    // Compute what `buildMcpEntryPlan` says the URL should be for the same
    // env the writer ran under. The writer must land exactly this URL.
    const plan = buildMcpEntryPlan({
      vaultName: "default",
      vaultExplicit: false,
      port: 1940,
      env: { PARACHUTE_HUB_ORIGIN: hubOrigin },
    });
    expect(plan.url).toBe(`${hubOrigin}/vault/default/mcp`);
    expect(plan.source).toBe("hub-origin");

    const config = readJson(path.join(tmp, ".claude.json"));
    const entry = config.mcpServers[plan.entryKey];
    expect(entry).toBeDefined();
    expect(entry.url).toBe(plan.url);
    expect(entry.headers.Authorization).toBe("Bearer pasted-302");

    // Stdout's `MCP URL:` line surfaces the same URL so an operator
    // reading the log sees what landed (was the same `url` variable
    // pre-#302 by coincidence; this pins it explicitly).
    expect(res.stdout).toContain(`MCP URL: ${plan.url}`);
  });

  test("--install-scope local writes ~/.claude.json under projects[<cwd>].mcpServers", () => {
    setupBareVault(tmp, "default");
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-mcp-local-"));
    try {
      const res = runCli(
        ["mcp-install", "--install-scope", "local", "--token", "local-bearer"],
        tmp,
        {},
        projectDir,
      );
      expect(res.exitCode).toBe(0);
      // Local writes to ~/.claude.json under projects[<absolute-cwd>].
      // Not <cwd>/.mcp.json (that's project scope).
      expect(fs.existsSync(path.join(projectDir, ".mcp.json"))).toBe(false);
      expect(fs.existsSync(path.join(tmp, ".claude.json"))).toBe(true);
      const config = readJson(path.join(tmp, ".claude.json"));
      const projectKey = fs.realpathSync(projectDir);
      const entry = config.projects[projectKey].mcpServers["parachute-vault"];
      expect(entry.type).toBe("http");
      expect(entry.headers.Authorization).toBe("Bearer local-bearer");
      expect(entry.url).toContain("/vault/default/mcp");
      // No top-level entry written for local scope.
      expect(config.mcpServers?.["parachute-vault"]).toBeUndefined();
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("--install-scope local preserves an existing top-level entry untouched", () => {
    setupBareVault(tmp, "default");
    // Pre-seed ~/.claude.json with a top-level user-scope entry from some
    // other client. The local install must not clobber it.
    fs.writeFileSync(
      path.join(tmp, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "some-other-server": { type: "http", url: "https://other.example/mcp" },
        },
      }),
    );
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-mcp-local-pre-"));
    try {
      const res = runCli(
        ["mcp-install", "--install-scope", "local", "--token", "t"],
        tmp,
        {},
        projectDir,
      );
      expect(res.exitCode).toBe(0);
      const config = readJson(path.join(tmp, ".claude.json"));
      // Pre-existing top-level entry preserved.
      expect(config.mcpServers["some-other-server"]).toBeDefined();
      // New local entry under projects[<cwd>].
      const projectKey = fs.realpathSync(projectDir);
      expect(config.projects[projectKey].mcpServers["parachute-vault"]).toBeDefined();
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("--install-scope local preserves a pre-existing project's other mcp servers", () => {
    setupBareVault(tmp, "default");
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-mcp-local-coexist-"));
    const projectKey = fs.realpathSync(projectDir);
    // Pre-seed a projects[cwd] entry with an unrelated MCP server +
    // additional fields. The install must not blow them away.
    fs.writeFileSync(
      path.join(tmp, ".claude.json"),
      JSON.stringify({
        projects: {
          [projectKey]: {
            allowedTools: ["Bash(ls:*)"],
            mcpServers: {
              "glif": { type: "http", url: "https://glif.example/mcp" },
            },
          },
        },
      }),
    );
    try {
      const res = runCli(
        ["mcp-install", "--install-scope", "local", "--token", "t"],
        tmp,
        {},
        projectDir,
      );
      expect(res.exitCode).toBe(0);
      const config = readJson(path.join(tmp, ".claude.json"));
      // Pre-existing sibling preserved.
      expect(config.projects[projectKey].mcpServers["glif"]).toBeDefined();
      // Pre-existing non-mcpServers field preserved.
      expect(config.projects[projectKey].allowedTools).toEqual(["Bash(ls:*)"]);
      // New entry added.
      expect(config.projects[projectKey].mcpServers["parachute-vault"]).toBeDefined();
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("--vault <name> keys the entry as parachute-vault-<name> (user scope)", () => {
    setupBareVault(tmp, "default");
    setupBareVault(tmp, "work");
    // Install for the second vault under user scope — singular slot
    // stays free for the default. Multi-vault is the motivation.
    const res = runCli(
      ["mcp-install", "--install-scope", "user", "--vault", "work", "--token", "work-bearer"],
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

  test("--vault without an explicit name uses the default and keys the singular slot (user scope)", () => {
    setupBareVault(tmp, "default");
    const res = runCli(
      ["mcp-install", "--install-scope", "user", "--token", "default-bearer"],
      tmp,
    );
    expect(res.exitCode).toBe(0);
    const config = readJson(path.join(tmp, ".claude.json"));
    expect(config.mcpServers["parachute-vault"]).toBeDefined();
    // Per-vault key for the default vault is NOT written when --vault wasn't
    // explicit; the singular slot is the canonical single-install shape.
    expect(config.mcpServers["parachute-vault-default"]).toBeUndefined();
  });

  test("--legacy-pat mints a vault-DB pvt_* token and prints deprecation warning", () => {
    setupBareVault(tmp, "default");
    const res = runCli(["mcp-install", "--install-scope", "user", "--legacy-pat"], tmp);
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

  test("--dry-run describes the write without touching disk or hitting the hub", () => {
    // Aaron hit this when probing `mcp-install --help`: the bare CLI
    // dispatch was creating an empty `projects[<cwd>]` slot in
    // ~/.claude.json as a side effect of writing the install. --dry-run
    // is the deliberate "tell me what you'd do" path.
    setupBareVault(tmp, "default");
    const res = runCli(
      ["mcp-install", "--install-scope", "user", "--token", "should-not-be-used", "--dry-run"],
      tmp,
    );
    expect(res.exitCode).toBe(0);
    // No claude.json should exist: the install was inhibited.
    expect(fs.existsSync(path.join(tmp, ".claude.json"))).toBe(false);
    // The dry-run output names target file, entry key, URL, and how to apply.
    expect(res.stdout).toMatch(/\[dry-run\]/);
    expect(res.stdout).toMatch(/Target file:/);
    expect(res.stdout).toMatch(/Entry key:\s+parachute-vault/);
    expect(res.stdout).toMatch(/MCP URL:/);
    expect(res.stdout).toMatch(/Re-run without --dry-run to apply\./);
  });

  test("--dry-run works for a vault that doesn't exist yet (probe shape)", () => {
    // The dry-run contract is "no side effects, including failures on
    // state the caller is asking about." A future-vault probe — would
    // installing for this not-yet-created vault land where I expect? —
    // is a legitimate pre-create check, not an error. The
    // vault-existence guard runs only on the real-install path.
    setupBareVault(tmp, "default");
    const res = runCli(
      ["mcp-install", "--vault", "future-vault", "--token", "t", "--dry-run"],
      tmp,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/\[dry-run\]/);
    // Output names the absent vault explicitly so the operator can tell
    // the dry-run worked against the right target.
    expect(res.stdout).toMatch(/Vault:\s+future-vault/);
    expect(res.stdout).toMatch(/does not exist yet/);
    expect(res.stdout).toMatch(/Entry key:\s+parachute-vault-future-vault/);
    // No claude.json written — dry-run still didn't touch disk.
    expect(fs.existsSync(path.join(tmp, ".claude.json"))).toBe(false);
  });

  test("--dry-run with --mint skips the hub round-trip and operator-token check", () => {
    // The whole point of --dry-run is "no side effects" — that includes
    // the hub-mint network call. A naive implementation might still try
    // to read operator.token and fail before the dry-run print fires.
    setupBareVault(tmp, "default");
    // Deliberately no operator.token file present, no PARACHUTE_HUB_ORIGIN.
    const res = runCli(["mcp-install", "--dry-run"], tmp, { PARACHUTE_HUB_ORIGIN: "" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toMatch(/\[dry-run\]/);
    expect(res.stderr).not.toMatch(/No operator token found/);
    expect(res.stderr).not.toMatch(/No hub origin configured/);
  });

  test("subsequent --token install on top of an existing entry overwrites the bearer (user scope)", () => {
    setupBareVault(tmp, "default");
    runCli(["mcp-install", "--install-scope", "user", "--token", "first"], tmp);
    const res = runCli(["mcp-install", "--install-scope", "user", "--token", "second"], tmp);
    expect(res.exitCode).toBe(0);
    const config = readJson(path.join(tmp, ".claude.json"));
    expect(config.mcpServers["parachute-vault"].headers.Authorization).toBe("Bearer second");
  });

  test("subsequent --token install in local scope overwrites the bearer at projects[<cwd>]", () => {
    setupBareVault(tmp, "default");
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-mcp-local-update-"));
    try {
      runCli(["mcp-install", "--install-scope", "local", "--token", "first"], tmp, {}, projectDir);
      const res = runCli(["mcp-install", "--install-scope", "local", "--token", "second"], tmp, {}, projectDir);
      expect(res.exitCode).toBe(0);
      const config = readJson(path.join(tmp, ".claude.json"));
      const projectKey = fs.realpathSync(projectDir);
      expect(config.projects[projectKey].mcpServers["parachute-vault"].headers.Authorization).toBe("Bearer second");
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("removeMcpConfig walks every projects[*] slot regardless of cwd", () => {
    // Pins the cwd-agnostic property of removeMcpConfig's local-scope walk.
    // Called directly rather than via subprocess `uninstall --yes` because
    // the CLI uninstall also runs `uninstallAgent()` against the real
    // launchd label `computer.parachute.vault` — not isolated by
    // PARACHUTE_HOME, so a subprocess test would nuke a real registered
    // daemon. Direct call keeps the test focused on the cleanup walk,
    // which is the property the reviewer flagged as untested.
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "vault-rmcfg-home-"));
    const cwdA = "/Users/imaginary/projectA";
    const cwdB = "/Users/imaginary/projectB";
    const claudePath = path.join(fakeHome, ".claude.json");
    fs.writeFileSync(
      claudePath,
      JSON.stringify({
        mcpServers: { "parachute-vault": { type: "http", url: "user-scope" } },
        projects: {
          [cwdA]: {
            allowedTools: ["Bash(ls:*)"],
            mcpServers: {
              "parachute-vault": { type: "http", url: "a" },
              "some-other-server": { type: "http", url: "kept-a" },
            },
          },
          [cwdB]: {
            mcpServers: {
              "parachute-vault-extra": { type: "http", url: "b1" },
              "parachute-vault/legacy": { type: "http", url: "b2-legacy" },
              "kept-server": { type: "http", url: "kept-b" },
            },
          },
        },
      }) + "\n",
    );

    // Bun's `os.homedir()` reads `process.env.HOME` first — swapping it for
    // the duration of the call routes the cleanup at fakeHome's .claude.json,
    // not the real user's. Restored in `finally`.
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "vault-rmcfg-cwd-"));
    const origHome = process.env.HOME;
    const origCwd = process.cwd();
    try {
      process.env.HOME = fakeHome;
      process.chdir(elsewhere);
      removeMcpConfig();
    } finally {
      process.chdir(origCwd);
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }

    const after = JSON.parse(fs.readFileSync(claudePath, "utf-8"));

    // User-scope: stripped.
    expect(after.mcpServers["parachute-vault"]).toBeUndefined();

    // projectA: vault entry gone, sibling MCP + allowedTools preserved.
    expect(after.projects[cwdA].mcpServers["parachute-vault"]).toBeUndefined();
    expect(after.projects[cwdA].mcpServers["some-other-server"]).toBeDefined();
    expect(after.projects[cwdA].allowedTools).toEqual(["Bash(ls:*)"]);

    // projectB: per-vault `parachute-vault-*` + legacy slash-form gone,
    // unrelated sibling preserved.
    expect(after.projects[cwdB].mcpServers["parachute-vault-extra"]).toBeUndefined();
    expect(after.projects[cwdB].mcpServers["parachute-vault/legacy"]).toBeUndefined();
    expect(after.projects[cwdB].mcpServers["kept-server"]).toBeDefined();

    fs.rmSync(fakeHome, { recursive: true, force: true });
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

// ---------------------------------------------------------------------------
// Uninstall flow — end-to-end with --skip-daemon (vault#296)
// ---------------------------------------------------------------------------
//
// `parachute-vault uninstall` calls `uninstallAgent()` which targets the
// hardcoded launchd label `computer.parachute.vault`. That label ignores
// `PARACHUTE_HOME`, so a naive subprocess test would `launchctl bootout`
// the real daemon on the developer's machine. `--skip-daemon` bypasses the
// launchd / systemd / backup-agent uninstall calls so tests can exercise
// the rest of the flow (wrapper removal, MCP cleanup, exit codes, ordering)
// without touching real operator state.

describe("cmdUninstall --skip-daemon (isolation flag for tests)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-uninstall-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("removes wrapper + server-path pointer + MCP entry, never touches real launchd", () => {
    // Stage the post-init artifacts uninstall is responsible for clearing:
    //   - start.sh wrapper (would otherwise need `bun:sqlite` + a real init)
    //   - server-path pointer
    //   - a vault MCP entry in the sandbox ~/.claude.json
    const vaultHome = path.join(tmp, "vault");
    fs.mkdirSync(vaultHome, { recursive: true });
    fs.writeFileSync(path.join(vaultHome, "start.sh"), "#!/bin/bash\necho stub\n", { mode: 0o755 });
    fs.writeFileSync(path.join(vaultHome, "server-path"), "/imaginary/server.ts\n");
    const claudePath = path.join(tmp, ".claude.json");
    fs.writeFileSync(
      claudePath,
      JSON.stringify({
        mcpServers: { "parachute-vault": { type: "http", url: "stub" } },
      }) + "\n",
    );

    const res = runCli(["uninstall", "--yes", "--skip-daemon"], tmp);

    expect(res.exitCode).toBe(0);

    // The flag must surface in stdout so a future maintainer reading a CI
    // log can tell the daemon step was skipped intentionally (vs. silently
    // by a future regression).
    expect(res.stdout).toContain("Skipping daemon removal (--skip-daemon).");

    // Wrapper + pointer gone — that's the "shared across platforms" step
    // immediately after daemon removal, so this pins the ordering invariant
    // that --skip-daemon doesn't short-circuit the rest of the flow.
    expect(fs.existsSync(path.join(vaultHome, "start.sh"))).toBe(false);
    expect(fs.existsSync(path.join(vaultHome, "server-path"))).toBe(false);

    // MCP cleanup ran — the vault entry is gone from ~/.claude.json.
    const after = readJson(claudePath);
    expect(after.mcpServers).toBeDefined();
    expect(after.mcpServers["parachute-vault"]).toBeUndefined();

    // "Done. To reinstall: `parachute-vault init`." is the closing
    // confirmation. Its presence means the function ran to completion;
    // its absence on a future regression would catch an early-return bug.
    expect(res.stdout).toContain("Done. To reinstall:");
  });

  test("--skip-daemon leaves user data alone without --wipe", () => {
    // The wipe-confirm branch is independent of the daemon branch; this
    // pins that --skip-daemon doesn't accidentally promote to a destructive
    // wipe. Seed a vaults dir, run uninstall without --wipe, assert it
    // still exists afterward.
    const vaultHome = path.join(tmp, "vault");
    const dataDir = path.join(vaultHome, "data", "default");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "vault.db"), "stub\n");

    const res = runCli(["uninstall", "--yes", "--skip-daemon"], tmp);

    expect(res.exitCode).toBe(0);
    expect(fs.existsSync(path.join(dataDir, "vault.db"))).toBe(true);
    // No wipe banner should appear.
    expect(res.stdout).not.toMatch(/User data removed/);
    expect(res.stdout).toContain("User data (~/.parachute/vault/) is left alone");
  });

  test("--skip-daemon + --wipe removes vault data (composes with destructive path)", () => {
    // Pin that --skip-daemon is purely the daemon-call escape hatch — it
    // does not gate or alter the --wipe semantics. A scripted destructive
    // test (CI cleanup, fresh-machine setup) must still see --wipe work.
    const vaultHome = path.join(tmp, "vault");
    const dataDir = path.join(vaultHome, "data", "default");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "vault.db"), "stub\n");
    fs.writeFileSync(path.join(vaultHome, ".env"), "PORT=1940\n");

    const res = runCli(["uninstall", "--yes", "--wipe", "--skip-daemon"], tmp);

    expect(res.exitCode).toBe(0);
    expect(fs.existsSync(path.join(vaultHome, "data"))).toBe(false);
    expect(fs.existsSync(path.join(vaultHome, ".env"))).toBe(false);
    expect(res.stdout).toMatch(/scripted destructive wipe/);
    expect(res.stdout).toContain("User data removed");
  });
});
