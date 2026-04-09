/**
 * Tests for POST /v1/audio/speech — the OpenAI-compatible TTS endpoint.
 *
 * These tests exercise `handleTtsSpeech` directly with an injected provider
 * + encoder so ffmpeg and Kokoro/ElevenLabs never have to be present. The
 * route-level registration in `server.ts` is a one-liner that dispatches
 * straight to this handler, so handler-level coverage is the load-bearing
 * part.
 */

import { describe, test, expect } from "bun:test";
import { handleTtsSpeech } from "./routes.ts";
import type { TtsProvider, TtsSynthesisResult } from "./tts-provider.ts";

/**
 * Fake encoder that returns a buffer starting with the OggS magic bytes so
 * callers that sniff the response can assert "looks like an Ogg file"
 * without requiring real ffmpeg.
 */
async function fakeEncode(audio: Buffer, _mime: string): Promise<Buffer> {
  return Buffer.concat([Buffer.from("OggS"), audio]);
}

function stubProvider(
  calls: Array<{ text: string; voice?: string }>,
): TtsProvider {
  return {
    name: "stub",
    async synthesize(text, opts): Promise<TtsSynthesisResult> {
      calls.push({ text, voice: opts?.voice });
      return { audio: Buffer.from("fake-audio"), mime: "audio/wav" };
    },
  };
}

function throwingProvider(): TtsProvider {
  return {
    name: "throwing",
    async synthesize(): Promise<TtsSynthesisResult> {
      throw new Error("provider exploded");
    },
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
      { getProvider: () => stubProvider(calls), encode: fakeEncode },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/ogg");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.slice(0, 4).toString()).toBe("OggS");
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe("Hello from the test");
    expect(calls[0].voice).toBe("af_heart");
  });

  test("markdown input is stripped before being sent to the provider", async () => {
    const calls: Array<{ text: string; voice?: string }> = [];
    const res = await handleTtsSpeech(
      makeRequest({
        input: "# Heading\n\nThis has **bold** and [a link](https://example.com).",
      }),
      { getProvider: () => stubProvider(calls), encode: fakeEncode },
    );

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    // The exact stripped output is owned by markdownToSpeech's own tests —
    // here we just assert the provider never saw the raw markdown syntax.
    expect(calls[0].text).not.toContain("**");
    expect(calls[0].text).not.toContain("](");
    expect(calls[0].text).not.toContain("#");
    expect(calls[0].text).toContain("bold");
    expect(calls[0].text).toContain("Heading");
  });

  test("omitting voice leaves voice undefined for the provider", async () => {
    const calls: Array<{ text: string; voice?: string }> = [];
    const res = await handleTtsSpeech(
      makeRequest({ input: "no voice here" }),
      { getProvider: () => stubProvider(calls), encode: fakeEncode },
    );

    expect(res.status).toBe(200);
    expect(calls[0].voice).toBeUndefined();
  });

  test("response_format: mp3 is accepted (but still returns ogg)", async () => {
    const calls: Array<{ text: string; voice?: string }> = [];
    const res = await handleTtsSpeech(
      makeRequest({ input: "hi", response_format: "mp3" }),
      { getProvider: () => stubProvider(calls), encode: fakeEncode },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/ogg");
  });

  test("missing input returns 400", async () => {
    const res = await handleTtsSpeech(
      makeRequest({ voice: "af_heart" }),
      { getProvider: () => stubProvider([]), encode: fakeEncode },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/input/i);
  });

  test("empty input returns 400", async () => {
    const res = await handleTtsSpeech(
      makeRequest({ input: "" }),
      { getProvider: () => stubProvider([]), encode: fakeEncode },
    );
    expect(res.status).toBe(400);
  });

  test("input that strips to empty returns 400 with the specific error", async () => {
    const calls: Array<{ text: string; voice?: string }> = [];
    const res = await handleTtsSpeech(
      makeRequest({ input: "```\ncode\n```" }),
      { getProvider: () => stubProvider(calls), encode: fakeEncode },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(
      "input has no speakable content after markdown preprocessing",
    );
    // Provider must not have been called.
    expect(calls).toHaveLength(0);
  });

  test("unknown response_format returns 400", async () => {
    const res = await handleTtsSpeech(
      makeRequest({ input: "hi", response_format: "foo" }),
      { getProvider: () => stubProvider([]), encode: fakeEncode },
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
      getProvider: () => stubProvider([]),
      encode: fakeEncode,
    });
    expect(res.status).toBe(400);
  });

  test("no configured provider returns 503", async () => {
    const res = await handleTtsSpeech(
      makeRequest({ input: "hi" }),
      { getProvider: () => null, encode: fakeEncode },
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("TTS provider not configured");
  });

  test("provider throwing returns 500 with the error message", async () => {
    const res = await handleTtsSpeech(
      makeRequest({ input: "hi" }),
      { getProvider: () => throwingProvider(), encode: fakeEncode },
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("provider exploded");
  });

  test("encoder throwing returns 500", async () => {
    const res = await handleTtsSpeech(
      makeRequest({ input: "hi" }),
      {
        getProvider: () => stubProvider([]),
        encode: async () => {
          throw new Error("ffmpeg blew up");
        },
      },
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("ffmpeg blew up");
  });
});
