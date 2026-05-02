/**
 * Metadata operator objects for `query-notes`.
 *
 * A metadata value that is a plain object whose keys are all drawn from
 * {@link SUPPORTED_OPS} is treated as an operator query. Otherwise the value
 * falls through to the existing exact-match behavior (primitive → JSON
 * stringify compare).
 *
 * Operator queries route through the generated columns maintained by
 * `indexed-fields`: `meta_<field>` on `notes`, backed by a B-tree index. The
 * field must be declared `indexed: true` in some tag schema; otherwise we
 * refuse with an actionable error (no silent fallback to a JSON scan, per the
 * decision doc).
 *
 * See `Parachute/Decisions/2026-04-19-metadata-indexing-via-tag-schemas`.
 */

import { Database, type SQLQueryBindings } from "bun:sqlite";
import { getIndexedField, type IndexedField } from "./indexed-fields.js";

export const SUPPORTED_OPS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "not_in",
  "exists",
] as const;

export type QueryOp = (typeof SUPPORTED_OPS)[number];

const OPS_SET: ReadonlySet<string> = new Set<string>(SUPPORTED_OPS);

export class QueryError extends Error {
  override name = "QueryError";
  code: string;
  constructor(message: string, code = "INVALID_QUERY") {
    super(message);
    this.code = code;
  }
}

/**
 * Returns true when `value` is a non-array, non-null, non-empty plain object.
 * The presence of *any* plain-object value commits the caller to operator-
 * parsing: a misspelled operator like `{ bogus: 5 }` is a loud error rather
 * than a silent fallback to JSON-blob exact-match. Nested-object exact-match
 * on the JSON blob was never a meaningful use case.
 */
export function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return Object.keys(value as object).length > 0;
}

function validateOperatorObject(field: string, obj: Record<string, unknown>): void {
  for (const key of Object.keys(obj)) {
    if (!OPS_SET.has(key)) {
      throw new QueryError(
        `unknown operator "${key}" on metadata field "${field}". Supported: ${SUPPORTED_OPS.join(", ")}.`,
        "UNKNOWN_OPERATOR",
      );
    }
  }
}

function toBinding(field: string, op: string, value: unknown): SQLQueryBindings {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  throw new QueryError(
    `operator "${op}" on metadata field "${field}" expects a primitive value (string, number, boolean, bigint, or null), got ${typeof value}`,
    "INVALID_OPERATOR_VALUE",
  );
}

/**
 * Look up `field` in `indexed_fields` or throw a loud error suggesting the
 * caller declare it via `update-tag` with `indexed: true`.
 */
export function requireIndexedField(db: Database, field: string): IndexedField {
  const row = getIndexedField(db, field);
  if (!row) {
    throw new QueryError(
      `metadata field "${field}" is not indexed. To use operator queries or order_by on this field, declare it via update-tag with indexed: true.`,
      "FIELD_NOT_INDEXED",
    );
  }
  return row;
}

/**
 * Build a SQL fragment + bound params for an operator object on an indexed
 * metadata field. Each operator maps to a single AND clause; an object like
 * `{ gt: 5, lt: 10 }` composes as `meta_<field> > 5 AND meta_<field> < 10`.
 */
export function buildOperatorClause(
  field: string,
  opObj: Record<string, unknown>,
): { sql: string; params: SQLQueryBindings[] } {
  validateOperatorObject(field, opObj);
  // `field` came from indexed_fields (which validated it via FIELD_NAME_RE
  // when the declaration was recorded), so interpolating it into the column
  // name is safe.
  const col = `"meta_${field}"`;
  const parts: string[] = [];
  const params: SQLQueryBindings[] = [];

  for (const [op, value] of Object.entries(opObj)) {
    switch (op as QueryOp) {
      case "eq":
        if (value === null) {
          parts.push(`${col} IS NULL`);
        } else {
          parts.push(`${col} = ?`);
          params.push(toBinding(field, op, value));
        }
        break;
      case "ne":
        if (value === null) {
          parts.push(`${col} IS NOT NULL`);
        } else {
          // Preserve "field is set AND not equal" semantics — SQLite's `<>`
          // returns NULL (not true) when the LHS is NULL, so a notes row
          // that has no value for the field would be silently excluded. Be
          // explicit: either the column is null, or the values differ.
          parts.push(`(${col} IS NULL OR ${col} <> ?)`);
          params.push(toBinding(field, op, value));
        }
        break;
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const sym = op === "gt" ? ">" : op === "gte" ? ">=" : op === "lt" ? "<" : "<=";
        parts.push(`${col} ${sym} ?`);
        params.push(toBinding(field, op, value));
        break;
      }
      case "in":
      case "not_in": {
        if (!Array.isArray(value)) {
          throw new QueryError(
            `operator "${op}" on metadata field "${field}" expects an array`,
            "INVALID_OPERATOR_VALUE",
          );
        }
        if (value.length === 0) {
          // Empty IN is a contradiction; empty NOT IN is a no-op. Emit SQL
          // that matches these semantics without running a parameterless
          // `IN ()` (which is a syntax error in SQLite).
          parts.push(op === "in" ? "0" : "1");
          break;
        }
        const placeholders = value.map(() => "?").join(", ");
        if (op === "in") {
          parts.push(`${col} IN (${placeholders})`);
        } else {
          parts.push(`(${col} IS NULL OR ${col} NOT IN (${placeholders}))`);
        }
        for (const v of value) params.push(toBinding(field, op, v));
        break;
      }
      case "exists":
        if (typeof value !== "boolean") {
          throw new QueryError(
            `operator "exists" on metadata field "${field}" expects a boolean`,
            "INVALID_OPERATOR_VALUE",
          );
        }
        parts.push(value ? `${col} IS NOT NULL` : `${col} IS NULL`);
        break;
    }
  }

  return {
    sql: parts.length === 1 ? parts[0]! : `(${parts.join(" AND ")})`,
    params,
  };
}
