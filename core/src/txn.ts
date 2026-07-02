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
 * **Nesting is unsupported**, matching the pre-seam code exactly: SQLite
 * throws "cannot start a transaction within a transaction" on a nested
 * `BEGIN`, and none of the migrated call sites nest (a batch wraps individual
 * `createNote`s, none of which open their own transaction). If a nested
 * caller ever appears, the fix is SAVEPOINT-based re-entrancy *in the bun
 * implementation here* — the call sites stay untouched.
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
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    // Best-effort rollback — if the COMMIT itself threw the transaction is
    // already resolved and ROLLBACK would throw "no transaction is active";
    // swallow that so the original error is the one that propagates.
    try {
      db.exec("ROLLBACK");
    } catch {
      // no active transaction to roll back
    }
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
 * for this seam; the raw `BEGIN IMMEDIATE` path stays the single implementation.
 */
export async function transactionAsync<T>(db: TxnCapableDb, fn: () => Promise<T>): Promise<T> {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = await fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // no active transaction to roll back
    }
    throw err;
  }
}
