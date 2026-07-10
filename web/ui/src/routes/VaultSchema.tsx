/**
 * `/vault/:name/schema` — the Schema editor (vault#283).
 *
 * The operator capstone of the multi-writer arc (MW1 attribution + MW2
 * strict schemas + #314 migrate-tag-field). Edits the LIVE tag schema —
 * which lives in the DB `tags` + `indexed_fields` tables, NOT vault.yaml
 * (whose `tag_schemas` block is an ignored legacy one-time seed). Writes
 * go through `PUT /api/tags/:name` — the same chokepoint the `update-tag`
 * MCP tool funnels through, so an AI and the operator write the same row.
 *
 * MVP slice:
 *   1. Tag list with badges (has-schema / N indexed / strict).
 *   2. Per-tag fields editor — a row per field (name / type / enum / required
 *      / cardinality / indexed / strict / description), add/remove, plus an
 *      editable tag description. Save sends the FULL merged fields object
 *      (three-way semantics: omit = preserve, so a dropped field must be
 *      absent from the sent map).
 *   3. Hierarchy — a parent_names picker + a read-only effective/inherited-
 *      fields preview (what a note on this tag actually gets). Conflict
 *      badges when the projection reports them.
 *   4. Indexed-fields catalog (read) — what's queryable, and which tags
 *      co-declare each field.
 *   5. Conformance warning on tightening — before saving a strict/required/
 *      narrowed-enum/changed-type that EXISTING notes would violate, count
 *      them and warn ("N existing notes violate this — migrate with
 *      `parachute-vault schema migrate-field`"). Detect + warn + point at the
 *      CLI; the in-SPA one-click migrate is deferred (needs a migrate API).
 *
 * Deferred (out of MVP): raw vault.yaml editing (edits the ignored seed),
 * triggers editor, relationships authoring (opaque/app-defined — read-only
 * at most), server/global + secrets, and the one-click migrate.
 *
 * Risks handled: authoritative validation is server-side (we mirror checks
 * client-side for fast feedback but treat the API 400 as final); GLOBAL
 * indexed/type fields (co-declarers surfaced; API 400 backstop); index
 * rebuilds are slow DDL (save-on-commit, surfaced as a potentially-slow
 * action); hierarchy cycles (warned); concurrency (re-fetch before save,
 * stale-write surfaced); mid-edit 401 (auth-required banner, no work lost
 * because the form state stays in memory).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { HttpError } from "../lib/api.ts";
import { hasAdminScope } from "../lib/scope.ts";
import { SignInBanner } from "../lib/SignInBanner.tsx";
import {
  FIELD_TYPES,
  INDEXABLE_TYPES,
  type ConformanceResult,
  type EffectiveSchemaResult,
  type IndexedFieldCatalogEntry,
  type SchemaFieldSpec,
  type TagListEntry,
  type TagRecordResult,
  checkConformance,
  getEffectiveSchema,
  getTagRecord,
  listSchemaTags,
  saveTag,
} from "../lib/schema-api.ts";

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; tags: TagListEntry[] }
  | { kind: "auth-required"; status: number | null }
  | { kind: "error"; message: string };

export function VaultSchema({ vaultName }: { vaultName?: string } = {}) {
  const params = useParams<{ name: string }>();
  const name = vaultName ?? params.name;
  const isPerVaultMount = vaultName !== undefined;
  const detailHref = isPerVaultMount ? "/" : `/vault/${encodeURIComponent(name ?? "")}`;

  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!name) return;
    setState({ kind: "loading" });
    listSchemaTags(name)
      .then((tags) => {
        if (cancelled) return;
        setState({ kind: "ok", tags });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
          setState({ kind: "auth-required", status: err.status });
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

  const onRecovered = useCallback(() => setReloadTick((n) => n + 1), []);
  const reloadList = useCallback(() => setReloadTick((n) => n + 1), []);

  if (!name) {
    return (
      <div>
        <h2>Schema</h2>
        <p className="muted">Missing vault name.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="list-header">
        <h2>
          Schema for <code>{name}</code>
        </h2>
        <Link to={detailHref} className="muted">
          ← Vault detail
        </Link>
      </div>
      <p className="dim" style={{ marginTop: 0 }}>
        Tag schemas declare the metadata fields notes carry, which fields are
        indexed (queryable), and the tag hierarchy. Edits write the live schema
        directly — the same data an AI sees through <code>update-tag</code>.
      </p>

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
        <div className="schema-layout">
          <TagList
            tags={state.tags}
            selected={selected}
            onSelect={setSelected}
          />
          {selected ? (
            <TagEditor
              key={selected}
              vaultName={name}
              tag={selected}
              allTags={state.tags}
              onSaved={reloadList}
            />
          ) : (
            <div className="schema-detail">
              <p className="muted">Select a tag to view or edit its schema.</p>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Tag count badges: has-schema, N indexed, strict. */
function tagBadges(t: TagListEntry): { hasSchema: boolean; indexed: number; strict: boolean } {
  const fields = t.fields ?? {};
  const entries = Object.values(fields);
  return {
    hasSchema:
      (t.description !== null && t.description !== undefined) || entries.length > 0,
    indexed: entries.filter((f) => f.indexed === true).length,
    strict: entries.some((f) => f.strict === true),
  };
}

function TagList({
  tags,
  selected,
  onSelect,
}: {
  tags: TagListEntry[];
  selected: string | null;
  onSelect: (tag: string) => void;
}) {
  const sorted = useMemo(
    () => [...tags].sort((a, b) => a.name.localeCompare(b.name)),
    [tags],
  );
  return (
    <div className="schema-taglist" role="navigation" aria-label="Tags">
      <ul className="tag-list">
        {sorted.map((t) => {
          const b = tagBadges(t);
          return (
            <li key={t.name}>
              <button
                type="button"
                className={`tag-list-item${selected === t.name ? " selected" : ""}`}
                onClick={() => onSelect(t.name)}
                aria-current={selected === t.name}
              >
                <code className="tag-name">{t.name}</code>
                <span className="tag-meta">
                  <span className="dim">{t.count}</span>
                  {b.hasSchema ? <span className="badge">schema</span> : null}
                  {b.indexed > 0 ? <span className="badge">{b.indexed} indexed</span> : null}
                  {b.strict ? <span className="badge badge-strict">strict</span> : null}
                </span>
              </button>
            </li>
          );
        })}
        {sorted.length === 0 ? <li className="muted">No tags yet.</li> : null}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-tag editor
// ---------------------------------------------------------------------------

/** A field row in the editor's working state — name + spec, with a stable key
 *  so React can track rows across renames (the field NAME is editable). */
interface FieldRow {
  key: string;
  name: string;
  spec: SchemaFieldSpec;
}

let rowKeySeq = 0;
function newRowKey(): string {
  return `row-${rowKeySeq++}`;
}

function recordToRows(fields: Record<string, SchemaFieldSpec> | null): FieldRow[] {
  if (!fields) return [];
  return Object.entries(fields).map(([name, spec]) => ({
    key: newRowKey(),
    name,
    spec: { ...spec },
  }));
}

/** Build the merged `fields` object the PUT body needs from the working rows.
 *  Drops rows with a blank name. The full intended map is sent so a removed
 *  row actually drops the field (three-way merge semantics). */
function rowsToFields(rows: FieldRow[]): Record<string, SchemaFieldSpec> {
  const out: Record<string, SchemaFieldSpec> = {};
  for (const r of rows) {
    const n = r.name.trim();
    if (!n) continue;
    const spec: SchemaFieldSpec = {};
    if (r.spec.type) spec.type = r.spec.type;
    if (r.spec.enum && r.spec.enum.length > 0) spec.enum = r.spec.enum;
    if (r.spec.required) spec.required = true;
    if (r.spec.cardinality === "many") spec.cardinality = "many";
    if (r.spec.indexed) spec.indexed = true;
    if (r.spec.strict) spec.strict = true;
    if (r.spec.description && r.spec.description.trim().length > 0) {
      spec.description = r.spec.description.trim();
    }
    out[n] = spec;
  }
  return out;
}

const FIELD_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

type EditorState =
  | { kind: "loading" }
  | { kind: "ok"; record: TagRecordResult; effective: EffectiveSchemaResult }
  | { kind: "auth-required"; status: number | null }
  | { kind: "error"; message: string };

function TagEditor({
  vaultName,
  tag,
  allTags,
  onSaved,
}: {
  vaultName: string;
  tag: string;
  allTags: TagListEntry[];
  onSaved: () => void;
}) {
  const isAdmin = hasAdminScope(vaultName);
  const [state, setState] = useState<EditorState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    Promise.all([getTagRecord(vaultName, tag), getEffectiveSchema(vaultName, tag)])
      .then(([record, effective]) => {
        if (cancelled) return;
        // getTagRecord returns null on 404 (vault#550 — the server now
        // answers tag_not_found instead of synthesizing an all-null 200).
        // Reachable via TOCTOU (tag deleted between the list load and this
        // click) — degrade to the empty-record editor exactly as the old
        // all-null server response did, not the generic error banner.
        const effectiveRecord =
          record ?? {
            name: tag,
            count: 0,
            description: null,
            fields: null,
            relationships: null,
            parent_names: null,
            created_at: null,
            updated_at: null,
          };
        setState({ kind: "ok", record: effectiveRecord, effective });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
          setState({ kind: "auth-required", status: err.status });
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
  }, [vaultName, tag, reloadTick]);

  const onRecovered = useCallback(() => setReloadTick((n) => n + 1), []);

  if (state.kind === "loading") {
    return (
      <div className="schema-detail">
        <p className="muted">Loading {tag}…</p>
      </div>
    );
  }
  if (state.kind === "auth-required") {
    return (
      <div className="schema-detail">
        <SignInBanner vaultName={vaultName} status={state.status} onRecovered={onRecovered} />
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="schema-detail">
        <div className="error-banner">
          <code>{state.message}</code>
        </div>
      </div>
    );
  }

  return (
    <TagEditorForm
      vaultName={vaultName}
      tag={tag}
      record={state.record}
      effective={state.effective}
      allTags={allTags}
      isAdmin={isAdmin}
      onSaved={() => {
        setReloadTick((n) => n + 1);
        onSaved();
      }}
    />
  );
}

function TagEditorForm({
  vaultName,
  tag,
  record,
  effective,
  allTags,
  isAdmin,
  onSaved,
}: {
  vaultName: string;
  tag: string;
  record: TagRecordResult;
  effective: EffectiveSchemaResult;
  allTags: TagListEntry[];
  isAdmin: boolean;
  onSaved: () => void;
}) {
  const [description, setDescription] = useState<string>(record.description ?? "");
  const [rows, setRows] = useState<FieldRow[]>(() => recordToRows(record.fields));
  const [parents, setParents] = useState<string[]>(record.parent_names ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(0);
  // Conformance gate: when a save would break existing notes, we surface a
  // confirm step holding the report rather than saving immediately.
  const [conformance, setConformance] = useState<ConformanceResult | null>(null);
  const [checking, setChecking] = useState(false);
  // Set when the conformance pre-check itself FAILED (network/server). The
  // next submit bypasses the check and saves directly — the server still
  // enforces strict fields on write, so the worst case is a write rejection,
  // not silent data loss. Cleared on any edit (same as `conformance`).
  const [conformanceCheckFailed, setConformanceCheckFailed] = useState(false);

  // Co-declarers of each indexed field — surfaced so the operator changes
  // them together (indexed/type are GLOBAL across all declaring tags). Built
  // from the indexed-field catalog the effective endpoint returned.
  const catalogByField = useMemo(() => {
    const m = new Map<string, IndexedFieldCatalogEntry>();
    for (const f of effective.indexed_fields) m.set(f.name, f);
    return m;
  }, [effective.indexed_fields]);

  const candidateParents = useMemo(
    () => allTags.map((t) => t.name).filter((n) => n !== tag).sort((a, b) => a.localeCompare(b)),
    [allTags, tag],
  );

  // Cycle warning: a parent that lists this tag among its (transitive)
  // ancestors would form a cycle. We approximate with the available data —
  // a parent whose own effective_parents include this tag is a direct cycle.
  // The server's resolver is the real cycle detector; this is fast feedback.
  const cycleParents = useMemo(() => {
    const byName = new Map(allTags.map((t) => [t.name, t] as const));
    const offenders: string[] = [];
    for (const p of parents) {
      const pt = byName.get(p);
      if (pt?.parent_names?.includes(tag)) offenders.push(p);
    }
    return offenders;
  }, [parents, allTags, tag]);

  const willRebuildIndex = useMemo(() => {
    const before = new Set(
      Object.entries(record.fields ?? {})
        .filter(([, s]) => s.indexed === true)
        .map(([k]) => k),
    );
    const after = new Set(
      rows.filter((r) => r.spec.indexed && r.name.trim()).map((r) => r.name.trim()),
    );
    // Symmetric difference is non-empty → an ALTER TABLE / CREATE INDEX (or
    // DROP) will run, which is slow DDL on a large vault.
    for (const k of after) if (!before.has(k)) return true;
    for (const k of before) if (!after.has(k)) return true;
    return false;
  }, [rows, record.fields]);

  const clientErrors = useMemo(() => validateRowsClientSide(rows), [rows]);

  // Any edit invalidates a prior conformance verdict — a stale "0 violations"
  // (or a stale check-failed) must never let a subsequent tightening through
  // without a fresh check.
  const clearConformance = () => {
    setConformance(null);
    setConformanceCheckFailed(false);
  };

  const updateRow = (key: string, patch: Partial<SchemaFieldSpec>, namePatch?: string) => {
    setRows((prev) =>
      prev.map((r) =>
        r.key === key
          ? {
              ...r,
              name: namePatch !== undefined ? namePatch : r.name,
              spec: { ...r.spec, ...patch },
            }
          : r,
      ),
    );
    clearConformance();
  };

  const addRow = () => {
    setRows((prev) => [...prev, { key: newRowKey(), name: "", spec: { type: "string" } }]);
    clearConformance();
  };

  const removeRow = (key: string) => {
    setRows((prev) => prev.filter((r) => r.key !== key));
    clearConformance();
  };

  const toggleParent = (p: string) => {
    setParents((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
    // Parent changes don't affect the field-conformance verdict, but clear it
    // anyway to keep the "re-check on any edit" invariant simple.
    clearConformance();
  };

  // Save flow: (1) light client-side check; (2) conformance check — if any
  // existing note would violate the proposed spec, surface the warning and
  // require a second confirming click; (3) PUT. The conformance state is
  // cleared on any edit so a stale "safe" verdict can't slip a tightening
  // through.
  const doSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const fields = rowsToFields(rows);
      await saveTag(vaultName, tag, {
        description: description.trim().length > 0 ? description.trim() : null,
        // Full-replacement: the editor's rows ARE the intended field set, so a
        // removed row must drop the field (not be resurrected by a server-side
        // merge). See schema-api.ts saveTag.
        fields: Object.keys(fields).length > 0 ? fields : null,
        replace_fields: true,
        parent_names: parents.length > 0 ? parents : null,
      });
      setSavedTick((n) => n + 1);
      clearConformance();
      setTimeout(() => setSavedTick(0), 3000);
      onSaved();
    } catch (err) {
      if (err instanceof HttpError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;
    if (clientErrors.length > 0) {
      setError(clientErrors[0]);
      return;
    }
    setError(null);
    // Confirm path: a conformance warning is showing (a tightening that breaks
    // notes), OR the pre-check itself failed and the operator chose to proceed.
    // Either way this click is the explicit "save anyway".
    if ((conformance && conformance.violating_notes > 0) || conformanceCheckFailed) {
      await doSave();
      return;
    }
    // Otherwise run the conformance check first.
    setChecking(true);
    try {
      const fields = rowsToFields(rows);
      const report = await checkConformance(vaultName, tag, fields);
      if (report.violating_notes > 0) {
        setConformance(report);
        return; // require a confirming second click
      }
      clearConformance();
      await doSave();
    } catch (err) {
      // A failed conformance check shouldn't block the operator — surface it
      // and flip into the "save anyway" state so the next click saves directly
      // (the server still enforces strict on write, so the worst case is a
      // write rejection, never silent data loss).
      setError(
        `Could not check existing notes for conformance (${
          err instanceof Error ? err.message : String(err)
        }). Click Save again to apply anyway — strict fields are still enforced on write.`,
      );
      setConformance(null);
      setConformanceCheckFailed(true);
    } finally {
      setChecking(false);
    }
  };

  const readOnly = !isAdmin;

  return (
    <form className="schema-detail" onSubmit={onSubmit}>
      <div className="list-header">
        <h3 style={{ margin: 0 }}>
          <code>{tag}</code>
        </h3>
        <span className="dim">{record.count} note{record.count === 1 ? "" : "s"}</span>
      </div>

      {readOnly ? (
        <div className="warn-banner" role="status">
          You're viewing with a read-only token. Saving requires{" "}
          <code>vault:{vaultName}:admin</code>. Re-enter from the hub directory's
          "Manage" link with an admin session to edit.
        </div>
      ) : null}

      {/* Description */}
      <div className="form-row">
        <label htmlFor="tag-description">Description</label>
        <textarea
          id="tag-description"
          value={description}
          disabled={readOnly}
          rows={2}
          onChange={(e) => {
            setDescription(e.target.value);
            clearConformance();
          }}
          placeholder="What this tag means + how to use it (sent to AI clients)."
        />
      </div>

      {/* Fields editor */}
      <fieldset className="schema-fields">
        <legend>Fields</legend>
        {rows.length === 0 ? (
          <p className="dim">No fields declared. Add one to start a schema.</p>
        ) : null}
        {rows.map((r) => (
          <FieldRowEditor
            key={r.key}
            row={r}
            readOnly={readOnly}
            coDeclarers={
              r.spec.indexed
                ? (catalogByField.get(r.name.trim())?.tags ?? []).filter((t) => t !== tag)
                : []
            }
            onChange={(patch, namePatch) => updateRow(r.key, patch, namePatch)}
            onRemove={() => removeRow(r.key)}
          />
        ))}
        {!readOnly ? (
          <button type="button" className="secondary" onClick={addRow}>
            + Add field
          </button>
        ) : null}
      </fieldset>

      {/* Hierarchy: parent picker */}
      <fieldset className="schema-parents">
        <legend>Parents (hierarchy)</legend>
        <p className="dim" style={{ marginTop: 0 }}>
          A note on <code>{tag}</code> inherits the fields of every parent (and
          their ancestors). Queries for a parent also match this tag.
        </p>
        {candidateParents.length === 0 ? (
          <p className="dim">No other tags to pick as parents yet.</p>
        ) : (
          <div className="parent-grid">
            {candidateParents.map((p) => (
              <label key={p} className="parent-chip">
                <input
                  type="checkbox"
                  checked={parents.includes(p)}
                  disabled={readOnly}
                  onChange={() => toggleParent(p)}
                />
                <code>{p}</code>
              </label>
            ))}
          </div>
        )}
        {cycleParents.length > 0 ? (
          <div className="warn-banner" role="alert" style={{ marginTop: "0.5rem" }}>
            Cycle warning: <code>{cycleParents.join(", ")}</code> already
            list(s) <code>{tag}</code> as a parent. A cycle is tolerated at
            runtime but is almost always a config bug.
          </div>
        ) : null}
      </fieldset>

      {/* Effective (inherited) fields preview — read-only */}
      <EffectivePreview tag={tag} effective={effective} />

      {/* Indexed-field catalog — read view */}
      <IndexedCatalog catalog={effective.indexed_fields} tag={tag} />

      {/* Client-side validation hints */}
      {clientErrors.length > 0 ? (
        <div className="warn-banner" role="alert">
          <strong>Fix before saving:</strong>
          <ul style={{ margin: "0.4rem 0 0" }}>
            {clientErrors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Index-rebuild cost notice */}
      {willRebuildIndex && !readOnly ? (
        <div className="info-banner" role="status">
          This save changes which fields are indexed. Vault will rebuild the
          backing column + index (an <code>ALTER TABLE</code> / index build) —
          on a large vault this can take a moment.
        </div>
      ) : null}

      {/* Conformance warning (the #314 tie-in) */}
      {conformance && conformance.violating_notes > 0 ? (
        <ConformanceWarning report={conformance} tag={tag} />
      ) : null}

      {error ? (
        <div className="error-banner" role="alert">
          <code>{error}</code>
        </div>
      ) : null}

      {savedTick > 0 ? (
        <div
          className="mint-banner"
          style={{ padding: "0.75rem 1rem", margin: "1rem 0" }}
          role="status"
        >
          Saved.
        </div>
      ) : null}

      <div className="actions">
        <button type="submit" disabled={readOnly || saving || checking}>
          {saving
            ? "Saving…"
            : checking
              ? "Checking existing notes…"
              : (conformance && conformance.violating_notes > 0) || conformanceCheckFailed
                ? "Save anyway"
                : "Save"}
        </button>
      </div>
    </form>
  );
}

/** A single field row's editor. */
function FieldRowEditor({
  row,
  readOnly,
  coDeclarers,
  onChange,
  onRemove,
}: {
  row: FieldRow;
  readOnly: boolean;
  coDeclarers: string[];
  onChange: (patch: Partial<SchemaFieldSpec>, namePatch?: string) => void;
  onRemove: () => void;
}) {
  const { name, spec } = row;
  const indexable = INDEXABLE_TYPES.has(spec.type ?? "");
  const enumStr = (spec.enum ?? []).join(", ");

  return (
    <div className="field-row">
      <div className="field-row-main">
        <input
          aria-label="Field name"
          className="field-name-input"
          type="text"
          value={name}
          disabled={readOnly}
          placeholder="field_name"
          onChange={(e) => onChange({}, e.target.value)}
        />
        <select
          aria-label="Field type"
          value={spec.type ?? ""}
          disabled={readOnly}
          onChange={(e) => {
            const type = e.target.value || undefined;
            // If the new type isn't indexable, drop the indexed flag.
            const patch: Partial<SchemaFieldSpec> = { type };
            if (type && !INDEXABLE_TYPES.has(type)) patch.indexed = false;
            onChange(patch);
          }}
        >
          <option value="">(any)</option>
          {FIELD_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <label className="field-flag">
          <input
            type="checkbox"
            checked={spec.required === true}
            disabled={readOnly}
            onChange={(e) => onChange({ required: e.target.checked })}
          />
          required
        </label>
        <label className="field-flag">
          <input
            type="checkbox"
            checked={spec.cardinality === "many"}
            disabled={readOnly}
            onChange={(e) => onChange({ cardinality: e.target.checked ? "many" : "one" })}
          />
          many
        </label>
        <label className="field-flag" title={indexable ? undefined : "Only string / integer / boolean fields can be indexed"}>
          <input
            type="checkbox"
            checked={spec.indexed === true}
            disabled={readOnly || !indexable}
            onChange={(e) => onChange({ indexed: e.target.checked })}
          />
          indexed
        </label>
        <label className="field-flag">
          <input
            type="checkbox"
            checked={spec.strict === true}
            disabled={readOnly}
            onChange={(e) => onChange({ strict: e.target.checked })}
          />
          strict
        </label>
        {!readOnly ? (
          <button
            type="button"
            className="secondary field-remove"
            onClick={onRemove}
            aria-label={`Remove field ${name || "(unnamed)"}`}
          >
            ✕
          </button>
        ) : null}
      </div>
      <div className="field-row-extra">
        <input
          aria-label="Enum values (comma-separated)"
          type="text"
          className="field-enum-input"
          value={enumStr}
          disabled={readOnly}
          placeholder="enum values (comma-separated, optional)"
          onChange={(e) => {
            const vals = e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            onChange({ enum: vals });
          }}
        />
        <input
          aria-label="Field description"
          type="text"
          className="field-desc-input"
          value={spec.description ?? ""}
          disabled={readOnly}
          placeholder="description (optional)"
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </div>
      {coDeclarers.length > 0 ? (
        <p className="dim field-codeclarers">
          Also indexed by: {coDeclarers.map((t) => <code key={t}>{t}</code>)}. Type
          + indexed are global across all of these — change them together.
        </p>
      ) : null}
    </div>
  );
}

/** Read-only preview of the effective (own ∪ inherited) field map. */
function EffectivePreview({
  tag,
  effective,
}: {
  tag: string;
  effective: EffectiveSchemaResult;
}) {
  const ownFields = new Set(Object.keys(effective.fields ?? {}));
  const entries = Object.entries(effective.effective_fields);
  return (
    <div className="schema-effective section">
      <h4 style={{ margin: "0 0 0.5rem" }}>Effective fields (what a note actually gets)</h4>
      {effective.effective_parents.length > 0 ? (
        <p className="dim" style={{ marginTop: 0 }}>
          Inherits from: {effective.effective_parents.map((p) => <code key={p}>{p}</code>)}
        </p>
      ) : (
        <p className="dim" style={{ marginTop: 0 }}>
          No parents — effective fields are just <code>{tag}</code>'s own.
        </p>
      )}
      {entries.length === 0 ? (
        <p className="dim">No fields (own or inherited).</p>
      ) : (
        <table className="schema-table">
          <thead>
            <tr>
              <th>Field</th>
              <th>Type</th>
              <th>Source</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([fname, fspec]) => {
              const inherited = !ownFields.has(fname);
              const flags = [
                fspec.required ? "required" : null,
                fspec.cardinality === "many" ? "many" : null,
                fspec.strict ? "strict" : null,
                fspec.enum && fspec.enum.length > 0 ? `enum[${fspec.enum.length}]` : null,
              ].filter(Boolean) as string[];
              return (
                <tr key={fname}>
                  <td>
                    <code>{fname}</code>
                  </td>
                  <td>{fspec.type ?? <span className="dim">any</span>}</td>
                  <td>
                    {inherited ? (
                      <span className="badge">inherited</span>
                    ) : (
                      <span className="dim">own</span>
                    )}
                  </td>
                  <td>{flags.length > 0 ? flags.join(", ") : <span className="dim">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Read view of the vault-wide indexed-field catalog. */
function IndexedCatalog({
  catalog,
  tag,
}: {
  catalog: IndexedFieldCatalogEntry[];
  tag: string;
}) {
  return (
    <div className="schema-catalog section">
      <h4 style={{ margin: "0 0 0.5rem" }}>Indexed fields (what's queryable)</h4>
      {catalog.length === 0 ? (
        <p className="dim">No indexed fields in this vault yet.</p>
      ) : (
        <table className="schema-table">
          <thead>
            <tr>
              <th>Field</th>
              <th>Type</th>
              <th>Declared by</th>
            </tr>
          </thead>
          <tbody>
            {catalog.map((f) => (
              <tr key={f.name} className={f.tags.includes(tag) ? "row-this-tag" : undefined}>
                <td>
                  <code>{f.name}</code>
                </td>
                <td>{f.type}</td>
                <td>
                  {f.tags.map((t) => (
                    <code key={t} className={t === tag ? "tag-self" : undefined}>
                      {t}
                    </code>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** The MW2/#314 tightening warning. */
function ConformanceWarning({
  report,
  tag,
}: {
  report: ConformanceResult;
  tag: string;
}) {
  return (
    <div className="warn-banner" role="alert">
      <strong>
        {report.violating_notes} existing note
        {report.violating_notes === 1 ? "" : "s"} violate this schema.
      </strong>{" "}
      They'll be REJECTED on their next write once you tighten{" "}
      <code>{report.checked_fields.join(", ")}</code>.
      <p style={{ margin: "0.5rem 0" }}>
        Migrate the existing data first with the CLI:
      </p>
      <pre style={{ margin: "0 0 0.5rem", whiteSpace: "pre-wrap" }}>
        <code>
          parachute-vault schema migrate-field {tag} &lt;field&gt; --transform …
        </code>
      </pre>
      {report.sample.length > 0 ? (
        <details>
          <summary>
            Examples ({report.sample.length} of {report.violating_notes})
          </summary>
          <ul style={{ margin: "0.4rem 0 0" }}>
            {report.sample.map((s) => (
              <li key={s.id}>
                <code>{s.path ?? s.id}</code>
                {": "}
                {s.fields.map((f) => f.reason).join(", ")}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <p className="dim" style={{ margin: "0.5rem 0 0", fontSize: "0.9em" }}>
        Click <strong>Save anyway</strong> to apply the schema regardless —
        these notes stay readable but reject on edit until migrated.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Client-side validation (fast feedback; server is authoritative)
// ---------------------------------------------------------------------------

/**
 * Light checks mirrored from the server so the operator gets instant
 * feedback. The API 400 (invalid_indexed_field etc.) remains the final word.
 */
export function validateRowsClientSide(rows: FieldRow[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const n = r.name.trim();
    if (!n) {
      // A blank row is dropped on save, not an error — skip.
      continue;
    }
    if (seen.has(n)) {
      errors.push(`Duplicate field name "${n}".`);
      continue;
    }
    seen.add(n);
    // Indexed fields must be valid SQL identifiers (server FIELD_NAME_RE).
    if (r.spec.indexed && !FIELD_NAME_RE.test(n)) {
      errors.push(
        `"${n}" can't be indexed — indexed field names must start with a letter or underscore and contain only letters, digits, underscores (max 63 chars).`,
      );
    }
    // Indexed requires an indexable type.
    if (r.spec.indexed && r.spec.type && !INDEXABLE_TYPES.has(r.spec.type)) {
      errors.push(`"${n}" is indexed but type "${r.spec.type}" can't be indexed (use string / integer / boolean).`);
    }
  }
  return errors;
}
