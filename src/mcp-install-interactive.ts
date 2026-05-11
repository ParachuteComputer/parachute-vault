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
  //    suggest project when in a project context, user otherwise.
  let installScope: InstallScope;
  if (updateLocation) {
    installScope = updateLocation.scope;
  } else {
    const suggested: InstallScope = ctx.inProjectContext ? "project" : "user";
    if (suggested === "project") {
      io.log(`Looks like you're in a project directory (${pathTail(ctx.cwd)}).`);
      const useProject = await io.confirm(
        "Install for this project only (./.mcp.json)?",
        true,
      );
      installScope = useProject ? "project" : "user";
      io.log(
        installScope === "project"
          ? `  → Writing to ${ctx.cwd}/.mcp.json (project-scoped).`
          : "  → Writing to ~/.claude.json (user-scoped).",
      );
    } else {
      io.log("Installing globally to ~/.claude.json (no project markers in this directory).");
      installScope = "user";
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
        "  admin       → mint with vault:admin (schema management).",
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
      // Legacy path keeps the scope choice — narrowing applies to the
      // pvt_*'s scope set the same way it would to a hub JWT.
    } else {
      mode = "mint";
      if (answer === "write") scope = "vault:write";
      else if (answer === "admin") scope = "vault:admin";
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
        "  legacy → mint a vault-DB pvt_* token (deprecated, vault#288).",
      ].join("\n"),
      validate: (s) => (s === "paste" || s === "legacy" ? null : "expected: paste or legacy"),
    });
    if (answer === "paste") {
      mode = "token";
      pastedToken = await askToken(io);
    } else {
      mode = "legacy-pat";
    }
  }
  io.log("");

  // 5. Preview + final confirm.
  const targetLabel = installScope === "project" ? `${ctx.cwd}/.mcp.json` : "~/.claude.json";
  const entryKey =
    updateLocation?.entryKey ??
    (vaultExplicit ? `parachute-vault-${vaultName}` : "parachute-vault");
  const url = mcpUrlFromCtx(ctx, vaultName);
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
    io.log(`  Scope: ${scope}. The pvt_* token is vault-DB-resident (vault#288 deprecation).`);
  }
  const proceed = await io.confirm("Proceed?", true);
  if (!proceed) {
    io.log("Aborted — nothing was written.");
    return "abort";
  }

  return { mode, scope, installScope, vaultName, vaultExplicit, ...(pastedToken ? { pastedToken } : {}) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pick which existing entry the prompt should lead with. Prefer user-level
 * (the canonical "installed for me everywhere" location) over project-level
 * (which is more often a per-project override that may not represent the
 * operator's primary install).
 */
function pickExistingForPrompt(ctx: InstallContext): ExistingMcpEntry | null {
  return ctx.existing.user ?? ctx.existing.project ?? null;
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
 * Build the URL the walkthrough will preview. Same shape `chooseMcpUrl`
 * would produce — we re-derive here to keep the preview honest without
 * piping `chooseMcpUrl`'s extra metadata through.
 */
function mcpUrlFromCtx(ctx: InstallContext, vaultName: string): string {
  return `${ctx.hubOrigin}/vault/${vaultName}/mcp`;
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
