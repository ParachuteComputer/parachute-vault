/**
 * `/vault/:name/transcription` — the transcription setup page.
 *
 * Sibling of the embeddings toggle, but answering a harder question. Embeddings
 * is a boolean an operator flips. Transcription can be *configured* and still
 * not work, because it needs a CLI binary and a model file on disk that no
 * setting can promise are there — so the honest surface isn't a switch, it's a
 * readiness report.
 *
 * The failure this page exists to end: a box accepting audio for weeks and
 * transcribing nothing, with the only evidence a boot log line the operator had
 * scrolled past (vault#643). Everything here is in service of "is it working,
 * and if not, what exactly do I run".
 *
 * Three deliberate choices:
 *
 *   - **The reason is shown verbatim, not summarised.** The server already
 *     names which piece is missing and its size; re-wording that in the client
 *     would be a second place for it to drift.
 *   - **The searched directories are visible on failure.** On macOS the likeliest
 *     cause is a binary that IS installed but invisible to a launchd-supervised
 *     vault (no login-shell PATH), and "not found" alone actively misleads there.
 *   - **The model picker saves a preference and says so.** It never claims to
 *     install — downloads and package managers stay in the CLI, so the page hands
 *     over the command instead of pretending a browser tab can do it.
 */
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  HttpError,
  type TranscriptionSettings,
  getTranscriptionSettings,
  putTranscriptionSettings,
} from "../lib/api.ts";
import { SignInBanner } from "../lib/SignInBanner.tsx";

type State =
  | { kind: "loading" }
  | { kind: "ok"; settings: TranscriptionSettings }
  | { kind: "auth-required"; status: number | null; message?: string }
  | { kind: "error"; message: string };

/** A copyable command block — the page's main call to action. */
function CommandBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.5rem" }}>
      <code
        style={{
          flex: 1,
          padding: "0.5rem 0.65rem",
          background: "var(--bg-subtle, rgba(0,0,0,0.05))",
          borderRadius: 4,
          fontSize: "0.9em",
          overflowX: "auto",
        }}
      >
        {command}
      </code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(command).then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            },
            () => {
              /* clipboard blocked — the command is selectable anyway */
            },
          );
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function VaultTranscription({ vaultName }: { vaultName?: string } = {}) {
  const params = useParams<{ name: string }>();
  const name = vaultName ?? params.name;
  const isPerVaultMount = vaultName !== undefined;
  const detailHref = isPerVaultMount ? "/" : `/vault/${encodeURIComponent(name ?? "")}`;

  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const onRecovered = useCallback(() => setReloadTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    if (!name) return;
    setState({ kind: "loading" });
    getTranscriptionSettings(name)
      .then((settings) => {
        if (!cancelled) setState({ kind: "ok", settings });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
          setState({ kind: "auth-required", status: err.status, message: err.message });
          return;
        }
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [name, reloadTick]);

  const save = async (body: { provider?: string; model_id?: string }) => {
    if (!name) return;
    setSaving(true);
    setSaveError(null);
    try {
      const settings = await putTranscriptionSettings(name, body);
      setState({ kind: "ok", settings });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (state.kind === "loading") {
    return (
      <div>
        <h2>Transcription</h2>
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (state.kind === "auth-required") {
    return (
      <div>
        <h2>Transcription</h2>
        <SignInBanner
          vaultName={name ?? ""}
          status={state.status}
          serverMessage={state.message}
          onRecovered={onRecovered}
        />
        <Link to={detailHref}>← Back</Link>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div>
        <h2>Transcription</h2>
        <div className="error-banner" role="alert">
          {state.message}
        </div>
        <Link to={detailHref}>← Back</Link>
      </div>
    );
  }

  const s = state.settings;

  return (
    <div>
      <h2>Transcription</h2>
      <p className="muted">
        Turns voice recordings into text, locally — the audio never leaves this machine.
      </p>

      {/* ---- Status: the one thing an operator came here to learn ---------- */}
      {s.ready && s.active ? (
        <div className="ok-banner" role="status">
          <strong>Working.</strong> Audio you record is being transcribed
          {s.model ? ` with ${s.model.label}` : ""}.
        </div>
      ) : s.ready && s.restart_required ? (
        <div className="warn-banner" role="status">
          <p style={{ margin: "0 0 0.5rem" }}>
            <strong>Ready, but not running yet.</strong> Everything needed is installed;
            the vault picked up its transcription setup at boot, so it needs a restart to
            use this.
          </p>
          <CommandBlock command="parachute restart vault" />
        </div>
      ) : (
        <div className="warn-banner" role="alert">
          <p style={{ margin: "0 0 0.5rem" }}>
            <strong>Not transcribing.</strong> Audio will still upload and be stored — it
            just won't be turned into text until this is set up.
          </p>
          {/* Verbatim from the server: it already names the missing piece and
              its size, and re-wording it here would be a second place to drift. */}
          {s.reason ? (
            <p className="dim" style={{ margin: "0 0 0.5rem", fontSize: "0.9em" }}>
              {s.reason}
            </p>
          ) : null}
          {s.fix_command ? <CommandBlock command={s.fix_command} /> : null}
        </div>
      )}

      {/* ---- What's installed, concretely -------------------------------- */}
      <div className="section">
        <h3 style={{ margin: "0 0 0.75rem", fontSize: "1rem", fontWeight: 500 }}>
          What's on this machine
        </h3>
        <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.4rem 1rem" }}>
          <dt className="dim">Provider</dt>
          <dd style={{ margin: 0 }}>
            <code>{s.provider}</code>
          </dd>

          <dt className="dim">{s.binary.name}</dt>
          <dd style={{ margin: 0 }}>
            {s.binary.path ? (
              <code>{s.binary.path}</code>
            ) : (
              <>
                <span className="dim">not found</span>
                {/* Load-bearing on macOS: a launchd-supervised vault has no
                    login-shell PATH, so the binary can be installed and still
                    invisible. Showing where we looked is what makes that
                    diagnosable instead of baffling. */}
                <details style={{ marginTop: "0.35rem" }}>
                  <summary className="dim" style={{ fontSize: "0.85em" }}>
                    Where we looked
                  </summary>
                  <ul style={{ margin: "0.35rem 0 0", fontSize: "0.85em" }}>
                    {s.binary.searched.map((d) => (
                      <li key={d}>
                        <code>{d}</code>
                      </li>
                    ))}
                  </ul>
                  <p className="dim" style={{ margin: "0.35rem 0 0", fontSize: "0.85em" }}>
                    Installed somewhere else? Set <code>WHISPER_CPP_BIN_DIR</code> to that
                    directory.
                  </p>
                </details>
              </>
            )}
          </dd>

          <dt className="dim">ffmpeg</dt>
          <dd style={{ margin: 0 }}>
            {s.ffmpeg.path ? (
              <code>{s.ffmpeg.path}</code>
            ) : (
              <span className="dim">
                not found — required, since recordings arrive as webm and have to be
                transcoded
              </span>
            )}
          </dd>

          <dt className="dim">Model</dt>
          <dd style={{ margin: 0 }}>
            {s.model ? (
              <>
                {s.model.label}{" "}
                <span className="dim">
                  ({s.model.size_mb} MB
                  {s.model.installed ? ", downloaded" : ", not downloaded"})
                </span>
              </>
            ) : (
              <span className="dim">
                <code>{s.model_id}</code> isn't a known model
              </span>
            )}
          </dd>
        </dl>
      </div>

      {/* ---- Model picker ------------------------------------------------ */}
      <div className="section">
        <h3 style={{ margin: "0 0 0.35rem", fontSize: "1rem", fontWeight: 500 }}>Model</h3>
        <p className="dim" style={{ margin: "0 0 0.75rem", fontSize: "0.9em" }}>
          Bigger is more accurate and slower. Picking one here saves the choice — run{" "}
          <code>parachute-vault transcription install</code> to download it.
        </p>
        {saveError ? (
          <div className="error-banner" role="alert" style={{ marginBottom: "0.5rem" }}>
            {saveError}
          </div>
        ) : null}
        <div style={{ display: "grid", gap: "0.4rem" }}>
          {s.available_models.map((m) => (
            <label
              key={m.id}
              className="radio-row"
              style={{ display: "flex", gap: "0.6rem", alignItems: "flex-start" }}
            >
              <input
                type="radio"
                name="transcription-model"
                value={m.id}
                checked={m.id === s.model_id}
                disabled={saving}
                onChange={() => void save({ model_id: m.id, provider: "whisper-cpp" })}
                style={{ width: "auto", marginTop: "0.25rem" }}
              />
              <span>
                <strong>{m.label}</strong>{" "}
                <span className="dim">
                  · {m.size_mb} MB
                  {m.installed ? " · downloaded" : ""}
                </span>
                <br />
                <span className="dim" style={{ fontSize: "0.85em" }}>
                  {m.note}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <p style={{ marginTop: "1.25rem" }}>
        <Link to={detailHref}>← Back</Link>
      </p>
    </div>
  );
}
