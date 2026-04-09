/**
 * Tests for POST /v1/audio/speech — the OpenAI-compatible TTS endpoint.
 *
 * Injects a stub `parachute-narrate` module so the real provider /
 * subprocess / ffmpeg never run. Production resolves narrate via dynamic
 * import (mirroring `getScribe`); tests pass a stub via `deps.getNarrate`.
 */

import { describe, test, expect } from "bun:test";
import { handleTtsSpeech } from "./routes.ts";
import type { NarrateModule } from "./tts-hook.ts";

// Local stand-ins for narrate's typed error classes. Tests don't import
// from parachute-narrate directly — they stub the whole module — so we
// mint local subclasses that `instanceof` correctly against themselves.
class StubNarrateEmptyInputError extends Error {
  constructor(...args: unknown[]) {
    super((args[0] as string | undefined) ?? "empty after markdown preprocessing");
  }
}
class StubNarrateNoProviderError extends Error {
  constructor(...args: unknown[]) {
    super((args[0] as string | undefined) ?? "no TTS provider configured");
  }
}

function stubNarrate(
  calls: Array<{ text: string; voice?: string }>,
): NarrateModule {
  return {
    async synthesize(text, opts) {
      calls.push({ text, voice: opts?.voice });
      return {
        audio: Buffer.concat([Buffer.from("OggS"), Buffer.from("-stub:"), Buffer.from(text)]),
        mime: "audio/ogg",
        voice: opts?.voice,
        provider: "stub",
      };
    },
    markdownToSpeech: (t) => t,
    NarrateEmptyInputError: StubNarrateEmptyInputError,
    NarrateNoProviderError: StubNarrateNoProviderError,
  };
}

function throwingNarrate(err: Error): NarrateModule {
  return {
    async synthesize() {
      throw err;
    },
    markdownToSpeech: (t) => t,
    NarrateEmptyInputError: StubNarrateEmptyInputError,
    NarrateNoProviderError: StubNarrateNoProviderError,
  };
}

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("handleTtsSpeech", () => {
  test("valid plain-text request returns 200 with OggS bytes", async () => {
    const calls: Array<{ text: string; voice?: string }> = [];
    const res = await handleTtsSpeech(
      makeRequest({
        model: "kokoro",
        voice: "af_heart",
        input: "Hello from the test",
      }),
      { getNarrate: async () => stubNarrate(calls) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/ogg");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.slice(0, 4).toString()).toBe("OggS");
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe("Hello from the test");
    expect(calls[0].voice).toBe("af_heart");
  });

  test("markdown input flows through to narrate (narrate owns preprocessing)", async () => {
    // Previously vault stripped markdown before calling the provider.
    // Now narrate owns that step — the handler just forwards the raw
    // input and lets narrate's pipeline handle it. The stub doesn't
    // strip, so we just assert the raw text made it through.
    const calls: Array<{ text: string; voice?: string }> = [];
    const raw = "# Heading\n\nThis has **bold** and [a link](https://example.com).";
    const res = await handleTtsSpeech(
      makeRequest({ input: raw }),
      { getNarrate: async () => stubNarrate(calls) },
    );

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe(raw);
  });

  test("omitting voice leaves voice undefined for narrate", async () => {
    const calls: Array<{ text: string; voice?: string }> = [];
    const res = await handleTtsSpeech(
      makeRequest({ input: "no voice here" }),
      { getNarrate: async () => stubNarrate(calls) },
    );

    expect(res.status).toBe(200);
    expect(calls[0].voice).toBeUndefined();
  });

  test("response_format: mp3 is accepted (but still returns ogg)", async () => {
    const calls: Array<{ text: string; voice?: string }> = [];
    const res = await handleTtsSpeech(
      makeRequest({ input: "hi", response_format: "mp3" }),
      { getNarrate: async () => stubNarrate(calls) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/ogg");
  });

  test("response_format: opus is accepted", async () => {
    const calls: Array<{ text: string; voice?: string }> = [];
    const res = await handleTtsSpeech(
      makeRequest({ input: "hi", response_format: "opus" }),
      { getNarrate: async () => stubNarrate(calls) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/ogg");
  });

  test("missing input returns 400", async () => {
    const res = await handleTtsSpeech(
      makeRequest({ voice: "af_heart" }),
      { getNarrate: async () => stubNarrate([]) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/input/i);
  });

  test("empty input returns 400", async () => {
    const res = await handleTtsSpeech(
      makeRequest({ input: "" }),
      { getNarrate: async () => stubNarrate([]) },
    );
    expect(res.status).toBe(400);
  });

  test("NarrateEmptyInputError returns 400 with the specific error", async () => {
    const res = await handleTtsSpeech(
      makeRequest({ input: "```\ncode\n```" }),
      {
        getNarrate: async () => throwingNarrate(new StubNarrateEmptyInputError()),
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(
      "input has no speakable content after markdown preprocessing",
    );
  });

  test("NarrateNoProviderError returns 503 with the specific error", async () => {
    const res = await handleTtsSpeech(
      makeRequest({ input: "hi" }),
      {
        getNarrate: async () => throwingNarrate(new StubNarrateNoProviderError()),
      },
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("TTS provider not configured");
  });

  test("unknown response_format returns 400", async () => {
    const res = await handleTtsSpeech(
      makeRequest({ input: "hi", response_format: "foo" }),
      { getNarrate: async () => stubNarrate([]) },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/response_format/);
  });

  test("non-object body returns 400", async () => {
    const req = new Request("http://localhost/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    const res = await handleTtsSpeech(req, {
      getNarrate: async () => stubNarrate([]),
    });
    expect(res.status).toBe(400);
  });

  test("narrate not installed returns 501", async () => {
    const res = await handleTtsSpeech(
      makeRequest({ input: "hi" }),
      { getNarrate: async () => null },
    );
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(
      "TTS not available — parachute-narrate is not installed",
    );
  });

  test("narrate throwing a generic error returns 500 with the error message", async () => {
    const res = await handleTtsSpeech(
      makeRequest({ input: "hi" }),
      { getNarrate: async () => throwingNarrate(new Error("provider exploded")) },
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("provider exploded");
  });
});
