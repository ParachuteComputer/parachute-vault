/**
 * migrate-tag-field (vault#314) — evolve a tag-schema field's type / values
 * across the existing notes that carry a tag, so a schema tightening (declare a
 * `strict` enum, rename an enum value, retype a field, set a default for a
 * now-required field) can bring the back-catalog into conformance in one
 * operation instead of editing notes by hand.
 *
 * This is the companion to enforced writes (vault#299 / MW2): declare `strict`
 * → find the non-conforming notes → migrate them. The migration is the EXACT
 * use case the migrate-bypass scope (`vault:migrate`) exists for — it rewrites
 * notes through `strict` enforcement and logs the bypass for audit.
 *
 * Design (issue #314):
 *   - Walk every note carrying `tag` (descendants included — `store.queryNotes`
 *     already expands the hierarchy), apply a `transform` to the named
 *     metadata `field`, write back.
 *   - **Dry-run by default.** The default returns a plan (count + sample of
 *     would-change rows) WITHOUT mutating. `apply: true` is the explicit
 *     opt-in that writes. A migration is destructive across many notes, so the
 *     preview is first-class.
 *   - **Bypass + attribution.** Each rewrite runs `enforceStrictWrite` with
 *     `bypass: true` so a `strict:true` field that the back-catalog violates
 *     doesn't block the migration, and every bypassed write is logged
 *     (`onBypass`). Writes carry `actor`/`via` (MW1) — the migration is the
 *     `last_updated_*` author; `created_*` is set-once and never touched.
 *   - **Surgical.** Only the named `field` on matching notes is touched; all
 *     other metadata is preserved verbatim. A `rename` transform moves the
 *     value to the new key and drops the old.
 *   - **Clean failure.** An unconvertible retype (`to_int` on `"banana"`)
 *     fails that note cleanly — it's reported as `errored`, never partially
 *     written. By default a single error aborts the whole apply BEFORE any
 *     write (atomic preflight); `continueOnError: true` switches to
 *     best-effort, writing the convertible notes and reporting the rest.
 *   - **Idempotent.** Re-running an apply once the catalog conforms is a no-op
 *     (no note is in the would-change set the second time).
 */

import type { Store, Note } from "./types.js";
import type { ValidationWarning } from "./schema-defaults.js";
import { enforceStrictWrite } from "./mcp.js";

// Re-export for callers (tests, server layer) that work with the bypass
// logger's violation list without importing schema-defaults directly.
export type { ValidationWarning } from "./schema-defaults.js";

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

/**
 * The transform set (issue #314 §Proposal — the built-in set; no expression
 * language). Each names a concrete schema-evolution move:
 *
 *   - `rename`    — move the field's value to a NEW metadata key, dropping the
 *                   old key. The schema-rename move (`kpi` → `metric`). `to` is
 *                   the new field name. Notes missing the field are untouched.
 *   - `remap`     — rewrite the field's VALUE per a value→value map. The enum
 *                   value-rename move (`old` → `new`). Values not in the map are
 *                   left as-is. Pass `default` to also fill missing/null values.
 *   - `set_default` — set the field to `value` on notes where it's missing,
 *                   null, or (when `onlyInvalid` + a validator) currently
 *                   invalid. Notes that already carry a valid value are
 *                   untouched. The "default for a now-required field" move.
 *   - `to_string` / `to_int` / `to_number` / `to_boolean` — retype the field's
 *                   value. Conversions are conservative (see `coerce*`); an
 *                   unconvertible value is an error for that note, not a
 *                   silent drop. The "changed a field's type" move.
 */
export type FieldTransform =
  | { kind: "rename"; to: string }
  | { kind: "remap"; map: Record<string, unknown>; default?: unknown }
  | { kind: "set_default"; value: unknown; onlyInvalid?: boolean }
  | { kind: "to_string" }
  | { kind: "to_int" }
  | { kind: "to_number" }
  | { kind: "to_boolean" };

/** A transform raised this when a value can't be converted (clean per-note failure). */
export class TransformError extends Error {
  code = "TRANSFORM_ERROR" as const;
  constructor(message: string) {
    super(message);
    this.name = "TransformError";
  }
}

const PRESENT = Symbol("present"); // sentinel: field exists with this value
const ABSENT = Symbol("absent"); // sentinel: field is missing entirely

/**
 * Outcome of applying a transform to one note's field. `change` describes the
 * metadata edit:
 *   - `null` → no change (note left untouched).
 *   - `{ setField, value }` → set `setField` to `value`.
 *   - `{ setField, value, dropField }` → set the new key, drop the old (rename).
 */
interface TransformResult {
  /** Field name to write (the new key for rename, else the original field). */
  setField: string;
  /** Value to write. */
  value: unknown;
  /** Field name to remove (rename only — the original key). */
  dropField?: string;
}

/**
 * Apply a transform to the (possibly-absent) current value of `field`. Returns
 * the metadata edit to make, or `null` for "no change." Throws `TransformError`
 * on an unconvertible retype.
 *
 * `present` distinguishes "field is missing" from "field is present and null/
 * undefined" — `set_default` fills both, but `rename`/`remap`/retype only act
 * on a present field (you can't rename a key that isn't there).
 */
export function applyTransform(
  field: string,
  current: unknown,
  present: boolean,
  transform: FieldTransform,
  isValid?: (v: unknown) => boolean,
): TransformResult | null {
  switch (transform.kind) {
    case "rename": {
      if (!present) return null; // nothing to move
      if (transform.to === field) return null; // no-op rename
      return { setField: transform.to, value: current, dropField: field };
    }
    case "remap": {
      // Fill missing/null when a `default` is provided…
      if (!present || current === null || current === undefined) {
        if ("default" in transform) {
          return changeIfDifferent(field, current, transform.default, present);
        }
        return null;
      }
      // …else remap the value if it's a key in the map (string-keyed lookup).
      const key = typeof current === "string" ? current : String(current);
      if (Object.prototype.hasOwnProperty.call(transform.map, key)) {
        return changeIfDifferent(field, current, transform.map[key], present);
      }
      return null; // value not in the map — leave as-is
    }
    case "set_default": {
      const missing = !present || current === null || current === undefined;
      if (missing) {
        return changeIfDifferent(field, current, transform.value, present);
      }
      // Present + non-null. Overwrite only when `onlyInvalid` and the value
      // currently fails validation (e.g. an enum value that's no longer legal).
      if (transform.onlyInvalid && isValid && !isValid(current)) {
        return changeIfDifferent(field, current, transform.value, present);
      }
      return null;
    }
    case "to_string": {
      if (!present || current === null || current === undefined) return null;
      return changeIfDifferent(field, current, coerceString(current), present);
    }
    case "to_int": {
      if (!present || current === null || current === undefined) return null;
      return changeIfDifferent(field, current, coerceInt(field, current), present);
    }
    case "to_number": {
      if (!present || current === null || current === undefined) return null;
      return changeIfDifferent(field, current, coerceNumber(field, current), present);
    }
    case "to_boolean": {
      if (!present || current === null || current === undefined) return null;
      return changeIfDifferent(field, current, coerceBoolean(field, current), present);
    }
  }
}

/**
 * Return a `TransformResult` only when the new value actually differs from the
 * current one (idempotency at the value level — a remap to the same value, or a
 * retype of an already-correctly-typed value, is a no-op). `present === false`
 * always counts as a change when we're writing a value (the field is being
 * added).
 */
function changeIfDifferent(
  field: string,
  current: unknown,
  next: unknown,
  present: boolean,
): TransformResult | null {
  if (present && Object.is(current, next)) return null;
  // Deep-equal escape hatch for non-primitive equal values (rare; remap to an
  // equal object/array). JSON compare is sufficient — metadata is JSON.
  if (present && typeof current === typeof next && typeof current === "object") {
    try {
      if (JSON.stringify(current) === JSON.stringify(next)) return null;
    } catch {
      /* fall through — treat as a change */
    }
  }
  return { setField: field, value: next };
}

function coerceString(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // Objects/arrays → JSON, which is the least-surprising stringification for
  // metadata and round-trips back through `to_*` cleanly.
  return JSON.stringify(v);
}

function coerceInt(field: string, v: unknown): number {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TransformError(`'${field}': ${v} is not a finite number`);
    if (!Number.isInteger(v)) {
      throw new TransformError(`'${field}': ${v} has a fractional part — cannot convert to integer`);
    }
    return v;
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const t = v.trim();
    // Strict integer parse — reject "5px", "5.5", "" and other junk that
    // Number() would silently coerce or NaN.
    if (!/^[+-]?\d+$/.test(t)) {
      throw new TransformError(`'${field}': "${v}" is not an integer`);
    }
    const n = Number(t);
    if (!Number.isSafeInteger(n)) {
      throw new TransformError(`'${field}': "${v}" is out of safe-integer range`);
    }
    return n;
  }
  throw new TransformError(`'${field}': cannot convert ${typeof v} to integer`);
}

function coerceNumber(field: string, v: unknown): number {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TransformError(`'${field}': ${v} is not a finite number`);
    return v;
  }
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "" || !Number.isFinite(Number(t))) {
      throw new TransformError(`'${field}': "${v}" is not a number`);
    }
    return Number(t);
  }
  throw new TransformError(`'${field}': cannot convert ${typeof v} to number`);
}

function coerceBoolean(field: string, v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (v === 1) return true;
    if (v === 0) return false;
    throw new TransformError(`'${field}': ${v} is not a boolean (expected 0 or 1)`);
  }
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true" || t === "yes" || t === "1") return true;
    if (t === "false" || t === "no" || t === "0") return false;
    throw new TransformError(`'${field}': "${v}" is not a boolean (expected true/false/yes/no/1/0)`);
  }
  throw new TransformError(`'${field}': cannot convert ${typeof v} to boolean`);
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

export interface MigrateTagFieldOpts {
  /** The tag whose notes carry the field. Hierarchy descendants are included. */
  tag: string;
  /** The metadata field to evolve. */
  field: string;
  /** The transform to apply. */
  transform: FieldTransform;
  /**
   * Dry-run by default. `apply: true` is the explicit opt-in that writes —
   * everything else returns a plan and mutates NOTHING.
   */
  apply?: boolean;
  /**
   * Write-attribution (MW1) for the rewrites. The migration is the
   * `last_updated_*` author; `created_*` is never touched. Defaults to
   * `{ actor: "migrate", via: "migrate" }` so a migration is always
   * distinguishable in the attribution columns even when the caller omits it.
   */
  actor?: string | null;
  via?: string | null;
  /**
   * How many would-change rows to include in `sample`. Default 10. The full
   * count is always reported regardless.
   */
  sampleSize?: number;
  /**
   * Error policy on an unconvertible retype:
   *   - default (`false`) — ATOMIC: any error aborts the whole apply BEFORE a
   *     single write, so the migration is all-or-nothing. The plan lists every
   *     errored note so the operator can fix the data first.
   *   - `true` — best-effort: write every convertible note, report the rest.
   */
  continueOnError?: boolean;
  /**
   * Bypass-audit logger (MW2). Invoked once per write that bypassed a
   * `strict:true` field constraint, with the would-be violations + attribution.
   * The server layer passes `logStrictBypass`; core stays log-sink-agnostic.
   * Omitted → bypassed writes still happen (the migration must), just unlogged.
   */
  onStrictBypass?: (info: {
    actor: string | null;
    via: string | null;
    path?: string | null;
    tags?: string[];
    violations: ValidationWarning[];
  }) => void;
}

/** A single planned/applied note change. */
export interface MigrateChange {
  id: string;
  path: string | null;
  /** The value of the field before the transform (the original key for rename). */
  before: unknown;
  /** The value written (under `field`, or under the new key for rename). */
  after: unknown;
  /** Set for rename: the new key the value moved to. */
  renamedTo?: string;
}

/** A note that couldn't be transformed (unconvertible retype). */
export interface MigrateErroredNote {
  id: string;
  path: string | null;
  before: unknown;
  error: string;
}

export interface MigrateTagFieldResult {
  tag: string;
  field: string;
  transform: FieldTransform;
  /** True when this run wrote to the vault; false for a dry-run. */
  applied: boolean;
  /** Notes carrying the tag that were scanned. */
  scanned: number;
  /** Notes that would change (dry-run) or did change (apply). */
  changed: number;
  /** Notes left untouched (already conformant / field absent / value not in map). */
  unchanged: number;
  /** Notes whose transform failed (unconvertible). */
  errored: number;
  /** A bounded preview of the changes (up to `sampleSize`). */
  sample: MigrateChange[];
  /** Every errored note (not bounded — the operator needs the full list to fix data). */
  errors: MigrateErroredNote[];
}

/**
 * Run a tag-field migration. Dry-run by default; `apply: true` writes.
 *
 * The flow is preflight-then-write:
 *   1. Query every note carrying `tag`.
 *   2. For each, compute the transform result. Collect changes + errors.
 *   3. If NOT `apply` → return the plan (nothing written).
 *   4. If `apply` and there are errors and NOT `continueOnError` → return the
 *      plan WITHOUT writing (atomic abort — the operator fixes the data first).
 *   5. Otherwise write each change via `store.updateNote`, running
 *      `enforceStrictWrite(bypass:true)` first so a `strict` violation logs
 *      rather than blocks.
 */
export async function migrateTagField(
  store: Store,
  opts: MigrateTagFieldOpts,
): Promise<MigrateTagFieldResult> {
  const { tag, field, transform } = opts;
  const sampleSize = opts.sampleSize ?? 10;
  const actor = opts.actor ?? "migrate";
  const via = opts.via ?? "migrate";

  // Validate the transform shape up front so a bad arg fails before any scan.
  validateTransform(field, transform);

  // A validator the `set_default { onlyInvalid }` path uses to decide whether
  // a present value is "invalid" — driven by the tag's resolved schema for the
  // field (enum / type), so `onlyInvalid` means "the current value violates the
  // declared schema." Absent schema → never invalid (so onlyInvalid is a no-op,
  // which is the safe reading: with nothing to validate against, don't clobber).
  // Only built for the transform that uses it; other transforms never call it.
  const isValid =
    transform.kind === "set_default" && transform.onlyInvalid
      ? makeFieldValidator(store, tag, field)
      : undefined;

  const notes = await collectTaggedNotes(store, tag);

  const changes: MigrateChange[] = [];
  const errors: MigrateErroredNote[] = [];
  // Parallel list of (note, result) for the write phase — keeps the transform
  // pass and the write pass from diverging on which notes change.
  const pending: { note: Note; result: TransformResult }[] = [];

  for (const note of notes) {
    const meta = (note.metadata ?? {}) as Record<string, unknown>;
    const present = Object.prototype.hasOwnProperty.call(meta, field);
    const current = present ? meta[field] : undefined;
    let result: TransformResult | null;
    try {
      result = applyTransform(field, current, present, transform, isValid);
    } catch (err) {
      errors.push({
        id: note.id,
        path: note.path ?? null,
        before: current,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (result === null) continue; // unchanged
    pending.push({ note, result });
    if (changes.length < sampleSize) {
      changes.push({
        id: note.id,
        path: note.path ?? null,
        before: current,
        after: result.value,
        ...(result.dropField ? { renamedTo: result.setField } : {}),
      });
    }
  }

  const baseResult = {
    tag,
    field,
    transform,
    scanned: notes.length,
    changed: pending.length,
    unchanged: notes.length - pending.length - errors.length,
    errored: errors.length,
    sample: changes,
    errors,
  };

  // Dry-run, or an atomic abort because the preflight found errors.
  if (!opts.apply) {
    return { ...baseResult, applied: false };
  }
  if (errors.length > 0 && !opts.continueOnError) {
    // Atomic: refuse to write any note when some can't be converted, so the
    // migration is all-or-nothing. The caller sees the full error list.
    return { ...baseResult, applied: false };
  }

  // Write phase.
  for (const { note, result } of pending) {
    const nextMeta: Record<string, unknown> = { ...(note.metadata ?? {}) };
    nextMeta[result.setField] = result.value;
    if (result.dropField && result.dropField !== result.setField) {
      delete nextMeta[result.dropField];
    }

    // Run strict enforcement with bypass ON (MW2) through the SAME gate the
    // MCP/REST write transports use, so the migration can't drift from the
    // canonical enforcement contract (e.g. when audit-log #300 lands and
    // `onBypass` grows a DB write). The migration must write THROUGH a
    // `strict:true` field the back-catalog violates — bypass skips the throw,
    // and `onBypass` logs the waived violations with attribution for audit.
    enforceStrictWrite(
      store,
      { path: note.path, tags: note.tags, metadata: nextMeta },
      {
        bypass: true,
        onBypass: opts.onStrictBypass
          ? (violations) =>
              opts.onStrictBypass!({
                actor,
                via,
                path: note.path ?? null,
                tags: note.tags,
                violations,
              })
          : undefined,
      },
    );

    await store.updateNote(note.id, { metadata: nextMeta, actor, via });
  }

  return { ...baseResult, applied: true };
}

/**
 * Make a predicate "does this value satisfy the tag's declared schema for
 * `field`?" from the live schema config. Used by `set_default { onlyInvalid }`.
 * When no schema declares the field, every value is "valid" (no constraint to
 * fail), so `onlyInvalid` won't overwrite anything — the conservative choice.
 */
function makeFieldValidator(
  store: Store,
  tag: string,
  field: string,
): (v: unknown) => boolean {
  return (v: unknown): boolean => {
    // Build a synthetic single-field note and ask the resolver whether THIS
    // field has a strict-or-advisory violation. Any violation on the field →
    // invalid.
    const status = store.validateNoteAgainstSchemas({
      tags: [tag],
      metadata: { [field]: v },
    });
    if (!status) return true;
    return !status.warnings.some(
      (w) => w.field === field && w.reason !== "schema_conflict" && w.reason !== "missing_required",
    );
  };
}

/** Pull every note carrying `tag` (hierarchy-expanded by the store). */
async function collectTaggedNotes(store: Store, tag: string): Promise<Note[]> {
  // The migration must see EVERY tagged note, not a default page. Use a large
  // limit — the same approach `syncAllWikilinks` takes for a whole-vault sweep.
  return store.queryNotes({ tags: [tag], limit: 1_000_000 });
}

// ---------------------------------------------------------------------------
// CLI transform-spec parsing
// ---------------------------------------------------------------------------

/**
 * Parse a CLI `--transform <spec>` string into a `FieldTransform`. The built-in
 * spec grammar (issue #314 — "just a built-in set", no expression language):
 *
 *   rename:<newkey>            → { kind: "rename", to }
 *   remap:<old>=<new>[,...]    → { kind: "remap", map }
 *   set-default:<value>        → { kind: "set_default", value }   (value JSON-parsed, else string)
 *   set-default-invalid:<v>    → { kind: "set_default", value, onlyInvalid: true }
 *   to_string|to_int|to_number|to_boolean → the matching retype
 *
 * `remap` values and `set-default` values are parsed as JSON when they parse
 * (so `set-default:0`, `set-default:true`, `remap:a=1`), falling back to the
 * literal string otherwise (so `set-default:draft`, `remap:wip=published`).
 *
 * Throws `TransformError` on an unrecognized or malformed spec.
 */
export function parseTransformSpec(spec: string): FieldTransform {
  const trimmed = spec.trim();

  if (trimmed === "to_string") return { kind: "to_string" };
  if (trimmed === "to_int") return { kind: "to_int" };
  if (trimmed === "to_number") return { kind: "to_number" };
  if (trimmed === "to_boolean") return { kind: "to_boolean" };

  const colon = trimmed.indexOf(":");
  if (colon === -1) {
    throw new TransformError(
      `unrecognized transform "${spec}" (expected one of: rename:<key>, remap:<old>=<new>, set-default:<value>, set-default-invalid:<value>, to_string, to_int, to_number, to_boolean)`,
    );
  }
  const head = trimmed.slice(0, colon);
  const rest = trimmed.slice(colon + 1);

  switch (head) {
    case "rename": {
      if (!rest) throw new TransformError("rename: missing new key — use rename:<newkey>");
      return { kind: "rename", to: rest };
    }
    case "remap": {
      if (!rest) throw new TransformError("remap: missing pairs — use remap:<old>=<new>[,<old>=<new>]");
      const map: Record<string, unknown> = {};
      for (const pair of rest.split(",")) {
        const eq = pair.indexOf("=");
        if (eq === -1) {
          throw new TransformError(`remap: "${pair}" is not an <old>=<new> pair`);
        }
        const oldVal = pair.slice(0, eq);
        const newVal = pair.slice(eq + 1);
        if (!oldVal) throw new TransformError(`remap: empty <old> in "${pair}"`);
        map[oldVal] = parseScalar(newVal);
      }
      return { kind: "remap", map };
    }
    case "set-default": {
      return { kind: "set_default", value: parseScalar(rest) };
    }
    case "set-default-invalid": {
      return { kind: "set_default", value: parseScalar(rest), onlyInvalid: true };
    }
    default:
      throw new TransformError(`unknown transform "${head}" in "${spec}"`);
  }
}

/** Parse a CLI scalar: JSON when it parses to a scalar, else the literal string. */
function parseScalar(raw: string): unknown {
  if (raw === "") return "";
  try {
    const parsed = JSON.parse(raw);
    // Only accept JSON scalars (string/number/boolean/null) — an unquoted word
    // like `draft` throws and falls through to the literal-string branch.
    if (
      parsed === null ||
      typeof parsed === "string" ||
      typeof parsed === "number" ||
      typeof parsed === "boolean"
    ) {
      return parsed;
    }
  } catch {
    /* not JSON — treat as a literal string */
  }
  return raw;
}

/** Reject a structurally-invalid transform before any DB work. */
function validateTransform(field: string, transform: FieldTransform): void {
  switch (transform.kind) {
    case "rename":
      if (typeof transform.to !== "string" || transform.to.length === 0) {
        throw new TransformError("rename: `to` (new field name) is required");
      }
      break;
    case "remap":
      if (!transform.map || typeof transform.map !== "object" || Array.isArray(transform.map)) {
        throw new TransformError("remap: `map` (value→value object) is required");
      }
      break;
    case "set_default":
      if (!("value" in transform)) {
        throw new TransformError("set_default: `value` is required");
      }
      break;
    case "to_string":
    case "to_int":
    case "to_number":
    case "to_boolean":
      break;
    default:
      throw new TransformError(`unknown transform: ${(transform as { kind: string }).kind}`);
  }
}
