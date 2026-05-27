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
 * Schedule preset → `interval_seconds` mapping: friendly labels (Live /
 * Every minute / Hourly / Daily / Manual only) on the picker, the
 * backend's existing integer-seconds field on the wire. "Manual only"
 * is the special case that sets `watch: false` — every other choice
 * implies `watch: true` since the value's meaningless when the watch
 * loop isn't running.
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  HttpError,
  type MirrorConfig,
  type MirrorSnapshot,
  type MirrorStatus,
  getMirror,
  putMirror,
  runMirrorNow,
} from "../lib/api.ts";
import { hasAdminScope } from "../lib/scope.ts";

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; snapshot: MirrorSnapshot }
  | { kind: "auth-required" }
  | { kind: "error"; message: string };

/**
 * Schedule presets — friendly labels operators recognize, mapped to the
 * backend's `interval_seconds` integer. "Manual only" is the odd one
 * out: it sets `watch: false` instead of choosing an interval, because
 * the interval value is meaningless when the watch loop isn't armed.
 */
const SCHEDULE_OPTIONS: ReadonlyArray<{
  value: string;
  label: string;
  interval?: number;
  watch: boolean;
}> = [
  { value: "live", label: "Live (every 5s)", interval: 5, watch: true },
  { value: "minute", label: "Every minute", interval: 60, watch: true },
  { value: "10min", label: "Every 10 minutes", interval: 600, watch: true },
  { value: "hourly", label: "Hourly", interval: 3600, watch: true },
  { value: "daily", label: "Daily", interval: 86400, watch: true },
  { value: "manual", label: "Manual only", watch: false },
];

/**
 * Map the persisted `(watch, interval_seconds)` pair back to the picker
 * value. Non-exact intervals (operator hand-edited config.yaml to 17s,
 * say) fall through to "live" as the closest aligned default; the
 * underlying `interval_seconds` field is still preserved on the config
 * blob until the operator picks a different option and saves.
 */
function inferScheduleValue(config: MirrorConfig): string {
  if (!config.watch) return "manual";
  const match = SCHEDULE_OPTIONS.find(
    (opt) => opt.watch && opt.interval === config.interval_seconds,
  );
  return match?.value ?? "live";
}

/**
 * Apply a schedule choice to a config blob. "manual" flips watch off;
 * everything else sets watch=true + the named interval.
 */
function applySchedule(config: MirrorConfig, value: string): MirrorConfig {
  const opt = SCHEDULE_OPTIONS.find((o) => o.value === value);
  if (!opt) return config;
  if (!opt.watch) return { ...config, watch: false };
  return {
    ...config,
    watch: true,
    interval_seconds: opt.interval ?? config.interval_seconds,
  };
}

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
      "Local audit trail. Hidden under vault data. Always-on watch.",
    apply: (current) => ({
      ...current,
      enabled: true,
      location: "internal",
      watch: true,
      auto_commit: true,
      auto_push: false,
      interval_seconds: 5,
    }),
  },
  {
    id: "live",
    label: "Live Mirror",
    subtext:
      "Visible folder. Open in Obsidian, push to GitHub.",
    apply: (current) => ({
      ...current,
      enabled: true,
      location: "external",
      watch: true,
      auto_commit: true,
      // Don't force-flip auto_push — operator may not have credentials yet.
      interval_seconds: 5,
    }),
  },
  {
    id: "manual",
    label: "Manual Export",
    subtext: "Snapshot on demand.",
    apply: (current) => ({
      ...current,
      enabled: true,
      location: "external",
      watch: false,
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
        onSaved={(snap) => {
          onSnapshot(snap);
          onRefresh();
        }}
      />
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
  onSaved,
}: {
  vaultName: string;
  initial: MirrorConfig;
  readOnly: boolean;
  onSaved: (snap: MirrorSnapshot) => void;
}) {
  const [config, setConfig] = useState<MirrorConfig>(initial);
  const [schedule, setSchedule] = useState<string>(inferScheduleValue(initial));
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
    setSchedule(inferScheduleValue(initial));
  }, [initial]);

  const onApplyPreset = (preset: Preset) => {
    const next = preset.apply(config);
    setConfig(next);
    setSchedule(inferScheduleValue(next));
  };

  const onChangeSchedule = (value: string) => {
    setSchedule(value);
    setConfig((prev) => applySchedule(prev, value));
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
        else if (lower.includes("interval_seconds")) setErrorField("interval_seconds");
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
        <label htmlFor="schedule-select">Schedule</label>
        <select
          id="schedule-select"
          value={schedule}
          disabled={readOnly}
          onChange={(e) => onChangeSchedule(e.target.value)}
        >
          {SCHEDULE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <p className="dim" style={{ margin: "0.35rem 0 0" }}>
          {schedule === "manual"
            ? "Watch loop disabled — exports only fire when you click \"Run export now\"."
            : "Watch loop runs in-process and triggers an export pass at the chosen interval."}
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
            <div className="warn-banner" style={{ marginTop: "0.5rem" }} role="alert">
              Auto-push requires git credentials configured outside vault (e.g., SSH
              key, <code>GH_TOKEN</code>). Failed pushes are logged but won't crash the
              export.
            </div>
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
