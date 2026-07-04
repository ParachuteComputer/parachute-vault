/**
 * Shared live-query frame corpus — MIRRORED VERBATIM from the cloud door's
 * `parachute-cloud/workers/vault/test/fixtures/live-frame-corpus.ts` (the SINGLE
 * source of truth). Kept byte-identical here so the self-host WS/SSE parity test
 * asserts against the EXACT same fixture the cloud door pins — the load-bearing
 * cross-door conformance check (WS-hibernation migration, 2026-07-04). If the
 * canonical corpus changes upstream, re-mirror this file.
 *
 * Each case is a transport-neutral `(event, data)` tuple. The invariant under
 * test: for a given case, the SSE `data:` body and the WS message carry a
 * byte-IDENTICAL serialization of the inner payload (`notes` / `note` / `id`) —
 * the ONLY difference is that the WS message folds the SSE `event:` NAME into a
 * `type` discriminator (`{ type, ...data }`), because a WebSocket message has no
 * separate event-name framing. The snapshot case additionally chunks with a
 * `done` flag on the WS side (transport framing under the ~1 MiB message cap);
 * its note OBJECTS still serialize identically.
 *
 * The notes deliberately include the drift-prone bits: unicode, nested metadata,
 * a null value, an empty array, quotes/newlines in content, and stable key
 * ordering — anything a careless re-serialization would reorder or mangle.
 */

/** A note-shaped payload (loosely typed — the parity test cares about bytes, not
 *  the full Note interface; the wire carries whatever the store returns). */
export interface CorpusNote {
  id: string;
  path: string;
  content: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  extension: string;
}

export const NOTE_A: CorpusNote = {
  id: "11111111-1111-4111-8111-111111111111",
  path: "greetings/héllo",
  content: 'line one\nline "two" with quotes\n#greeting [[world]]',
  tags: ["greeting", "watch"],
  metadata: { mood: "warm", priority: 5, pinned: true, note: null, aliases: [] },
  createdAt: "2026-07-04T00:00:00.000Z",
  updatedAt: "2026-07-04T00:00:01.000Z",
  extension: "md",
};

export const NOTE_B: CorpusNote = {
  id: "22222222-2222-4222-8222-222222222222",
  path: "meetings/2026-07-04",
  content: "standup — ☂️ parachute cloud",
  tags: ["meeting"],
  metadata: { attendees: ["aaron", "uni"], count: 2 },
  createdAt: "2026-07-04T09:00:00.000Z",
  updatedAt: "2026-07-04T09:30:00.000Z",
  extension: "md",
};

export interface FrameCase {
  name: string;
  event: "snapshot" | "upsert" | "remove";
  /** The inner payload — the SSE `data:` body is exactly `JSON.stringify(data)`;
   *  the WS message is `JSON.stringify({ type: event, ...data })`. */
  data: Record<string, unknown>;
}

export const FRAME_CORPUS: FrameCase[] = [
  { name: "snapshot (two notes)", event: "snapshot", data: { notes: [NOTE_A, NOTE_B] } },
  { name: "snapshot (empty set)", event: "snapshot", data: { notes: [] } },
  { name: "upsert (rich note)", event: "upsert", data: { note: NOTE_A } },
  { name: "upsert (unicode note)", event: "upsert", data: { note: NOTE_B } },
  { name: "remove (id)", event: "remove", data: { id: NOTE_A.id } },
];
