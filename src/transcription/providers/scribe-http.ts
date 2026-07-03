/**
 * `scribe-http` — the whisper-compatible remote transcription provider
 * (scribe-fold Phase 1).
 *
 * This is a byte-for-byte port of the transcription worker's former
 * `callScribe`: discover a scribe URL (via `SCRIBE_URL` / `services.json`,
 * resolved by the caller and handed in), POST the audio as multipart
 * `file` to `<url>/v1/audio/transcriptions` (the Whisper API shape) with an
 * optional `context` part and an optional `Authorization: Bearer` header,
 * and read `{ text }` back. It is BOTH the default provider for existing
 * installs (so their behavior is unchanged across the fold) and the migration
 * bridge to any remote/whisper-compatible endpoint.
 *
 * Error mapping (unchanged from the old `callScribe`, now expressed as the
 * runtime-agnostic `TranscriptionError`):
 *   - 4xx with a JSON `error_code` → non-retriable `TranscriptionError`
 *     carrying that `code` (e.g. `missing_provider`). Re-POSTing the same
 *     audio at the same broken scribe just fails again; the operator must act.
 *   - 4xx without `error_code` (auth, malformed multipart) → non-retriable
 *     `TranscriptionError` with the body text.
 *   - 5xx → retriable `TranscriptionError` (upstream hiccup; worker backs off).
 *   - network error / timeout → the raw `Error` propagates (worker treats a
 *     plain Error as retriable).
 *   - 200 with a missing/invalid `text` field → plain `Error` (retriable).
 */

import { appendContextPart } from "../../context.ts";
import {
  TranscriptionError,
  type TranscriptionProvider,
  type TranscribeInput,
  type TranscribeResult,
  type ProviderAvailability,
} from "../../../core/src/transcription/provider.ts";

const DEFAULT_TIMEOUT_MS = 120_000;

export interface ScribeHttpProviderOpts {
  /**
   * Resolved scribe base URL (no trailing slash required — trimmed here).
   * `undefined`/empty means scribe isn't discoverable → `available()` is false
   * and `transcribe()` throws a non-retriable `missing_provider`-style error.
   */
  url?: string;
  /** Optional bearer token for scribe (the shared loopback secret / hub JWT). */
  token?: string;
  /** Per-request timeout (ms). Default 120s — matches the former worker default. */
  timeoutMs?: number;
  /** Injection seam for tests; production omits it and uses global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class ScribeHttpProvider implements TranscriptionProvider {
  readonly name = "scribe-http";

  private readonly url: string | undefined;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ScribeHttpProviderOpts = {}) {
    this.url = opts.url?.trim() ? opts.url.trim().replace(/\/$/, "") : undefined;
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * Availability is purely "can we resolve a scribe URL" — no network probe.
   * The capability flag is read on config reads, so this must stay cheap.
   */
  async available(): Promise<ProviderAvailability> {
    if (!this.url) {
      return {
        ok: false,
        reason: "no scribe URL configured (set SCRIBE_URL or install scribe so it registers in services.json)",
      };
    }
    return { ok: true };
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
    if (!this.url) {
      // Mirrors scribe's own `missing_provider` contract: terminal, operator
      // must act. Reaching here means the worker was constructed without a
      // resolvable scribe URL — a config problem, not a transient one.
      throw new TranscriptionError("no scribe URL configured", {
        code: "missing_provider",
        retriable: false,
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const file = new File([input.audio], input.filename, { type: input.mimeType });
      const form = new FormData();
      form.append("file", file);
      if (input.context) appendContextPart(form, input.context);

      const endpoint = `${this.url}/v1/audio/transcriptions`;
      const headers: Record<string, string> = {};
      if (this.token) headers["Authorization"] = `Bearer ${this.token}`;

      const resp = await this.fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: form,
        signal: controller.signal,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        // Try to extract a structured error_code from a JSON body (scribe#47).
        let errorCode: string | undefined;
        let errorMessage: string | undefined;
        try {
          const parsed = JSON.parse(body) as { error?: string; error_code?: string; message?: string };
          if (typeof parsed.error_code === "string") errorCode = parsed.error_code;
          if (typeof parsed.error === "string") errorMessage = parsed.error;
          else if (typeof parsed.message === "string") errorMessage = parsed.message;
        } catch {
          // Not JSON — leave errorCode undefined; the raw body becomes the message.
        }
        // 4xx is terminal (re-POSTing the same audio at the same broken scribe
        // will just fail again). 5xx is retriable — provider hiccup.
        const retriable = resp.status >= 500;
        const message = errorMessage
          ?? (errorCode ? `scribe ${errorCode}` : `scribe returned ${resp.status}: ${body}`);
        throw new TranscriptionError(message, {
          code: errorCode,
          httpStatus: resp.status,
          retriable,
        });
      }
      const result = await resp.json() as { text?: string };
      if (typeof result.text !== "string") {
        throw new Error("scribe response missing text field");
      }
      return { text: result.text };
    } finally {
      clearTimeout(timer);
    }
  }
}
