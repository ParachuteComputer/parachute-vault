/**
 * `/` — vault picker.
 *
 * Phase A entry point. Lists every vault hosted by this server (read from
 * the public `/vaults/list` endpoint). Each row links to the per-vault
 * detail page where the actual admin surfaces live. Token mint, config
 * edit, etc. land in subsequent phases.
 *
 * This page intentionally requires NO auth — it's the landing surface a
 * fresh hub-redirect lands on (if `#token=...` was missing or stripped),
 * and showing an empty 401 there is worse UX than showing the names and
 * letting the auth failure surface on the detail click.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { HttpError, listVaultNames } from "../lib/api.ts";

type State =
  | { kind: "loading" }
  | { kind: "ok"; vaults: string[] }
  | { kind: "error"; message: string };

export function VaultsList() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    listVaultNames()
      .then((vaults) => {
        if (cancelled) return;
        setState({ kind: "ok", vaults });
      })
      .catch((err) => {
        if (cancelled) return;
        const message =
          err instanceof HttpError ? `${err.status}: ${err.message}` : err instanceof Error ? err.message : String(err);
        setState({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") {
    return (
      <div>
        <h2>Vaults</h2>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div>
        <h2>Vaults</h2>
        <div className="error-banner">
          <code>{state.message}</code>
        </div>
      </div>
    );
  }

  if (state.vaults.length === 0) {
    return (
      <div>
        <h2>Vaults</h2>
        <div className="empty">
          No vaults yet. Run <code>parachute-vault create &lt;name&gt;</code> on the host to create one.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="list-header">
        <h2>Vaults</h2>
      </div>
      {state.vaults.map((name) => (
        <Link key={name} to={`/vault/${name}`} className="vault-row">
          <div className="body">
            <div className="name">
              <code>{name}</code>
            </div>
          </div>
          <div className="chev">→</div>
        </Link>
      ))}
    </div>
  );
}
