/**
 * `/` under the multi-vault mount (`/vault/admin/`, B3 of the 2026-06-09
 * hub-module-boundary migration) — the vault MODULE's home surface.
 *
 * The flagship of the thin-hub shift: vault's instance-lifecycle UX
 * (list / create / delete) lives HERE, in vault's own surface, while the
 * hub keeps the identity transactions (`POST /vaults`,
 * `DELETE /vaults/<name>` with its enumerated cascade). The page composes
 * the two through the operator's hub session:
 *
 *   - The LIST is the public well-known doc — load-open, no auth.
 *   - CREATE / DELETE drive the hub endpoints with a host-admin bearer
 *     minted from the session cookie (`lib/host-admin-auth.ts`). An
 *     unauthenticated visitor sees the page plus the `SignInBanner`
 *     (mints fail → banner; signing in recovers via the banner's poll).
 *   - Per-vault USAGE cells fan out lazily, one isolated mint+fetch per
 *     row (`lib/multi-vault-api.ts:fetchVaultUsage`) — failures collapse
 *     to "—" so a down/old vault can't break the list.
 *
 * Per-vault deep-links are FULL-DOCUMENT navigations: plain
 * `<a href="/vault/<name>/admin/">` (origin-absolute), never React Router
 * `Link`. Two reasons, both load-bearing: under `basename="/vault/admin"`
 * a `Link` would resolve to `/vault/admin/vault/<name>/admin/`, and the
 * SPA's per-vault token cache is one-vault-per-document — each instance's
 * admin must boot in its own document. (This is the documented carve-out
 * from web/ui/CLAUDE.md's "never hardcode a leading-slash URL" rule.)
 *
 * Served direct on :1940 (no hub front door) the well-known fetch 404s →
 * the page degrades to a read-only banner pointing at the hub origin,
 * with a best-effort name list from the daemon's public `/vaults/list`.
 */
import { useCallback, useEffect, useState } from "react";
import { listVaultNames } from "../lib/api.ts";
import { HostAdminError, ensureHostAdminToken, redirectToAccountHome } from "../lib/host-admin-auth.ts";
import {
  type CreateVaultResult,
  type DeleteVaultResult,
  type VaultUsage,
  type WellKnownVault,
  VaultsApiError,
  createVaultViaHub,
  deleteVaultViaHub,
  fetchVaultUsage,
  formatBytes,
  listWellKnownVaults,
  validateNewVaultName,
} from "../lib/multi-vault-api.ts";
import { SignInBanner } from "../lib/SignInBanner.tsx";

type ListState =
  | { kind: "loading" }
  | { kind: "ok"; vaults: WellKnownVault[] }
  | { kind: "no-hub"; names: string[] }
  | { kind: "error"; message: string };

/** Host-admin session state. `ok` enables create/delete; `banner` renders
 *  the SignInBanner with the matching status (403 = the non-admin
 *  "go to your account" case). */
type AuthState = { kind: "checking" } | { kind: "ok" } | { kind: "banner"; status: number | null };

type UsageCell = { kind: "loading" } | { kind: "ok"; usage: VaultUsage } | { kind: "error" };

type CreateState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "created"; result: CreateVaultResult }
  | { kind: "error"; message: string };

type DeleteState =
  | { kind: "idle" }
  /** Confirm UI open for one row; `typed` is the retype-the-name input. */
  | { kind: "confirming"; name: string; typed: string }
  | { kind: "deleting"; name: string }
  | { kind: "done"; result: DeleteVaultResult }
  | { kind: "error"; name: string; message: string };

export function MultiVaultHome() {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [auth, setAuth] = useState<AuthState>({ kind: "checking" });
  const [usage, setUsage] = useState<Record<string, UsageCell>>({});
  const [create, setCreate] = useState<CreateState>({ kind: "idle" });
  const [newName, setNewName] = useState("");
  const [del, setDel] = useState<DeleteState>({ kind: "idle" });
  const [reload, setReload] = useState(0);

  // --- vault list (load-open) ---------------------------------------------
  useEffect(() => {
    void reload; // trigger-only dep — re-fetch after create/delete
    let cancelled = false;
    listWellKnownVaults().then(async (result) => {
      if (cancelled) return;
      if (result.kind === "ok") {
        setList({ kind: "ok", vaults: result.vaults });
        return;
      }
      if (result.kind === "no-hub") {
        // Direct-on-:1940 degraded mode: best-effort names from the
        // daemon's public /vaults/list (may itself be disabled — empty
        // list is fine, the banner is the message).
        const names = await listVaultNames().catch(() => [] as string[]);
        if (cancelled) return;
        setList({ kind: "no-hub", names });
        return;
      }
      setList({ kind: "error", message: result.message });
    });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  // --- host-admin session probe (hub mode only) ----------------------------
  useEffect(() => {
    if (list.kind !== "ok") return;
    if (auth.kind === "ok") return;
    let cancelled = false;
    ensureHostAdminToken().then((result) => {
      if (cancelled) return;
      if (result.kind === "ok") setAuth({ kind: "ok" });
      else if (result.kind === "forbidden") setAuth({ kind: "banner", status: 403 });
      else if (result.kind === "auth-required") setAuth({ kind: "banner", status: result.status });
      else setAuth({ kind: "banner", status: null });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-probe per list load only
  }, [list.kind]);

  // --- per-row usage fan-out (isolated, fault-tolerant) --------------------
  useEffect(() => {
    if (list.kind !== "ok") return;
    const names = list.vaults.map((v) => v.name);
    if (names.length === 0) return;
    let cancelled = false;
    setUsage((prev) => {
      const next = { ...prev };
      for (const name of names) if (!next[name]) next[name] = { kind: "loading" };
      return next;
    });
    for (const name of names) {
      fetchVaultUsage(name)
        .then((u) => {
          if (cancelled) return;
          setUsage((prev) => ({ ...prev, [name]: { kind: "ok", usage: u } }));
        })
        .catch(() => {
          if (cancelled) return;
          setUsage((prev) => ({ ...prev, [name]: { kind: "error" } }));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [list]);

  const onBannerRecovered = useCallback(() => {
    setAuth({ kind: "ok" });
    setUsage({}); // re-seed: signed-in mints can now succeed
    setReload((n) => n + 1);
  }, []);

  // --- actions --------------------------------------------------------------
  const nameError = validateNewVaultName(newName);

  async function onCreate(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (newName.length === 0 || nameError) return;
    setCreate({ kind: "submitting" });
    try {
      const result = await createVaultViaHub(newName);
      setCreate({ kind: "created", result });
      setNewName("");
      setReload((n) => n + 1);
    } catch (err) {
      if (err instanceof HostAdminError) {
        if (err.disposition === "forbidden") {
          redirectToAccountHome();
          return;
        }
        setAuth({ kind: "banner", status: err.status || null });
        setCreate({ kind: "idle" });
        return;
      }
      const message =
        err instanceof VaultsApiError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      setCreate({ kind: "error", message });
    }
  }

  async function onConfirmDelete(name: string): Promise<void> {
    setDel({ kind: "deleting", name });
    try {
      const result = await deleteVaultViaHub(name);
      setDel({ kind: "done", result });
      setUsage((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      setReload((n) => n + 1);
    } catch (err) {
      if (err instanceof HostAdminError) {
        if (err.disposition === "forbidden") {
          redirectToAccountHome();
          return;
        }
        setAuth({ kind: "banner", status: err.status || null });
        setDel({ kind: "idle" });
        return;
      }
      // 409 last_vault carries the hub's guidance message (resurrection
      // guard + the CLI escape hatch) — surface it verbatim.
      const message =
        err instanceof VaultsApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      setDel({ kind: "error", name, message });
    }
  }

  // --- render ----------------------------------------------------------------

  if (list.kind === "loading") {
    return (
      <div>
        <h2>Vaults</h2>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (list.kind === "no-hub") {
    return (
      <div>
        <h2>Vaults</h2>
        <div className="warn-banner" role="status">
          <p style={{ margin: "0 0 0.5rem" }}>
            This page is being served directly by the vault daemon — there's no hub on this
            origin, so vault management (create / delete) isn't available here.
          </p>
          <p className="dim" style={{ margin: 0, fontSize: "0.85rem" }}>
            The hub origin is the front door: open <code>/vault/admin/</code> on your hub (port
            1939 by default) to manage vaults. Read-only vault names below.
          </p>
        </div>
        {list.names.length > 0 ? (
          <div style={{ marginTop: "1rem" }}>
            {list.names.map((name) => (
              <a key={name} href={`/vault/${encodeURIComponent(name)}/admin/`} className="vault-row">
                <div className="body">
                  <div className="name">
                    <code>{name}</code>
                  </div>
                </div>
                <div className="chev">→</div>
              </a>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  if (list.kind === "error") {
    return (
      <div>
        <h2>Vaults</h2>
        <div className="error-banner">
          <code>{list.message}</code>
        </div>
        <button type="button" className="secondary" onClick={() => setReload((n) => n + 1)}>
          Retry
        </button>
      </div>
    );
  }

  const canMutate = auth.kind === "ok";

  return (
    <div>
      <div className="list-header">
        <h2>Vaults ({list.vaults.length})</h2>
      </div>

      {auth.kind === "banner" ? (
        <SignInBanner status={auth.status} onRecovered={onBannerRecovered} ensure={ensureHostAdminToken} />
      ) : null}

      <p className="muted">
        Vaults registered with this hub. <strong>Manage</strong> opens each vault's own admin
        page (a full page load — use your browser's back button to return here).
      </p>

      {del.kind === "done" ? <CascadeSummaryView result={del.result} onDismiss={() => setDel({ kind: "idle" })} /> : null}

      {list.vaults.length === 0 ? (
        <div className="empty">
          No vaults yet{canMutate ? " — create your first below." : "."}
        </div>
      ) : (
        <div style={{ marginTop: "1rem" }}>
          {list.vaults.map((v) => {
            const usageCell = usage[v.name];
            const usageText =
              usageCell?.kind === "ok"
                ? `${usageCell.usage.notes} ${usageCell.usage.notes === 1 ? "note" : "notes"} · ${formatBytes(usageCell.usage.totalBytes)}`
                : usageCell?.kind === "loading"
                  ? "…"
                  : "—";
            const isConfirming = del.kind === "confirming" && del.name === v.name;
            const isDeleting = del.kind === "deleting" && del.name === v.name;
            const rowError = del.kind === "error" && del.name === v.name ? del.message : null;
            return (
              <div key={v.name} className="vault-row-group">
                <div className="vault-row">
                  <div className="body">
                    <div className="name">
                      <code>{v.name}</code>
                      {v.version ? (
                        <span className="tag muted" title="Vault version">
                          {" "}
                          v{v.version}
                        </span>
                      ) : null}
                    </div>
                    <div className="dim vault-usage" data-testid={`vault-usage-${v.name}`}>
                      {usageText}
                    </div>
                    {rowError ? (
                      <div className="error-banner" style={{ marginTop: "0.5rem" }}>
                        <code>{rowError}</code>
                      </div>
                    ) : null}
                  </div>
                  <div className="vault-row-actions">
                    {/* Full-document navigation by design — see module docstring. */}
                    <a href={`/vault/${encodeURIComponent(v.name)}/admin/`}>
                      <button type="button">Manage</button>
                    </a>
                    {canMutate ? (
                      <button
                        type="button"
                        className="secondary"
                        disabled={isDeleting}
                        onClick={() =>
                          setDel(
                            isConfirming
                              ? { kind: "idle" }
                              : { kind: "confirming", name: v.name, typed: "" },
                          )
                        }
                      >
                        {isDeleting ? "Deleting…" : "Delete"}
                      </button>
                    ) : null}
                  </div>
                </div>
                {isConfirming && del.kind === "confirming" ? (
                  <div className="section" style={{ marginTop: "0.5rem" }}>
                    <p style={{ margin: "0 0 0.5rem" }}>
                      Deleting <code>{v.name}</code> permanently destroys its notes and revokes
                      every token, grant, assignment, and invite naming it. Type the vault name to
                      confirm:
                    </p>
                    <div className="row" style={{ display: "flex", gap: "0.5rem" }}>
                      <input
                        type="text"
                        aria-label={`Type ${v.name} to confirm deletion`}
                        placeholder={v.name}
                        value={del.typed}
                        onChange={(e) =>
                          setDel({ kind: "confirming", name: v.name, typed: e.target.value })
                        }
                      />
                      <button
                        type="button"
                        disabled={del.typed !== v.name}
                        onClick={() => void onConfirmDelete(v.name)}
                      >
                        Delete this vault
                      </button>
                      <button type="button" className="secondary" onClick={() => setDel({ kind: "idle" })}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {canMutate ? (
        <div className="section" style={{ marginTop: "1.5rem" }}>
          <h3 style={{ margin: "0 0 0.85rem", fontSize: "1rem", fontWeight: 500 }}>
            Create a vault
          </h3>
          {create.kind === "created" ? (
            <CreatedBanner result={create.result} onDone={() => setCreate({ kind: "idle" })} />
          ) : (
            <form onSubmit={(e) => void onCreate(e)}>
              {create.kind === "error" ? (
                <div className="error-banner" style={{ marginBottom: "0.5rem" }}>
                  Couldn't create vault: <code>{create.message}</code>
                </div>
              ) : null}
              <div className="row" style={{ display: "flex", gap: "0.5rem" }}>
                <input
                  id="new-vault-name"
                  type="text"
                  aria-label="New vault name"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. work, home, scratch"
                  disabled={create.kind === "submitting"}
                />
                <button
                  type="submit"
                  disabled={newName.length === 0 || !!nameError || create.kind === "submitting"}
                >
                  {create.kind === "submitting" ? "Creating…" : "Create vault"}
                </button>
              </div>
              {nameError ? (
                <div className="field-error">{nameError}</div>
              ) : (
                <div className="dim" style={{ fontSize: "0.85rem", marginTop: "0.35rem" }}>
                  Lowercase letters, numbers, hyphens, underscores. Becomes the path under{" "}
                  <code>/vault/&lt;name&gt;</code>.
                </div>
              )}
            </form>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Post-create result. Branches on `created` (HTTP 201 vs idempotent 200),
 * never token truthiness — a 201 can carry no token when the bootstrap
 * mint was unavailable (the hub SPA's NewVault lesson, ported here).
 */
function CreatedBanner({ result, onDone }: { result: CreateVaultResult; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (!result.token) return;
    try {
      await navigator.clipboard.writeText(result.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can fail in non-secure contexts; the token stays visible
      // for manual copy.
    }
  };

  if (result.token) {
    return (
      <div className="mint-banner">
        <h4 style={{ margin: "0 0 0.5rem" }}>
          Vault <code>{result.name}</code> created — access token (shown once)
        </h4>
        <p className="muted">
          A hub-issued JWT scoped <code>vault:{result.name}:admin</code>, shown only this once.{" "}
          {result.tokenGuidance ??
            "It is short-lived — don't bank it as a durable credential. You don't need it for the OAuth connect path."}{" "}
          For a durable header-auth token, mint a scope-narrow one with{" "}
          <code>parachute auth mint-token --scope vault:{result.name}:read</code>.
        </p>
        <div className="token-box">
          <code>{result.token}</code>
          <button type="button" className="secondary" onClick={() => void onCopy()}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div className="actions" style={{ marginTop: "0.5rem" }}>
          <button type="button" onClick={onDone}>
            Done — I've saved the token
          </button>
        </div>
      </div>
    );
  }

  if (result.created) {
    return (
      <div className="section">
        <p>
          Vault <code>{result.name}</code> was created
          {result.tokenGuidance ? (
            <>
              {" "}
              — <span className="muted">{result.tokenGuidance}</span>
            </>
          ) : (
            <span className="muted"> (no bootstrap token was minted)</span>
          )}
          . Connect over OAuth (no token needed), or mint a scope-narrow header-auth token with{" "}
          <code>parachute auth mint-token --scope vault:{result.name}:read</code>.
        </p>
        <button type="button" onClick={onDone}>
          Done
        </button>
      </div>
    );
  }

  return (
    <div className="section">
      <p>
        Vault <code>{result.name}</code> already existed; nothing new was created.
      </p>
      <button type="button" onClick={onDone}>
        Continue
      </button>
    </div>
  );
}

/** The structured delete-cascade summary from hub#637 — counts per identity
 *  artifact class, plus the report-only orphaned-channels warning. */
function CascadeSummaryView({ result, onDismiss }: { result: DeleteVaultResult; onDismiss: () => void }) {
  const c = result.cascade;
  return (
    <div className="section" role="status" style={{ marginTop: "0.75rem" }}>
      <h3 style={{ margin: "0 0 0.5rem", fontSize: "1rem", fontWeight: 500 }}>
        Vault <code>{result.name}</code> deleted
      </h3>
      <ul style={{ margin: "0 0 0.5rem" }}>
        <li>{c.tokens_revoked} token(s) revoked</li>
        <li>
          {c.grants_rewritten} grant(s) rewritten, {c.grants_dropped} dropped
        </li>
        <li>{c.user_vaults_removed} user assignment(s) removed</li>
        <li>{c.invites_invalidated} invite(s) invalidated</li>
        <li>{c.connections_torn_down} connection(s) torn down</li>
        <li>
          vault data {c.vault_removed ? "removed" : "NOT removed"}; module{" "}
          {c.module_restarted ? "restarted" : "not restarted"}
        </li>
      </ul>
      {c.orphaned_channels.length > 0 ? (
        <div className="warn-banner" style={{ marginBottom: "0.5rem" }}>
          Orphaned channel(s) still reference this vault:{" "}
          {c.orphaned_channels.map((name, i) => (
            <span key={name}>
              {i > 0 ? ", " : ""}
              <code>{name}</code>
            </span>
          ))}{" "}
          — remove them from the channel module's own admin page.
        </div>
      ) : null}
      {result.warnings.length > 0 ? (
        <div className="warn-banner" style={{ marginBottom: "0.5rem" }}>
          {result.warnings.map((w) => (
            <div key={w.step}>
              <code>{w.step}</code>: {w.detail}
            </div>
          ))}
        </div>
      ) : null}
      <button type="button" className="secondary" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
