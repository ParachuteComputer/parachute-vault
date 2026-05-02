/**
 * `/vault/:name/tokens` — token management.
 *
 * Phase B (vault#217). Three operations against `/vault/<name>/tokens`:
 *
 *   - **List**     — table of label / scopes / created / last-used.
 *   - **Mint**     — form for label + (optional) scope-narrowing. On 201
 *     the plaintext `pvt_*` is rendered exactly once in a banner with copy
 *     + dismissal warning. Server can't re-emit; we hold it in component
 *     state and lose it on navigation away. Dismissal clears it explicitly.
 *   - **Revoke**   — confirm modal then DELETE.
 *
 * Mutate UI is gated on `hasAdminScope(name)`. The vault server requires
 * `vault:<name>:admin` for all three verbs (list, mint, revoke), so the
 * client-side gate is defense-in-depth: a read-scoped session sees a
 * banner directing them to re-auth instead of getting a 403 toast on
 * every interaction.
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { HttpError } from "../lib/api.ts";
import { hasAdminScope } from "../lib/scope.ts";
import {
  type MintTokenResult,
  type TokenSummary,
  listTokens,
  mintToken,
  revokeToken,
} from "../lib/tokens-api.ts";

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; tokens: TokenSummary[] }
  | { kind: "auth-required" }
  | { kind: "error"; message: string };

const KNOWN_SCOPE_VERBS = ["read", "write", "admin"] as const;

export function VaultTokens() {
  const { name } = useParams<{ name: string }>();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [minted, setMinted] = useState<MintTokenResult | null>(null);
  const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!name) return;
    setState({ kind: "loading" });
    listTokens(name)
      .then((tokens) => {
        if (cancelled) return;
        setState({ kind: "ok", tokens });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
          setState({ kind: "auth-required" });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [name, reloadTick]);

  if (!name) {
    return (
      <div>
        <h2>Tokens</h2>
        <p className="muted">Missing vault name.</p>
        <Link to="/">← Back to vaults</Link>
      </div>
    );
  }

  const isAdmin = hasAdminScope(name);

  return (
    <div>
      <div className="list-header">
        <h2>
          Tokens for <code>{name}</code>
        </h2>
        <Link to={`/vault/${encodeURIComponent(name)}`} className="muted">
          ← Vault detail
        </Link>
      </div>

      {!isAdmin ? (
        <div className="warn-banner">
          You're viewing this page with a read-only token. Mint and revoke require{" "}
          <code>vault:{name}:admin</code>. Re-enter from the hub directory's "Manage" link with an
          admin-scoped session to manage tokens.
        </div>
      ) : null}

      {minted ? <MintBanner result={minted} onDismiss={() => setMinted(null)} /> : null}

      {/*
       * MintForm is hidden while the just-minted banner is showing. The
       * banner is the single point at which the operator copies the
       * plaintext pvt_*; if a second mint happens before the first is
       * saved, the first is gone forever (the server can't re-emit). The
       * dismissal-then-mint sequence makes that loss impossible by
       * construction. Keep the gate; don't "fix" it back to always-on.
       */}
      {state.kind === "ok" && isAdmin && !minted ? (
        <MintForm
          vaultName={name}
          onMinted={(result) => {
            setMinted(result);
            setReloadTick((n) => n + 1);
          }}
        />
      ) : null}

      <div className="section">
        <h3 style={{ margin: "0 0 0.85rem", fontSize: "1rem", fontWeight: 500 }}>Existing tokens</h3>
        {state.kind === "loading" ? <p className="muted">Loading…</p> : null}
        {state.kind === "auth-required" ? (
          <div className="warn-banner">
            Open this page from the hub's directory — the "Manage" link supplies the admin token.
          </div>
        ) : null}
        {state.kind === "error" ? (
          <div className="error-banner">
            <code>{state.message}</code>
          </div>
        ) : null}
        {state.kind === "ok" ? (
          <TokenList
            vaultName={name}
            tokens={state.tokens}
            allowRevoke={isAdmin}
            confirmingRevokeId={confirmingRevokeId}
            onAskConfirm={setConfirmingRevokeId}
            onRevoked={() => {
              setConfirmingRevokeId(null);
              setReloadTick((n) => n + 1);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function MintBanner({ result, onDismiss }: { result: MintTokenResult; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(result.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard fails outside secure contexts; the token's still in the box.
    }
  };
  return (
    <div className="mint-banner">
      <h3>New token (shown once)</h3>
      <p className="muted">
        This is the only time the vault will show this token. Copy it now and store it somewhere
        safe — a password manager, the operator's notes, paraclaw's secrets store. If you lose it,
        revoke it and mint a new one.
      </p>
      <div className="token-box">
        <code>{result.token}</code>
        <button type="button" onClick={onCopy} className="secondary">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="warn">⚠ Don't dismiss this banner until you've saved the token.</p>
      <div className="actions">
        <button type="button" onClick={onDismiss}>
          Done — I've saved the token
        </button>
      </div>
    </div>
  );
}

function MintForm({
  vaultName,
  onMinted,
}: {
  vaultName: string;
  onMinted: (result: MintTokenResult) => void;
}) {
  const [label, setLabel] = useState("");
  const [verb, setVerb] = useState<(typeof KNOWN_SCOPE_VERBS)[number]>("admin");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedLabel = label.trim();
  const labelMissing = trimmedLabel.length === 0;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (labelMissing) {
      setError("label required — give the token a recognizable name");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await mintToken(vaultName, {
        label: trimmedLabel,
        scopes: [`vault:${vaultName}:${verb}`],
      });
      onMinted(result);
      setLabel("");
      setVerb("admin");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="section">
      <h3 style={{ margin: "0 0 0.85rem", fontSize: "1rem", fontWeight: 500 }}>Mint a token</h3>
      {error ? (
        <div className="error-banner">
          <code>{error}</code>
        </div>
      ) : null}
      <div className="form-row">
        <label htmlFor="mint-label">
          Label <span className="dim">(required)</span>
        </label>
        <input
          id="mint-label"
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. ci, paraclaw-prod, my-laptop"
          maxLength={120}
          required
        />
      </div>
      <div className="form-row">
        <label htmlFor="mint-scope">Scope</label>
        <select
          id="mint-scope"
          value={verb}
          onChange={(e) => setVerb(e.target.value as typeof verb)}
        >
          <option value="read">read — query notes only</option>
          <option value="write">write — query + create/update notes</option>
          <option value="admin">admin — full control (incl. token mgmt)</option>
        </select>
        <p className="dim" style={{ margin: "0.35rem 0 0" }}>
          Issued as <code>vault:{vaultName}:{verb}</code>. Lower scopes inherit narrower powers.
        </p>
      </div>
      <div className="actions">
        <button type="submit" disabled={submitting || labelMissing}>
          {submitting ? "Minting…" : "Mint token"}
        </button>
      </div>
    </form>
  );
}

function TokenList({
  vaultName,
  tokens,
  allowRevoke,
  confirmingRevokeId,
  onAskConfirm,
  onRevoked,
}: {
  vaultName: string;
  tokens: TokenSummary[];
  allowRevoke: boolean;
  confirmingRevokeId: string | null;
  onAskConfirm: (id: string | null) => void;
  onRevoked: () => void;
}) {
  if (tokens.length === 0) {
    return <p className="muted">No tokens yet. Mint one above to get started.</p>;
  }
  return (
    <div className="token-list">
      {tokens.map((tok) => (
        <TokenRow
          key={tok.id}
          vaultName={vaultName}
          token={tok}
          allowRevoke={allowRevoke}
          confirming={confirmingRevokeId === tok.id}
          onAskConfirm={onAskConfirm}
          onRevoked={onRevoked}
        />
      ))}
    </div>
  );
}

function TokenRow({
  vaultName,
  token,
  allowRevoke,
  confirming,
  onAskConfirm,
  onRevoked,
}: {
  vaultName: string;
  token: TokenSummary;
  allowRevoke: boolean;
  confirming: boolean;
  onAskConfirm: (id: string | null) => void;
  onRevoked: () => void;
}) {
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConfirm = async () => {
    setRevoking(true);
    setError(null);
    try {
      await revokeToken(vaultName, token.id);
      onRevoked();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRevoking(false);
    }
  };

  return (
    <div className="token-row">
      <div className="body">
        <div className="name">
          <strong>{token.label}</strong>
          <code className="dim">{token.id}</code>
        </div>
        <div className="meta">
          <span className="dim">scopes:</span>{" "}
          {token.scopes.length > 0 ? (
            token.scopes.map((s) => (
              <code key={s} className="scope-tag">
                {s}
              </code>
            ))
          ) : (
            <span className="dim">(legacy — {token.permission})</span>
          )}
        </div>
        <div className="meta dim">
          created {fmtDate(token.created_at)}
          {token.last_used_at ? ` · last used ${fmtDate(token.last_used_at)}` : " · never used"}
          {token.expires_at ? ` · expires ${fmtDate(token.expires_at)}` : ""}
        </div>
        {error ? (
          <div className="error-banner" style={{ marginTop: "0.5rem" }}>
            <code>{error}</code>
          </div>
        ) : null}
      </div>
      {allowRevoke ? (
        confirming ? (
          <div className="actions">
            <button type="button" onClick={onConfirm} disabled={revoking}>
              {revoking ? "Revoking…" : "Confirm revoke"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => onAskConfirm(null)}
              disabled={revoking}
            >
              Cancel
            </button>
          </div>
        ) : (
          <button type="button" className="secondary" onClick={() => onAskConfirm(token.id)}>
            Revoke
          </button>
        )
      ) : null}
    </div>
  );
}

function fmtDate(iso: string): string {
  // v1 shows ISO timestamps verbatim — exact wall-clock UTC is what an
  // operator wants for incident triage. Phase C may add a relative +
  // local-time formatting pass once the broader admin UI gets a date util.
  return iso;
}
