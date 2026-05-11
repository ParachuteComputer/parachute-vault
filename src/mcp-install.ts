/**
 * Helpers for `parachute-vault mcp-install`. Three concerns live here:
 *
 *   1. **URL pickers.** The MCP URL written into the client config must match
 *      vault's advertised OAuth issuer for the origin the client will reach
 *      the server on — otherwise strict clients (Claude Code's MCP SDK)
 *      reject discovery on origin/issuer mismatch (RFC 8414 §3.1). Two
 *      pickers: `chooseMcpUrl` returns the full `<origin>/vault/<name>/mcp`
 *      shape for the entry; `chooseHubOrigin` returns the bare `<origin>` for
 *      the hub-mint API call.
 *
 *   2. **Operator-token reader.** Reads `~/.parachute/operator.token` (or
 *      `$PARACHUTE_HOME/operator.token`). The hub-mint path uses it as the
 *      bearer for `POST <hub>/api/auth/mint-token`. Returns null when absent
 *      or empty — caller decides whether that's a hard error.
 *
 *   3. **Hub mint-token client.** `mintHubJwt` posts to
 *      `<hub>/api/auth/mint-token` with the operator bearer and returns the
 *      scope-narrow JWT. Test seam for `fetch` injected as an opt so unit
 *      tests don't need a real hub.
 *
 *   4. **Install target resolver.** `resolveInstallTarget` picks between
 *      `~/.claude.json` (user) and `./.mcp.json` (project) based on the
 *      `--install-scope` flag.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// URL picking
// ---------------------------------------------------------------------------

export type McpUrlSource = "hub-origin" | "expose-state" | "loopback";

/**
 * Pick the URL written into the MCP client's `mcpServers.<key>.url` slot.
 * Returns the per-vault MCP endpoint (`/vault/<name>/mcp`); see
 * `chooseHubOrigin` for the bare-origin form used by hub API calls.
 *
 * Source order:
 *   1. `PARACHUTE_HUB_ORIGIN` env (vault is advertising the hub as issuer).
 *   2. `~/.parachute/expose-state.json` canonical FQDN (active tailnet /
 *      public exposure the CLI brought up).
 *   3. Loopback on the configured port.
 */
export function chooseMcpUrl(
  vaultName: string,
  port: number,
  env: { PARACHUTE_HUB_ORIGIN?: string | undefined } = process.env as { PARACHUTE_HUB_ORIGIN?: string },
): { url: string; source: McpUrlSource } {
  const origin = chooseHubOrigin(port, env);
  return { url: `${origin.url}/vault/${vaultName}/mcp`, source: origin.source };
}

/**
 * Pick the bare hub origin (no path suffix). Used by hub-mint when posting
 * to `<origin>/api/auth/mint-token`. Same source order as `chooseMcpUrl`.
 *
 * Note: when the source is `loopback`, the origin is *vault's* loopback URL,
 * not a hub. Hub-mint against a loopback origin will fail at the network
 * layer (no hub on that port) — the caller catches and surfaces a clear
 * "no hub configured" error.
 */
export function chooseHubOrigin(
  port: number,
  env: { PARACHUTE_HUB_ORIGIN?: string | undefined } = process.env as { PARACHUTE_HUB_ORIGIN?: string },
): { url: string; source: McpUrlSource } {
  const hub = env.PARACHUTE_HUB_ORIGIN?.replace(/\/$/, "");
  if (hub) {
    return { url: hub, source: "hub-origin" };
  }
  const fqdn = readExposedFqdn();
  if (fqdn) {
    return { url: `https://${fqdn}`, source: "expose-state" };
  }
  return { url: `http://127.0.0.1:${port}`, source: "loopback" };
}

/**
 * Best-effort read of `~/.parachute/expose-state.json` (CLI-owned). Returns
 * the canonical FQDN when an active tailnet/public exposure is configured;
 * returns undefined on any error or when absent — this is advisory, not
 * load-bearing.
 *
 * Re-derives the ecosystem root per-call so tests that flip `PARACHUTE_HOME`
 * see the override — the top-level `CONFIG_DIR` const in config.ts is frozen
 * at module import.
 */
function readExposedFqdn(): string | undefined {
  try {
    const root = process.env.PARACHUTE_HOME ?? resolve(homedir(), ".parachute");
    const p = resolve(root, "expose-state.json");
    if (!existsSync(p)) return undefined;
    const raw = JSON.parse(readFileSync(p, "utf-8")) as {
      layer?: string;
      canonicalFqdn?: string;
    };
    if ((raw.layer === "tailnet" || raw.layer === "public") && raw.canonicalFqdn) {
      return raw.canonicalFqdn;
    }
  } catch {}
  return undefined;
}

// ---------------------------------------------------------------------------
// Operator-token reader
// ---------------------------------------------------------------------------

/**
 * Read the operator bearer from `<root>/operator.token`. Root is
 * `$PARACHUTE_HOME` if set, otherwise `~/.parachute`. Returns null when the
 * file is absent or empty — caller decides whether that's a hard error.
 *
 * We don't enforce the 0600 mode check here (hub's reader does). The CLI
 * runs locally; if the operator chmod'd it loose, that's already their
 * footgun, and vault's install command isn't the place to gate on it.
 */
export function readOperatorToken(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const root = env.PARACHUTE_HOME ?? resolve(homedir(), ".parachute");
    const path = resolve(root, "operator.token");
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf-8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hub mint-token client
// ---------------------------------------------------------------------------

/**
 * Default lifetime when `--expires-in` isn't passed. Matches the hub CLI's
 * default (90 days) — see `parachute-hub/src/api-mint-token.ts`.
 */
export const HUB_MINT_DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * Result of a successful hub mint-token call. Shape mirrors the hub HTTP
 * response so callers can pass `expires_at` through to logs / UX.
 */
export interface MintedHubJwt {
  /** The signed JWT to write into `Authorization: Bearer …`. */
  token: string;
  /** JTI for revocation. */
  jti: string;
  /** ISO timestamp at which the token expires. */
  expires_at: string;
  /** Whitespace-joined scope claim, mirrors the request. */
  scope: string;
}

/**
 * Discriminated failure modes from `mintHubJwt`. Callers turn each into a
 * different operator-facing message — hub-unreachable has its own remediation
 * (check `PARACHUTE_HUB_ORIGIN` / start the hub); API-error propagates the
 * hub's own `error_description`.
 *
 * Operator-token absence is *not* a `mintHubJwt` failure mode: the caller is
 * responsible for `readOperatorToken()` before invoking us — by the time we
 * see `operatorToken: string`, it's guaranteed present.
 */
export type MintHubJwtError =
  | { kind: "network"; cause: string; origin: string }
  | { kind: "api-error"; status: number; error: string; description: string };

export interface MintHubJwtOpts {
  hubOrigin: string;
  operatorToken: string;
  scope: string;
  subject?: string;
  expiresInSeconds?: number;
  /** Test seam — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * POST to `<hub>/api/auth/mint-token`. The operator-token bearer must carry
 * `parachute:host:auth` (the admin scope-set covers it). Returns the minted
 * JWT or a discriminated error the caller turns into a clear message.
 *
 * Network errors are caught and returned as `{ kind: "network" }` rather
 * than bubbling — the CLI doesn't want stack traces, and the operator wants
 * to know *which* endpoint failed.
 */
export async function mintHubJwt(opts: MintHubJwtOpts): Promise<MintedHubJwt | MintHubJwtError> {
  const url = `${opts.hubOrigin.replace(/\/$/, "")}/api/auth/mint-token`;
  const body: Record<string, unknown> = {
    scope: opts.scope,
    expires_in: opts.expiresInSeconds ?? HUB_MINT_DEFAULT_TTL_SECONDS,
  };
  if (opts.subject) body.subject = opts.subject;

  const fetchFn = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${opts.operatorToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return { kind: "network", cause, origin: opts.hubOrigin };
  }

  if (!res.ok) {
    // Hub responses are JSON `{ error, error_description }`. Parse defensively
    // — a misconfigured hub or a network appliance returning HTML for 502s
    // shouldn't crash the CLI; we'll surface what we got.
    let error = "unknown_error";
    let description = `HTTP ${res.status}`;
    try {
      const payload = (await res.json()) as { error?: unknown; error_description?: unknown };
      if (typeof payload.error === "string") error = payload.error;
      if (typeof payload.error_description === "string") description = payload.error_description;
    } catch {}
    return { kind: "api-error", status: res.status, error, description };
  }

  const payload = (await res.json()) as Partial<MintedHubJwt>;
  if (
    typeof payload.token !== "string" ||
    typeof payload.jti !== "string" ||
    typeof payload.expires_at !== "string" ||
    typeof payload.scope !== "string"
  ) {
    return {
      kind: "api-error",
      status: res.status,
      error: "malformed_response",
      description: "hub mint-token response is missing required fields (token/jti/expires_at/scope)",
    };
  }
  return {
    token: payload.token,
    jti: payload.jti,
    expires_at: payload.expires_at,
    scope: payload.scope,
  };
}

// ---------------------------------------------------------------------------
// Install target resolver
// ---------------------------------------------------------------------------

export type InstallScope = "user" | "project";

export interface InstallTarget {
  /** Absolute path the install will write to. */
  path: string;
  /** Which scope the path corresponds to (for log lines + doctor). */
  scope: InstallScope;
}

/**
 * Pick the MCP client config file path based on `--install-scope`. Project
 * scope writes to `<cwd>/.mcp.json` (Claude Code convention); user scope
 * writes to `~/.claude.json` (legacy + still canonical for user-wide setup).
 *
 * `homedir()` from node:os is cached at process start on Bun, so in-process
 * `process.env.HOME` overrides don't propagate to it. We prefer the
 * (mutable) env var when set so tests that flip `HOME` see the override
 * without subprocess-spawning. Falls back to `homedir()` for the
 * common case where neither tests nor exotic chrooting touches HOME.
 */
export function resolveInstallTarget(
  scope: InstallScope,
  cwd: string = process.cwd(),
): InstallTarget {
  if (scope === "project") {
    return { path: resolve(cwd, ".mcp.json"), scope: "project" };
  }
  const home = process.env.HOME ?? homedir();
  return { path: resolve(home, ".claude.json"), scope: "user" };
}

// ---------------------------------------------------------------------------
// Context detection — feeds the interactive walkthrough's smart defaults
// ---------------------------------------------------------------------------

/**
 * "Is this a project directory?" heuristic. Looks for any of the common
 * project-root markers in the supplied directory (defaults to CWD):
 *
 *   .git              — git checkout (the strong signal)
 *   package.json      — Node/Bun project
 *   pyproject.toml    — Python project (modern)
 *   Cargo.toml        — Rust project
 *   go.mod            — Go module
 *   deno.json         — Deno project
 *   .parachute        — Parachute config dir present (matches our own convention)
 *
 * The detection is intentionally shallow — only the supplied directory,
 * not its ancestors. Walking up to find a marker would create surprising
 * defaults from arbitrary subdirectories ("why does installing from
 * ~/code/myproject/subdir behave like ~/code/myproject?"). The operator
 * can always opt explicitly with `--install-scope project` from anywhere.
 */
export function detectProjectContext(cwd: string = process.cwd()): boolean {
  const markers = [
    ".git",
    "package.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "deno.json",
    ".parachute",
  ];
  for (const marker of markers) {
    if (existsSync(resolve(cwd, marker))) return true;
  }
  return false;
}

/**
 * Shape of an existing vault MCP entry the interactive walkthrough cares
 * about. Used to default the "update where it is" branch in the install-
 * scope prompt without re-reading the same files multiple times.
 */
export interface ExistingMcpEntry {
  /** Absolute path of the config file the entry lives in. */
  path: string;
  /** Display label for prompts (~/.claude.json or ./.mcp.json). */
  label: string;
  /** Whether the entry sits in user or project scope. */
  scope: InstallScope;
  /** `mcpServers` key the entry occupies. */
  entryKey: string;
  /** The URL field of the entry (operator-visible state). */
  url: string;
  /** Whether the entry has an Authorization header. */
  hasAuth: boolean;
}

/**
 * Look for an existing parachute-vault entry at the user-level
 * `~/.claude.json` and the project-level `./.mcp.json`. Returns each
 * matching entry independently so the walkthrough can present either
 * (or both, but in practice we pick one).
 *
 * `parachute-vault` (singular) wins over `parachute-vault-<name>` at the
 * same file — the singular slot is the canonical default install; per-
 * vault keys are the multi-vault add-ons.
 */
export function detectExistingEntries(
  cwd: string = process.cwd(),
): { user?: ExistingMcpEntry; project?: ExistingMcpEntry } {
  return {
    ...maybeEntry(resolveInstallTarget("user"), "~/.claude.json"),
    ...maybeEntry(resolveInstallTarget("project", cwd), `${cwd}/.mcp.json`),
  };

  function maybeEntry(
    target: InstallTarget,
    label: string,
  ): { user?: ExistingMcpEntry } | { project?: ExistingMcpEntry } | {} {
    if (!existsSync(target.path)) return {};
    let config: any;
    try {
      config = JSON.parse(readFileSync(target.path, "utf-8"));
    } catch {
      return {};
    }
    const servers: Record<string, any> = config?.mcpServers ?? {};
    let entry = servers["parachute-vault"];
    let entryKey = "parachute-vault";
    if (!entry) {
      for (const key of Object.keys(servers)) {
        if (key.startsWith("parachute-vault-")) {
          entry = servers[key];
          entryKey = key;
          break;
        }
      }
    }
    if (!entry || typeof entry.url !== "string") return {};
    const result: ExistingMcpEntry = {
      path: target.path,
      label,
      scope: target.scope,
      entryKey,
      url: entry.url,
      hasAuth: Boolean(entry.headers?.Authorization),
    };
    return target.scope === "user" ? { user: result } : { project: result };
  }
}

/**
 * Snapshot of everything the interactive walkthrough needs to pick smart
 * defaults. Computed once at the start of the flow so each prompt's
 * reasoning is consistent (no surprise mid-flow re-reads).
 */
export interface InstallContext {
  /** All vault names declared on this host. */
  vaults: string[];
  /** The vault `default_vault` config points at (or first vault, or "default"). */
  defaultVault: string;
  /** Whether a hub origin is configured beyond the loopback fallback. */
  hubReachable: boolean;
  /** The resolved hub origin (loopback if no hub configured). */
  hubOrigin: string;
  /** Whether `~/.parachute/operator.token` exists and is non-empty. */
  operatorTokenPresent: boolean;
  /** Heuristic: is CWD a project directory? */
  inProjectContext: boolean;
  /** Where the walkthrough was invoked from. */
  cwd: string;
  /** Pre-existing entries at user / project scope, if any. */
  existing: { user?: ExistingMcpEntry; project?: ExistingMcpEntry };
}

/**
 * Build an `InstallContext` from the current process + filesystem. Pure-
 * function-shaped (takes everything it needs as args with sensible
 * defaults), so tests can synthesize alternate contexts without monkey-
 * patching globals.
 */
export function detectInstallContext(opts: {
  vaults: string[];
  defaultVault: string;
  port: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): InstallContext {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  // Narrow to chooseHubOrigin's expected shape — NodeJS.ProcessEnv is a
  // string-index type that doesn't structurally match the explicit shape
  // chooseHubOrigin declares; passing a sliced view sidesteps the
  // structural-incompatibility complaint without losing safety.
  const hub = chooseHubOrigin(opts.port, { PARACHUTE_HUB_ORIGIN: env.PARACHUTE_HUB_ORIGIN });
  return {
    vaults: opts.vaults,
    defaultVault: opts.defaultVault,
    hubReachable: hub.source !== "loopback",
    hubOrigin: hub.url,
    operatorTokenPresent: readOperatorToken(env) !== null,
    inProjectContext: detectProjectContext(cwd),
    cwd,
    existing: detectExistingEntries(cwd),
  };
}
