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
  buildMcpEntryPlan,
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

const CLI = path.resolve(import.meta.dir, "cli.ts");

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
    port: 1940,
    env: { PARACHUTE_HUB_ORIGIN: "https://hub.example" },
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
  test("single vault + no project context + can mint: prompts for install scope (defaults local), then mint at vault:read", async () => {
    const { io, state } = mockIO([
      null, // accept install-scope default ("local")
      null, // accept "mint" with vault:read scope
      true, // proceed
    ]);
    const result = await runInteractiveInstall(baseCtx(), io);
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    expect(result.mode).toBe("mint");
    expect(result.scope).toBe("vault:read");
    // No project markers → suggested default is `local` (matches Claude
    // Code's `claude mcp add` default). The walkthrough always prompts.
    expect(result.installScope).toBe("local");
    expect(result.vaultName).toBe("default");
    expect(result.vaultExplicit).toBe(false);
    // Vault prompt skipped (single vault). Install-scope is now an ask
    // (not a confirm) — always fires. Then auth ask + final confirm.
    expect(state.prompts.map((p) => p.kind)).toEqual(["ask", "ask", "confirm"]);
  });

  test("multi-vault: walkthrough asks which vault and respects the choice", async () => {
    const { io, state } = mockIO([
      "boulder", // pick vault "boulder"
      null,       // accept install-scope default
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
    const { io } = mockIO([null, null, null, true]); // vault, install-scope, mint, proceed
    const result = await runInteractiveInstall(
      baseCtx({ vaults: ["default", "boulder"] }),
      io,
    );
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    expect(result.vaultName).toBe("default");
    expect(result.vaultExplicit).toBe(false);
  });

  test("project context: walkthrough suggests project-scope install as the default", async () => {
    const { io, state } = mockIO([
      null, // accept install-scope default (project, because markers detected)
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
    // First prompt is the install-scope ask; default tilts to "project"
    // when project markers are present in cwd.
    expect(state.prompts[0]!.kind).toBe("ask");
    expect(state.prompts[0]!.default).toBe("project");
  });

  test("project context but operator picks user: install scope falls to user", async () => {
    const { io } = mockIO([
      "user", // override the project-scope default → user
      null,   // accept mint
      true,   // proceed
    ]);
    const result = await runInteractiveInstall(
      baseCtx({ inProjectContext: true }),
      io,
    );
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    expect(result.installScope).toBe("user");
  });

  test("no project markers: install-scope prompt still fires and defaults to local", async () => {
    const { io, state } = mockIO([
      null, // accept install-scope default (local)
      null, // accept mint
      true, // proceed
    ]);
    const result = await runInteractiveInstall(
      baseCtx({ inProjectContext: false, cwd: "/Gitcoin" }),
      io,
    );
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    // This is the dogfood-feedback case: operator is in a plain
    // directory (no .git, no package.json). The walkthrough must NOT
    // silently autopilot to user scope — always prompt.
    expect(result.installScope).toBe("local");
    expect(state.prompts.find((p) => p.kind === "ask" && p.default === "local")).toBeDefined();
  });

  test("no project markers: operator can choose user explicitly", async () => {
    const { io } = mockIO([
      "user", // override default
      null,   // accept mint
      true,   // proceed
    ]);
    const result = await runInteractiveInstall(
      baseCtx({ inProjectContext: false }),
      io,
    );
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    expect(result.installScope).toBe("user");
  });

  test("install-scope prompt: invalid value re-prompts with help affordance", async () => {
    const { io, state } = mockIO([
      "everywhere", // invalid
      "local",       // valid
      null,          // accept mint
      true,          // proceed
    ]);
    const result = await runInteractiveInstall(baseCtx(), io);
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    expect(result.installScope).toBe("local");
    expect(state.logs.some((l) => /expected one of/.test(l))).toBe(true);
  });

  test("hub not reachable: walkthrough offers paste vs legacy (no mint option)", async () => {
    const { io, state } = mockIO([
      null,     // accept install-scope default
      "legacy", // pick legacy-pat
      null,     // accept default scope (read) on the F2 scope prompt
      true,     // proceed
    ]);
    const result = await runInteractiveInstall(
      baseCtx({ hubReachable: false }),
      io,
    );
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    expect(result.mode).toBe("legacy-pat");
    expect(result.scope).toBe("vault:read");
    // Auth prompt should explain the no-hub state.
    expect(state.logs.some((l) => /Hub-mint isn't available/.test(l))).toBe(true);
  });

  test("hub reachable but no operator.token: also offers paste vs legacy", async () => {
    const { io, state } = mockIO([
      null,         // accept install-scope default
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
      null,    // accept install-scope default
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
      null,    // accept install-scope default
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
      null,              // accept install-scope default
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

  test("typing 'legacy' at the auth prompt switches to legacy-pat with default scope", async () => {
    const { io } = mockIO([
      null,    // accept install-scope default
      "legacy",
      null,    // accept default scope (read) on the F2 scope prompt
      true,
    ]);
    const result = await runInteractiveInstall(baseCtx(), io);
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    expect(result.mode).toBe("legacy-pat");
    expect(result.scope).toBe("vault:read");
  });

  test("legacy-pat path: typing 'write' on the scope prompt widens to vault:write (F2)", async () => {
    const { io, state } = mockIO([
      null,       // accept install-scope default
      "legacy",   // pick legacy-pat
      "write",    // widen scope
      true,       // proceed
    ]);
    const result = await runInteractiveInstall(baseCtx(), io);
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    expect(result.mode).toBe("legacy-pat");
    expect(result.scope).toBe("vault:write");
    // Scope-prompt wording must match the mint path's "least privilege" framing.
    expect(state.prompts.some((p) => /least privilege/.test(p.question))).toBe(true);
  });

  test("legacy-pat path (no-hub branch): scope prompt also fires (F2)", async () => {
    const { io } = mockIO([
      null,      // accept install-scope default
      "legacy",  // pick legacy (no-hub branch)
      "admin",   // widen scope
      true,      // proceed
    ]);
    const result = await runInteractiveInstall(baseCtx({ hubReachable: false }), io);
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    expect(result.mode).toBe("legacy-pat");
    expect(result.scope).toBe("vault:admin");
  });

  test("paste path: preview clarifies scope is determined by the pasted token (F2)", async () => {
    const { io, state } = mockIO([
      null,             // accept install-scope default
      "paste",          // pick paste
      "my-existing-jwt", // bearer
      true,              // proceed
    ]);
    const result = await runInteractiveInstall(baseCtx(), io);
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    expect(result.mode).toBe("token");
    // Preview should explicitly note that scope is the pasted token's,
    // not the walkthrough's vault:read default. Operators shouldn't
    // infer scope from the walkthrough's framing when they're pasting.
    expect(state.logs.some((l) => /determined by the pasted token/.test(l))).toBe(true);
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
      null,  // accept install-scope default (local)
      null,  // accept mint
      true,  // proceed
    ]);
    const result = await runInteractiveInstall(
      baseCtx({ existing: { user: existing } }),
      io,
    );
    expect(result).not.toBe("abort");
    if (result === "abort") return;
    // Default flow resumed — local scope (no project markers), default vault.
    expect(result.installScope).toBe("local");
  });

  test("aborts cleanly when the operator declines the final confirm", async () => {
    const { io, state } = mockIO([
      null,  // accept install-scope default
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
      null,   // accept install-scope default
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
      null,      // accept install-scope default
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

  test("detects local-scope entry under projects[<cwd>].mcpServers", () => {
    const projectKey = path.resolve(tmpCwd);
    fs.writeFileSync(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        projects: {
          [projectKey]: {
            mcpServers: {
              "parachute-vault": {
                type: "http",
                url: "https://hub.example/vault/default/mcp",
                headers: { Authorization: "Bearer x" },
              },
            },
          },
        },
      }),
    );
    const found = detectExistingEntries(tmpCwd);
    expect(found.local).toBeDefined();
    expect(found.local!.scope).toBe("local");
    expect(found.local!.entryKey).toBe("parachute-vault");
    expect(found.local!.label).toContain(projectKey);
  });

  test("local-scope entry at a different cwd is not surfaced", () => {
    // Operator did `mcp-install --install-scope local` from /Other/Project
    // some time ago. The walkthrough running from tmpCwd today shouldn't
    // misread that as an "existing here" entry — local scope is per-cwd.
    fs.writeFileSync(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        projects: {
          "/Other/Project": {
            mcpServers: {
              "parachute-vault": {
                type: "http",
                url: "https://hub.example/vault/default/mcp",
              },
            },
          },
        },
      }),
    );
    const found = detectExistingEntries(tmpCwd);
    expect(found.local).toBeUndefined();
  });

  test("user + local + project entries coexist in one detect call", () => {
    const projectKey = path.resolve(tmpCwd);
    fs.writeFileSync(
      path.join(tmpHome, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          "parachute-vault": { type: "http", url: "https://hub.example/vault/u/mcp" },
        },
        projects: {
          [projectKey]: {
            mcpServers: {
              "parachute-vault": { type: "http", url: "https://hub.example/vault/l/mcp" },
            },
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(tmpCwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "parachute-vault": { type: "http", url: "https://hub.example/vault/p/mcp" },
        },
      }),
    );
    const found = detectExistingEntries(tmpCwd);
    expect(found.user).toBeDefined();
    expect(found.local).toBeDefined();
    expect(found.project).toBeDefined();
    expect(found.user!.url).toContain("/vault/u/");
    expect(found.local!.url).toContain("/vault/l/");
    expect(found.project!.url).toContain("/vault/p/");
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

// ---------------------------------------------------------------------------
// Preview-accuracy: what the walkthrough renders === what the install writes.
// ---------------------------------------------------------------------------
//
// vault#293. The walkthrough's preview shows the operator a JSON shape; the
// writer then constructs the actual entry. If the two compute the entry-key
// or URL by different recipes, the operator confirms a shape that doesn't
// land on disk. The seam is `buildMcpEntryPlan` — both call sites must use
// it. These tests pin the seam directly + assert the preview's logged
// entry-key matches what `buildMcpEntryPlan` produces for the equivalent
// decision shape.

// Direct unit tests for `buildMcpEntryPlan` live in `mcp-install.test.ts`
// alongside the rest of the `mcp-install.ts` module tests. The cross-check
// below asserts the consumer side (preview render) matches the helper's
// output for the equivalent decision shape.

describe("preview accuracy — what the walkthrough logs === buildMcpEntryPlan(decision)", () => {
  // The walkthrough's preview render and the writer's entry-construction
  // share `buildMcpEntryPlan` post-vault#293. These tests run the
  // walkthrough end-to-end with a mock IO, capture the preview's logged
  // entry-key + URL lines, and assert they match what `buildMcpEntryPlan`
  // would produce for the decision shape the walkthrough returned. If
  // either path drifts, this test goes red — without needing to spawn the
  // CLI or touch the filesystem.

  test("default-vault paste flow at user scope: preview matches buildMcpEntryPlan", async () => {
    const { io } = mockIO([
      null, // accept install-scope default ("user" — no project ctx, no existing)
      "paste", // auth mode → paste
      "PASTED-BEARER", // token prompt
      true, // proceed at final confirm
    ]);
    const ctx = baseCtx({
      inProjectContext: false,
      port: 1940,
      env: { PARACHUTE_HUB_ORIGIN: "https://hub.example" },
      hubOrigin: "https://hub.example",
    });

    const logs: string[] = [];
    const captured: InteractiveIO = {
      ...io,
      log: (line) => {
        logs.push(line);
        io.log(line);
      },
    };

    const decision = await runInteractiveInstall(ctx, captured);
    expect(decision).not.toBe("abort");
    if (decision === "abort") return;

    // Extract the preview's entry-key + URL from captured logs.
    const entryKeyLine = logs.find((l) => /^\s+"parachute-vault[^"]*":/.test(l));
    const urlLine = logs.find((l) => /^\s+"url":/.test(l));
    expect(entryKeyLine).toBeDefined();
    expect(urlLine).toBeDefined();
    const previewEntryKey = /"(parachute-vault[^"]*)"/.exec(entryKeyLine!)![1]!;
    const previewUrl = /"url":\s*"([^"]+)"/.exec(urlLine!)![1]!;

    // What the seam says the writer will produce for the same decision:
    const plan = buildMcpEntryPlan({
      vaultName: decision.vaultName,
      vaultExplicit: decision.vaultExplicit,
      port: ctx.port,
      env: ctx.env,
      ...(decision.existingEntryKey ? { existingEntryKey: decision.existingEntryKey } : {}),
    });

    expect(previewEntryKey).toBe(plan.entryKey);
    expect(previewUrl).toBe(plan.url);
  });

  test("update-existing flow reuses the existing entry-key in both preview and plan", async () => {
    // Existing entry sits at `parachute-vault-legacy-name`. The
    // walkthrough's "update where it is" branch should keep that key in
    // the preview AND propagate it on the decision so the writer agrees.
    const existing: ExistingMcpEntry = {
      path: "/tmp/.claude.json",
      label: "~/.claude.json",
      scope: "user",
      entryKey: "parachute-vault-legacy-name",
      url: "https://hub.example/vault/default/mcp",
      hasAuth: true,
    };
    const ctx = baseCtx({
      existing: { user: existing },
      port: 1940,
      env: { PARACHUTE_HUB_ORIGIN: "https://hub.example" },
      hubOrigin: "https://hub.example",
    });

    const { io } = mockIO([
      null, // accept "update where it is" (default true)
      "paste",
      "PASTED-BEARER",
      true, // proceed
    ]);
    const logs: string[] = [];
    const captured: InteractiveIO = {
      ...io,
      log: (line) => {
        logs.push(line);
        io.log(line);
      },
    };
    const decision = await runInteractiveInstall(ctx, captured);
    expect(decision).not.toBe("abort");
    if (decision === "abort") return;

    expect(decision.existingEntryKey).toBe("parachute-vault-legacy-name");

    const previewEntryKeyLine = logs.find((l) => /^\s+"parachute-vault[^"]*":/.test(l));
    expect(previewEntryKeyLine).toBeDefined();
    const previewEntryKey = /"(parachute-vault[^"]*)"/.exec(previewEntryKeyLine!)![1]!;
    expect(previewEntryKey).toBe("parachute-vault-legacy-name");

    const plan = buildMcpEntryPlan({
      vaultName: decision.vaultName,
      vaultExplicit: decision.vaultExplicit,
      port: ctx.port,
      env: ctx.env,
      existingEntryKey: decision.existingEntryKey!,
    });
    expect(plan.entryKey).toBe("parachute-vault-legacy-name");
  });
});
