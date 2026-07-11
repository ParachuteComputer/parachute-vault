/**
 * The transaction seam (Phase-1 shared-core refactor, vault cloud design §4).
 *
 * Core code must never emit raw `BEGIN`/`COMMIT`/`ROLLBACK` — that's the one
 * SQLite construct DO's `sql.exec` blocks, so it can't be shimmed like the
 * rest of the `Database` surface. Instead every atomic block routes through
 * `transaction` / `transactionAsync` here. The bun backend implements them
 * as `BEGIN IMMEDIATE … COMMIT` with rollback-on-throw; a future Durable-
 * Object backend implements the same contract with `ctx.storage.transactionSync`
 * (and `Store.transaction`, see types.ts, is the object-level entry point).
 *
 * `BEGIN IMMEDIATE` (write lock up front) matches the pre-seam behavior of
 * the 13 core blocks this replaced — several used a bare `BEGIN`, but every
 * one of them only ever wrote, so acquiring the write lock eagerly is a
 * strict improvement (no lazy busy-upgrade) and never a semantic change.
 *
 * **Nesting via SAVEPOINTs** (vault#589): the outermost `transaction` /
 * `transactionAsync` on a connection opens a real `BEGIN IMMEDIATE`; a nested
 * call (one whose connection is already inside a transaction) opens a
 * `SAVEPOINT` instead, so composing an atomic block out of primitives that
 * each open their own transaction never hits SQLite's "cannot start a
 * transaction within a transaction". This is the re-entrancy the original
 * seam anticipated ("the fix is SAVEPOINT-based re-entrancy in the bun
 * implementation here — the call sites stay untouched"). The nesting depth is
 * tracked per connection in {@link txnDepth}; a non-nested caller (depth 0 →
 * 1) is byte-for-byte the old `BEGIN … COMMIT` / `ROLLBACK` path, so existing
 * single-level callers are unaffected. The motivating nested caller is the
 * atomic blow-away import (`importVault` wrapping schema/note/link writes,
 * several of which open their own `transaction`).
 *
 * The `transactionSync` (Durable-Object) delegate path is unchanged — a DO
 * backend supplies its own natively re-entrant primitive, so the SAVEPOINT
 * bookkeeping here only governs the bun `BEGIN` path.
 */

/** The minimal DB surface the transaction seam needs — kept structural (no
 *  `bun:sqlite` import) so a non-bun backend satisfies it too.
 *
 *  `transactionSync` is OPTIONAL: a backend whose engine blocks explicit
 *  `BEGIN`/`COMMIT` (Cloudflare Durable Objects — `sql.exec` throws on them)
 *  exposes a native synchronous transaction primitive instead, and
 *  {@link transaction} delegates to it. bun's `Database` has no such method, so
 *  it takes the `BEGIN IMMEDIATE` path — the check is a duck-type, never a
 *  behavior change for the bun backend. */
export interface TxnCapableDb {
  exec(sql: string): void;
  /** Native commit-on-return / rollback-on-throw transaction, when the backend
   *  provides one (e.g. a DO shim delegating to `ctx.storage.transactionSync`). */
  transactionSync?<T>(fn: () => T): T;
}

/**
 * Per-connection nesting depth for the bun `BEGIN` path. Keyed on the db
 * handle so two connections track independently; a `WeakMap` so a dropped
 * connection's entry is collected. Depth 0 = no open transaction; the first
 * `transaction`/`transactionAsync` opens `BEGIN IMMEDIATE` and sets depth 1;
 * each further nested call opens a `SAVEPOINT` and bumps the depth. See the
 * file header (vault#589).
 */
const txnDepth = new WeakMap<TxnCapableDb, number>();

/** One entry on the nesting stack: whether this frame owns the outer
 *  `BEGIN … COMMIT`/`ROLLBACK` (outermost) or a `SAVEPOINT` (nested), plus the
 *  depth to restore on exit. */
interface TxnFrame {
  outermost: boolean;
  savepoint: string | null;
  priorDepth: number;
}

/** Open a transaction frame: `BEGIN IMMEDIATE` at depth 0, else a uniquely
 *  named `SAVEPOINT`. Bumps {@link txnDepth} only after the SQL succeeds. */
function enterTxn(db: TxnCapableDb): TxnFrame {
  const priorDepth = txnDepth.get(db) ?? 0;
  if (priorDepth === 0) {
    db.exec("BEGIN IMMEDIATE");
    txnDepth.set(db, 1);
    return { outermost: true, savepoint: null, priorDepth };
  }
  const savepoint = `parachute_sp_${priorDepth}`;
  db.exec(`SAVEPOINT ${savepoint}`);
  txnDepth.set(db, priorDepth + 1);
  return { outermost: false, savepoint, priorDepth };
}

/** Commit a frame: `COMMIT` for the outermost, `RELEASE` for a savepoint
 *  (which merges its writes into the enclosing transaction). */
function commitTxn(db: TxnCapableDb, frame: TxnFrame): void {
  if (frame.outermost) db.exec("COMMIT");
  else db.exec(`RELEASE ${frame.savepoint}`);
  txnDepth.set(db, frame.priorDepth);
}

/** Roll a frame back: `ROLLBACK` for the outermost (whole transaction),
 *  `ROLLBACK TO` + `RELEASE` for a savepoint (unwind just this frame; the
 *  error still propagates so an enclosing frame decides its own fate).
 *  Best-effort — if the COMMIT itself threw, the transaction is already
 *  resolved and these throw "no transaction"/"no such savepoint"; swallow so
 *  the original error propagates. */
function rollbackTxn(db: TxnCapableDb, frame: TxnFrame): void {
  try {
    if (frame.outermost) {
      db.exec("ROLLBACK");
    } else {
      db.exec(`ROLLBACK TO ${frame.savepoint}`);
      db.exec(`RELEASE ${frame.savepoint}`);
    }
  } catch {
    // nothing to unwind — the transaction was already resolved
  }
  txnDepth.set(db, frame.priorDepth);
}

/**
 * Run `fn` inside a single write transaction, committing its result or
 * rolling back on throw. Synchronous — the callback must not await (see
 * `transactionAsync` for the batch paths that legitimately await the async
 * Store facade).
 *
 * When the backing db exposes a native `transactionSync` (a backend whose
 * engine blocks raw `BEGIN`/`COMMIT` — Durable Objects), we delegate to it: a
 * real transaction with the same commit-on-return / rollback-on-throw contract,
 * without ever issuing the explicit transaction SQL that backend rejects. bun's
 * `Database` has no `transactionSync`, so it takes the `BEGIN IMMEDIATE` path
 * below unchanged.
 */
export function transaction<T>(db: TxnCapableDb, fn: () => T): T {
  if (typeof db.transactionSync === "function") {
    return db.transactionSync(fn);
  }
  const frame = enterTxn(db);
  try {
    const result = fn();
    commitTxn(db, frame);
    return result;
  } catch (err) {
    rollbackTxn(db, frame);
    throw err;
  }
}

/**
 * Async sibling of {@link transaction} for the batch executors, which run
 * their body through the async `Store` facade (`await store.createNote(...)`
 * etc.). The transaction spans the awaits on the shared connection — the
 * same shape as the pre-seam `if (batched) db.exec("BEGIN")` blocks in
 * mcp.ts / routes.ts. A DO backend can't map this onto `transactionSync`
 * (which forbids awaiting); porting the batch path is a Phase-2 concern.
 *
 * Deliberately NOT given the `db.transactionSync` fast-path that {@link transaction}
 * has: `transactionSync` runs its callback synchronously and forbids awaiting,
 * so it cannot wrap an `async` body that awaits the Store facade between writes.
 * A DO backend that needs an atomic async batch has to reshape the batch as a
 * synchronous unit (or use an async DO transaction primitive) — out of scope
 * for this seam; the bun `BEGIN IMMEDIATE` path stays the single implementation.
 *
 * Re-entrant (vault#589): if the connection is already inside a transaction —
 * e.g. the atomic blow-away import wraps this around store writes that
 * themselves call {@link transaction} — a nested call opens a SAVEPOINT rather
 * than a second `BEGIN`. See the file header.
 */
export async function transactionAsync<T>(db: TxnCapableDb, fn: () => Promise<T>): Promise<T> {
  const frame = enterTxn(db);
  try {
    const result = await fn();
    commitTxn(db, frame);
    return result;
  } catch (err) {
    rollbackTxn(db, frame);
    throw err;
  }
}
