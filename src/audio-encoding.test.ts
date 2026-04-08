/**
 * Tests for the OGG Opus encoder helper.
 *
 * These tests shell out to the real ffmpeg binary — they will fail if
 * ffmpeg is not on PATH. That is intentional: `encodeOggOpus` is a hard
 * ffmpeg dependency, so the tests document what "working" means.
 */

import { describe, test, expect } from "bun:test";
import {
  encodeOggOpus,
  isFfmpegAvailable,
  __resetFfmpegCacheForTests,
} from "./audio-encoding.ts";

/**
 * Build a tiny WAV in memory: mono, 8 kHz PCM16, `samples` samples of
 * silence. Enough for ffmpeg to parse and re-encode.
 */
function buildSilentWav(samples: number): Buffer {
  const sampleRate = 8000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = samples * blockAlign;
  const chunkSize = 36 + dataSize;

  const buf = Buffer.alloc(44 + dataSize);
  let off = 0;
  buf.write("RIFF", off); off += 4;
  buf.writeUInt32LE(chunkSize, off); off += 4;
  buf.write("WAVE", off); off += 4;
  buf.write("fmt ", off); off += 4;
  buf.writeUInt32LE(16, off); off += 4; // PCM fmt chunk size
  buf.writeUInt16LE(1, off); off += 2; // audio format = PCM
  buf.writeUInt16LE(numChannels, off); off += 2;
  buf.writeUInt32LE(sampleRate, off); off += 4;
  buf.writeUInt32LE(byteRate, off); off += 4;
  buf.writeUInt16LE(blockAlign, off); off += 2;
  buf.writeUInt16LE(bitsPerSample, off); off += 2;
  buf.write("data", off); off += 4;
  buf.writeUInt32LE(dataSize, off); off += 4;
  // Silence: bytes already zero from Buffer.alloc.
  return buf;
}

describe("encodeOggOpus", () => {
  test("ffmpeg is available on this machine (test prerequisite)", async () => {
    __resetFfmpegCacheForTests();
    const ok = await isFfmpegAvailable();
    expect(ok).toBe(true);
  });

  test("encodes a tiny WAV to an OGG Opus stream", async () => {
    const wav = buildSilentWav(8000); // 1 second of silence at 8 kHz
    const ogg = await encodeOggOpus(wav, "audio/wav");
    expect(ogg.byteLength).toBeGreaterThan(0);
    // OGG magic bytes.
    expect(ogg.toString("ascii", 0, 4)).toBe("OggS");
    // Opus streams embed "OpusHead" near the start of the first page.
    expect(ogg.toString("ascii", 0, 200)).toContain("OpusHead");
  });

  test("throws when ffmpeg exits non-zero (garbage input)", async () => {
    // Feed ffmpeg a buffer with a WAV extension but no valid audio payload.
    const garbage = Buffer.from("this is definitely not a wav file");
    await expect(encodeOggOpus(garbage, "audio/wav")).rejects.toThrow(
      /ffmpeg exited with code/,
    );
  });
});
