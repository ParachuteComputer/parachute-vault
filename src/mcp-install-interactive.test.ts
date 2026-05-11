/**
 * Tests for the interactive walkthrough.
 *
 * Two layers:
 *
 *   1. Unit tests for `runInteractiveInstall` driven by a mock `InteractiveIO`
 *      with pre-canned answers. These pin the prompt-by-prompt flow without
 *      touching readline / stdin — every branch of the decision tree gets a
 *      direct fixture.
 *
 *   2. Integration tests for `detectInstallContext` + project / existing-entry
 *      detection helpers — the context the walkthrough reads from.
 *
 * CLI-level dispatch (TTY-detect, no-flag → interactive) is covered in
 * `mcp-install.test.ts` since spawning a subprocess is the right shape
 * for "what does `mcp-install` actually do."
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectExistingEntries,
  detectInstallContext,
  detectProjectContext,
  type ExistingMcpEntry,
  type InstallContext,
} from "./mcp-install.ts";
import {
  runInteractiveInstall,
  type InteractiveIO,
} from "./mcp-install-interactive.ts";

// ---------------------------------------------------------------------------
// Mock IO: queue answers + capture log output
// ---------------------------------------------------------------------------

interface MockIOState {
  /** Pre-canned answers, consumed in order. `null` means "press Enter on default". */
  answers: (string | boolean | null)[];
  /** Captured log lines, in order. */
  logs: string[];
  /** Captured (question, default) pairs from ask + confirm, in order. */
  prompts: { kind: "ask" | "confirm"; question: string; default: string | boolean }[];
}

function mockIO(answers: (string | boolean | null)[]): { io: InteractiveIO; state: MockIOState } {
  const state: MockIOState = { answers: [...answers], logs: [], prompts: [] };
  const io: InteractiveIO = {
    log: (line) => state.logs.push(line),
    ask: async (question, defaultValue) => {
      state.prompts.push({ kind: "ask", question, default: defaultValue });
      if (state.answers.length === 0) {
        throw new Error(`mock IO exhausted on ask("${question}", "${defaultValue}")`);
      }
      const next = state.answers.shift();
      if (next === null) return defaultValue;
      if (typeof next !== "string") {
        throw new Error(`mock IO got non-string for ask: ${String(next)}`);
      }
      return next;
    },
    confirm: async (question, defaultYes) => {
      state.prompts.push({ kind: "confirm", question, default: defaultYes });
      if (state.answers.length === 0) {
        throw new Error(`mock IO exhausted on confirm("${question}", ${defaultYes})`);
      }
      const next = state.answers.shift();
      if (next === null) return defaultYes;
      if (typeof next !== "boolean") {
        throw new Error(`mock IO got non-boolean for confirm: ${String(next)}`);
      }
      return next;
    },
  };
  return { io, state };
}

/** Build a baseline context the walkthrough can chew on. Override fields per-test. */
function baseCtx(overrides: Partial<InstallContext> = {}): InstallContext {
  return {
    vaults: ["default"],
    defaultVault: "default",
    hubReachable: true,
    hubOrigin: "https://hub.example",
    operatorTokenPresent: true,
    inProjectContext: false,
    cwd: "/tmp/cwd",
    existing: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Decision-tree tests for the walkthrough
// ---------------------------------------------------------------------------

describe("runInteractiveInstall — decision tree", () => {
  test("single vault + no project context + can mint: walkthrough auto-picks vault and installs user-scope mint at vault:read", async () => {
    const { io, state } = mockIO([
      null, // accept "mint" with vault:read scope
      true, // proceed
    ]);
    const result = await runInteractiveInstall(baseCtx(), io);
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    expect(result.mode).toBe("mint");
    expect(result.scope).toBe("vault:read");
    expect(result.installScope).toBe("user");
    expect(result.vaultName).toBe("default");
    expect(result.vaultExplicit).toBe(false);
    // Vault prompt is skipped (single vault), install-scope prompt is
    // skipped (no project markers → user is automatic), and we hit the
    // auth prompt + final confirm.
    expect(state.prompts.map((p) => p.kind)).toEqual(["ask", "confirm"]);
  });

  test("multi-vault: walkthrough asks which vault and respects the choice", async () => {
    const { io, state } = mockIO([
      "boulder", // pick vault "boulder"
      null,       // accept mint with vault:read
      true,       // proceed
    ]);
    const result = await runInteractiveInstall(
      baseCtx({ vaults: ["default", "boulder", "techne"] }),
      io,
    );
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    expect(result.vaultName).toBe("boulder");
    // vaultExplicit only true when picking a non-default vault; here
    // default_vault="default" but we picked "boulder" → explicit.
    expect(result.vaultExplicit).toBe(true);
    expect(state.prompts[0]!.question).toMatch(/Which vault/i);
  });

  test("multi-vault: pressing Enter accepts the default_vault and is not marked explicit", async () => {
    const { io } = mockIO([null, null, true]); // accept default vault, accept mint, proceed
    const result = await runInteractiveInstall(
      baseCtx({ vaults: ["default", "boulder"] }),
      io,
    );
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    expect(result.vaultName).toBe("default");
    expect(result.vaultExplicit).toBe(false);
  });

  test("project context: walkthrough suggests project-scope install (default Y)", async () => {
    const { io, state } = mockIO([
      null, // accept project-scope default
      null, // accept mint with vault:read
      true, // proceed
    ]);
    const result = await runInteractiveInstall(
      baseCtx({ inProjectContext: true, cwd: "/home/user/code/myproject" }),
      io,
    );
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    expect(result.installScope).toBe("project");
    expect(state.prompts[0]!.kind).toBe("confirm");
    expect(state.prompts[0]!.question).toMatch(/this project/i);
    expect(state.prompts[0]!.default).toBe(true);
  });

  test("project context but operator declines: install scope falls to user", async () => {
    const { io } = mockIO([
      false, // decline project scope
      null,  // accept mint
      true,  // proceed
    ]);
    const result = await runInteractiveInstall(
      baseCtx({ inProjectContext: true }),
      io,
    );
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    expect(result.installScope).toBe("user");
  });

  test("hub not reachable: walkthrough offers paste vs legacy (no mint option)", async () => {
    const { io, state } = mockIO([
      "legacy", // pick legacy-pat
      true,     // proceed
    ]);
    const result = await runInteractiveInstall(
      baseCtx({ hubReachable: false }),
      io,
    );
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    expect(result.mode).toBe("legacy-pat");
    // Auth prompt should explain the no-hub state.
    expect(state.logs.some((l) => /Hub-mint isn't available/.test(l))).toBe(true);
  });

  test("hub reachable but no operator.token: also offers paste vs legacy", async () => {
    const { io, state } = mockIO([
      "paste",      // pick paste
      "pasted-jwt", // the bearer
      true,         // proceed
    ]);
    const result = await runInteractiveInstall(
      baseCtx({ operatorTokenPresent: false }),
      io,
    );
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    expect(result.mode).toBe("token");
    expect(result.pastedToken).toBe("pasted-jwt");
    expect(state.logs.some((l) => /no operator token/i.test(l))).toBe(true);
  });

  test("scope widening: typing 'write' produces vault:write mint", async () => {
    const { io } = mockIO([
      "write", // widen scope
      true,    // proceed
    ]);
    const result = await runInteractiveInstall(baseCtx(), io);
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    expect(result.mode).toBe("mint");
    expect(result.scope).toBe("vault:write");
  });

  test("scope widening: typing 'admin' produces vault:admin mint", async () => {
    const { io } = mockIO([
      "admin",
      true,
    ]);
    const result = await runInteractiveInstall(baseCtx(), io);
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    expect(result.scope).toBe("vault:admin");
  });

  test("typing 'paste' at the auth prompt switches to token mode + asks for token", async () => {
    const { io } = mockIO([
      "paste",           // switch to paste
      "my-existing-jwt", // the bearer
      true,              // proceed
    ]);
    const result = await runInteractiveInstall(baseCtx(), io);
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    expect(result.mode).toBe("token");
    expect(result.pastedToken).toBe("my-existing-jwt");
  });

  test("typing 'legacy' at the auth prompt switches to legacy-pat", async () => {
    const { io } = mockIO([
      "legacy",
      true,
    ]);
    const result = await runInteractiveInstall(baseCtx(), io);
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    expect(result.mode).toBe("legacy-pat");
  });

  test("existing entry at user scope: walkthrough leads with 'update it?' (default Y)", async () => {
    const existing: ExistingMcpEntry = {
      path: "/home/user/.claude.json",
      label: "~/.claude.json",
      scope: "user",
      entryKey: "parachute-vault",
      url: "https://hub.example/vault/default/mcp",
      hasAuth: true,
    };
    const { io, state } = mockIO([
      true,  // update it
      null,  // accept mint
      true,  // proceed
    ]);
    const result = await runInteractiveInstall(
      baseCtx({ existing: { user: existing } }),
      io,
    );
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    // Update path pins install scope + vault from existing entry, so the
    // walkthrough should NOT re-prompt for those.
    expect(result.installScope).toBe("user");
    expect(result.vaultName).toBe("default");
    expect(state.prompts[0]!.question).toMatch(/Update it/i);
    expect(state.prompts[0]!.default).toBe(true);
  });

  test("existing entry: declining the update prompt continues to fresh-pick", async () => {
    const existing: ExistingMcpEntry = {
      path: "/home/user/.claude.json",
      label: "~/.claude.json",
      scope: "user",
      entryKey: "parachute-vault",
      url: "https://hub.example/vault/default/mcp",
      hasAuth: true,
    };
    const { io } = mockIO([
      false, // decline update
      null,  // accept mint
      true,  // proceed
    ]);
    const result = await runInteractiveInstall(
      baseCtx({ existing: { user: existing } }),
      io,
    );
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    // Default flow resumed — user scope (no project context), default vault.
    expect(result.installScope).toBe("user");
  });

  test("aborts cleanly when the operator declines the final confirm", async () => {
    const { io, state } = mockIO([
      null,  // accept mint
      false, // decline final confirm
    ]);
    const result = await runInteractiveInstall(baseCtx(), io);
    expect(result).toBe("abort");
    expect(state.logs.some((l) => /Aborted/.test(l))).toBe(true);
  });

  test("no vaults at all: aborts immediately with remediation", async () => {
    const { io, state } = mockIO([]); // no answers needed; should bail before prompting
    const result = await runInteractiveInstall(baseCtx({ vaults: [] }), io);
    expect(result).toBe("abort");
    expect(state.logs.some((l) => /No vaults found/.test(l))).toBe(true);
    expect(state.prompts).toHaveLength(0);
  });

  test("'help' input on the auth prompt re-prompts after showing explanation", async () => {
    const { io, state } = mockIO([
      "help", // ask for help
      null,   // then accept mint
      true,   // proceed
    ]);
    const result = await runInteractiveInstall(baseCtx(), io);
    expect(result).not.toBe("abort");
    // The help text should have been logged between the two ask calls.
    // It enumerates the choices (mint / write / admin / paste / legacy);
    // matching on the "Choices:" header keeps the assertion stable
    // against future re-wording of individual lines.
    const helpLogged = state.logs.some((l) => /Choices:/.test(l) && /paste/.test(l) && /legacy/.test(l));
    expect(helpLogged).toBe(true);
  });

  test("invalid input at vault prompt re-prompts with the error", async () => {
    const { io, state } = mockIO([
      "ghost",   // unknown vault
      "boulder", // pick a real one
      null,      // accept mint
      true,      // proceed
    ]);
    const result = await runInteractiveInstall(
      baseCtx({ vaults: ["default", "boulder"] }),
      io,
    );
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    expect(result.vaultName).toBe("boulder");
    // Error message should have been logged.
    const errLogged = state.logs.some((l) => /unknown vault/i.test(l));
    expect(errLogged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Context-detection helpers
// ---------------------------------------------------------------------------

describe("detectProjectContext", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-project-ctx-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("empty directory: not a project", () => {
    expect(detectProjectContext(tmp)).toBe(false);
  });

  test("directory with .git: is a project", () => {
    fs.mkdirSync(path.join(tmp, ".git"));
    expect(detectProjectContext(tmp)).toBe(true);
  });

  test("directory with package.json: is a project", () => {
    fs.writeFileSync(path.join(tmp, "package.json"), "{}");
    expect(detectProjectContext(tmp)).toBe(true);
  });

  test("directory with pyproject.toml: is a project", () => {
    fs.writeFileSync(path.join(tmp, "pyproject.toml"), "[project]\n");
    expect(detectProjectContext(tmp)).toBe(true);
  });

  test("directory with Cargo.toml: is a project", () => {
    fs.writeFileSync(path.join(tmp, "Cargo.toml"), "[package]\n");
    expect(detectProjectContext(tmp)).toBe(true);
  });

  test("does NOT walk up to find a marker — shallow only", () => {
    // .git in tmp, but we ask about tmp/subdir.
    fs.mkdirSync(path.join(tmp, ".git"));
    fs.mkdirSync(path.join(tmp, "subdir"));
    expect(detectProjectContext(path.join(tmp, "subdir"))).toBe(false);
  });
});

describe("detectExistingEntries", () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "vault-existing-home-"));
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), "vault-existing-cwd-"));
    origHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  test("no files present: returns empty", () => {
    expect(detectExistingEntries(tmpCwd)).toEqual({});
  });

  test("detects singular parachute-vault entry at user scope", () => {
    fs.writeFileSync(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "parachute-vault": {
            type: "http",
            url: "https://hub.example/vault/default/mcp",
            headers: { Authorization: "Bearer x" },
          },
        },
      }),
    );
    const found = detectExistingEntries(tmpCwd);
    expect(found.user).toBeDefined();
    expect(found.user!.scope).toBe("user");
    expect(found.user!.entryKey).toBe("parachute-vault");
    expect(found.user!.hasAuth).toBe(true);
  });

  test("detects per-vault parachute-vault-<name> entry at project scope", () => {
    fs.writeFileSync(
      path.join(tmpCwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "parachute-vault-work": {
            type: "http",
            url: "https://hub.example/vault/work/mcp",
          },
        },
      }),
    );
    const found = detectExistingEntries(tmpCwd);
    expect(found.project).toBeDefined();
    expect(found.project!.scope).toBe("project");
    expect(found.project!.entryKey).toBe("parachute-vault-work");
    expect(found.project!.hasAuth).toBe(false);
  });

  test("prefers singular slot over per-vault entries when both exist in one file", () => {
    fs.writeFileSync(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "parachute-vault-other": {
            type: "http",
            url: "https://hub.example/vault/other/mcp",
          },
          "parachute-vault": {
            type: "http",
            url: "https://hub.example/vault/default/mcp",
          },
        },
      }),
    );
    const found = detectExistingEntries(tmpCwd);
    expect(found.user!.entryKey).toBe("parachute-vault");
  });

  test("malformed JSON does not throw — silently skipped", () => {
    fs.writeFileSync(path.join(tmpHome, ".claude.json"), "{ not json");
    expect(detectExistingEntries(tmpCwd)).toEqual({});
  });
});

describe("detectInstallContext", () => {
  let tmpHome: string;
  let origHome: string | undefined;
  let origParachuteHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "vault-detect-ctx-"));
    origHome = process.env.HOME;
    origParachuteHome = process.env.PARACHUTE_HOME;
    process.env.HOME = tmpHome;
    process.env.PARACHUTE_HOME = tmpHome;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origParachuteHome === undefined) delete process.env.PARACHUTE_HOME;
    else process.env.PARACHUTE_HOME = origParachuteHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test("with hub origin env + operator.token: hubReachable + operatorTokenPresent both true", () => {
    fs.writeFileSync(path.join(tmpHome, "operator.token"), "operator-bearer");
    const ctx = detectInstallContext({
      vaults: ["default"],
      defaultVault: "default",
      port: 1940,
      env: { PARACHUTE_HUB_ORIGIN: "https://hub.example", PARACHUTE_HOME: tmpHome, HOME: tmpHome },
    });
    expect(ctx.hubReachable).toBe(true);
    expect(ctx.hubOrigin).toBe("https://hub.example");
    expect(ctx.operatorTokenPresent).toBe(true);
  });

  test("without hub origin: hubReachable is false and origin is loopback", () => {
    const ctx = detectInstallContext({
      vaults: ["default"],
      defaultVault: "default",
      port: 1940,
      env: { PARACHUTE_HOME: tmpHome, HOME: tmpHome },
    });
    expect(ctx.hubReachable).toBe(false);
    expect(ctx.hubOrigin).toBe("http://127.0.0.1:1940");
  });

  test("without operator.token: operatorTokenPresent is false", () => {
    const ctx = detectInstallContext({
      vaults: ["default"],
      defaultVault: "default",
      port: 1940,
      env: { PARACHUTE_HUB_ORIGIN: "https://hub.example", PARACHUTE_HOME: tmpHome, HOME: tmpHome },
    });
    expect(ctx.operatorTokenPresent).toBe(false);
  });
});
