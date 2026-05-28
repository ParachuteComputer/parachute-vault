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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * Strip every vault MCP entry from ~/.claude.json (user-scope + every
 * local-scope `projects[*].mcpServers`) and ./.mcp.json (project-scope at
 * cwd). Cleanup walks every `projects[*]` slot so an operator who installed
 * locally in one directory can uninstall from anywhere without remembering
 * where. Silent no-op on missing files / malformed JSON.
 *
 * Lives in mcp-install.ts (not cli.ts) so tests can call it directly
 * without triggering cli.ts's top-level dispatch on import.
 */
export function removeMcpConfig(): void {
  // Prefer `process.env.HOME` over cached `homedir()` — Bun caches the OS
  // userinfo at process start so in-process HOME overrides (tests, exotic
  // chrooting) don't apply via homedir(). Matches resolveInstallTarget's
  // home-resolution pattern.
  const home = process.env.HOME ?? homedir();
  const claudeJsonPath = resolve(home, ".claude.json");
  const projectMcpJsonPath = resolve(process.cwd(), ".mcp.json");
  for (const path of [claudeJsonPath, projectMcpJsonPath]) {
    if (!existsSync(path)) continue;
    try {
      const config = JSON.parse(readFileSync(path, "utf-8"));
      // Drop the singular key and every per-vault `parachute-vault-<name>`
      // entry. Legacy `parachute-vault/<name>` (slash-form) sub-keys from a
      // pre-multi-vault pattern still get cleaned up here.
      const stripVaultKeys = (servers: Record<string, unknown> | undefined) => {
        if (!servers) return;
        for (const key of Object.keys(servers)) {
          if (
            key === "parachute-vault" ||
            key.startsWith("parachute-vault-") ||
            key.startsWith("parachute-vault/")
          ) {
            delete servers[key];
          }
        }
      };
      stripVaultKeys(config.mcpServers);
      // Local-scope cleanup: walk every project entry and strip vault keys.
      if (config.projects && typeof config.projects === "object") {
        for (const projectKey of Object.keys(config.projects)) {
          const projectEntry = config.projects[projectKey];
          if (projectEntry && typeof projectEntry === "object") {
            stripVaultKeys(projectEntry.mcpServers);
          }
        }
      }
      writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
    } catch {}
  }
}

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
// Entry-key + URL builder (shared by preview render + write path)
// ---------------------------------------------------------------------------

/**
 * Single source of truth for the MCP entry's slot key and URL. Both the
 * interactive walkthrough's preview render and the writer (`executeMcpInstall`
 * → `installMcpConfig`) call this so the JSON shape the operator confirms is
 * the JSON shape that lands on disk. Drift between the two would silently
 * mislead — they used to compute these independently (preview from
 * `${ctx.hubOrigin}/vault/<name>/mcp` directly; writer through `chooseMcpUrl`).
 * They agree today but a future change to one path could diverge from the
 * other. vault#293.
 *
 * `existingEntryKey` wins when an update of a pre-existing entry is in
 * progress — the walkthrough already pins this earlier in the flow; passing
 * it here just keeps the preview honest about the slot the writer will
 * actually use.
 */
export function buildMcpEntryPlan(opts: {
  vaultName: string;
  vaultExplicit: boolean;
  port: number;
  env?: { PARACHUTE_HUB_ORIGIN?: string | undefined };
  /** When updating an existing entry, the slot key the operator picked previously. */
  existingEntryKey?: string;
}): { entryKey: string; url: string; source: McpUrlSource } {
  const { vaultName, vaultExplicit, port, env, existingEntryKey } = opts;
  const entryKey =
    existingEntryKey ??
    (vaultExplicit ? `parachute-vault-${vaultName}` : "parachute-vault");
  const { url, source } = chooseMcpUrl(vaultName, port, env ?? (process.env as { PARACHUTE_HUB_ORIGIN?: string }));
  return { entryKey, url, source };
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
  /**
   * Bearer presented on the mint-token request. For the CLI install path this
   * is `~/.parachute/operator.token`; for the manage-token MCP proxy
   * (vault#403, MGT) it's the RAW caller bearer the MCP session presented (a
   * hub JWT carrying `vault:<name>:admin`). Hub's capability-attenuation guard
   * (hub#452) decides what the bearer may mint.
   */
  operatorToken: string;
  scope: string;
  subject?: string;
  expiresInSeconds?: number;
  /**
   * Optional `permissions` claim forwarded verbatim to hub's mint-token body
   * (e.g. `{ scoped_tags: [...] }` so the minted JWT carries the tag
   * restriction vault enforces via C0). Omitted from the request body when
   * undefined. See `parachute-hub/src/api-mint-token.ts` (permissions claim).
   */
  permissions?: Record<string, unknown>;
  /** Test seam — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * POST to `<hub>/api/auth/mint-token`. The bearer must carry minting authority
 * per hub's attenuation rules — `parachute:host:auth` (CLI operator token) or
 * `vault:<name>:admin` (the manage-token MCP proxy's caller bearer). Returns
 * the minted JWT or a discriminated error the caller turns into a clear
 * message.
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
  if (opts.permissions !== undefined) body.permissions = opts.permissions;

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
// Hub revoke-token client (vault#403, MGT)
// ---------------------------------------------------------------------------

/**
 * Discriminated failure modes from `revokeHubJwt`. `network` mirrors
 * `mintHubJwt`; `api-error` carries hub's `{ error, error_description }`.
 * Note: hub's revoke-token is idempotent (re-revoking an already-revoked
 * jti returns 200), so a successful idempotent re-revoke is NOT an error.
 */
export type RevokeHubJwtError =
  | { kind: "network"; cause: string; origin: string }
  | { kind: "api-error"; status: number; error: string; description: string };

export interface RevokeHubJwtOpts {
  hubOrigin: string;
  /**
   * RAW caller bearer. As of hub#454, a `vault:<N>:admin` hub JWT is
   * sufficient to revoke any jti whose scopes it could have minted (same-vault
   * capability attenuation, symmetric to mint) — so the manage-token proxy
   * forwards the caller's own `vault:<N>:admin` bearer here. A
   * `parachute:host:auth` operator bearer also works (it can revoke anything).
   */
  operatorToken: string;
  /** The hub jti to revoke. */
  jti: string;
  /** Test seam — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface RevokedHubJwt {
  jti: string;
  revoked_at: string;
}

/**
 * POST to `<hub>/api/auth/revoke-token` with `{ jti }`.
 *
 * As of hub#454, hub's revoke-token applies capability attenuation symmetric
 * to mint: a `vault:<N>:admin` bearer may revoke any jti whose scopes it could
 * have minted (same-vault subsets), and `parachute:host:auth` may revoke
 * anything. So the manage-token proxy's caller `vault:<N>:admin` bearer is the
 * expected-success path for revoking tokens it minted within that vault's
 * authority — `parachute:host:auth` is no longer required.
 *
 * Idempotent on hub's side (re-revoking an already-revoked jti returns 200).
 * Network failures are caught and returned, not thrown.
 */
export async function revokeHubJwt(opts: RevokeHubJwtOpts): Promise<RevokedHubJwt | RevokeHubJwtError> {
  const url = `${opts.hubOrigin.replace(/\/$/, "")}/api/auth/revoke-token`;
  const fetchFn = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${opts.operatorToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jti: opts.jti }),
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return { kind: "network", cause, origin: opts.hubOrigin };
  }

  if (!res.ok) {
    let error = "unknown_error";
    let description = `HTTP ${res.status}`;
    try {
      const payload = (await res.json()) as { error?: unknown; error_description?: unknown };
      if (typeof payload.error === "string") error = payload.error;
      if (typeof payload.error_description === "string") description = payload.error_description;
    } catch {}
    return { kind: "api-error", status: res.status, error, description };
  }

  const payload = (await res.json()) as Partial<RevokedHubJwt>;
  if (typeof payload.jti !== "string" || typeof payload.revoked_at !== "string") {
    return {
      kind: "api-error",
      status: res.status,
      error: "malformed_response",
      description: "hub revoke-token response is missing required fields (jti/revoked_at)",
    };
  }
  return { jti: payload.jti, revoked_at: payload.revoked_at };
}

// ---------------------------------------------------------------------------
// `mcp-config` — emit the JSON shape `claude -p --mcp-config '<json>'` expects
// ---------------------------------------------------------------------------

/**
 * Build the JSON config shape consumed by `claude -p --mcp-config '<json>'`.
 *
 * Two emission modes:
 *
 *   - **literal** (`useEnvVars: false`): the URL and bearer are inlined. The
 *     emitted JSON is ready to splice into a runner via shell substitution
 *     (`--mcp-config "$(parachute-vault mcp-config <name>)"`). Treat the
 *     output as secret — it carries a usable bearer.
 *
 *   - **env-var template** (`useEnvVars: true`): the URL becomes
 *     `${PARACHUTE_HUB_URL}/vault/<name>/mcp` and the Authorization value
 *     becomes `Bearer ${PARACHUTE_VAULT_TOKEN}`. Shape-only; safe to commit.
 *     Consumers must expand the placeholders at runtime (most shells do this
 *     under double-quoted interpolation; `claude -p` itself does not).
 *
 * The `entryKey` rule mirrors `buildMcpEntryPlan`: vault-explicit installs
 * key as `parachute-vault-<name>` so multi-vault runners can mount more than
 * one vault under distinct slots. (The default install — singular
 * `parachute-vault` — is reserved for the local-scope MCP entry; `mcp-config`
 * always pins the per-vault key, since this is the script-spawning shape
 * where you usually do name the vault.)
 *
 * Always emits stable JSON with two-space indent so the output is diff-able
 * across runs.
 */
export interface BuildMcpConfigJsonOpts {
  vaultName: string;
  /** Base URL (without `/vault/<name>/mcp`). Ignored when `useEnvVars` is true. */
  baseUrl: string;
  /** Bearer to embed verbatim. Ignored when `useEnvVars` is true. */
  bearer: string;
  /** Emit `${PARACHUTE_HUB_URL}` / `${PARACHUTE_VAULT_TOKEN}` placeholders instead of inlined values. */
  useEnvVars?: boolean;
}

export function buildMcpConfigJson(opts: BuildMcpConfigJsonOpts): string {
  const { vaultName, baseUrl, bearer, useEnvVars } = opts;
  const entryKey = `parachute-vault-${vaultName}`;
  const url = useEnvVars
    ? `\${PARACHUTE_HUB_URL}/vault/${vaultName}/mcp`
    : `${baseUrl.replace(/\/$/, "")}/vault/${vaultName}/mcp`;
  const authValue = useEnvVars
    ? "Bearer ${PARACHUTE_VAULT_TOKEN}"
    : `Bearer ${bearer}`;
  const config = {
    mcpServers: {
      [entryKey]: {
        type: "http",
        url,
        headers: { Authorization: authValue },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}

// ---------------------------------------------------------------------------
// Install target resolver
// ---------------------------------------------------------------------------

export type InstallScope = "user" | "project" | "local";

export interface InstallTarget {
  /** Absolute path the install will write to. */
  path: string;
  /** Which scope the path corresponds to (for log lines + doctor). */
  scope: InstallScope;
  /**
   * For `local` scope: the absolute CWD the entry is keyed under inside
   * `~/.claude.json`'s `projects` map. Undefined for `user` and `project`.
   */
  localProjectKey?: string;
}

/**
 * Pick the MCP client config file path based on `--install-scope`. Three
 * shapes:
 *
 *   user    → `~/.claude.json` top-level `mcpServers` (global, every project).
 *   project → `<cwd>/.mcp.json` (Claude Code convention; check into the repo).
 *   local   → `~/.claude.json` under `projects[<absolute-cwd>].mcpServers`
 *             (private to this machine, scoped to this directory). Matches
 *             Claude's own `claude mcp add` default.
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
  const claudeJson = resolve(home, ".claude.json");
  if (scope === "local") {
    return {
      path: claudeJson,
      scope: "local",
      localProjectKey: resolve(cwd),
    };
  }
  return { path: claudeJson, scope: "user" };
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
 * Look for an existing parachute-vault entry across the three scopes:
 *   user    — `~/.claude.json` top-level `mcpServers`.
 *   local   — `~/.claude.json` under `projects[<cwd>].mcpServers`.
 *   project — `<cwd>/.mcp.json`.
 *
 * Returns each matching entry independently so the walkthrough can present
 * the most relevant one to the operator.
 *
 * `parachute-vault` (singular) wins over `parachute-vault-<name>` at the
 * same file — the singular slot is the canonical default install; per-
 * vault keys are the multi-vault add-ons.
 */
export function detectExistingEntries(
  cwd: string = process.cwd(),
): { user?: ExistingMcpEntry; local?: ExistingMcpEntry; project?: ExistingMcpEntry } {
  const userTarget = resolveInstallTarget("user");
  const localTarget = resolveInstallTarget("local", cwd);
  const projectTarget = resolveInstallTarget("project", cwd);
  const userConfig = readJsonOrNull(userTarget.path);
  return {
    ...maybeUserEntry(userConfig, userTarget.path),
    ...maybeLocalEntry(userConfig, localTarget.path, localTarget.localProjectKey!),
    ...maybeProjectEntry(projectTarget.path, `${cwd}/.mcp.json`),
  };

  function readJsonOrNull(p: string): any {
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf-8"));
    } catch {
      return null;
    }
  }

  function pickEntry(servers: Record<string, any>): { entry: any; entryKey: string } | null {
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
    if (!entry || typeof entry.url !== "string") return null;
    return { entry, entryKey };
  }

  function maybeUserEntry(config: any, p: string): { user?: ExistingMcpEntry } | {} {
    if (!config) return {};
    const servers: Record<string, any> = config?.mcpServers ?? {};
    const picked = pickEntry(servers);
    if (!picked) return {};
    return {
      user: {
        path: p,
        label: "~/.claude.json",
        scope: "user",
        entryKey: picked.entryKey,
        url: picked.entry.url,
        hasAuth: Boolean(picked.entry.headers?.Authorization),
      },
    };
  }

  function maybeLocalEntry(
    config: any,
    p: string,
    projectKey: string,
  ): { local?: ExistingMcpEntry } | {} {
    if (!config) return {};
    const servers: Record<string, any> = config?.projects?.[projectKey]?.mcpServers ?? {};
    const picked = pickEntry(servers);
    if (!picked) return {};
    return {
      local: {
        path: p,
        label: `~/.claude.json (projects["${projectKey}"])`,
        scope: "local",
        entryKey: picked.entryKey,
        url: picked.entry.url,
        hasAuth: Boolean(picked.entry.headers?.Authorization),
      },
    };
  }

  function maybeProjectEntry(p: string, label: string): { project?: ExistingMcpEntry } | {} {
    const config = readJsonOrNull(p);
    if (!config) return {};
    const servers: Record<string, any> = config?.mcpServers ?? {};
    const picked = pickEntry(servers);
    if (!picked) return {};
    return {
      project: {
        path: p,
        label,
        scope: "project",
        entryKey: picked.entryKey,
        url: picked.entry.url,
        hasAuth: Boolean(picked.entry.headers?.Authorization),
      },
    };
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
  /**
   * Vault listen port. Carried on the context so the preview's
   * `buildMcpEntryPlan` call resolves the MCP URL through the same
   * `chooseMcpUrl` path the writer uses. Without this, preview was building
   * the URL from `${hubOrigin}/vault/<name>/mcp` directly — coincidentally
   * identical today but liable to drift.
   */
  port: number;
  /**
   * Environment snapshot used for hub-origin resolution. Held on the
   * context so the preview's URL build sees the same `PARACHUTE_HUB_ORIGIN`
   * the writer will see (tests can override deterministically).
   */
  env: { PARACHUTE_HUB_ORIGIN?: string | undefined };
  /** Whether `~/.parachute/operator.token` exists and is non-empty. */
  operatorTokenPresent: boolean;
  /** Heuristic: is CWD a project directory? */
  inProjectContext: boolean;
  /** Where the walkthrough was invoked from. */
  cwd: string;
  /** Pre-existing entries at user / local / project scope, if any. */
  existing: { user?: ExistingMcpEntry; local?: ExistingMcpEntry; project?: ExistingMcpEntry };
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
  const hubEnv = { PARACHUTE_HUB_ORIGIN: env.PARACHUTE_HUB_ORIGIN };
  const hub = chooseHubOrigin(opts.port, hubEnv);
  return {
    vaults: opts.vaults,
    defaultVault: opts.defaultVault,
    hubReachable: hub.source !== "loopback",
    hubOrigin: hub.url,
    port: opts.port,
    env: hubEnv,
    operatorTokenPresent: readOperatorToken(env) !== null,
    inProjectContext: detectProjectContext(cwd),
    cwd,
    existing: detectExistingEntries(cwd),
  };
}
