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
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { HttpError, type VaultDetailResult, getVaultDetail } from "../lib/api.ts";
import { getIssuerOrigin } from "../lib/scope.ts";
import { SignInBanner } from "../lib/SignInBanner.tsx";
import { McpConnectCard } from "./McpConnectCard.tsx";

type State =
  | { kind: "loading" }
  | { kind: "ok"; vault: VaultDetailResult }
  | { kind: "auth-required"; status: number | null; message?: string }
  | { kind: "missing" }
  | { kind: "error"; message: string };

export function VaultDetail({ vaultName }: { vaultName?: string } = {}) {
  // Two callers: the per-vault mount passes `vaultName` straight through
  // (no `:name` segment exists under `basename="/vault/<name>/admin"`);
  // the stand-alone `/vault/:name` route reads it from useParams. The
  // presence of the prop also tells us which Link shape to emit — under
  // per-vault mount the tokens sub-route is `/tokens`; under stand-alone
  // it's `/vault/<name>/tokens`. Picking the wrong one re-introduces the
  // doubled-URL bug that motivated this refactor.
  const params = useParams<{ name: string }>();
  const name = vaultName ?? params.name;
  const isPerVaultMount = vaultName !== undefined;
  const tokensHref = isPerVaultMount ? "/tokens" : `/vault/${encodeURIComponent(name ?? "")}/tokens`;
  const mirrorHref = isPerVaultMount ? "/mirror" : `/vault/${encodeURIComponent(name ?? "")}/mirror`;
  const schemaHref = isPerVaultMount ? "/schema" : `/vault/${encodeURIComponent(name ?? "")}/schema`;
  const embeddingsHref = isPerVaultMount ? "/embeddings" : `/vault/${encodeURIComponent(name ?? "")}/embeddings`;
  const transcriptionHref = isPerVaultMount ? "/transcription" : `/vault/${encodeURIComponent(name ?? "")}/transcription`;
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const onRecovered = useCallback(() => setReloadTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    if (!name) {
      setState({ kind: "missing" });
      return;
    }
    setState({ kind: "loading" });
    getVaultDetail(name)
      .then((vault) => {
        if (cancelled) return;
        setState({ kind: "ok", vault });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof HttpError) {
          if (err.status === 401 || err.status === 403) {
            // Carry the server's message through. On a 401 whose real cause is
            // server-side (vault#642 — e.g. "revocation list unavailable"),
            // this string is the only written record of what went wrong, and
            // the banner shows it rather than guessing "you're signed out".
            setState({ kind: "auth-required", status: err.status, message: err.message });
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
  }, [name, reloadTick]);

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
        <SignInBanner
          vaultName={name ?? ""}
          status={state.status}
          serverMessage={state.message}
          onRecovered={onRecovered}
        />
        {isPerVaultMount ? null : <Link to="/">← Back to vaults</Link>}
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
        {isPerVaultMount ? null : <Link to="/">← Back to vaults</Link>}
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
        {isPerVaultMount ? null : <Link to="/">← Back to vaults</Link>}
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
        {isPerVaultMount ? null : (
          <Link to="/" className="muted">
            ← All vaults
          </Link>
        )}
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

      {/* Connect-to-AI is the obvious next step after setup. The hub origin
          is derived from the SPA's own origin (window.location.origin — the
          SPA is served at <hub-origin>/vault/<name>/admin) inside the card. */}
      <div className="section">
        <McpConnectCard vaultName={vault.name} tokensHref={tokensHref} />
      </div>

      <div className="section">
        <h3 style={{ margin: "0 0 0.85rem", fontSize: "1rem", fontWeight: 500 }}>Stats</h3>
        <div className="stats">
          <div className="stat">
            <div className="label">Notes</div>
            <div className="value">{vault.stats.totalNotes}</div>
          </div>
          <div className="stat">
            <div className="label">Tags</div>
            <div className="value">{vault.stats.tagCount}</div>
          </div>
          <div className="stat">
            <div className="label">Attachments</div>
            <div className="value">{vault.stats.attachmentCount}</div>
          </div>
          <div className="stat">
            <div className="label">Links</div>
            <div className="value">{vault.stats.linkCount}</div>
          </div>
        </div>
      </div>

      <div className="section">
        <h3 style={{ margin: "0 0 0.85rem", fontSize: "1rem", fontWeight: 500 }}>Manage</h3>
        <ul className="manage-list">
          <li>
            <Link to={tokensHref}>Tokens →</Link>
            <span className="dim"> mint, list, and revoke hub access tokens (JWTs)</span>
          </li>
          <li>
            <Link to={mirrorHref}>Git backup →</Link>
            <span className="dim"> mirror this vault to a git repository on a schedule, or on demand</span>
          </li>
          <li>
            <Link to={schemaHref}>Schema →</Link>
            <span className="dim"> edit tag schemas — fields, indexing, hierarchy, strict validation</span>
          </li>
          <li>
            <Link to={embeddingsHref}>Semantic search →</Link>
          </li>
          <li>
            <Link to={transcriptionHref}>Transcription →</Link>
            <span className="dim"> turn embeddings on or off — rank notes by meaning, not just keywords</span>
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
 * The destination (`GET /hub/permissions?vault=<name>`) is live: hub
 * 301-redirects `/hub/permissions → /admin/permissions` (honoring the
 * `?vault=` query), so the link resolves to hub's permissions UI.
 *
 * Without an `iss` claim (no token, malformed token), we render an
 * informational line instead of a broken link — same content, no false
 * affordance.
 */
function PermissionsLink({ vaultName }: { vaultName: string }) {
  const issuer = getIssuerOrigin();
  if (!issuer) {
    return (
      <li>
        <span>Permissions →</span>
        <span className="dim">
          {" "}grants are managed on hub (the OAuth issuer); link will be live when hub ships its
          permissions UI.
        </span>
      </li>
    );
  }
  const href = `${issuer}/hub/permissions?vault=${encodeURIComponent(vaultName)}`;
  return (
    <li>
      <a href={href}>Permissions →</a>
      <span className="dim">
        {" "}grants are managed on hub (the OAuth issuer); link will be live when hub ships its
        permissions UI.
      </span>
    </li>
  );
}
