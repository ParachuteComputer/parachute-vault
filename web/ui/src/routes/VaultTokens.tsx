/**
 * `/vault/:name/tokens` — token management.
 *
 * The auth-unification arc (SPA step). New tokens are **hub JWTs** minted via
 * hub's registry (`/api/auth/*`) with the host-admin bearer
 * (`host-admin-auth.ts`). The deprecated `pvt_*` mint path is GONE — the only
 * remaining trace of `pvt_*` is a read-only + revoke-only "Legacy tokens"
 * section, shown when the vault still has live `pvt_*` rows (until the DROP,
 * vault#282). Fresh installs never see it.
 *
 * Three operations on the hub-JWT surface:
 *   - **List**   — accumulate ALL pages of `/api/auth/tokens`, then
 *     client-filter to this vault's `vault:<name>:*` rows.
 *   - **Mint**   — form for label + scope verb + optional tag-allowlist + TTL.
 *     On 200 the one-time-reveal hub JWT renders in a banner (single-emit;
 *     the server never re-emits it).
 *   - **Revoke** — confirm modal then `POST /api/auth/revoke-token { jti }`.
 *
 * Mutate UI is gated on `hasAdminScope(name)` (the vault-admin JWT the SPA
 * already holds). The host-admin bearer is minted lazily by the token API
 * calls; a friend account (signed in but not the hub admin) gets a 403 from
 * the host-admin endpoint → we redirect to the issuer's `/account/` home.
 *
 * Two independent load states: the hub-JWT list (host-admin bearer) and the
 * legacy `pvt_*` list (vault-admin bearer). They load + fail independently.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { HttpError } from "../lib/api.ts";
import { HostAdminError, redirectToAccountHome } from "../lib/host-admin-auth.ts";
import { hasAdminScope } from "../lib/scope.ts";
import { SignInBanner } from "../lib/SignInBanner.tsx";
import {
  DEFAULT_TTL_DAYS,
  type HubTokenSummary,
  type LegacyTokenSummary,
  type MintHubTokenResult,
  type ScopeVerb,
  TTL_DAY_OPTIONS,
  listHubTokens,
  listLegacyTokens,
  listVaultTags,
  mintHubToken,
  revokeHubToken,
  revokeLegacyToken,
} from "../lib/tokens-api.ts";

type HubLoadState =
  | { kind: "loading" }
  | { kind: "ok"; tokens: HubTokenSummary[] }
  | { kind: "auth-required"; status: number | null }
  | { kind: "error"; message: string };

type LegacyLoadState =
  | { kind: "loading" }
  | { kind: "ok"; tokens: LegacyTokenSummary[] }
  // Legacy-list auth/error failures are non-fatal — the hub-JWT surface is
  // the page's primary function. We collapse them to "hidden" so a vault
  // whose legacy endpoint 401s/errors just doesn't render the section.
  | { kind: "hidden" };

const KNOWN_SCOPE_VERBS: ScopeVerb[] = ["read", "write", "admin"];

const TTL_LABELS: Record<number, string> = {
  30: "30 days",
  90: "90 days",
  180: "180 days",
  365: "1 year (max)",
};

/** Branch a thrown error from a host-admin-backed call into the right load
 *  disposition. `forbidden` triggers the friend-account redirect as a side
 *  effect; the returned state is what the caller should set. */
function dispositionForHubError(err: unknown): HubLoadState {
  if (err instanceof HostAdminError) {
    if (err.disposition === "forbidden") {
      redirectToAccountHome();
      return { kind: "auth-required", status: 403 };
    }
    if (err.disposition === "auth-required") {
      return { kind: "auth-required", status: err.status };
    }
    return { kind: "error", message: err.message };
  }
  if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
    return { kind: "auth-required", status: err.status };
  }
  return { kind: "error", message: err instanceof Error ? err.message : String(err) };
}

export function VaultTokens({ vaultName }: { vaultName?: string } = {}) {
  const params = useParams<{ name: string }>();
  const name = vaultName ?? params.name;
  const isPerVaultMount = vaultName !== undefined;
  const detailHref = isPerVaultMount ? "/" : `/vault/${encodeURIComponent(name ?? "")}`;

  const [hubState, setHubState] = useState<HubLoadState>({ kind: "loading" });
  const [legacyState, setLegacyState] = useState<LegacyLoadState>({ kind: "loading" });
  const [minted, setMinted] = useState<MintHubTokenResult | null>(null);
  const [confirmingRevokeJti, setConfirmingRevokeJti] = useState<string | null>(null);
  const [confirmingLegacyId, setConfirmingLegacyId] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  // Hub-JWT list (host-admin bearer).
  useEffect(() => {
    let cancelled = false;
    if (!name) return;
    setHubState({ kind: "loading" });
    listHubTokens(name)
      .then((tokens) => {
        if (cancelled) return;
        setHubState({ kind: "ok", tokens });
      })
      .catch((err) => {
        if (cancelled) return;
        setHubState(dispositionForHubError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [name, reloadTick]);

  // Legacy pvt_* list (vault-admin bearer). Non-fatal — any failure (or an
  // empty list) collapses to "hidden", so fresh installs and vaults whose
  // legacy endpoint 401s simply don't render the section.
  useEffect(() => {
    let cancelled = false;
    if (!name) return;
    setLegacyState({ kind: "loading" });
    listLegacyTokens(name)
      .then((tokens) => {
        if (cancelled) return;
        setLegacyState(tokens.length > 0 ? { kind: "ok", tokens } : { kind: "hidden" });
      })
      .catch(() => {
        if (cancelled) return;
        setLegacyState({ kind: "hidden" });
      });
    return () => {
      cancelled = true;
    };
  }, [name, reloadTick]);

  const onRecovered = useCallback(() => setReloadTick((n) => n + 1), []);

  // Belt-and-suspenders for the single-emit contract: while the just-minted
  // token is on screen, prompt the browser's "leave site?" confirm on tab
  // close / refresh / back. Dismissing the banner detaches the listener.
  useEffect(() => {
    if (!minted) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [minted]);

  if (!name) {
    return (
      <div>
        <h2>Tokens</h2>
        <p className="muted">Missing vault name.</p>
        {isPerVaultMount ? null : <Link to="/">← Back to vaults</Link>}
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
        <Link to={detailHref} className="muted">
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
       * MintForm is hidden while the just-minted banner is showing — the
       * banner is the single point at which the operator copies the
       * plaintext token; a second mint before the first is saved would lose
       * the first forever (the server can't re-emit). The dismissal-then-mint
       * sequence makes that loss impossible by construction.
       */}
      {hubState.kind === "ok" && isAdmin && !minted ? (
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
        {hubState.kind === "loading" ? <p className="muted">Loading…</p> : null}
        {hubState.kind === "auth-required" ? (
          <SignInBanner vaultName={name} status={hubState.status} onRecovered={onRecovered} />
        ) : null}
        {hubState.kind === "error" ? (
          <div className="error-banner">
            <code>{hubState.message}</code>
          </div>
        ) : null}
        {hubState.kind === "ok" ? (
          <HubTokenList
            tokens={hubState.tokens}
            allowRevoke={isAdmin}
            confirmingJti={confirmingRevokeJti}
            onAskConfirm={setConfirmingRevokeJti}
            onRevoked={() => {
              setConfirmingRevokeJti(null);
              setReloadTick((n) => n + 1);
            }}
          />
        ) : null}
      </div>

      {legacyState.kind === "ok" ? (
        <LegacySection
          vaultName={name}
          tokens={legacyState.tokens}
          allowRevoke={isAdmin}
          confirmingId={confirmingLegacyId}
          onAskConfirm={setConfirmingLegacyId}
          onRevoked={() => {
            setConfirmingLegacyId(null);
            setReloadTick((n) => n + 1);
          }}
        />
      ) : null}
    </div>
  );
}

function MintBanner({ result, onDismiss }: { result: MintHubTokenResult; onDismiss: () => void }) {
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
  onMinted: (result: MintHubTokenResult) => void;
}) {
  const [label, setLabel] = useState("");
  const [verb, setVerb] = useState<ScopeVerb>("admin");
  const [ttlDays, setTtlDays] = useState<number>(DEFAULT_TTL_DAYS);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [tagsLoadError, setTagsLoadError] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    listVaultTags(vaultName)
      .then((rows) => {
        if (cancelled) return;
        // Picker only offers root tags — sub-tags inherit at enforcement time
        // via the `_tags/<name>` hierarchy. The server rejects any value with
        // a `/`, so filtering here keeps the UI honest.
        const roots = rows.map((t) => t.name).filter((n) => !n.includes("/")).sort();
        setAvailableTags(roots);
      })
      .catch((err) => {
        if (cancelled) return;
        setTagsLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [vaultName]);

  const trimmedLabel = label.trim();
  const labelMissing = trimmedLabel.length === 0;

  const toggleTag = (name: string) => {
    setSelectedTags((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (labelMissing) {
      setError("label required — give the token a recognizable name");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await mintHubToken(vaultName, {
        verb,
        label: trimmedLabel,
        scopedTags: [...selectedTags],
        ttlDays,
      });
      onMinted(result);
      setLabel("");
      setVerb("admin");
      setTtlDays(DEFAULT_TTL_DAYS);
      setSelectedTags(new Set());
    } catch (err) {
      if (err instanceof HostAdminError && err.disposition === "forbidden") {
        redirectToAccountHome();
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="section">
      <h3 style={{ margin: "0 0 0.85rem", fontSize: "1rem", fontWeight: 500 }}>Mint a token</h3>
      <p className="dim" style={{ margin: "0 0 0.85rem" }}>
        Issues a hub-signed token (JWT) scoped to this vault. Store it like a password — it's shown
        once and can't be re-displayed.
      </p>
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
        <select id="mint-scope" value={verb} onChange={(e) => setVerb(e.target.value as ScopeVerb)}>
          {KNOWN_SCOPE_VERBS.map((v) => (
            <option key={v} value={v}>
              {v === "read"
                ? "read — query notes only"
                : v === "write"
                  ? "write — query + create/update notes"
                  : "admin — full control (incl. token mgmt)"}
            </option>
          ))}
        </select>
        <p className="dim" style={{ margin: "0.35rem 0 0" }}>
          Issued as <code>vault:{vaultName}:{verb}</code>. Lower scopes inherit narrower powers.
        </p>
      </div>
      <div className="form-row">
        <label htmlFor="mint-ttl">Expires after</label>
        <select
          id="mint-ttl"
          value={ttlDays}
          onChange={(e) => setTtlDays(Number(e.target.value))}
        >
          {TTL_DAY_OPTIONS.map((days) => (
            <option key={days} value={days}>
              {TTL_LABELS[days] ?? `${days} days`}
            </option>
          ))}
        </select>
        <p className="dim" style={{ margin: "0.35rem 0 0" }}>
          The token stops working after this. Rotate before it lapses.
        </p>
      </div>
      <div className="form-row">
        <label>
          Tag scope <span className="dim">(optional)</span>
        </label>
        {tagsLoadError ? (
          <p className="dim" style={{ margin: "0.35rem 0 0" }}>
            Couldn't load tags: <code>{tagsLoadError}</code>. Token will be unscoped.
          </p>
        ) : availableTags.length === 0 ? (
          <p className="dim" style={{ margin: "0.35rem 0 0" }}>
            No root tags in this vault yet — token will see the full vault.
          </p>
        ) : (
          <>
            <div className="tag-picker">
              {availableTags.map((t) => (
                <label key={t} className="tag-checkbox">
                  <input
                    type="checkbox"
                    checked={selectedTags.has(t)}
                    onChange={() => toggleTag(t)}
                  />
                  <code>{t}</code>
                </label>
              ))}
            </div>
            <p className="dim" style={{ margin: "0.35rem 0 0" }}>
              {selectedTags.size === 0
                ? "Nothing selected — token sees the full vault (unscoped)."
                : `Token limited to: ${[...selectedTags].join(", ")}. Sub-tags (e.g. health/food) are reachable when their root is selected.`}
            </p>
          </>
        )}
      </div>
      <div className="actions">
        <button type="submit" disabled={submitting || labelMissing}>
          {submitting ? "Minting…" : "Mint token"}
        </button>
      </div>
    </form>
  );
}

function HubTokenList({
  tokens,
  allowRevoke,
  confirmingJti,
  onAskConfirm,
  onRevoked,
}: {
  tokens: HubTokenSummary[];
  allowRevoke: boolean;
  confirmingJti: string | null;
  onAskConfirm: (jti: string | null) => void;
  onRevoked: () => void;
}) {
  if (tokens.length === 0) {
    return <p className="muted">No tokens yet. Mint one above to get started.</p>;
  }
  return (
    <div className="token-list">
      {tokens.map((tok) => (
        <HubTokenRow
          key={tok.jti}
          token={tok}
          allowRevoke={allowRevoke}
          confirming={confirmingJti === tok.jti}
          onAskConfirm={onAskConfirm}
          onRevoked={onRevoked}
        />
      ))}
    </div>
  );
}

function HubTokenRow({
  token,
  allowRevoke,
  confirming,
  onAskConfirm,
  onRevoked,
}: {
  token: HubTokenSummary;
  allowRevoke: boolean;
  confirming: boolean;
  onAskConfirm: (jti: string | null) => void;
  onRevoked: () => void;
}) {
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isRevoked = token.revoked_at !== null;

  const onConfirm = async () => {
    setRevoking(true);
    setError(null);
    try {
      await revokeHubToken(token.jti);
      onRevoked();
    } catch (err) {
      if (err instanceof HostAdminError && err.disposition === "forbidden") {
        redirectToAccountHome();
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      setRevoking(false);
    }
  };

  return (
    <div className="token-row">
      <div className="body">
        <div className="name">
          <strong>{token.label ?? "(unlabeled)"}</strong>
          <code className="dim">{token.jti}</code>
          {isRevoked ? (
            <code className="scope-tag" title="This token has been revoked and no longer works.">
              revoked
            </code>
          ) : null}
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
            <span className="dim">(none)</span>
          )}
        </div>
        {token.scoped_tags && token.scoped_tags.length > 0 ? (
          <div className="meta">
            <span className="dim">tags:</span>{" "}
            {token.scoped_tags.map((t) => (
              <code key={t} className="scope-tag tag-pill">
                #{t}
              </code>
            ))}
          </div>
        ) : null}
        <div className="meta dim">
          created {fmtDate(token.created_at)}
          {token.expires_at ? ` · expires ${fmtDate(token.expires_at)}` : ""}
          {isRevoked && token.revoked_at ? ` · revoked ${fmtDate(token.revoked_at)}` : ""}
        </div>
        {error ? (
          <div className="error-banner" style={{ marginTop: "0.5rem" }}>
            <code>{error}</code>
          </div>
        ) : null}
      </div>
      {allowRevoke && !isRevoked ? (
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
          <button type="button" className="secondary" onClick={() => onAskConfirm(token.jti)}>
            Revoke
          </button>
        )
      ) : null}
    </div>
  );
}

/**
 * Read-only + revoke-only section for the vault's legacy `pvt_*` tokens.
 * Rendered only when the legacy list is non-empty (the parent collapses an
 * empty / failed legacy load to "hidden"). Collapsible — defaults closed so
 * a vault mid-migration shows it but doesn't lead with it.
 */
function LegacySection({
  vaultName,
  tokens,
  allowRevoke,
  confirmingId,
  onAskConfirm,
  onRevoked,
}: {
  vaultName: string;
  tokens: LegacyTokenSummary[];
  allowRevoke: boolean;
  confirmingId: string | null;
  onAskConfirm: (id: string | null) => void;
  onRevoked: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="section">
      <h3
        style={{
          margin: "0 0 0.5rem",
          fontSize: "1rem",
          fontWeight: 500,
          cursor: "pointer",
          userSelect: "none",
        }}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? "▾" : "▸"} Legacy tokens (pre-0.6.0){" "}
        <span className="dim" style={{ fontWeight: 400 }}>
          ({tokens.length})
        </span>
      </h3>
      <p className="dim" style={{ margin: "0 0 0.85rem" }}>
        These <code>pvt_*</code> tokens predate the move to hub-signed tokens. They still work, but
        the vault can no longer mint new ones — rotate each to a hub token above, then revoke the
        legacy one here.
      </p>
      {open ? (
        <div className="token-list">
          {tokens.map((tok) => (
            <LegacyTokenRow
              key={tok.id}
              vaultName={vaultName}
              token={tok}
              allowRevoke={allowRevoke}
              confirming={confirmingId === tok.id}
              onAskConfirm={onAskConfirm}
              onRevoked={onRevoked}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function LegacyTokenRow({
  vaultName,
  token,
  allowRevoke,
  confirming,
  onAskConfirm,
  onRevoked,
}: {
  vaultName: string;
  token: LegacyTokenSummary;
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
      await revokeLegacyToken(vaultName, token.id);
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
        {token.scoped_tags && token.scoped_tags.length > 0 ? (
          <div className="meta">
            <span className="dim">tags:</span>{" "}
            {token.scoped_tags.map((t) => (
              <code key={t} className="scope-tag tag-pill">
                #{t}
              </code>
            ))}
          </div>
        ) : null}
        <div className="meta dim">
          created {fmtDate(token.created_at)}
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
  // operator wants for incident triage.
  return iso;
}
