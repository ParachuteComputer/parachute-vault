/**
 * In-process job registry for git imports (vault#640).
 *
 * **Why this exists.** `POST /vault/<name>/.parachute/mirror/import` used to
 * run the whole clone-and-import inside the request and return the result.
 * That shape has a hard ceiling that has nothing to do with how long the work
 * legitimately takes:
 *
 *   - hub proxies the vault behind `Bun.serve({ idleTimeout: 255 })`, so any
 *     import past ~4 minutes dies in the proxy no matter what vault does;
 *   - browsers and intermediate proxies impose their own limits;
 *   - a dropped connection lost the import's outcome entirely, even when the
 *     import itself had succeeded.
 *
 * So the old handler papered over it with a 60s clone timeout and a docstring
 * promising "if/when bigger vaults arrive we promote to async polling." They
 * arrived. This is that promotion.
 *
 * **Shape.** POST starts a job and returns `202 { job_id }` immediately. The
 * work continues on the server independent of the request that started it.
 * `GET .../mirror/import/<job_id>` returns the current record; the SPA polls
 * it for stage + progress and renders the terminal state.
 *
 * **Deliberately in-memory.** Jobs do not survive a vault restart, and that's
 * the honest design rather than a shortcut: the work itself can't survive a
 * restart either (the clone lives in a tempdir, the importer holds an open
 * store handle), so a persisted "running" row would only ever resurrect as a
 * lie. A restart mid-import surfaces as `job_not_found`, which the SPA reads
 * as "the server restarted — check your vault and retry." Whatever the
 * importer had already committed is committed; merge mode makes a retry safe.
 *
 * **Concurrency.** One running import per vault, enforced here so the 409
 * lands before a tempdir is created. `cloneAndImport` keeps its own inFlight
 * guard as the inner belt for direct (CLI / test) callers.
 */

import type {
  ImportProgress,
  ImportResult,
  ImportStage,
} from "./mirror-import.ts";

/** How long a finished job stays queryable before GC. */
export const FINISHED_JOB_TTL_MS = 60 * 60_000;

/** Terminal + non-terminal job states. */
export type ImportJobStatus = "running" | "succeeded" | "failed";

/**
 * Error detail for a failed job. Mirrors the `error_type` vocabulary the
 * synchronous handler used to return, so the SPA's error branching is
 * unchanged — it just reads them off the job record instead of the POST
 * response.
 */
export interface ImportJobError {
  error_type:
    | "git_not_installed"
    | "concurrent_import"
    | "not_a_vault_export"
    | "clone_failed"
    | "internal";
  message: string;
}

/** The record the status endpoint serves. */
export interface ImportJob {
  job_id: string;
  vault_name: string;
  status: ImportJobStatus;
  stage: ImportStage;
  /** Latest progress line for the current stage, when there is one. */
  detail?: string;
  started_at: string;
  updated_at: string;
  finished_at?: string;
  /** Present iff `status === "succeeded"`. */
  result?: ImportResult;
  /** Present iff `status === "failed"`. */
  error?: ImportJobError;
}

/** Thrown by `startImportJob` when this vault already has one running. */
export class ImportJobConflictError extends Error {
  constructor(public readonly vaultName: string) {
    super(
      `An import is already running for vault "${vaultName}". Wait for it to finish, or reload to watch its progress.`,
    );
    this.name = "ImportJobConflictError";
  }
}

/** job_id → record. */
const jobs = new Map<string, ImportJob>();
/** vault name → job_id of the RUNNING job, if any. */
const running = new Map<string, string>();

/**
 * Drop finished jobs past their TTL. Called opportunistically on every
 * create/read rather than on a timer — a timer would keep the event loop
 * alive and there is no correctness need for prompt collection.
 */
function gc(now: number): void {
  for (const [id, job] of jobs) {
    if (job.status === "running") continue;
    const finished = job.finished_at ? Date.parse(job.finished_at) : 0;
    if (Number.isFinite(finished) && now - finished > FINISHED_JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
}

/** The running job for a vault, or undefined. */
export function getRunningImportJob(vaultName: string): ImportJob | undefined {
  const id = running.get(vaultName);
  return id ? jobs.get(id) : undefined;
}

/**
 * Look up a job by id, scoped to a vault. The vault scope matters: the route
 * is authorized against `vault:<name>:admin`, so an admin of vault A must not
 * be able to read vault B's import record by guessing an id.
 */
export function getImportJob(
  vaultName: string,
  jobId: string,
): ImportJob | undefined {
  gc(Date.now());
  const job = jobs.get(jobId);
  if (!job || job.vault_name !== vaultName) return undefined;
  return job;
}

/**
 * Register a job and start `work` on it. Returns the initial record
 * synchronously so the route can 202 immediately; `work` runs detached.
 *
 * `work` receives a progress sink to call as it moves through stages. Its
 * resolved value becomes `result`; a throw becomes `error` via `classify`.
 */
export function startImportJob(
  vaultName: string,
  work: (onProgress: (update: ImportProgress) => void) => Promise<ImportResult>,
  classify: (err: unknown) => ImportJobError,
): ImportJob {
  const now = Date.now();
  gc(now);
  if (running.has(vaultName)) {
    throw new ImportJobConflictError(vaultName);
  }

  const nowIso = new Date(now).toISOString();
  const job: ImportJob = {
    job_id: crypto.randomUUID(),
    vault_name: vaultName,
    status: "running",
    stage: "cloning",
    started_at: nowIso,
    updated_at: nowIso,
  };
  jobs.set(job.job_id, job);
  running.set(vaultName, job.job_id);

  const onProgress = (update: ImportProgress) => {
    // A tick that arrives after the job finished (a late stderr line racing
    // the exit) must not resurrect a terminal record.
    if (job.status !== "running") return;
    job.stage = update.stage;
    if (update.detail !== undefined) job.detail = update.detail;
    else delete job.detail;
    job.updated_at = new Date().toISOString();
  };

  const finish = (patch: Partial<ImportJob>) => {
    Object.assign(job, patch);
    job.finished_at = new Date().toISOString();
    job.updated_at = job.finished_at;
    delete job.detail;
    running.delete(vaultName);
  };

  // Detached on purpose — the response has already been sent by the time this
  // settles. Every rejection path is funnelled through `classify` so an
  // unexpected throw becomes a readable job error rather than an unhandled
  // rejection that leaves the job "running" forever.
  void work(onProgress).then(
    (result) => finish({ status: "succeeded", result }),
    (err) => finish({ status: "failed", error: classify(err) }),
  );

  return job;
}

/** Test seam: forget every job. */
export function _resetImportJobsForTest(): void {
  jobs.clear();
  running.clear();
}
