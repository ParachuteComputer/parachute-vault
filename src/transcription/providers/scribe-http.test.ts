import { describe, test, expect } from "bun:test";
import { ScribeHttpProvider } from "./scribe-http.ts";
import { TranscriptionError } from "../../../core/src/transcription/provider.ts";

/**
 * Conformance tests for the `scribe-http` provider (scribe-fold Phase 1).
 *
 * These pin that the provider reproduces the former `callScribe` behavior
 * EXACTLY — endpoint shape, auth header, context part, and the terminal-vs-
 * retriable error mapping the worker depends on. If these drift, existing
 * scribe installs change behavior across the fold, which Phase 1 forbids.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Capture the last fetch call so we can assert endpoint/headers/body. */
function recordingFetch(response: Response | (() => Response | Promise<Response>)): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return typeof response === "function" ? await response() : response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const AUDIO = new Uint8Array([1, 2, 3, 4]);

describe("ScribeHttpProvider.available", () => {
  test("ok:true when a URL is configured", async () => {
    const p = new ScribeHttpProvider({ url: "http://scribe.test" });
    expect(await p.available()).toEqual({ ok: true });
  });

  test("ok:false with a reason when no URL is configured", async () => {
    const p = new ScribeHttpProvider({ url: undefined });
    const avail = await p.available();
    expect(avail.ok).toBe(false);
    expect(avail.reason).toBeTruthy();
  });

  test("ok:false for an empty/whitespace URL", async () => {
    expect((await new ScribeHttpProvider({ url: "   " }).available()).ok).toBe(false);
  });

  test("name is stable 'scribe-http'", () => {
    expect(new ScribeHttpProvider({ url: "http://scribe.test" }).name).toBe("scribe-http");
  });
});

describe("ScribeHttpProvider.transcribe — happy path", () => {
  test("POSTs multipart to /v1/audio/transcriptions and returns { text }", async () => {
    const { fetchImpl, calls } = recordingFetch(jsonResponse({ text: "hello world" }));
    const p = new ScribeHttpProvider({ url: "http://scribe.test/", fetchImpl });

    const result = await p.transcribe({ audio: AUDIO, filename: "a.webm", mimeType: "audio/webm" });

    expect(result.text).toBe("hello world");
    // Trailing slash on the base URL is normalized away (no `//v1`).
    expect(calls[0]!.url).toBe("http://scribe.test/v1/audio/transcriptions");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.body).toBeInstanceOf(FormData);
    const form = calls[0]!.init?.body as FormData;
    expect(form.get("file")).toBeInstanceOf(File);
  });

  test("sends Authorization: Bearer when a token is set", async () => {
    const { fetchImpl, calls } = recordingFetch(jsonResponse({ text: "x" }));
    const p = new ScribeHttpProvider({ url: "http://scribe.test", token: "sekret", fetchImpl });
    await p.transcribe({ audio: AUDIO, filename: "a.webm", mimeType: "audio/webm" });
    expect((calls[0]!.init?.headers as Record<string, string>)["Authorization"]).toBe("Bearer sekret");
  });

  test("omits Authorization when no token (loopback-trust)", async () => {
    const { fetchImpl, calls } = recordingFetch(jsonResponse({ text: "x" }));
    const p = new ScribeHttpProvider({ url: "http://scribe.test", fetchImpl });
    await p.transcribe({ audio: AUDIO, filename: "a.webm", mimeType: "audio/webm" });
    expect((calls[0]!.init?.headers as Record<string, string>)["Authorization"]).toBeUndefined();
  });

  test("attaches a context part when context has entries", async () => {
    const { fetchImpl, calls } = recordingFetch(jsonResponse({ text: "x" }));
    const p = new ScribeHttpProvider({ url: "http://scribe.test", fetchImpl });
    await p.transcribe({
      audio: AUDIO,
      filename: "a.webm",
      mimeType: "audio/webm",
      context: { entries: [{ name: "Aaron", summary: "founder" }] },
    });
    const form = calls[0]!.init?.body as FormData;
    expect(form.get("context")).toBeInstanceOf(Blob);
  });

  test("no context part when entries is empty", async () => {
    const { fetchImpl, calls } = recordingFetch(jsonResponse({ text: "x" }));
    const p = new ScribeHttpProvider({ url: "http://scribe.test", fetchImpl });
    await p.transcribe({ audio: AUDIO, filename: "a.webm", mimeType: "audio/webm", context: { entries: [] } });
    expect((calls[0]!.init?.body as FormData).get("context")).toBeNull();
  });
});

describe("ScribeHttpProvider.transcribe — error mapping", () => {
  test("4xx with error_code → non-retriable TranscriptionError carrying code", async () => {
    const { fetchImpl } = recordingFetch(
      jsonResponse({ error: "no transcription provider configured", error_code: "missing_provider" }, 400),
    );
    const p = new ScribeHttpProvider({ url: "http://scribe.test", fetchImpl });

    let thrown: unknown;
    try {
      await p.transcribe({ audio: AUDIO, filename: "a.webm", mimeType: "audio/webm" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(TranscriptionError);
    const e = thrown as TranscriptionError;
    expect(e.code).toBe("missing_provider");
    expect(e.httpStatus).toBe(400);
    expect(e.retriable).toBe(false);
    // error message prefers the JSON `error` field verbatim.
    expect(e.message).toBe("no transcription provider configured");
  });

  test("4xx without error_code → non-retriable with 'scribe returned 400: <body>' message", async () => {
    const { fetchImpl } = recordingFetch(new Response("bad multipart", { status: 400 }));
    const p = new ScribeHttpProvider({ url: "http://scribe.test", fetchImpl });

    let thrown: unknown;
    try {
      await p.transcribe({ audio: AUDIO, filename: "a.webm", mimeType: "audio/webm" });
    } catch (err) {
      thrown = err;
    }
    const e = thrown as TranscriptionError;
    expect(e).toBeInstanceOf(TranscriptionError);
    expect(e.code).toBeUndefined();
    expect(e.retriable).toBe(false);
    expect(e.message).toBe("scribe returned 400: bad multipart");
  });

  test("5xx → retriable TranscriptionError", async () => {
    const { fetchImpl } = recordingFetch(new Response("upstream boom", { status: 503 }));
    const p = new ScribeHttpProvider({ url: "http://scribe.test", fetchImpl });

    let thrown: unknown;
    try {
      await p.transcribe({ audio: AUDIO, filename: "a.webm", mimeType: "audio/webm" });
    } catch (err) {
      thrown = err;
    }
    const e = thrown as TranscriptionError;
    expect(e).toBeInstanceOf(TranscriptionError);
    expect(e.retriable).toBe(true);
    expect(e.httpStatus).toBe(503);
  });

  test("200 with missing text field → plain Error (retriable via worker)", async () => {
    const { fetchImpl } = recordingFetch(jsonResponse({ not_text: 1 }));
    const p = new ScribeHttpProvider({ url: "http://scribe.test", fetchImpl });

    let thrown: unknown;
    try {
      await p.transcribe({ audio: AUDIO, filename: "a.webm", mimeType: "audio/webm" });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(TranscriptionError);
    expect((thrown as Error).message).toBe("scribe response missing text field");
  });

  test("no URL configured → non-retriable missing_provider (never fetches)", async () => {
    const { fetchImpl, calls } = recordingFetch(jsonResponse({ text: "should not run" }));
    const p = new ScribeHttpProvider({ url: undefined, fetchImpl });

    let thrown: unknown;
    try {
      await p.transcribe({ audio: AUDIO, filename: "a.webm", mimeType: "audio/webm" });
    } catch (err) {
      thrown = err;
    }
    const e = thrown as TranscriptionError;
    expect(e).toBeInstanceOf(TranscriptionError);
    expect(e.code).toBe("missing_provider");
    expect(e.retriable).toBe(false);
    expect(calls.length).toBe(0);
  });
});
