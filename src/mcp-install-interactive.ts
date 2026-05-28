/**
 * Interactive walkthrough for `parachute-vault mcp-install`.
 *
 * Fires when the operator runs the command with no install-shaping flags
 * AND stdin is a TTY. Walks them through four decisions — vault, install
 * location, auth mode + scope, final confirmation — with smart defaults
 * informed by ambient context (number of vaults, hub reachability,
 * operator-token presence, project-dir detection, existing entries).
 *
 * Design principle: every prompt has a default that's auto-selected on
 * Enter. The reason for the default is visible so the operator can
 * override informedly. The final preview shows the actual JSON shape that
 * will be written (with a `<hub-jwt>` placeholder when minting — the live
 * mint happens *after* the confirm so a cancellation skips the network
 * call and avoids exposing the token in scrollback unnecessarily).
 *
 * The module is shaped around an injected `InteractiveIO` so tests can
 * pin the prompt-by-prompt flow with canned answers; production wires
 * the IO to `prompt.ts` + console.log.
 */

import { buildMcpEntryPlan } from "./mcp-install.ts";
import type { InstallContext, ExistingMcpEntry, InstallScope } from "./mcp-install.ts";

/**
 * I/O surface the walkthrough talks to. The interface keeps the prompts
 * testable: production injects readline-backed implementations; tests
 * inject pre-canned answer queues.
 */
export interface InteractiveIO {
  /** Print a line to the operator. */
  log(line: string): void;
  /**
   * Ask a free-text question with a default. Returns the trimmed answer,
   * or `defaultValue` if the operator pressed Enter on an empty input.
   */
  ask(question: string, defaultValue: string): Promise<string>;
  /**
   * Ask a yes/no question with a default. Returns true for yes.
   */
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
}

/**
 * The fully-resolved install decision the walkthrough produces. Same shape
 * the flag-driven path computes — `cmdMcpInstall` hands it off to the
 * shared backend `installMcpConfig`.
 */
export interface InstallDecision {
  mode: "mint" | "token" | "legacy-pat";
  scope: "vault:read" | "vault:write" | "vault:admin";
  installScope: InstallScope;
  vaultName: string;
  /**
   * Whether the operator explicitly opted for a non-default vault. Controls
   * entry-key shape (singular `parachute-vault` vs `parachute-vault-<name>`).
   */
  vaultExplicit: boolean;
  /** Pasted bearer when `mode === "token"`. */
  pastedToken?: string;
  /**
   * When the walkthrough decided to update an existing entry, the key of
   * that entry — so the writer keys the new state at the same slot the
   * preview promised. Absent on fresh installs. See vault#293.
   */
  existingEntryKey?: string;
}

/**
 * Walk the operator through the install decision. Returns the resolved
 * decision, or `"abort"` if they cancelled at the final preview / typed
 * "no" on confirm.
 */
export async function runInteractiveInstall(
  ctx: InstallContext,
  io: InteractiveIO,
): Promise<InstallDecision | "abort"> {
  if (ctx.vaults.length === 0) {
    io.log("✗ No vaults found. Run `parachute-vault init` or `parachute-vault create <name>` first.");
    return "abort";
  }

  io.log("Setting up Parachute Vault as an MCP server.");
  io.log("");

  // 1. Existing entry — strongest signal. If we find one, ask whether to
  //    update it. "Update" pins both the install location AND the entry
  //    key, so subsequent prompts can skip those questions.
  const existing = pickExistingForPrompt(ctx);
  let updateLocation: ExistingMcpEntry | null = null;
  if (existing) {
    io.log(`I see Parachute Vault is already installed at ${existing.label} ("${existing.entryKey}").`);
    const update = await io.confirm("Update it (recommended)?", true);
    if (update) {
      updateLocation = existing;
      io.log(`  → Updating the existing entry at ${existing.label}.`);
    } else {
      io.log("  → Installing somewhere else.");
    }
    io.log("");
  }

  // 2. Vault target. Skipped when there's exactly one vault (no choice to
  //    make) or when we're updating an existing entry (the entry's URL
  //    already encodes the vault — we don't re-pick).
  let vaultName: string;
  let vaultExplicit: boolean;
  if (updateLocation) {
    vaultName = extractVaultFromUrl(updateLocation.url) ?? ctx.defaultVault;
    vaultExplicit = updateLocation.entryKey !== "parachute-vault";
    io.log(`Targeting vault "${vaultName}" (from the existing entry).`);
    io.log("");
  } else if (ctx.vaults.length === 1) {
    vaultName = ctx.vaults[0]!;
    vaultExplicit = false;
    io.log(`Targeting your one vault: "${vaultName}".`);
    io.log("");
  } else {
    io.log(`You have ${ctx.vaults.length} vaults: ${ctx.vaults.join(", ")}.`);
    vaultName = await askPersistent(io, "Which vault?", ctx.defaultVault, {
      help: `Type a vault name. Default "${ctx.defaultVault}" is your configured default_vault.`,
      validate: (s) => (ctx.vaults.includes(s) ? null : `unknown vault "${s}" — pick one of: ${ctx.vaults.join(", ")}`),
    });
    vaultExplicit = vaultName !== ctx.defaultVault;
    io.log("");
  }

  // 3. Install location. If we're updating, use that location. Otherwise
  //    always prompt with the three scopes available (local / project /
  //    user) — Claude Code reads ./.mcp.json regardless of git/package
  //    markers, so the prior "no markers → autopilot global" branch was
  //    wrong (silently overrode the operator's intent when they happened
  //    to be in a plain dir). Default tilts on the same marker signal:
  //    project markers → suggest `project`, else suggest `local`. The
  //    suggestion shapes the default; it does NOT decide.
  let installScope: InstallScope;
  if (updateLocation) {
    installScope = updateLocation.scope;
  } else {
    const suggested: InstallScope = ctx.inProjectContext ? "project" : "local";
    io.log(`Where to install? (CWD: ${pathTail(ctx.cwd)})`);
    io.log("  local    — ~/.claude.json under projects[<cwd>] (private, this dir only)");
    io.log("  project  — ./.mcp.json (checked into the repo, shared with team)");
    io.log("  user     — ~/.claude.json top-level (every project, every dir)");
    const answer = await askPersistent(
      io,
      `Press Enter for "${suggested}", or type local / project / user`,
      suggested,
      {
        help: [
          "Install scopes (mirrors Claude Code's `claude mcp add --scope`):",
          "  local    → ~/.claude.json under projects[<cwd>].mcpServers.",
          "             Private to your machine, scoped to this directory.",
          "             Claude Code only loads it when launched from here.",
          "  project  → <cwd>/.mcp.json. Checked into the repo; shared with",
          "             anyone who clones it. Pick this when the vault",
          "             integration belongs to the team / project.",
          "  user     → ~/.claude.json top-level mcpServers. Loaded for",
          "             every Claude Code session regardless of cwd.",
        ].join("\n"),
        validate: (s) => {
          const ok = ["local", "project", "user"];
          return ok.includes(s) ? null : `expected one of: ${ok.join(", ")}`;
        },
      },
    );
    installScope = answer as InstallScope;
    if (installScope === "local") {
      io.log(`  → Writing to ~/.claude.json under projects["${ctx.cwd}"].mcpServers (local — this directory only).`);
    } else if (installScope === "project") {
      io.log(`  → Writing to ${ctx.cwd}/.mcp.json (project-scoped — shared with the repo).`);
    } else {
      io.log("  → Writing to ~/.claude.json top-level (user-scoped — every project).");
    }
    io.log("");
  }

  // 4. Auth mode + scope. The branching point: hub-mint available, or
  //    not. When neither operator.token nor hub is configured, we fall
  //    through to paste/legacy.
  const canMint = ctx.hubReachable && ctx.operatorTokenPresent;
  let mode: InstallDecision["mode"];
  let scope: InstallDecision["scope"] = "vault:read";
  let pastedToken: string | undefined;

  if (canMint) {
    io.log(`I can mint a hub JWT for you (least-privilege: vault:${vaultName}:read).`);
    const answer = await askPersistent(io, "Press Enter to accept, or type 'write', 'admin', or 'paste'", "mint", {
      help: [
        "Choices:",
        "  Enter       → mint a hub JWT with vault:read scope (recommended).",
        "  write       → mint with vault:write (mutations).",
        "  admin       → mint a hub JWT with vault:<name>:admin (schema management).",
        "                Requires parachute:host:admin on the operator token (the",
        "                default operator.token carries it). NOT legacy-pat.",
        "  paste       → use an existing token instead of minting.",
        "  legacy      → mint a vault-DB pvt_* (self-hosted-without-hub).",
      ].join("\n"),
      validate: (s) => {
        const ok = ["mint", "write", "admin", "paste", "legacy"];
        return ok.includes(s) ? null : `expected one of: ${ok.join(", ")}`;
      },
    });
    if (answer === "paste") {
      mode = "token";
      pastedToken = await askToken(io);
    } else if (answer === "legacy") {
      mode = "legacy-pat";
      // Legacy path mints a vault-DB pvt_* with scope narrowing — same
      // verb choice as the mint path. Prompt for it explicitly so the
      // operator gets the same control they get when widening a hub
      // JWT's scope. (vault#292 review F2.)
      scope = await askScope(io);
    } else if (answer === "admin") {
      // `vault:<name>:admin` is now mintable via hub mint-token when the
      // operator's bearer carries `parachute:host:admin` (hub PR-A, hub#449).
      // The default operator.token carries host-admin, so this is the
      // canonical admin path — no more legacy-pat fallback. The verb
      // extraction downstream narrows `vault:admin` → `vault:<name>:admin`.
      io.log("  → admin will be minted as a scope-narrowed hub JWT (vault:" + vaultName + ":admin).");
      mode = "mint";
      scope = "vault:admin";
    } else {
      mode = "mint";
      if (answer === "write") scope = "vault:write";
    }
  } else {
    // No hub-mint path available — explain why and offer the alternatives.
    const reason = !ctx.hubReachable
      ? "no hub origin configured (PARACHUTE_HUB_ORIGIN unset, no active expose-state)"
      : "no operator token at ~/.parachute/operator.token";
    io.log(`Hub-mint isn't available — ${reason}.`);
    io.log("Two options: paste an existing token, or mint a vault-DB pvt_* (deprecated).");
    const answer = await askPersistent(io, "Which? [paste / legacy]", "paste", {
      help: [
        "  paste  → use an existing bearer (hub JWT, pvt_*, anything).",
        "  legacy → mint a vault-DB pvt_* token (deprecated, vault#282).",
      ].join("\n"),
      validate: (s) => (s === "paste" || s === "legacy" ? null : "expected: paste or legacy"),
    });
    if (answer === "paste") {
      mode = "token";
      pastedToken = await askToken(io);
    } else {
      mode = "legacy-pat";
      // Same scope prompt as the canMint legacy branch (F2).
      scope = await askScope(io);
    }
  }
  io.log("");

  // 5. Preview + final confirm.
  const targetLabel =
    installScope === "project"
      ? `${ctx.cwd}/.mcp.json`
      : installScope === "local"
        ? `~/.claude.json (projects["${ctx.cwd}"])`
        : "~/.claude.json";
  // Single source of truth for entry-key + URL — same function the writer
  // will call when it actually lands the entry. See vault#293.
  const { entryKey, url } = buildMcpEntryPlan({
    vaultName,
    vaultExplicit,
    port: ctx.port,
    env: ctx.env,
    ...(updateLocation?.entryKey ? { existingEntryKey: updateLocation.entryKey } : {}),
  });
  const bearerPreview =
    mode === "token" ? "<your token>" : mode === "mint" ? "<hub-jwt>" : "<pvt_*>";

  io.log(`Here's what I'll write to ${targetLabel}:`);
  io.log("");
  io.log(`  "${entryKey}": {`);
  io.log(`    "type": "http",`);
  io.log(`    "url": "${url}",`);
  io.log(`    "headers": { "Authorization": "Bearer ${bearerPreview}" }`);
  io.log(`  }`);
  io.log("");
  if (mode === "mint") {
    io.log(`  Scope: ${scope} → narrowed to vault:${vaultName}:${scope.split(":")[1]}.`);
  } else if (mode === "legacy-pat") {
    io.log(`  Scope: ${scope}. The pvt_* token is vault-DB-resident (vault#282 deprecation).`);
  } else {
    // mode === "token" (paste). The pasted bearer carries its own scope
    // claim — we don't inspect or override it; whatever scope the issuer
    // baked in is what the vault will enforce. Surfacing this in the
    // preview keeps the operator from assuming they're getting
    // vault:read just because the walkthrough's default reads that way.
    io.log(`  Scope: determined by the pasted token (not validated here).`);
  }
  const proceed = await io.confirm("Proceed?", true);
  if (!proceed) {
    io.log("Aborted — nothing was written.");
    return "abort";
  }

  return {
    mode,
    scope,
    installScope,
    vaultName,
    vaultExplicit,
    ...(pastedToken ? { pastedToken } : {}),
    ...(updateLocation?.entryKey ? { existingEntryKey: updateLocation.entryKey } : {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pick which existing entry the prompt should lead with. Preference order:
 *   1. local at this exact CWD — strongest signal the operator was just
 *      here and updated this very directory before.
 *   2. user — the global install location, applies to every project.
 *   3. project — the repo-shared install; lowest priority since it can
 *      drift independently of the operator's primary install.
 */
function pickExistingForPrompt(ctx: InstallContext): ExistingMcpEntry | null {
  return ctx.existing.local ?? ctx.existing.user ?? ctx.existing.project ?? null;
}

/**
 * Extract the vault name from an MCP URL of the shape
 * `…/vault/<name>/mcp`. Returns null if the URL doesn't match.
 */
function extractVaultFromUrl(url: string): string | null {
  const match = /\/vault\/([^/]+)\/mcp\b/.exec(url);
  return match ? match[1]! : null;
}

/**
 * Show only the last two path segments of CWD so the prompt is readable
 * without leaking the operator's full home path in a screenshot.
 */
function pathTail(p: string): string {
  const parts = p.split("/").filter((s) => s.length > 0);
  return parts.slice(-2).join("/") || p;
}

/**
 * Prompt for scope when minting a vault-DB pvt_* (legacy-pat). Mirrors
 * the mint path's "widen with write/admin" wording so the legacy and
 * hub-mint branches surface scope as the same kind of choice. Mint's
 * own scope prompt is inline at the auth-mode step (legacy is the
 * extra round we couldn't fold there without ambiguity).
 */
async function askScope(io: InteractiveIO): Promise<InstallDecision["scope"]> {
  const answer = await askPersistent(io, "Press Enter for vault:read (least privilege), or type 'write' or 'admin' to widen", "read", {
    help: [
      "Scopes for the legacy pvt_* token:",
      "  read   → vault:read (default — listing + reading only).",
      "  write  → vault:write (mutations: create, update, delete notes).",
      "  admin  → vault:admin (full, including schema management).",
    ].join("\n"),
    validate: (s) => {
      const ok = ["read", "write", "admin"];
      return ok.includes(s) ? null : `expected one of: ${ok.join(", ")}`;
    },
  });
  return `vault:${answer}` as InstallDecision["scope"];
}

/**
 * Prompt for a token. Uses `ask` rather than `askPassword` so the operator
 * can see what they pasted (most clients show the token in plain text in
 * their config anyway — masking here is theater, not security). Empty
 * input re-prompts.
 */
async function askToken(io: InteractiveIO): Promise<string> {
  while (true) {
    const t = (await io.ask("Paste your bearer token", "")).trim();
    if (t.length > 0) return t;
    io.log("  (empty input — paste a token, or Ctrl-C to abort.)");
  }
}

/**
 * Wrapper around `io.ask` that re-prompts on validation failure and
 * surfaces a help message on "help" / "?" / "/help". Keeps each prompt's
 * call site terse without giving up the affordances.
 */
async function askPersistent(
  io: InteractiveIO,
  question: string,
  defaultValue: string,
  opts: { help: string; validate: (s: string) => string | null },
): Promise<string> {
  while (true) {
    const answerRaw = await io.ask(question, defaultValue);
    const answer = answerRaw.trim();
    if (answer === "help" || answer === "?" || answer === "/help") {
      io.log(opts.help);
      continue;
    }
    const err = opts.validate(answer);
    if (err) {
      io.log(`  ${err}. (Type "help" for options.)`);
      continue;
    }
    return answer;
  }
}

// ---------------------------------------------------------------------------
// Production IO wiring
// ---------------------------------------------------------------------------

/**
 * Build an `InteractiveIO` backed by the readline-based prompt module.
 * The standalone factory keeps `runInteractiveInstall` test-driveable
 * without dragging readline into the test's mock graph.
 */
export async function defaultInteractiveIO(): Promise<InteractiveIO> {
  const { ask, confirm } = await import("./prompt.ts");
  return {
    log: (line) => console.log(line),
    ask: (q, def) => ask(q, def),
    confirm: (q, defYes) => confirm(q, defYes),
  };
}
