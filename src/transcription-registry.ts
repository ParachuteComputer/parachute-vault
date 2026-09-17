/**
 * Process-singleton holder for the active TranscriptionWorker (vault#353).
 *
 * The server registers its selected local or remote worker at boot after
 * wiring the attachment hook. Retry endpoints use the worker to kick jobs;
 * automatic-upload eligibility also checks the startup provider identity.
 */

import type { TranscriptionWorker } from "./transcription-worker.ts";

let activeWorker: TranscriptionWorker | null = null;
let activeProvider: string | null = null;

export function setTranscriptionWorker(worker: TranscriptionWorker | null, provider: string | null = null): void {
  activeWorker = worker;
  activeProvider = worker ? provider : null;
}

/** Provider bound at worker startup, not a newly edited environment value. */
export function getTranscriptionWorkerProvider(): string | null { return activeProvider; }

export function getTranscriptionWorker(): TranscriptionWorker | null {
  return activeWorker;
}
