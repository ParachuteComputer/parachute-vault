/**
 * `/vault/:name` — per-vault detail.
 *
 * Phase A scope: name, description, created_at, mount path, and basic
 * stats (notes / tags / attachments / links). Hits `/vault/<name>/` which
 * returns all of these in a single round trip. Authenticated — requires a
 * hub-issued JWT carrying `vault:<name>:read` or higher.
 *
 * Phase B (vault#217) added tokens. Phase C (vault#218) surfaces a link to
 * hub's permissions UI under the "Manage" section — grants live in hub's
 * grants table (the OAuth issuer is the source of truth), so the modular
 * play is "vault links to hub" rather than "vault inlines hub data."
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { HttpError, type VaultDetailResult, getVaultDetail } from "../lib/api.ts";
import { getIssuerOrigin } from "../lib/scope.ts";

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
        <h3 style={{ margin: "0 0 0.85rem", fontSize: "1rem", fontWeight: 500 }}>Manage</h3>
        <ul className="manage-list">
          <li>
            <Link to={`/vault/${encodeURIComponent(vault.name)}/tokens`}>Tokens →</Link>
            <span className="dim"> mint, list, and revoke <code>pvt_*</code> tokens</span>
          </li>
          <PermissionsLink vaultName={vault.name} />
        </ul>
      </div>
    </div>
  );
}

/**
 * Forward-pointing link to hub's permissions UI. Hub origin is read from
 * the JWT's `iss` claim (the OAuth issuer set during token mint), so we
 * don't need a runtime-config endpoint or hub coordination — the data's
 * already in hand from the same token that authenticated the page.
 *
 * The destination (hub#162 — `GET /hub/permissions?vault=<name>`) doesn't
 * exist yet; clicks 404 until hub catches up. The copy says so explicitly
 * so an operator who clicks isn't confused by the empty page.
 *
 * Without an `iss` claim (no token, malformed token), we render an
 * informational line instead of a broken link — same content, no false
 * affordance.
 */
function PermissionsLink({ vaultName }: { vaultName: string }) {
  const issuer = getIssuerOrigin();
  const description = (
    <span className="dim">
      {" "}grants are managed on hub (the OAuth issuer); link is forward-pointing — hub#162 is the
      destination.
    </span>
  );
  if (!issuer) {
    return (
      <li>
        <span>Permissions →</span>
        {description}
      </li>
    );
  }
  const href = `${issuer}/hub/permissions?vault=${encodeURIComponent(vaultName)}`;
  return (
    <li>
      <a href={href}>Permissions →</a>
      {description}
    </li>
  );
}
