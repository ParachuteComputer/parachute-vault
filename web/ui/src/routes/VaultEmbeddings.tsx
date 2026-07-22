/**
 * `/vault/:name/embeddings` — the semantic-search (embeddings) opt-in toggle.
 *
 * The 0.7.3 fast-follow: 0.7.3 made semantic search opt-in (default off) with
 * a persisted `embeddings_enabled` config.yaml setting, but the only way to
 * flip it was hand-editing config or setting an env var. This page gives the
 * operator a real toggle over that setting, read/written via
 * `GET|PUT /vault/<name>/.parachute/embeddings`.
 *
 * Two honesty properties the copy + banners preserve:
 *   - **Restart-to-apply.** The embedding provider is captured at boot, so
 *     flipping the setting doesn't hot-activate the running process. When the
 *     persisted state differs from what's live, we show a "restart to apply"
 *     banner (`restart_required`).
 *   - **Env override wins.** `EMBEDDINGS_ENABLED` is the low-level override;
 *     when it's forcing a value the toggle still saves, but we flag that the
 *     env var is in force so the switch never lies about what's actually on.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { HttpError, type EmbeddingsSettings, getEmbeddingsSettings, putEmbeddingsSettings } from "../lib/api.ts";
import { SignInBanner } from "../lib/SignInBanner.tsx";

type State =
  | { kind: "loading" }
  | { kind: "ok"; settings: EmbeddingsSettings }
  | { kind: "auth-required"; status: number | null }
  | { kind: "error"; message: string };

export function VaultEmbeddings({ vaultName }: { vaultName?: string } = {}) {
  const params = useParams<{ name: string }>();
  const name = vaultName ?? params.name;
  const isPerVaultMount = vaultName !== undefined;
  const detailHref = isPerVaultMount ? "/" : `/vault/${encodeURIComponent(name ?? "")}`;

  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!name) return;
    setState({ kind: "loading" });
    getEmbeddingsSettings(name)
      .then((settings) => {
        if (cancelled) return;
        setState({ kind: "ok", settings });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
          setState({ kind: "auth-required", status: err.status });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [name, reloadTick]);

  const onRecovered = useCallback(() => setReloadTick((n) => n + 1), []);

  if (!name) {
    return (
      <div>
        <h2>Semantic search</h2>
        <p className="muted">Missing vault name.</p>
        {isPerVaultMount ? null : <Link to="/">← Back to vaults</Link>}
      </div>
    );
  }

  return (
    <div>
      <div className="list-header">
        <h2>
          Semantic search for <code>{name}</code>
        </h2>
        <Link to={detailHref} className="muted">
          ← Vault detail
        </Link>
      </div>

      {state.kind === "loading" ? <p className="muted">Loading…</p> : null}

      {state.kind === "auth-required" ? (
        <SignInBanner vaultName={name} status={state.status} onRecovered={onRecovered} />
      ) : null}

      {state.kind === "error" ? (
        <div className="error-banner">
          <code>{state.message}</code>
        </div>
      ) : null}

      {state.kind === "ok" ? (
        <EmbeddingsScreen
          vaultName={name}
          settings={state.settings}
          onSettings={(s) => setState({ kind: "ok", settings: s })}
        />
      ) : null}
    </div>
  );
}

function EmbeddingsScreen({
  vaultName,
  settings,
  onSettings,
}: {
  vaultName: string;
  settings: EmbeddingsSettings;
  onSettings: (s: EmbeddingsSettings) => void;
}) {
  // The checkbox reflects the operator's *intended* persisted value; it seeds
  // from the loaded persisted `enabled` and diverges until saved.
  const [desired, setDesired] = useState(settings.enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const dirty = desired !== settings.enabled;

  const onSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    setJustSaved(false);
    try {
      const next = await putEmbeddingsSettings(vaultName, desired);
      onSettings(next);
      setJustSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [vaultName, desired, onSettings]);

  return (
    <div>
      {/* Env override wins over the persisted setting — say so plainly so the
          toggle never lies about what's actually in force. */}
      {settings.env_forced ? (
        <div className="warn-banner" role="status">
          The <code>EMBEDDINGS_ENABLED</code> environment variable is forcing semantic search{" "}
          <strong>{settings.env_override ? "on" : "off"}</strong>. This setting is still saved, but the environment
          override wins until it's removed from <code>~/.parachute/vault/.env</code>.
        </div>
      ) : null}

      {/* Persisted ≠ running: a restart is needed to apply. Shown both on load
          (a prior flip never restarted) and right after a save. */}
      {settings.restart_required ? (
        <div className="info-banner" role="status">
          {justSaved ? "Saved. " : ""}
          Semantic search is currently <strong>{settings.active ? "active" : "off"}</strong> in the running vault, but
          the saved setting wants it <strong>{settings.effective ? "on" : "off"}</strong>.{" "}
          <strong>Restart the vault to apply.</strong> The provider is loaded once at boot, so the change takes effect
          on the next restart.
        </div>
      ) : justSaved ? (
        <div className="info-banner" role="status">
          Saved. Semantic search is <strong>{settings.active ? "active" : "off"}</strong>.
        </div>
      ) : null}

      <div className="section">
        <label className="tag-checkbox">
          <input
            type="checkbox"
            checked={desired}
            disabled={saving}
            onChange={(e) => {
              setDesired(e.target.checked);
              setJustSaved(false);
            }}
          />
          <span>Enable semantic search (embeddings)</span>
        </label>

        <p className="dim" style={{ margin: "0.6rem 0 0" }}>
          Semantic search ranks notes by meaning (<code>query-notes</code> with <code>near_text</code>), not just
          keywords. Enabling triggers a one-time model download (~{settings.model_download_mb}MB) on the first
          embed, then embeds every note on write and backfills existing notes in the background. This is a{" "}
          <strong>host-wide</strong> setting — it affects every vault on this server.
        </p>
      </div>

      {error ? (
        <div className="error-banner" style={{ marginTop: "1rem" }}>
          <code>{error}</code>
        </div>
      ) : null}

      <div className="actions">
        <button type="button" onClick={onSave} disabled={!dirty || saving}>
          {saving ? "Saving…" : desired ? "Enable semantic search" : "Disable semantic search"}
        </button>
      </div>
    </div>
  );
}
