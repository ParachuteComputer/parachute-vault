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
 * Layout (restructured for non-technical owners — Aaron's "the settings
 * are very confusing for people, we want clearer defaults"):
 *   1. BackupStatusBanner — plain-language status. Every new vault ships
 *      with an internal live git history, so the default read is
 *      "✓ Version history — on." When credentials are wired + auto_push is
 *      on it upgrades to "✓ Version history + backed up off this machine."
 *   2. "Back up to GitHub" (GitRemoteSection) — the one upgrade an owner
 *      cares about, promoted above the fold (GitHub Device Flow / PAT).
 *   3. A single "Advanced settings" disclosure holding everything else —
 *      the preset shortcuts (History / External folder mirror / Manual
 *      Export), the raw config form (location / external_path / sync_mode /
 *      auto_commit / auto_push), the Status card with run-now / push-now,
 *      and import-from-git. A normal owner never opens it.
 *
 * The presets pre-fill the raw form so an operator who knows the shape
 * they want gets there in one click; the detailed fields below let custom
 * shapes through without bypassing the form's validation. The export
 * "Mirror" is the internal vocabulary; owner-facing copy says "Backup".
 *
 * Post-event-driven shift (vault#382): the granular schedule picker
 * (Live/Minute/10min/Hourly/Daily/Manual) has been replaced by a binary
 * sync-mode picker — "On change" (events) and "Manual only" (no
 * auto-fire). The export is event-driven now; time-based cadence is the
 * exclusive territory of the operator's own cron (or the admin SPA's
 * "Run export now" button).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { SignInBanner } from "../lib/SignInBanner.tsx";
import {
  HttpError,
  type DeviceCodeResponse,
  type GitHubRepoInfo,
  type MirrorConfig,
  type MirrorCredentialSaveResult,
  type MirrorCredentialStatus,
  type MirrorImportCredentials,
  type MirrorImportResult,
  type MirrorSnapshot,
  type MirrorStatus,
  type SelectGithubRepoResult,
  createGithubRepo,
  deleteMirrorAuth,
  getMirror,
  getMirrorAuth,
  listGithubRepos,
  pollGithubDeviceFlow,
  postMirrorAuthPat,
  postMirrorImport,
  pushMirrorNow,
  putMirror,
  runMirrorNow,
  selectGithubRepo,
  startGithubDeviceFlow,
} from "../lib/api.ts";
import { hasAdminScope } from "../lib/scope.ts";

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; snapshot: MirrorSnapshot }
  | { kind: "auth-required"; status: number | null }
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
    label: "External folder mirror",
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
          Backup for <code>{name}</code>
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

  // Single "Advanced" disclosure for the whole page. A normal owner never
  // needs to open it: the backup status banner + "Back up to GitHub"
  // upgrade above carry the entire common path. Everything an operator
  // wants — the raw config (location / sync_mode / auto_commit / auto_push
  // / external folder), the preset shortcuts, the manual run-now / push-now
  // buttons, the manual export, and import-from-git — lives inside.
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <>
      <BackupStatusBanner status={snapshot.status} config={snapshot.config} creds={creds} />

      {!isAdmin ? (
        <div className="warn-banner">
          You're viewing this page with a read-only token. Saving config + manual run
          require <code>vault:{vaultName}:admin</code>. Re-enter from the hub directory's
          "Manage" link with an admin-scoped session to make changes.
        </div>
      ) : null}

      {/* The one upgrade an owner cares about: back up off-machine to GitHub
          (or any HTTPS git host). Promoted out of "advanced" — it's the
          primary call to action on this page. */}
      {isAdmin ? (
        <GitRemoteSection
          vaultName={vaultName}
          creds={creds}
          credsError={credsError}
          onCredsChanged={setCreds}
          onCredsSaved={() => {
            // Refresh the snapshot so the new auto_push + status fields
            // (last_push_at, last_push_sha, commits_unpushed) land in
            // the SPA's view of state. Same trigger as putMirror.
            onRefresh();
          }}
          locationIsExternal={snapshot.config.location === "external"}
        />
      ) : null}

      <div className="section">
        <button
          type="button"
          className="secondary"
          onClick={() => setAdvancedOpen((s) => !s)}
          aria-expanded={advancedOpen}
        >
          {advancedOpen ? "Hide advanced settings" : "Advanced settings"}
        </button>
        {!advancedOpen ? (
          <p className="dim" style={{ margin: "0.6rem 0 0" }}>
            Manual exports, run-now, an external (Obsidian-visible) mirror folder,
            commit settings, and import-from-a-repo. Most owners never need these.
          </p>
        ) : null}
      </div>

      {advancedOpen ? (
        <>
          <StatusCard
            status={snapshot.status}
            config={snapshot.config}
            creds={creds}
            canRun={isAdmin && snapshot.status.enabled}
            vaultName={vaultName}
            onSnapshot={onSnapshot}
          />
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
            <ImportFromGitSection
              vaultName={vaultName}
              creds={creds}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}

/**
 * Plain-language backup status — the hero of the page. A non-technical
 * owner should read one line and know their vault is safe. Derived
 * entirely from the snapshot + credential status (no new API):
 *
 *  - enabled + internal location → "Version history — on." (the default
 *    every new vault ships with: a full local git history of every change).
 *  - + credentials ACTUALLY wired AND auto_push on → "Version history +
 *    backed up off this machine." We require real credentials, not just
 *    the auto_push flag: never tell an owner their data is backed up when
 *    no working remote exists (or while creds are still loading).
 *  - disabled → an honest "off" state with a nudge to the advanced toggle.
 *
 * "Mirror" is the internal vocabulary; the owner-facing copy is "Backup"
 * / "version history" throughout.
 */
function BackupStatusBanner({
  status,
  config,
  creds,
}: {
  status: MirrorStatus;
  config: MirrorConfig;
  creds: MirrorCredentialStatus | null;
}) {
  if (!config.enabled) {
    return (
      <div className="warn-banner" role="status">
        <strong>Version history is off.</strong> This vault isn't saving a
        local history of changes right now. Open <strong>Advanced settings</strong>{" "}
        below to turn it back on.
      </div>
    );
  }

  // Only claim "backed up off this machine" when credentials are ACTUALLY
  // wired (a real remote exists) AND auto_push is on. `auto_push` alone is
  // not enough: a vault can carry the flag with no working remote, and
  // while creds are still loading `creds === null` — telling the owner
  // their data is backed up when it isn't is a trust violation. Gate on
  // `creds?.active_method` being truthy, never on auto_push alone.
  const hasRemote = !!creds?.active_method;
  const pushingToRemote = config.auto_push && hasRemote;

  const githubLogin =
    creds?.active_method === "github_oauth" ? creds.github_oauth?.user_login : undefined;

  return (
    <div className="mint-banner" role="status" style={{ marginBottom: "1rem" }}>
      {pushingToRemote ? (
        <>
          <strong>✓ Version history + backed up off this machine.</strong>{" "}
          {githubLogin ? (
            <>
              Every change is saved locally and pushed to GitHub as{" "}
              <code>@{githubLogin}</code>.
            </>
          ) : (
            <>
              Every change is saved locally and pushed to your git remote
              automatically.
            </>
          )}
        </>
      ) : (
        <>
          <strong>✓ Version history — on.</strong> Your vault automatically
          saves a full local history of every change. Want an off-machine copy
          too? Use <strong>Back up to GitHub</strong> below.
        </>
      )}
      {status.last_error ? (
        <p className="dim" style={{ margin: "0.5rem 0 0" }}>
          Heads up — the last backup pass reported an error. See{" "}
          <strong>Advanced settings</strong> below for details.
        </p>
      ) : null}
    </div>
  );
}

function StatusCard({
  status,
  config,
  creds,
  canRun,
  vaultName,
  onSnapshot,
}: {
  status: MirrorStatus;
  config: MirrorConfig;
  creds: MirrorCredentialStatus | null;
  canRun: boolean;
  vaultName: string;
  onSnapshot: (snap: MirrorSnapshot) => void;
}) {
  const enabled = config.enabled;
  const [running, setRunning] = useState(false);
  const [pushing, setPushing] = useState(false);
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

  const onPushNow = async () => {
    setPushing(true);
    setRunError(null);
    try {
      const snap = await pushMirrorNow(vaultName);
      onSnapshot(snap);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setPushing(false);
    }
  };

  // Cut 6: disable "Push now" when there's no remote to push to (no
  // credentials AND auto_push is false). Operators with auto_push on
  // but no creds yet still get the button — clicking will surface the
  // missing-credentials error cleanly via last_push_error.
  const hasRemote = !!creds?.active_method || config.auto_push;
  const pushDisabled = !canRun || pushing || !hasRemote;

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
        {/* Cut 5: push status. Always render the row so the operator
            can read "never" — silence here was a footgun (Aaron's bug:
            "did the push actually fire?" with nothing to look at). */}
        <div>Last push</div>
        <div>
          {status.last_push_at ? (
            <>
              <code>{status.last_push_at}</code>
              {status.last_push_sha ? (
                <span className="dim">
                  {" "}· <code>{status.last_push_sha.slice(0, 10)}</code>
                </span>
              ) : null}
            </>
          ) : (
            <span className="dim">never</span>
          )}
        </div>
        {/* Surface commits_unpushed as a subdued helper when there's
            work pending and no recent push. Hides when 0 (synced) or
            null (no upstream yet — too noisy on first-boot). */}
        {status.commits_unpushed !== null && status.commits_unpushed > 0 ? (
          <>
            <div></div>
            <div className="dim">
              {status.commits_unpushed} commit{status.commits_unpushed === 1 ? "" : "s"} ready to push
            </div>
          </>
        ) : null}
      </div>
      {status.last_push_error ? (
        <div className="error-banner" style={{ marginTop: "1rem" }}>
          <strong>Last push failed:</strong> <code>{status.last_push_error}</code>
        </div>
      ) : null}
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
        <button
          type="button"
          className="secondary"
          onClick={onPushNow}
          disabled={pushDisabled}
          title={
            !enabled
              ? "Enable the mirror first, then push."
              : !canRun
                ? "Admin scope required to push."
                : !hasRemote
                  ? "Wire credentials or turn on auto-push to push to a remote."
                  : undefined
          }
        >
          {pushing ? "Pushing…" : "Push now"}
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
          <strong>History</strong> is the default every vault ships with —
          vault manages the history folder under its own data dir, no path to
          pick, no remote to configure. <strong>External folder mirror</strong> +{" "}
          <strong>Manual Export</strong> are for operators who want to point at a
          visible folder (Obsidian, GitHub).
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

      {/*
        Show the auto_push checkbox when EITHER:
          - location is external (vault doesn't manage the working tree;
            the operator might have wired their own git remote), OR
          - credentials are configured (PAT or GitHub OAuth) — at which
            point vault has a remote to push to regardless of where the
            working tree lives. The credential save path writes `origin`
            on the mirror dir whether it's internal or external.

        The old pattern hid the checkbox on internal locations under the
        assumption "internal = no remote." That breaks the round-trip
        Aaron hit: History preset (internal) + PAT saved → no way to
        flip auto_push on from the UI. Now the checkbox renders whenever
        the operator has a remote to push to.

        Backend validation (mirror-config.ts:validateMirrorConfigShape)
        mirrors this: auto_push + internal is accepted iff credentials
        are wired; rejected otherwise with an actionable error.
      */}
      {config.location === "external" || creds?.active_method ? (
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
          <p className="dim" style={{ margin: "0.35rem 0 0", fontSize: "0.9em" }}>
            When credentials are configured, vault can push the mirror's commits
            to your remote regardless of whether the mirror folder lives under
            vault's data dir or somewhere visible.
          </p>
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
                <strong>Back up to GitHub</strong> section above, or paste a Personal
                Access Token + remote URL there. Failed pushes are logged but won't crash
                the export.
              </div>
            )
          ) : null}
        </div>
      ) : null}

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
  onCredsSaved,
  locationIsExternal,
}: {
  vaultName: string;
  creds: MirrorCredentialStatus | null;
  credsError: string | null;
  onCredsChanged: (creds: MirrorCredentialStatus) => void;
  /**
   * Cut 3/6 — fires AFTER a successful save when the backend
   * auto-enables auto_push or fires an initial push, with the full save
   * result. Parent refreshes the mirror snapshot so the new
   * auto_push + last_push_at land in the SPA's view of state.
   */
  onCredsSaved: (result: MirrorCredentialSaveResult | SelectGithubRepoResult) => void;
  locationIsExternal: boolean;
}) {
  const [oauthOpen, setOauthOpen] = useState(false);
  const [patOpen, setPatOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /**
   * Toast surfaced after a successful credential save. Holds the save
   * result so the toast text can reference the actual push outcome
   * ("pushed sha abc1234" vs "auto-push enabled, next commit pushes").
   * Auto-dismisses on the next save or after a click.
   */
  const [saveResult, setSaveResult] = useState<
    MirrorCredentialSaveResult | SelectGithubRepoResult | null
  >(null);

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
    <div className="section" id="git-remote-section">
      <h3 style={{ margin: "0 0 0.85rem", fontSize: "1rem", fontWeight: 500 }}>
        {connected ? "Backed up to a git remote" : "Back up to GitHub"}
      </h3>
      <p className="dim" style={{ marginTop: 0 }}>
        {connected ? (
          <>
            Your vault pushes its history to an off-machine git remote.
            Credentials are stored on this server with <code>0600</code> file
            permissions — never sent to GitHub or any third party.
          </>
        ) : (
          <>
            Keep an off-machine copy: push your vault's history to GitHub (or any
            HTTPS git host). Credentials are stored on this server with{" "}
            <code>0600</code> file permissions, never sent to a third party.
          </>
        )}
      </p>

      {/*
        Pre-Cut-2 this read "Internal mirrors live under … no remote.
        Switch to External." With Cut 1/2 wired (auto_push works on
        internal location when credentials are configured), the message
        only applies when NO credentials are wired yet AND the location
        is internal — the case where there's genuinely nothing to push
        to. After credentials land, internal mirrors push fine.
      */}
      {!locationIsExternal && !creds?.active_method ? (
        <div className="info-banner" style={{ marginBottom: "0.75rem" }} role="status">
          Internal mirrors live under the vault's data directory. To push them
          to a remote, paste a Personal Access Token + remote URL below — that
          wires the remote and turns on auto-push automatically.
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

      {/* Cut 3 / Cut 6 confirmation toast. Renders after a successful PAT
          save / OAuth repo pick when the backend auto-enabled auto_push
          and/or fired an initial push. The copy adapts to the four
          shapes: was-already-on, just-enabled+pushed, just-enabled+
          push-failed, just-enabled+nothing-to-push. */}
      {saveResult ? (
        <div
          className="mint-banner"
          style={{ marginBottom: "0.75rem" }}
          role="status"
        >
          <strong>Credentials saved.</strong>{" "}
          {(() => {
            const sr = saveResult;
            const pushedSha =
              sr.initial_push.fired && sr.initial_push.pushed
                ? sr.initial_push.sha
                : undefined;
            const pushError =
              sr.initial_push.fired && !sr.initial_push.pushed
                ? sr.initial_push.error
                : undefined;
            if (sr.auto_push_was_already_enabled) {
              if (pushedSha) {
                return (
                  <>
                    Auto-push was already on; just pushed{" "}
                    <code>{pushedSha.slice(0, 10)}</code>.
                  </>
                );
              }
              if (pushError) {
                return (
                  <>
                    Auto-push was already on; the push attempt failed —
                    see Advanced settings → Status for details.
                  </>
                );
              }
              return <>Auto-push was already on; nothing to push right now.</>;
            }
            if (sr.auto_push_enabled) {
              if (pushedSha) {
                return (
                  <>
                    Auto-push enabled and the first push landed{" "}
                    <code>{pushedSha.slice(0, 10)}</code>. Your next commit will
                    push to the remote too.
                  </>
                );
              }
              if (pushError) {
                return (
                  <>
                    Auto-push enabled. The initial push attempt failed — see
                    Advanced settings → Status for the error.
                  </>
                );
              }
              return (
                <>Auto-push enabled. Your next commit will push to the remote.</>
              );
            }
            return <>Credentials wired. Auto-push remains off; flip it on in
              Advanced settings → Configuration to push commits automatically.</>;
          })()}{" "}
          <button
            type="button"
            className="secondary"
            onClick={() => setSaveResult(null)}
            style={{ marginLeft: "0.5rem" }}
            aria-label="Dismiss"
          >
            Dismiss
          </button>
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
          onConnected={(c, selectResult) => {
            onCredsChanged(c);
            if (selectResult) {
              setSaveResult(selectResult);
              onCredsSaved(selectResult);
            }
            setOauthOpen(false);
          }}
        />
      ) : null}

      {patOpen ? (
        <PATModal
          vaultName={vaultName}
          onClose={() => setPatOpen(false)}
          onSaved={(result) => {
            onCredsChanged(result);
            setSaveResult(result);
            onCredsSaved(result);
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
  /**
   * Cut 3/6: second arg carries the select-repo result so the parent
   * can surface a confirmation toast with auto_push + initial push
   * details. Undefined when the modal closes without a repo pick (e.g.
   * cancel during the device-code phase).
   */
  onConnected: (
    creds: MirrorCredentialStatus,
    selectResult?: SelectGithubRepoResult,
  ) => void;
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
              const selectResult = await selectGithubRepo(vaultName, { owner, name });
              const c = await getMirrorAuth(vaultName);
              onConnected(c, selectResult);
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
  /** Cut 3/6: the result now carries auto_push side-effects + initial
   *  push outcome so the parent can render a confirmation toast. */
  onSaved: (result: MirrorCredentialSaveResult) => void;
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
      const result = await postMirrorAuthPat(vaultName, {
        token: token.trim(),
        remote_url: remoteUrl.trim(),
        label: label.trim() || undefined,
      });
      onSaved(result);
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

// ===========================================================================
// Import-from-git section — pull a vault state from a remote git repo into
// THIS vault. Symmetric counterpart to the export flow above.
//
// Three credential paths:
//   1. From connected GitHub — only visible when active_method ===
//      "github_oauth". Opens a repo picker; selected repo's clone URL
//      becomes the remote.
//   2. From a remote URL — paste any HTTPS or SSH URL. Uses stored
//      credentials if available, otherwise warns.
//   3. One-time with a different credential — toggle reveals a PAT field
//      for a one-shot import that doesn't touch stored credentials.
//
// Two modes:
//   - Merge (default) — upsert-by-id; preserves notes that aren't in
//     the remote.
//   - Replace — wipe-then-import; remote becomes the new source of
//     truth. Gated behind a typed-name confirm.
//
// After success: offer to set the remote as the active mirror remote
// so future writes push back here (auto-wire offer).
// ===========================================================================

type ImportMode = "merge" | "replace";

type ImportPhase =
  | { kind: "idle" }
  | { kind: "running"; stage: "cloning" | "importing" }
  | { kind: "success"; result: MirrorImportResult; remoteUrl: string; mode: ImportMode }
  | { kind: "error"; message: string };

function ImportFromGitSection({
  vaultName,
  creds,
}: {
  vaultName: string;
  creds: MirrorCredentialStatus | null;
}) {
  const [remoteUrl, setRemoteUrl] = useState("");
  const [mode, setMode] = useState<ImportMode>("merge");
  const [usePerCallPat, setUsePerCallPat] = useState(false);
  const [perCallPat, setPerCallPat] = useState("");
  // vault#416 — default-on: also sync changes back to this repo. The operator
  // can uncheck before importing.
  const [enableSync, setEnableSync] = useState(true);
  const [phase, setPhase] = useState<ImportPhase>({ kind: "idle" });
  // Typed-name confirmation for replace mode. The operator types the
  // literal vault name to unlock the Start button.
  const [confirmText, setConfirmText] = useState("");
  // Repo picker overlay state.
  const [showRepoPicker, setShowRepoPicker] = useState(false);

  const hasGithubOauth =
    creds?.active_method === "github_oauth" && creds.github_oauth !== null;
  const hasStoredCreds = creds?.active_method !== null && creds?.active_method !== undefined;

  const replaceConfirmed =
    mode !== "replace" || confirmText.trim() === vaultName;

  const canStart =
    phase.kind !== "running" &&
    remoteUrl.trim().length > 0 &&
    replaceConfirmed &&
    (!usePerCallPat || perCallPat.trim().length > 0);

  const onStart = async () => {
    setPhase({ kind: "running", stage: "cloning" });
    let credentials: MirrorImportCredentials;
    if (usePerCallPat) {
      credentials = { kind: "pat", token: perCallPat.trim() };
    } else if (hasStoredCreds) {
      credentials = null; // server uses credentialsFile
    } else {
      credentials = { kind: "none" };
    }
    try {
      // Stage flip is a UI nicety — the server is synchronous from our POV
      // so the spinner copy can hint at "importing" partway through.
      const stageTimer = window.setTimeout(
        () => setPhase((p) => (p.kind === "running" ? { kind: "running", stage: "importing" } : p)),
        1500,
      );
      const result = await postMirrorImport(vaultName, {
        remote_url: remoteUrl.trim(),
        mode,
        credentials,
        enable_sync: enableSync,
      });
      window.clearTimeout(stageTimer);
      setPhase({ kind: "success", result, remoteUrl: remoteUrl.trim(), mode });
    } catch (err) {
      const message =
        err instanceof HttpError
          ? `${err.status === 409 ? "Already running. " : ""}${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      setPhase({ kind: "error", message });
    }
  };

  const onReset = () => {
    setPhase({ kind: "idle" });
    setConfirmText("");
  };

  return (
    <div className="section">
      <h3 style={{ margin: "0 0 0.85rem", fontSize: "1rem", fontWeight: 500 }}>
        Import from a git repo
      </h3>
      <p className="dim" style={{ marginTop: 0 }}>
        Pull a vault state from a remote git repo into <strong>this</strong> vault.
        Use this to load a vault someone has been mirroring, or to sync a vault
        between machines you control. The remote must be a Parachute vault export
        (created by <code>parachute-vault export</code> or the mirror's export flow).
      </p>

      {/*
        Multi-pusher caveat. Surfaces in both the SPA and the operator
        doc (parachute.computer/git-backup.njk). Aaron 2026-05-28:
        "I don't think we need to plan for that too elegantly right
        now, but it is important to think about." So we warn, we
        don't detect or block.
      */}
      <div className="warn-banner" style={{ marginBottom: "1rem" }} role="note">
        <strong>One vault per remote.</strong> Multiple vaults pushing to the
        same git repo isn't a supported shape — the last push wins, and
        vaults that diverge silently overwrite each other. Today's working
        pattern is one vault per remote. Active two-way sync is a future
        direction; for now, do exports from one place and imports as
        snapshots elsewhere.
      </div>

      {phase.kind === "success" ? (
        <ImportSuccessPanel
          vaultName={vaultName}
          result={phase.result}
          remoteUrl={phase.remoteUrl}
          mode={phase.mode}
          onReset={onReset}
        />
      ) : (
        <>
          <div className="form-row">
            <label htmlFor="import-remote-url">Remote URL</label>
            <input
              id="import-remote-url"
              type="text"
              value={remoteUrl}
              placeholder="https://github.com/aaron/my-vault.git"
              onChange={(e) => setRemoteUrl(e.target.value)}
              disabled={phase.kind === "running"}
            />
            {hasGithubOauth ? (
              <p className="dim" style={{ margin: "0.35rem 0 0", fontSize: "0.9em" }}>
                Or{" "}
                <button
                  type="button"
                  onClick={() => setShowRepoPicker(true)}
                  disabled={phase.kind === "running"}
                  style={{
                    background: "none",
                    border: "none",
                    padding: 0,
                    color: "var(--accent)",
                    textDecoration: "underline",
                    cursor: "pointer",
                    fontSize: "inherit",
                  }}
                >
                  pick from your GitHub repos
                </button>
                .
              </p>
            ) : null}
            {!hasStoredCreds && !usePerCallPat ? (
              <p className="hint" style={{ marginTop: "0.35rem", fontSize: "0.85em" }}>
                No saved git credentials. The import will be unauthenticated —
                works for public repos; private repos will fail with a clear
                error. Use the one-time credential toggle below if needed.
              </p>
            ) : null}
          </div>

          <div className="form-row">
            <label>Mode</label>
            <label className="radio-row">
              <input
                type="radio"
                name="import-mode"
                value="merge"
                checked={mode === "merge"}
                onChange={() => {
                  setMode("merge");
                  setConfirmText("");
                }}
                disabled={phase.kind === "running"}
              />
              <span>
                <strong>Merge</strong>{" "}
                <span className="dim">
                  — upsert by id. Notes in the remote get created/updated; any
                  notes that exist only locally <strong>survive</strong>.
                </span>
              </span>
            </label>
            <label className="radio-row">
              <input
                type="radio"
                name="import-mode"
                value="replace"
                checked={mode === "replace"}
                onChange={() => setMode("replace")}
                disabled={phase.kind === "running"}
              />
              <span>
                <strong>Replace</strong>{" "}
                <span className="dim">
                  — wipe this vault first, then import. The remote becomes the
                  new source of truth. <strong>Destructive.</strong>
                </span>
              </span>
            </label>
          </div>

          {mode === "replace" ? (
            <div className="form-row">
              <div className="error-banner" role="alert" style={{ marginBottom: "0.5rem" }}>
                <strong>Replace will delete every note in vault "{vaultName}" before
                importing.</strong> To confirm, type the vault name below:
              </div>
              <input
                id="import-confirm-name"
                type="text"
                value={confirmText}
                placeholder={vaultName}
                onChange={(e) => setConfirmText(e.target.value)}
                disabled={phase.kind === "running"}
                aria-label="Type vault name to confirm"
              />
            </div>
          ) : null}

          <div className="form-row">
            <label>
              <input
                type="checkbox"
                checked={usePerCallPat}
                onChange={(e) => setUsePerCallPat(e.target.checked)}
                disabled={phase.kind === "running"}
                style={{ width: "auto", marginRight: "0.5rem" }}
              />
              One-time credential for this import only
            </label>
            <p className="dim" style={{ margin: "0.35rem 0 0", fontSize: "0.85em" }}>
              Use a different Personal Access Token just for this clone, without
              changing your saved credentials.
            </p>
            {usePerCallPat ? (
              <input
                id="import-per-call-pat"
                type="password"
                value={perCallPat}
                placeholder="ghp_… or similar"
                onChange={(e) => setPerCallPat(e.target.value)}
                disabled={phase.kind === "running"}
                autoComplete="off"
                style={{ marginTop: "0.5rem" }}
              />
            ) : null}
          </div>

          {/*
            vault#416 — default-on "also sync back to this repo" checkbox.
            Reuses the access entered above (stored creds or the one-time PAT).
            Unchecking imports as a one-time snapshot with no push-back.
          */}
          <div className="form-row">
            <label>
              <input
                type="checkbox"
                checked={enableSync}
                onChange={(e) => setEnableSync(e.target.checked)}
                disabled={phase.kind === "running"}
                style={{ width: "auto", marginRight: "0.5rem" }}
              />
              Also sync changes back to this repo
            </label>
            <p className="dim" style={{ margin: "0.35rem 0 0", fontSize: "0.85em" }}>
              Pushes future changes to this repo automatically. Uses the access
              you provide above.
            </p>
          </div>

          {phase.kind === "error" ? (
            <div className="error-banner" role="alert">
              <code>{phase.message}</code>
            </div>
          ) : null}

          <div className="actions">
            <button
              type="button"
              onClick={onStart}
              disabled={!canStart}
              title={
                !replaceConfirmed
                  ? "Type the vault name to confirm Replace."
                  : remoteUrl.trim().length === 0
                    ? "Provide a remote URL."
                    : usePerCallPat && perCallPat.trim().length === 0
                      ? "Provide a token for one-time credential."
                      : undefined
              }
            >
              {phase.kind === "running"
                ? phase.stage === "cloning"
                  ? "Cloning…"
                  : "Importing…"
                : "Start import"}
            </button>
          </div>
        </>
      )}

      {showRepoPicker ? (
        <ImportRepoPickerModal
          vaultName={vaultName}
          onClose={() => setShowRepoPicker(false)}
          onPicked={(cloneUrl) => {
            setRemoteUrl(cloneUrl);
            setShowRepoPicker(false);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * After-success panel. Shows the import counts + warnings, and reflects the
 * sync-back outcome (vault#416).
 *
 * Sync is now enabled BY DEFAULT during the import (the checked-by-default
 * "Also sync changes back to this repo" checkbox). This panel just reports
 * what happened:
 *   - `sync_enabled` → confirm push-back is on.
 *   - `sync_warning` (and not enabled) → show it as an info/warning, NOT an
 *     error — the import still succeeded. Covers "no push credentials" and
 *     "a different mirror is already configured" (the multi-pusher footgun
 *     Aaron flagged — the server refuses to clobber an existing target).
 *   - opted out (no warning, not enabled) → nothing extra to say.
 */
function ImportSuccessPanel({
  vaultName,
  result,
  remoteUrl,
  mode,
  onReset,
}: {
  vaultName: string;
  result: MirrorImportResult;
  remoteUrl: string;
  mode: ImportMode;
  onReset: () => void;
}) {
  return (
    <>
      <div className="mint-banner" role="status" style={{ marginBottom: "0.75rem" }}>
        <strong>Import succeeded.</strong> Imported {result.notes_imported} note
        {result.notes_imported === 1 ? "" : "s"}, {result.tags_imported} tag schema
        {result.tags_imported === 1 ? "" : "s"}, {result.attachments_imported}{" "}
        attachment{result.attachments_imported === 1 ? "" : "s"}
        {mode === "replace" && result.notes_deleted !== undefined
          ? `, wiped ${result.notes_deleted} pre-existing note${result.notes_deleted === 1 ? "" : "s"}`
          : ""}
        .
      </div>

      {result.warnings.length > 0 ? (
        <details style={{ marginBottom: "0.75rem" }}>
          <summary>
            {result.warnings.length} warning{result.warnings.length === 1 ? "" : "s"}{" "}
            (see details)
          </summary>
          <ul style={{ marginTop: "0.5rem" }}>
            {result.warnings.map((w, i) => (
              <li key={i}>
                <code style={{ fontSize: "0.85em" }}>{w}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {result.sync_enabled ? (
        <div className="mint-banner" style={{ marginBottom: "0.75rem" }} role="status">
          <strong>Sync enabled.</strong> Changes to vault <code>{vaultName}</code>{" "}
          now push back to <code>{remoteUrl}</code> automatically.
        </div>
      ) : result.sync_warning ? (
        <div className="info-banner" style={{ marginBottom: "0.75rem" }} role="status">
          <p style={{ marginTop: 0 }}>
            <strong>Sync not enabled.</strong> {result.sync_warning}
          </p>
          <p className="dim" style={{ marginBottom: 0, fontSize: "0.9em" }}>
            You can still set up Sync from the{" "}
            <button
              type="button"
              onClick={() =>
                document
                  .getElementById("git-remote-section")
                  ?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
              style={{
                background: "none",
                border: "none",
                padding: 0,
                color: "var(--accent)",
                textDecoration: "underline",
                cursor: "pointer",
                fontSize: "inherit",
              }}
            >
              Git remote section
            </button>{" "}
            above.
          </p>
        </div>
      ) : null}

      <div className="actions">
        <button type="button" className="secondary" onClick={onReset}>
          Run another import
        </button>
      </div>
    </>
  );
}

/**
 * Repo picker modal for the import flow. Reuses the existing list-repos
 * endpoint (the one the export-side picker uses). On pick, populates
 * the parent's remote URL field with the chosen repo's clone URL.
 */
function ImportRepoPickerModal({
  vaultName,
  onClose,
  onPicked,
}: {
  vaultName: string;
  onClose: () => void;
  onPicked: (cloneUrl: string) => void;
}) {
  const [repos, setRepos] = useState<GitHubRepoInfo[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listGithubRepos(vaultName)
      .then(({ repos, truncated }) => {
        if (cancelled) return;
        setRepos(repos);
        setTruncated(Boolean(truncated));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [vaultName]);

  const filtered = (repos ?? []).filter((r) =>
    filter.length === 0
      ? true
      : r.full_name.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="list-header">
          <h3 style={{ margin: 0 }}>Pick a repo to import from</h3>
          <button type="button" className="secondary" onClick={onClose}>
            Close
          </button>
        </div>
        {error ? (
          <div className="error-banner" role="alert">
            <code>{error}</code>
          </div>
        ) : null}
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
            Showing the first 300 repos. Use the filter above to narrow down.
          </p>
        ) : null}
        {repos === null && !error ? <p className="muted">Loading repos…</p> : null}
        {repos !== null ? (
          <div className="repo-list">
            {filtered.length === 0 && filter.length > 0 ? (
              <p className="dim">No repos match "{filter}".</p>
            ) : null}
            {filtered.length === 0 && filter.length === 0 && repos.length === 0 ? (
              <p className="dim">You don't own any repos on this account.</p>
            ) : null}
            {filtered.map((r) => (
              <button
                type="button"
                key={r.full_name}
                className="repo-row"
                onClick={() => onPicked(r.clone_url)}
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
      </div>
    </div>
  );
}
