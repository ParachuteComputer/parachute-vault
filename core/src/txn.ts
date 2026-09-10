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
 *
 * **Shared-connection invariant (load-bearing for {@link transactionAsync}).**
 * The bun backend is a single synchronous connection. A `transactionAsync`
 * body — AND anything it calls — must not `await` genuine, slow I/O while the
 * transaction is open: every `await` yields the event loop, and any work that
 * runs during that yield and touches the store (a concurrent request, a
 * mutation hook that writes before its first real await) will `SAVEPOINT`-JOIN
 * this open transaction on the shared connection — committing/rolling back
 * with it, its writes cross-wiped by a `ROLLBACK TO`. The blow-away import
 * (the sole `transactionAsync` wrapping non-batch work) is safe by
 * construction: its replay awaits only already-resolved promises over the
 * synchronous bun store, so it never actually yields to unrelated work
 * mid-transaction, and the mutation hooks it fires do no synchronous store
 * writes (they defer via `queueMicrotask` and arm debounces / kick idempotent
 * workers — see hooks.ts). Any NEW `transactionAsync` caller must preserve
 * this: keep the body's awaits confined to the same synchronous connection,
 * never awaiting network/disk/subprocess I/O with the transaction open.
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

/**
 * Post-commit callbacks, stacked per transaction frame. A nested transaction
 * merges its callbacks into its parent when its SAVEPOINT is released; only
 * the outermost successful commit runs them. A rollback discards the frame.
 */
const afterCommitFrames = new WeakMap<TxnCapableDb, Array<Array<() => void>>>();

function enterAfterCommitFrame(db: TxnCapableDb): void {
  const frames = afterCommitFrames.get(db) ?? [];
  frames.push([]);
  afterCommitFrames.set(db, frames);
}

function commitAfterCommitFrame(db: TxnCapableDb): void {
  const frames = afterCommitFrames.get(db);
  const callbacks = frames?.pop() ?? [];
  const parent = frames?.at(-1);
  if (parent) {
    parent.push(...callbacks);
    return;
  }
  afterCommitFrames.delete(db);
  for (const callback of callbacks) callback();
}

function rollbackAfterCommitFrame(db: TxnCapableDb): void {
  const frames = afterCommitFrames.get(db);
  frames?.pop();
  if (!frames || frames.length === 0) afterCommitFrames.delete(db);
}

/**
 * Run a callback only after the surrounding transaction stack commits. When
 * called outside a transaction it runs immediately. This keeps hooks and
 * cache invalidation honest for synchronous store writes nested inside an
 * outer {@link transactionAsync} batch.
 */
export function afterCommit(db: TxnCapableDb, callback: () => void): void {
  const frame = afterCommitFrames.get(db)?.at(-1);
  if (frame) frame.push(callback);
  else callback();
}

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
  } catch (rollbackErr) {
    // Only swallow the ONE expected case: the COMMIT/RELEASE itself already
    // resolved the transaction, so there's nothing left to unwind — SQLite
    // reports "cannot rollback - no transaction is active" / "no such
    // savepoint". Any OTHER rollback failure is a real problem (a corrupt
    // connection, a lost write lock) and must not be masked — re-throw it so
    // the caller sees a failed rollback rather than a false success. Depth is
    // restored first so the connection's bookkeeping stays consistent even on
    // the re-throw path.
    txnDepth.set(db, frame.priorDepth);
    const msg = String((rollbackErr as Error)?.message ?? rollbackErr);
    if (/no transaction is active|no such savepoint/i.test(msg)) return;
    throw rollbackErr;
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
  enterAfterCommitFrame(db);
  if (typeof db.transactionSync === "function") {
    let result: T;
    try {
      result = db.transactionSync(fn);
    } catch (err) {
      rollbackAfterCommitFrame(db);
      throw err;
    }
    commitAfterCommitFrame(db);
    return result;
  }
  let frame: TxnFrame;
  try {
    frame = enterTxn(db);
  } catch (err) {
    rollbackAfterCommitFrame(db);
    throw err;
  }
  let result: T;
  try {
    result = fn();
    commitTxn(db, frame);
  } catch (err) {
    rollbackAfterCommitFrame(db);
    rollbackTxn(db, frame);
    throw err;
  }
  // The SQL transaction is already resolved. A callback error must propagate
  // without attempting a misleading ROLLBACK after COMMIT.
  commitAfterCommitFrame(db);
  return result;
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
  enterAfterCommitFrame(db);
  let frame: TxnFrame;
  try {
    frame = enterTxn(db);
  } catch (err) {
    rollbackAfterCommitFrame(db);
    throw err;
  }
  let result: T;
  try {
    result = await fn();
    commitTxn(db, frame);
  } catch (err) {
    rollbackAfterCommitFrame(db);
    rollbackTxn(db, frame);
    throw err;
  }
  commitAfterCommitFrame(db);
  return result;
}
