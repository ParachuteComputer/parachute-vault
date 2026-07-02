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
 *  `bun:sqlite` import) so a non-bun backend satisfies it too. */
export interface TxnCapableDb {
  exec(sql: string): void;
}

/**
 * Run `fn` inside a single write transaction, committing its result or
 * rolling back on throw. Synchronous — the callback must not await (DO's
 * `transactionSync` is sync-only; see `transactionAsync` for the batch paths
 * that legitimately await the async Store facade).
 */
export function transaction<T>(db: TxnCapableDb, fn: () => T): T {
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
