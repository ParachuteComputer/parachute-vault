/**
 * `/vault/:name/mirror` — admin SPA UI for the git-mirror lifecycle.
 *
 * Backend (already shipped pre-Phase A2 — see `src/mirror-config.ts`,
 * `src/mirror-manager.ts`, `src/mirror-routes.ts` + the design doc at
 * `parachute.computer/design/2026-05-20-vault-as-git-projection.md`)
 * already handles persistence, lifecycle, and HTTP. This route fills
 * the operator-facing gap so the "really good UI" for backing the
 * vault up to a git repository — one of the launch-era asks — has a
 * home that doesn't require curl + YAML editing.
 *
 * Layout: status card → manual-trigger button → preset cards → detailed
 * config form. The presets pre-fill the form (matching the three the
 * design doc names — "History" / "Live Mirror" / "Manual Export") so
 * an operator who knows what shape they want gets there in one click.
 * The detailed fields below the presets let custom shapes through
 * without bypassing the form's validation.
 *
 * Post-event-driven shift (vault#382): the granular schedule picker
 * (Live/Minute/10min/Hourly/Daily/Manual) has been replaced by a binary
 * sync-mode picker — "On change" (events) and "Manual only" (no
 * auto-fire). The export is event-driven now; time-based cadence is the
 * exclusive territory of the operator's own cron (or the admin SPA's
 * "Run export now" button).
 */
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  HttpError,
  type DeviceCodeResponse,
  type GitHubRepoInfo,
  type MirrorConfig,
  type MirrorCredentialStatus,
  type MirrorSnapshot,
  type MirrorStatus,
  createGithubRepo,
  deleteMirrorAuth,
  getMirror,
  getMirrorAuth,
  listGithubRepos,
  pollGithubDeviceFlow,
  postMirrorAuthPat,
  putMirror,
  runMirrorNow,
  selectGithubRepo,
  startGithubDeviceFlow,
} from "../lib/api.ts";
import { hasAdminScope } from "../lib/scope.ts";

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; snapshot: MirrorSnapshot }
  | { kind: "auth-required" }
  | { kind: "error"; message: string };

/**
 * Sync-mode picker options. "On change" subscribes to in-process hooks
 * (note / tag / attachment mutations) and debounces them into a single
 * export pass; the mirror stays fresh as the operator writes. "Manual
 * only" disables both events and the safety-net poll; only the "Run
 * export now" button (or `parachute-vault export` from the CLI) fires
 * an export.
 *
 * No schedule picker — the granular Live/Minute/Hourly options the
 * pre-event-driven UI offered have retired. Events are the live path;
 * cron is the cadence path; the operator chooses whichever fits.
 */
const SYNC_MODE_OPTIONS: ReadonlyArray<{
  value: "events" | "manual";
  label: string;
}> = [
  { value: "events", label: "On change (default)" },
  { value: "manual", label: "Manual only" },
];

/**
 * Preset definitions — the three shapes the design doc names. Each is a
 * partial overlay applied on top of the current config (so the operator's
 * commit_template + external_path persist through a preset click; only
 * the preset-relevant fields move). External-path warning still
 * surfaces when the chosen preset implies `location: external` and the
 * path isn't set.
 */
interface Preset {
  id: string;
  label: string;
  subtext: string;
  apply: (current: MirrorConfig) => MirrorConfig;
}

const PRESETS: ReadonlyArray<Preset> = [
  {
    id: "history",
    label: "History",
    subtext:
      "Local audit trail. Hidden under vault data. Events-driven.",
    apply: (current) => ({
      ...current,
      enabled: true,
      location: "internal",
      sync_mode: "events",
      auto_commit: true,
      auto_push: false,
    }),
  },
  {
    id: "live",
    label: "Live Mirror",
    subtext:
      "Visible folder. Open in Obsidian, push to GitHub. Events-driven.",
    apply: (current) => ({
      ...current,
      enabled: true,
      location: "external",
      sync_mode: "events",
      auto_commit: true,
      // Don't force-flip auto_push — operator may not have credentials yet.
    }),
  },
  {
    id: "manual",
    label: "Manual Export",
    subtext: "Snapshot on demand. No auto-fire.",
    apply: (current) => ({
      ...current,
      enabled: true,
      location: "external",
      sync_mode: "manual",
      auto_commit: true,
      auto_push: false,
    }),
  },
];

export function VaultMirror({ vaultName }: { vaultName?: string } = {}) {
  // Mirror VaultTokens/VaultDetail's mount handling: per-vault mount
  // passes `vaultName` straight through (no `:name` segment); stand-
  // alone reads from useParams. The presence of the prop also picks
  // the back-link shape.
  const params = useParams<{ name: string }>();
  const name = vaultName ?? params.name;
  const isPerVaultMount = vaultName !== undefined;
  const detailHref = isPerVaultMount ? "/" : `/vault/${encodeURIComponent(name ?? "")}`;

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!name) return;
    setState({ kind: "loading" });
    getMirror(name)
      .then((snapshot) => {
        if (cancelled) return;
        setState({ kind: "ok", snapshot });
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
        <h2>Mirror</h2>
        <p className="muted">Missing vault name.</p>
        {isPerVaultMount ? null : <Link to="/">← Back to vaults</Link>}
      </div>
    );
  }

  return (
    <div>
      <div className="list-header">
        <h2>
          Git backup for <code>{name}</code>
        </h2>
        <Link to={detailHref} className="muted">
          ← Vault detail
        </Link>
      </div>

      {state.kind === "loading" ? <p className="muted">Loading…</p> : null}

      {state.kind === "auth-required" ? (
        <div className="warn-banner">
          Open this page from the hub's directory — the "Manage" link supplies the admin
          token. Direct loads of <code>/vault/{name}/admin/mirror</code> can't see protected
          vault data.
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div className="error-banner">
          <code>{state.message}</code>
        </div>
      ) : null}

      {state.kind === "ok" ? (
        <MirrorScreen
          vaultName={name}
          snapshot={state.snapshot}
          onRefresh={() => setReloadTick((n) => n + 1)}
          onSnapshot={(snap) => setState({ kind: "ok", snapshot: snap })}
        />
      ) : null}
    </div>
  );
}

function MirrorScreen({
  vaultName,
  snapshot,
  onRefresh,
  onSnapshot,
}: {
  vaultName: string;
  snapshot: MirrorSnapshot;
  onRefresh: () => void;
  onSnapshot: (snap: MirrorSnapshot) => void;
}) {
  const isAdmin = hasAdminScope(vaultName);
  // Credential status — fetched separately because it lives at a different
  // endpoint + has its own update cadence (OAuth modal + PAT modal save
  // both invalidate it).
  const [creds, setCreds] = useState<MirrorCredentialStatus | null>(null);
  const [credsError, setCredsError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    getMirrorAuth(vaultName)
      .then((c) => {
        if (!cancelled) setCreds(c);
      })
      .catch((err) => {
        if (cancelled) return;
        // 401/403 already covered by parent route's auth gate; other
        // errors surface as a soft note in the GitRemote section.
        setCredsError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [vaultName, isAdmin]);

  return (
    <>
      <StatusCard
        status={snapshot.status}
        enabled={snapshot.config.enabled}
        canRun={isAdmin && snapshot.status.enabled}
        vaultName={vaultName}
        onSnapshot={onSnapshot}
      />
      {!isAdmin ? (
        <div className="warn-banner">
          You're viewing this page with a read-only token. Saving config + manual run
          require <code>vault:{vaultName}:admin</code>. Re-enter from the hub directory's
          "Manage" link with an admin-scoped session to make changes.
        </div>
      ) : null}
      <ConfigForm
        vaultName={vaultName}
        initial={snapshot.config}
        readOnly={!isAdmin}
        creds={creds}
        onSaved={(snap) => {
          onSnapshot(snap);
          onRefresh();
        }}
      />
      {isAdmin ? (
        <GitRemoteSection
          vaultName={vaultName}
          creds={creds}
          credsError={credsError}
          onCredsChanged={setCreds}
          locationIsExternal={snapshot.config.location === "external"}
        />
      ) : null}
    </>
  );
}

function StatusCard({
  status,
  enabled,
  canRun,
  vaultName,
  onSnapshot,
}: {
  status: MirrorStatus;
  enabled: boolean;
  canRun: boolean;
  vaultName: string;
  onSnapshot: (snap: MirrorSnapshot) => void;
}) {
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const onRun = async () => {
    setRunning(true);
    setRunError(null);
    try {
      const snap = await runMirrorNow(vaultName);
      onSnapshot(snap);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="section">
      <h3 style={{ margin: "0 0 0.85rem", fontSize: "1rem", fontWeight: 500 }}>Status</h3>
      <div className="kv">
        <div>Enabled</div>
        <div>{enabled ? <code>yes</code> : <code>no</code>}</div>
        <div>Watch loop</div>
        <div>{status.watch_running ? <code>running</code> : <code>stopped</code>}</div>
        <div>Path</div>
        <div>
          {status.mirror_path ? <code>{status.mirror_path}</code> : <span className="dim">—</span>}
        </div>
        <div>Last export</div>
        <div>
          {status.last_export_at ? (
            <>
              <code>{status.last_export_at}</code>
              {status.last_export_notes_count !== null ? (
                <span className="dim">
                  {" "}· {status.last_export_notes_count} note
                  {status.last_export_notes_count === 1 ? "" : "s"}
                </span>
              ) : null}
            </>
          ) : (
            <span className="dim">never</span>
          )}
        </div>
        <div>Last commit</div>
        <div>
          {status.last_commit_sha ? (
            <code>{status.last_commit_sha.slice(0, 10)}</code>
          ) : (
            <span className="dim">—</span>
          )}
        </div>
      </div>
      {status.last_error ? (
        <div className="error-banner" style={{ marginTop: "1rem" }}>
          <strong>Last error:</strong> <code>{status.last_error}</code>
        </div>
      ) : null}
      {runError ? (
        <div className="error-banner" style={{ marginTop: "1rem" }}>
          <code>{runError}</code>
        </div>
      ) : null}
      <div className="actions">
        <button
          type="button"
          onClick={onRun}
          disabled={!canRun || running}
          title={
            !enabled
              ? "Enable the mirror first, then trigger a manual export."
              : !canRun
                ? "Admin scope required to trigger a manual export."
                : undefined
          }
        >
          {running ? "Running…" : "Run export now"}
        </button>
      </div>
    </div>
  );
}

function ConfigForm({
  vaultName,
  initial,
  readOnly,
  creds,
  onSaved,
}: {
  vaultName: string;
  initial: MirrorConfig;
  readOnly: boolean;
  /** Credentials snapshot — drives the auto_push warning copy. Null while
   *  loading; treated identically to "no credentials configured." */
  creds: MirrorCredentialStatus | null;
  onSaved: (snap: MirrorSnapshot) => void;
}) {
  const [config, setConfig] = useState<MirrorConfig>(initial);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  // Field-level error gets rendered next to that field; the bare
  // `error` carries the general message + status badge.
  const [error, setError] = useState<string | null>(null);
  const [errorField, setErrorField] = useState<keyof MirrorConfig | null>(null);
  const [savedTick, setSavedTick] = useState(0);

  // Sync local form state when the parent re-fetches (e.g. after a
  // sibling save or manual-run finishes). Without this the form would
  // freeze on the first-rendered snapshot and ignore subsequent reloads.
  useEffect(() => {
    setConfig(initial);
  }, [initial]);

  const onApplyPreset = (preset: Preset) => {
    const next = preset.apply(config);
    setConfig(next);
  };

  const onChangeSyncMode = (value: "events" | "manual") => {
    setConfig((prev) => ({ ...prev, sync_mode: value }));
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (readOnly) return;
    setSaving(true);
    setError(null);
    setErrorField(null);
    try {
      const snap = await putMirror(vaultName, config);
      onSaved(snap);
      setSavedTick((n) => n + 1);
      setTimeout(() => setSavedTick(0), 3000);
    } catch (err) {
      if (err instanceof HttpError) {
        // The PUT endpoint surfaces { field, message } on 400s.
        // We can't see the `field` from HttpError alone (only the
        // top-level message), so we surface the message; the field
        // gets the visual indicator via parsing the message for
        // known field names. Keeping it loose: a missed match is
        // a UI nit, not a correctness bug.
        const msg = err.message;
        setError(msg);
        const lower = msg.toLowerCase();
        if (lower.includes("external_path")) setErrorField("external_path");
        else if (lower.includes("commit_template")) setErrorField("commit_template");
        else if (lower.includes("safety_net_seconds")) setErrorField("safety_net_seconds");
        else if (lower.includes("sync_mode")) setErrorField("sync_mode");
        else if (lower.includes("auto_push")) setErrorField("auto_push");
        else if (lower.includes("location")) setErrorField("location");
        else setErrorField(null);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="section" onSubmit={onSubmit}>
      <h3 style={{ margin: "0 0 0.85rem", fontSize: "1rem", fontWeight: 500 }}>
        Configuration
      </h3>

      <div className="form-row">
        <label>
          <input
            type="checkbox"
            checked={config.enabled}
            disabled={readOnly}
            onChange={(e) =>
              setConfig((prev) => ({ ...prev, enabled: e.target.checked }))
            }
            style={{ width: "auto", marginRight: "0.5rem" }}
          />
          Enable mirror
        </label>
        <p className="dim" style={{ margin: "0.35rem 0 0" }}>
          Master switch. When off, no export / commit / push runs.
        </p>
      </div>

      <div className="form-row">
        <label>Presets</label>
        <p className="dim" style={{ marginTop: 0, marginBottom: "0.5rem", fontSize: "0.9em" }}>
          <strong>History</strong> is the easiest start — vault manages the
          mirror folder under its own data dir, no path to pick, no remote
          to configure. <strong>Live Mirror</strong> + <strong>Manual
          Export</strong> are for operators who want to point at a visible
          folder (Obsidian, GitHub).
        </p>
        <div className="preset-grid">
          {PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="preset-card"
              disabled={readOnly}
              onClick={() => onApplyPreset(preset)}
              aria-label={`Apply ${preset.label} preset`}
            >
              <strong>{preset.label}</strong>
              <span className="dim">{preset.subtext}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="form-row">
        <label>Location</label>
        <div>
          <label className="radio-row">
            <input
              type="radio"
              name="location"
              value="internal"
              checked={config.location === "internal"}
              disabled={readOnly}
              onChange={() =>
                setConfig((prev) => ({ ...prev, location: "internal" }))
              }
            />
            <span>
              Internal <span className="dim">— hidden under vault data dir</span>
            </span>
          </label>
          <label className="radio-row">
            <input
              type="radio"
              name="location"
              value="external"
              checked={config.location === "external"}
              disabled={readOnly}
              onChange={() =>
                setConfig((prev) => ({ ...prev, location: "external" }))
              }
            />
            <span>
              External <span className="dim">— operator-picked path</span>
            </span>
          </label>
        </div>
      </div>

      {config.location === "external" ? (
        <div className="form-row">
          <label htmlFor="external-path">External path</label>
          <input
            id="external-path"
            type="text"
            value={config.external_path ?? ""}
            disabled={readOnly}
            onChange={(e) =>
              setConfig((prev) => ({
                ...prev,
                external_path: e.target.value.length > 0 ? e.target.value : null,
              }))
            }
            placeholder="/Users/you/Documents/vault-mirror"
            aria-invalid={errorField === "external_path"}
          />
          <div className="warn-banner" style={{ marginTop: "0.5rem" }} role="alert">
            Path must exist AND be a git repo (run <code>git init</code> first if
            needed).
          </div>
        </div>
      ) : null}

      <div className="form-row">
        <label htmlFor="sync-mode-select">Sync mode</label>
        <select
          id="sync-mode-select"
          value={config.sync_mode}
          disabled={readOnly}
          onChange={(e) => onChangeSyncMode(e.target.value as "events" | "manual")}
        >
          {SYNC_MODE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <p className="dim" style={{ margin: "0.35rem 0 0" }}>
          {config.sync_mode === "manual"
            ? "No auto-fire. Exports only run when you click \"Run export now\" (or run `parachute-vault export` from the CLI)."
            : "Every change to a note, tag, or attachment triggers an export within ~500ms. A background safety check runs hourly to catch anything missed."}
        </p>
      </div>

      <div className="form-row">
        <label>
          <input
            type="checkbox"
            checked={config.auto_commit}
            disabled={readOnly}
            onChange={(e) =>
              setConfig((prev) => ({ ...prev, auto_commit: e.target.checked }))
            }
            style={{ width: "auto", marginRight: "0.5rem" }}
          />
          Commit after each export
        </label>
        {!config.auto_commit ? (
          <p className="hint" style={{ marginTop: "0.25rem", fontSize: "0.85em" }}>
            Note: the export cursor still advances after each pass. Subsequent
            runs only re-export notes written since the last pass — even when
            triggered manually.
          </p>
        ) : null}
      </div>

      {config.location === "external" ? (
        <div className="form-row">
          <label>
            <input
              type="checkbox"
              checked={config.auto_push}
              disabled={readOnly}
              onChange={(e) =>
                setConfig((prev) => ({ ...prev, auto_push: e.target.checked }))
              }
              style={{ width: "auto", marginRight: "0.5rem" }}
            />
            Push after each commit
          </label>
          {config.auto_push ? (
            creds?.active_method ? (
              <div className="info-banner" style={{ marginTop: "0.5rem" }} role="status">
                {creds.active_method === "github_oauth" && creds.github_oauth ? (
                  <>
                    Will push to <code>@{creds.github_oauth.user_login}</code> on GitHub.
                  </>
                ) : creds.active_method === "pat" && creds.pat ? (
                  <>Will push using saved credential: <code>{creds.pat.label}</code>.</>
                ) : (
                  <>Will push using saved credential.</>
                )}{" "}
                Failed pushes are logged but won't crash the export.
              </div>
            ) : (
              <div className="warn-banner" style={{ marginTop: "0.5rem" }} role="alert">
                Auto-push needs git credentials. Either connect GitHub in the{" "}
                <strong>Git remote</strong> section below, or paste a Personal Access
                Token + remote URL. Failed pushes are logged but won't crash the export.
              </div>
            )
          ) : null}
        </div>
      ) : null}
      {/*
        Internal-location mirrors live under ~/.parachute/vault/data and have
        no configured git remote — a push would always fail. Hide the checkbox
        entirely rather than render a disabled one: the option is meaningless,
        not just unavailable. If a stored config carries auto_push:true +
        location:internal (e.g. operator switched from external→internal
        without unticking), the value persists on the config blob until they
        save a different one — the watch loop just skips pushes because there's
        no remote. Reviewer-flagged on #380.
      */}

      <div className="form-row">
        <button
          type="button"
          className="secondary"
          onClick={() => setShowAdvanced((s) => !s)}
        >
          {showAdvanced ? "Hide" : "Show"} advanced
        </button>
      </div>

      {showAdvanced ? (
        <div className="form-row">
          <label htmlFor="commit-template">Commit template</label>
          <input
            id="commit-template"
            type="text"
            value={config.commit_template}
            disabled={readOnly}
            onChange={(e) =>
              setConfig((prev) => ({ ...prev, commit_template: e.target.value }))
            }
            aria-invalid={errorField === "commit_template"}
          />
          <p className="dim" style={{ margin: "0.35rem 0 0" }}>
            Supports <code>{"{{date}}"}</code>, <code>{"{{notes_changed}}"}</code>,{" "}
            <code>{"{{plural}}"}</code>, <code>{"{{first_note_title}}"}</code>,{" "}
            <code>{"{{vault_name}}"}</code>.
          </p>
        </div>
      ) : null}

      {error ? (
        <div className="error-banner" role="alert">
          <code>{error}</code>
        </div>
      ) : null}

      {savedTick > 0 ? (
        <div
          className="mint-banner"
          style={{ padding: "0.75rem 1rem", marginBottom: "1rem" }}
          role="status"
        >
          Saved.
        </div>
      ) : null}

      <div className="actions">
        <button type="submit" disabled={readOnly || saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

// ===========================================================================
// Git remote credentials — UI for connecting GitHub OAuth or pasting a PAT.
// ===========================================================================

/**
 * Top-level credentials section. Shows current connection state +
 * affords Use PAT / Connect GitHub / Disconnect.
 *
 * PAT is the primary path because it works against any HTTPS+token git
 * host (GitHub, GitLab, Gitea, Bitbucket, self-hosted). The GitHub
 * Device Flow is presented as a one-click shortcut for GitHub users —
 * same end-state (a token wired into the mirror's remote URL), just
 * one fewer step. Aaron called this framing 2026-05-28: leading with
 * "Connect GitHub" implies Parachute is GitHub-only, which it isn't.
 *
 * The OAuth modal works like this: operator clicks "Connect GitHub",
 * vault calls GitHub's device-code endpoint, the modal displays the
 * user_code + verification_uri, operator types the code at
 * github.com/login/device, the modal polls until granted, then surfaces a
 * repo picker (or a "Create new private repo" form). Picking a repo
 * writes the embedded-credential URL onto the mirror's `origin`, closes
 * the flow.
 *
 * The PAT modal is the fallback: two fields (token + remote URL) + a
 * "Validate & save" button. The server runs `git ls-remote` against the
 * URL with the embedded token to confirm before saving.
 */
function GitRemoteSection({
  vaultName,
  creds,
  credsError,
  onCredsChanged,
  locationIsExternal,
}: {
  vaultName: string;
  creds: MirrorCredentialStatus | null;
  credsError: string | null;
  onCredsChanged: (creds: MirrorCredentialStatus) => void;
  locationIsExternal: boolean;
}) {
  const [oauthOpen, setOauthOpen] = useState(false);
  const [patOpen, setPatOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const connected = creds?.active_method !== null && creds?.active_method !== undefined;

  const onDisconnect = async () => {
    if (!confirm("Disconnect git remote credentials? Auto-push will stop working until you reconnect.")) {
      return;
    }
    setDisconnecting(true);
    setActionError(null);
    try {
      const c = await deleteMirrorAuth(vaultName);
      onCredsChanged(c);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="section">
      <h3 style={{ margin: "0 0 0.85rem", fontSize: "1rem", fontWeight: 500 }}>
        Git remote
      </h3>
      <p className="dim" style={{ marginTop: 0 }}>
        Credentials for <code>auto-push</code>. Stored on this server with{" "}
        <code>0600</code> file permissions. Never sent to GitHub or any third party.
      </p>

      {!locationIsExternal ? (
        <div className="info-banner" style={{ marginBottom: "0.75rem" }} role="status">
          Internal mirrors live under the vault's data directory and have no remote.
          Switch the location above to <strong>External</strong> to enable pushing.
        </div>
      ) : null}

      {credsError ? (
        <div className="error-banner" role="alert">
          Could not load credential status: <code>{credsError}</code>
        </div>
      ) : null}

      {connected ? (
        <div className="kv" style={{ marginBottom: "0.75rem" }}>
          <div>Status</div>
          <div>
            {creds?.active_method === "github_oauth" && creds.github_oauth ? (
              <>
                Connected to <code>@{creds.github_oauth.user_login}</code> on GitHub
              </>
            ) : creds?.active_method === "pat" && creds.pat ? (
              <>
                Custom credential: <code>{creds.pat.label}</code>
              </>
            ) : null}
          </div>
          {creds?.active_method === "github_oauth" && creds.github_oauth ? (
            <>
              <div>Token</div>
              <div>
                <code>{creds.github_oauth.token_preview}</code>{" "}
                <span className="dim">
                  · scope {creds.github_oauth.scope || "—"} · authorized{" "}
                  {creds.github_oauth.authorized_at.slice(0, 10)}
                </span>
              </div>
            </>
          ) : null}
          {creds?.active_method === "pat" && creds.pat ? (
            <>
              <div>Remote</div>
              <div>
                <code>{creds.pat.remote_url}</code>
              </div>
              <div>Token</div>
              <div>
                <code>{creds.pat.token_preview}</code>
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <p className="dim">
          Not connected. Auto-push won't work until you connect. Personal
          Access Token is the universal path (works with GitHub, GitLab,
          Gitea, Bitbucket, anything that takes an HTTPS token); the GitHub
          shortcut just saves a step for GitHub users.
        </p>
      )}

      {actionError ? (
        <div className="error-banner" role="alert">
          <code>{actionError}</code>
        </div>
      ) : null}

      <div className="actions">
        {!connected ? (
          <>
            {/*
              PAT is the primary action — works against any HTTPS+token git
              host (GitHub, GitLab, Gitea, Bitbucket, self-hosted). The
              GitHub Device Flow is a convenience shortcut: same result as
              generating a PAT manually, just one fewer step for GitHub
              users. Don't lead with the GitHub-specific path; it'd
              suggest Parachute is GitHub-only.
            */}
            <button type="button" onClick={() => setPatOpen(true)}>
              Use Personal Access Token
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setOauthOpen(true)}
            >
              Connect GitHub (one-click for GitHub users)
            </button>
          </>
        ) : (
          <button
            type="button"
            className="secondary"
            onClick={onDisconnect}
            disabled={disconnecting}
          >
            {disconnecting ? "Disconnecting…" : "Disconnect"}
          </button>
        )}
      </div>

      {oauthOpen ? (
        <GithubOAuthModal
          vaultName={vaultName}
          onClose={() => setOauthOpen(false)}
          onConnected={(c) => {
            onCredsChanged(c);
            setOauthOpen(false);
          }}
        />
      ) : null}

      {patOpen ? (
        <PATModal
          vaultName={vaultName}
          onClose={() => setPatOpen(false)}
          onSaved={(c) => {
            onCredsChanged(c);
            setPatOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// GitHub OAuth modal — device flow start + poll loop + repo picker.
// ---------------------------------------------------------------------------

type OAuthPhase =
  | { kind: "starting" }
  | { kind: "polling"; code: DeviceCodeResponse; pollIntervalMs: number; startedAt: number }
  | { kind: "granted"; user: { login: string } }
  | { kind: "error"; message: string };

function GithubOAuthModal({
  vaultName,
  onClose,
  onConnected,
}: {
  vaultName: string;
  onClose: () => void;
  onConnected: (creds: MirrorCredentialStatus) => void;
}) {
  const [phase, setPhase] = useState<OAuthPhase>({ kind: "starting" });
  const [now, setNow] = useState(Date.now());
  const pollAbortRef = useRef<boolean>(false);

  // Tick clock so the countdown ticks down visibly.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Start the device flow on mount.
  useEffect(() => {
    let cancelled = false;
    pollAbortRef.current = false;
    startGithubDeviceFlow(vaultName)
      .then((code) => {
        if (cancelled) return;
        setPhase({
          kind: "polling",
          code,
          pollIntervalMs: Math.max(code.interval, 1) * 1000,
          startedAt: Date.now(),
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setPhase({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
      pollAbortRef.current = true;
    };
  }, [vaultName]);

  // Poll loop — re-armed on every phase transition while phase=polling.
  useEffect(() => {
    if (phase.kind !== "polling") return;
    const code = phase.code;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let currentIntervalMs = phase.pollIntervalMs;
    const tick = async () => {
      if (cancelled || pollAbortRef.current) return;
      try {
        const result = await pollGithubDeviceFlow(vaultName, code.polling_id);
        if (cancelled) return;
        if (result.state === "granted") {
          setPhase({ kind: "granted", user: { login: result.user.login } });
          return;
        }
        if (result.state === "denied") {
          setPhase({ kind: "error", message: "Authorization denied." });
          return;
        }
        if (result.state === "expired") {
          setPhase({ kind: "error", message: "The device code expired. Try again." });
          return;
        }
        if (result.state === "slow_down") {
          currentIntervalMs = result.interval * 1000;
        }
        timer = setTimeout(tick, currentIntervalMs);
      } catch (err) {
        if (cancelled) return;
        setPhase({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    };
    timer = setTimeout(tick, currentIntervalMs);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase, vaultName]);

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // Clipboard API can fail in HTTP / no-permission contexts. Silent fail.
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="list-header">
          <h3 style={{ margin: 0 }}>Connect GitHub</h3>
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </div>

        {phase.kind === "starting" ? (
          <p className="muted">Requesting device code from GitHub…</p>
        ) : null}

        {phase.kind === "polling" ? (
          <>
            <p>
              <strong>Step 1.</strong> Open{" "}
              <a href={phase.code.verification_uri} target="_blank" rel="noreferrer">
                {phase.code.verification_uri}
              </a>{" "}
              in your browser.
            </p>
            <p>
              <strong>Step 2.</strong> Enter this code:
            </p>
            <div className="device-code-row">
              <code className="device-code">{phase.code.user_code}</code>
              <button
                type="button"
                className="secondary"
                onClick={() => copyCode(phase.code.user_code)}
              >
                Copy
              </button>
            </div>
            <p className="dim">
              Waiting for authorization…{" "}
              {formatCountdown(phase.code.expires_in, phase.startedAt, now)}
            </p>
          </>
        ) : null}

        {phase.kind === "granted" ? (
          <RepoPicker
            vaultName={vaultName}
            user={phase.user}
            onPicked={async (owner, name) => {
              await selectGithubRepo(vaultName, { owner, name });
              const c = await getMirrorAuth(vaultName);
              onConnected(c);
            }}
            onError={(message) => setPhase({ kind: "error", message })}
          />
        ) : null}

        {phase.kind === "error" ? (
          <>
            <div className="error-banner" role="alert">
              <code>{phase.message}</code>
            </div>
            <div className="actions">
              <button type="button" onClick={() => setPhase({ kind: "starting" })}>
                Try again
              </button>
              <button type="button" className="secondary" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function formatCountdown(expiresIn: number, startedAt: number, now: number): string {
  const elapsed = Math.floor((now - startedAt) / 1000);
  const remaining = Math.max(0, expiresIn - elapsed);
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  return `${mins}:${String(secs).padStart(2, "0")} remaining`;
}

// ---------------------------------------------------------------------------
// Repo picker — surfaces after a granted device-flow token.
// ---------------------------------------------------------------------------

function RepoPicker({
  vaultName,
  user,
  onPicked,
  onError,
}: {
  vaultName: string;
  user: { login: string };
  onPicked: (owner: string, name: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [repos, setRepos] = useState<GitHubRepoInfo[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [filter, setFilter] = useState("");
  const [picking, setPicking] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listGithubRepos(vaultName)
      .then(({ repos, truncated }) => {
        if (cancelled) return;
        setRepos(repos);
        setTruncated(Boolean(truncated));
      })
      .catch((err) => {
        if (!cancelled) onError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [vaultName, onError]);

  const filtered = (repos ?? []).filter((r) =>
    filter.length === 0
      ? true
      : r.full_name.toLowerCase().includes(filter.toLowerCase()),
  );

  const pickRepo = async (owner: string, name: string) => {
    setPicking(`${owner}/${name}`);
    try {
      await onPicked(owner, name);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setPicking(null);
    }
  };

  const createAndPick = async () => {
    if (newName.trim().length === 0) return;
    setCreating(true);
    try {
      const repo = await createGithubRepo(vaultName, {
        name: newName.trim(),
        description: "Parachute Vault mirror",
        private: true,
      });
      await onPicked(repo.owner, repo.name);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <p>
        Authorized as <code>@{user.login}</code>. Pick a repository to push the mirror to:
      </p>

      <div className="form-row">
        <input
          type="search"
          placeholder="Filter by name…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {truncated ? (
        <p className="muted" style={{ fontSize: "0.85em" }}>
          Showing the first 300 repos. Use the filter above to narrow down — or
          paste the clone URL directly via Personal Access Token below if your
          repo isn't here.
        </p>
      ) : null}

      {repos === null ? <p className="muted">Loading repos…</p> : null}

      {repos !== null ? (
        <div className="repo-list">
          {filtered.length === 0 && filter.length > 0 ? (
            <p className="dim">No repos match "{filter}".</p>
          ) : null}
          {filtered.length === 0 && filter.length === 0 && repos.length === 0 ? (
            <p className="dim">You don't own any repos on this account yet.</p>
          ) : null}
          {filtered.map((r) => (
            <button
              type="button"
              key={r.full_name}
              className="repo-row"
              onClick={() => pickRepo(r.owner, r.name)}
              disabled={picking !== null}
            >
              <span>
                <strong>{r.name}</strong>
                {r.private ? <span className="dim"> · private</span> : null}
              </span>
              <span className="dim">{r.updated_at.slice(0, 10)}</span>
            </button>
          ))}
        </div>
      ) : null}

      {!showCreate ? (
        <div className="actions" style={{ marginTop: "0.75rem" }}>
          <button
            type="button"
            className="secondary"
            onClick={() => setShowCreate(true)}
          >
            + Create new private repo
          </button>
        </div>
      ) : (
        <div className="form-row" style={{ marginTop: "0.75rem" }}>
          <label htmlFor="new-repo-name">New repo name</label>
          <input
            id="new-repo-name"
            type="text"
            value={newName}
            placeholder="my-vault-backup"
            onChange={(e) => setNewName(e.target.value)}
          />
          <div className="actions">
            <button
              type="button"
              onClick={createAndPick}
              disabled={creating || newName.trim().length === 0}
            >
              {creating ? "Creating…" : "Create"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setShowCreate(false)}
              disabled={creating}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// PAT modal — paste a token + remote URL, validate via `git ls-remote`.
// ---------------------------------------------------------------------------

function PATModal({
  vaultName,
  onClose,
  onSaved,
}: {
  vaultName: string;
  onClose: () => void;
  onSaved: (creds: MirrorCredentialStatus) => void;
}) {
  const [token, setToken] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const creds = await postMirrorAuthPat(vaultName, {
        token: token.trim(),
        remote_url: remoteUrl.trim(),
        label: label.trim() || undefined,
      });
      onSaved(creds);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="list-header">
          <h3 style={{ margin: 0 }}>Use Personal Access Token</h3>
          <button type="button" className="secondary" onClick={onClose} disabled={saving}>
            Close
          </button>
        </div>
        <p className="dim">
          Works for any provider that supports HTTPS push with a token in the URL
          (GitHub, GitLab, Codeberg, Gitea, …). The token is stored with{" "}
          <code>0600</code> file perms on this server.
        </p>
        <form onSubmit={onSubmit}>
          <div className="form-row">
            <label htmlFor="pat-token">Token</label>
            <input
              id="pat-token"
              type="password"
              value={token}
              autoComplete="off"
              onChange={(e) => setToken(e.target.value)}
              placeholder="ghp_… or glpat-… or similar"
              required
            />
          </div>
          <div className="form-row">
            <label htmlFor="pat-url">Remote URL</label>
            <input
              id="pat-url"
              type="url"
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              placeholder="https://github.com/owner/repo.git"
              required
            />
            <p className="dim" style={{ margin: "0.35rem 0 0" }}>
              We'll embed your token in the URL before saving (using GitHub's{" "}
              <code>x-access-token</code> convention). The URL you see on disk will
              carry the token; ensure the file isn't shared.
            </p>
          </div>
          <div className="form-row">
            <label htmlFor="pat-label">Label (optional)</label>
            <input
              id="pat-label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="GitHub PAT for backup"
            />
          </div>
          {error ? (
            <div className="error-banner" role="alert">
              <code>{error}</code>
            </div>
          ) : null}
          <div className="actions">
            <button type="submit" disabled={saving}>
              {saving ? "Validating…" : "Validate & save"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
