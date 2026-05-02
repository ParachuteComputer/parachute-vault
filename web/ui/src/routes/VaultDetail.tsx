/**
 * `/vault/:name` — per-vault detail.
 *
 * Phase A scope: name, description, created_at, mount path, and basic
 * stats (notes / tags / attachments / links). Hits `/vault/<name>/` which
 * returns all of these in a single round trip. Authenticated — requires a
 * hub-issued JWT carrying `vault:<name>:read` or higher.
 *
 * Phase B (vault#217) adds tokens; Phase C (vault#218) adds permissions.
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { HttpError, type VaultDetailResult, getVaultDetail } from "../lib/api.ts";

type State =
  | { kind: "loading" }
  | { kind: "ok"; vault: VaultDetailResult }
  | { kind: "auth-required" }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export function VaultDetail() {
  const { name } = useParams<{ name: string }>();
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    if (!name) {
      setState({ kind: "missing" });
      return;
    }
    getVaultDetail(name)
      .then((vault) => {
        if (cancelled) return;
        setState({ kind: "ok", vault });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof HttpError) {
          if (err.status === 401 || err.status === 403) {
            setState({ kind: "auth-required" });
            return;
          }
          if (err.status === 404) {
            setState({ kind: "missing" });
            return;
          }
          setState({ kind: "error", message: `${err.status}: ${err.message}` });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  if (state.kind === "loading") {
    return (
      <div>
        <h2>Vault</h2>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (state.kind === "auth-required") {
    return (
      <div>
        <h2>
          Vault <code>{name}</code>
        </h2>
        <div className="warn-banner">
          Open this page from the hub's directory — the "Manage" link supplies the admin token. Direct loads of{" "}
          <code>/admin/vault/{name}</code> can't see protected vault data.
        </div>
        <Link to="/">← Back to vaults</Link>
      </div>
    );
  }

  if (state.kind === "missing") {
    return (
      <div>
        <h2>Vault not found</h2>
        <p className="muted">
          No vault named <code>{name}</code> is registered on this server.
        </p>
        <Link to="/">← Back to vaults</Link>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div>
        <h2>
          Vault <code>{name}</code>
        </h2>
        <div className="error-banner">
          <code>{state.message}</code>
        </div>
        <Link to="/">← Back to vaults</Link>
      </div>
    );
  }

  const { vault } = state;
  const mountPath = `/vault/${vault.name}`;
  return (
    <div>
      <div className="list-header">
        <h2>
          Vault <code>{vault.name}</code>
        </h2>
        <Link to="/" className="muted">
          ← All vaults
        </Link>
      </div>

      <div className="kv section">
        <div>Name</div>
        <div>
          <code>{vault.name}</code>
        </div>
        {vault.description ? (
          <>
            <div>Description</div>
            <div>{vault.description}</div>
          </>
        ) : null}
        <div>Mount</div>
        <div>
          <code>{mountPath}</code>
        </div>
        {vault.createdAt ? (
          <>
            <div>Created</div>
            <div>
              <code>{vault.createdAt}</code>
            </div>
          </>
        ) : null}
      </div>

      <div className="section">
        <h3 style={{ margin: "0 0 0.85rem", fontSize: "1rem", fontWeight: 500 }}>Stats</h3>
        <div className="stats">
          <div className="stat">
            <div className="label">Notes</div>
            <div className="value">{vault.stats.notes}</div>
          </div>
          <div className="stat">
            <div className="label">Tags</div>
            <div className="value">{vault.stats.tags}</div>
          </div>
          <div className="stat">
            <div className="label">Attachments</div>
            <div className="value">{vault.stats.attachments}</div>
          </div>
          <div className="stat">
            <div className="label">Links</div>
            <div className="value">{vault.stats.links}</div>
          </div>
        </div>
      </div>

      <div className="section">
        <p className="muted">
          Token mint/revoke (Phase B / vault#217) and permissions editing (Phase C / vault#218) land here. For now,
          manage tokens directly with <code>parachute-vault tokens</code> on the host.
        </p>
      </div>
    </div>
  );
}
