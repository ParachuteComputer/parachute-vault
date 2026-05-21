/**
 * Process-singleton holder for the active TranscriptionWorker (vault#353).
 *
 * Mirrors `mirror-registry.ts`: `server.ts` constructs the worker on boot
 * (when scribe is discoverable), and the REST retry endpoint
 * (`/api/notes/:id/retry-transcription`) picks it up here to call `kick()`
 * for an event-driven re-run. Absent the worker (no scribe), the retry
 * endpoint still flips the attachment back to `pending` so the sweep would
 * pick it up — but it'll just sit there until scribe shows up.
 */

import type { TranscriptionWorker } from "./transcription-worker.ts";

let activeWorker: TranscriptionWorker | null = null;

export function setTranscriptionWorker(worker: TranscriptionWorker | null): void {
  activeWorker = worker;
}

export function getTranscriptionWorker(): TranscriptionWorker | null {
  return activeWorker;
}
