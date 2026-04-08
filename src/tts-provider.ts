/**
 * TTS (text-to-speech) provider abstraction + the `#reader` → audio hook.
 *
 * Parallel to `embed-provider.ts`. The factory reads env vars and returns a
 * configured provider or null. One reference implementation (ElevenLabs)
 * ships today; additional providers (Kokoro, XTTS, F5) can slot into the
 * same interface without touching callers.
 *
 * Env vars:
 *   TTS_PROVIDER=elevenlabs|kokoro|none  # default: none
 *   TTS_VOICE=<voice_id>                 # provider-specific (shared fallback)
 *   ELEVENLABS_API_KEY=<key>
 *   ELEVENLABS_MODEL=<model_id>          # optional, default eleven_multilingual_v2
 *   KOKORO_BIN=<path>                    # optional, default "uvx" — launcher
 *                                        #   for the mlx_audio Python package
 *   KOKORO_MODEL=<hf_repo_id>            # optional, default
 *                                        #   "prince-canuma/Kokoro-82M"
 *   KOKORO_VOICE=<voice_preset>          # optional, default "af_heart";
 *                                        #   falls back to TTS_VOICE if unset
 *   KOKORO_PYTHON_ARGS=<extra args>      # optional, space-separated; appended
 *                                        #   to the generate.py invocation
 *
 * The hook (registered in server.ts via `registerTtsHook`) listens for
 * `#reader`-tagged notes without an audio marker, calls the provider, writes
 * the MP3 to the vault's assets dir, and attaches it.
 *
 * See `core/src/hooks.ts` header for the sharp edges. In particular, this
 * hook uses a two-phase marker to avoid duplicate synthesis:
 *
 *   1. On entry: write `metadata.audio_pending_at = <now>` synchronously.
 *      The predicate excludes notes with EITHER `audio_rendered_at` OR
 *      `audio_pending_at` set, so a concurrent update cannot start a second
 *      run while this one is in flight.
 *   2. On success: replace `audio_pending_at` with `audio_rendered_at`
 *      (and record `audio_voice` + `audio_provider`) in the same update.
 *   3. On failure: leave `audio_pending_at` set. The note is now "stuck"
 *      and will not retry automatically. Clear the field manually (or via
 *      a future reconciliation job) to re-run.
 *
 * Why not clear on failure? Because clearing `audio_pending_at` is itself a
 * note mutation, which dispatches the hook again. The predicate would match
 * (neither marker set), the handler would re-run, the provider would fail
 * again, and we'd be in an infinite retry loop. Leaving the pending marker
 * set keeps the note quiescent until a human decides what to do.
 *
 * Known v1 limitations:
 * - Failed synthesis requires manual recovery (clear `audio_pending_at`).
 * - If the handler crashes between phase 1 and phase 2 (e.g. process
 *   SIGKILL mid-synthesis), the note also stays in pending state.
 * - If `store.addAttachment` throws after the audio file has been written
 *   to disk, the file is orphaned under `<assets>/tts/<date>/`. The note
 *   still stays in pending so no data is lost, but disk cleanup is manual.
 *   Rare — addAttachment only touches SQLite — but worth noting.
 * - A future pass can add stale-pending recovery by widening the predicate
 *   to include notes where `audio_pending_at` is older than ~10 minutes,
 *   or by introducing a separate `audio_failed_at` marker that excludes
 *   the note from the predicate without being confused with "in-flight".
 */

import { mkdirSync, writeFileSync, readFileSync, unlinkSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Note, Store } from "../core/src/types.ts";
import type { HookRegistry } from "../core/src/hooks.ts";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface TtsSynthesisResult {
  audio: Buffer;
  mime: string;
  /** Optional duration in seconds, if the provider reports it. */
  duration?: number;
}

export interface TtsProvider {
  name: string;
  synthesize(text: string, opts?: { voice?: string }): Promise<TtsSynthesisResult>;
}

// ---------------------------------------------------------------------------
// ElevenLabs
// ---------------------------------------------------------------------------

function createElevenLabsProvider(apiKey: string, defaultModel: string): TtsProvider {
  return {
    name: "elevenlabs",
    async synthesize(text: string, opts?: { voice?: string }): Promise<TtsSynthesisResult> {
      const voice = opts?.voice;
      if (!voice) {
        throw new Error("ElevenLabs TTS requires a voice id (set TTS_VOICE or pass opts.voice)");
      }
      const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: defaultModel,
          output_format: "mp3_44100_128",
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`ElevenLabs TTS error (${res.status}): ${body}`);
      }
      const audio = Buffer.from(await res.arrayBuffer());
      return { audio, mime: "audio/mpeg" };
    },
  };
}

// ---------------------------------------------------------------------------
// Kokoro (local, via Python + mlx-audio)
// ---------------------------------------------------------------------------

/**
 * Configuration resolved from env vars for the Kokoro provider.
 * Exposed for testing — see `buildKokoroCommand`.
 */
export interface KokoroConfig {
  /** Launcher binary. Default "uvx". */
  bin: string;
  /** mlx-audio HF repo id. Default "prince-canuma/Kokoro-82M". */
  model: string;
  /** Default voice preset. Default "af_heart". */
  voice: string;
  /** Optional extra args appended to the generate.py invocation. */
  extraArgs: string[];
  /** Subprocess timeout in milliseconds. Default 300_000 (5 min). */
  timeoutMs: number;
}

const KOKORO_DEFAULTS = {
  bin: "uvx",
  model: "prince-canuma/Kokoro-82M",
  voice: "af_heart",
  // First run downloads the model (~400MB) so we want generous headroom.
  // Steady-state generation is 3-30s. The hook surfaces timeouts as errors.
  timeoutMs: 300_000,
} as const;

function resolveKokoroConfig(env: Record<string, string | undefined>): KokoroConfig {
  const extraRaw = env.KOKORO_PYTHON_ARGS ?? "";
  const extraArgs = extraRaw.trim().length > 0 ? extraRaw.trim().split(/\s+/) : [];
  return {
    bin: env.KOKORO_BIN ?? KOKORO_DEFAULTS.bin,
    model: env.KOKORO_MODEL ?? KOKORO_DEFAULTS.model,
    voice: env.KOKORO_VOICE ?? env.TTS_VOICE ?? KOKORO_DEFAULTS.voice,
    extraArgs,
    timeoutMs: KOKORO_DEFAULTS.timeoutMs,
  };
}

/**
 * Build the argv for launching mlx-audio's generate.py. Pure function —
 * returns `[bin, ...args]`. Exposed so tests can assert the exact command
 * without actually spawning Python.
 */
export function buildKokoroCommand(
  config: KokoroConfig,
  text: string,
  outputDir: string,
  filePrefix: string,
  voiceOverride?: string,
): string[] {
  const voice = voiceOverride ?? config.voice;
  const argv: string[] = [];
  // If using uvx, we need `--from mlx-audio` so the tool provides mlx_audio,
  // plus `--with misaki[en] --with num2words` because the Kokoro model in
  // mlx-audio has these as hard runtime imports that aren't declared in the
  // package's own dependencies. Anything else (e.g. a direct python path)
  // is assumed to already have these importable.
  if (/(^|\/)uvx$/.test(config.bin)) {
    argv.push(
      config.bin,
      "--from",
      "mlx-audio",
      "--with",
      "misaki[en]",
      "--with",
      "num2words",
      "python",
    );
  } else {
    argv.push(config.bin);
  }
  argv.push(
    "-m",
    "mlx_audio.tts.generate",
    "--model",
    config.model,
    "--voice",
    voice,
    "--audio_format",
    "wav",
    "--output_path",
    outputDir,
    "--file_prefix",
    filePrefix,
    // With --join_audio, mlx-audio writes a single `{file_prefix}.wav`
    // regardless of how many internal segments the model produced. Without
    // this, longer inputs would split into `{file_prefix}_000.wav`,
    // `{file_prefix}_001.wav`, ... and we'd have to concat ourselves.
    "--join_audio",
    "--text",
    text,
  );
  if (config.extraArgs.length > 0) argv.push(...config.extraArgs);
  return argv;
}

/**
 * Injectable spawn surface — lets tests stub subprocess execution without
 * touching `Bun.spawn` globally. Returns the process exit code and any
 * captured stderr (used for error messages).
 */
export type KokoroSpawner = (argv: string[], timeoutMs: number) => Promise<{
  exitCode: number;
  stderr: string;
}>;

const defaultSpawner: KokoroSpawner = async (argv, timeoutMs) => {
  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // ignore
    }
  }, timeoutMs);

  const exitCode = await proc.exited;
  clearTimeout(timer);

  const stderr = await new Response(proc.stderr).text();
  // Drain stdout so the pipe doesn't back up (we don't use its contents).
  try {
    await new Response(proc.stdout).text();
  } catch {
    // ignore
  }

  if (timedOut) {
    throw new Error(
      `Kokoro TTS subprocess timed out after ${timeoutMs}ms. stderr: ${stderr.slice(0, 500)}`,
    );
  }
  return { exitCode: exitCode ?? -1, stderr };
};

export function createKokoroProvider(
  config: KokoroConfig,
  spawner: KokoroSpawner = defaultSpawner,
): TtsProvider {
  return {
    name: "kokoro",
    async synthesize(text: string, opts?: { voice?: string }): Promise<TtsSynthesisResult> {
      if (!text || text.trim().length === 0) {
        throw new Error("Kokoro TTS: refusing to synthesize empty text");
      }
      const workDir = join(
        tmpdir(),
        `kokoro-tts-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      mkdirSync(workDir, { recursive: true });
      const filePrefix = "out";
      const outPath = join(workDir, `${filePrefix}.wav`);

      try {
        const argv = buildKokoroCommand(config, text, workDir, filePrefix, opts?.voice);
        const { exitCode, stderr } = await spawner(argv, config.timeoutMs);
        if (exitCode !== 0) {
          throw new Error(
            `Kokoro TTS subprocess exited with code ${exitCode}. stderr: ${stderr.slice(0, 1000)}`,
          );
        }
        let audio: Buffer;
        try {
          audio = Buffer.from(readFileSync(outPath));
        } catch {
          throw new Error(
            `Kokoro TTS: expected output file ${outPath} was not created. stderr: ${stderr.slice(0, 500)}`,
          );
        }
        return { audio, mime: "audio/wav" };
      } finally {
        // Best-effort cleanup of the temp working directory.
        try {
          unlinkSync(outPath);
        } catch {
          // ignore
        }
        try {
          rmSync(workDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function getTtsProvider(
  env: Record<string, string | undefined> = process.env,
): TtsProvider | null {
  const provider = env.TTS_PROVIDER?.toLowerCase();
  if (!provider || provider === "none") return null;

  if (provider === "elevenlabs") {
    const apiKey = env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      console.warn("TTS_PROVIDER=elevenlabs but ELEVENLABS_API_KEY not set. TTS disabled.");
      return null;
    }
    const model = env.ELEVENLABS_MODEL ?? "eleven_multilingual_v2";
    return createElevenLabsProvider(apiKey, model);
  }

  if (provider === "kokoro") {
    return createKokoroProvider(resolveKokoroConfig(env));
  }

  console.warn(`Unknown TTS_PROVIDER: ${provider}. TTS disabled.`);
  return null;
}

// ---------------------------------------------------------------------------
// Hook: #reader → audio attachment
// ---------------------------------------------------------------------------

function mimeToExt(mime: string): string {
  if (mime === "audio/mpeg" || mime === "audio/mp3") return ".mp3";
  if (mime === "audio/wav") return ".wav";
  if (mime === "audio/ogg") return ".ogg";
  if (mime === "audio/webm") return ".webm";
  if (mime === "audio/mp4") return ".m4a";
  return ".bin";
}

export interface RegisterTtsHookOptions {
  provider: TtsProvider;
  /** Voice id to pass to the provider (usually env.TTS_VOICE). */
  voice?: string;
  /**
   * Resolve the vault assets directory for a given store. Called once per
   * handler invocation so the hook can work with multiple vaults.
   */
  resolveAssetsDir: (store: Store) => string;
  /** Optional logger override. */
  logger?: { error: (...args: unknown[]) => void; info?: (...args: unknown[]) => void };
}

/**
 * Register the `#reader` → audio hook on a HookRegistry. Returns the
 * unregister function from `HookRegistry.onNote`.
 */
export function registerTtsHook(
  hooks: HookRegistry,
  opts: RegisterTtsHookOptions,
): () => void {
  const logger = opts.logger ?? console;
  const providerName = opts.provider.name;

  return hooks.onNote({
    name: "tts-reader",
    event: ["created", "updated"],
    when: (note: Note) => {
      if (!note.tags?.includes("reader")) return false;
      const meta = note.metadata as Record<string, unknown> | undefined;
      if (meta?.audio_rendered_at) return false;
      if (meta?.audio_pending_at) return false;
      // Skip empty notes — nothing to synthesize.
      if (!note.content || note.content.trim().length === 0) return false;
      return true;
    },
    handler: async (note: Note, store: Store) => {
      const existingMeta = (note.metadata as Record<string, unknown> | undefined) ?? {};

      // Handler-side re-check. The hook-registry predicate runs at dispatch
      // time, but two synchronous mutations back-to-back can both snapshot
      // matches before either handler's phase-1 write lands — the semaphore
      // is global, not per-note. Re-checking here on the freshly-read note
      // (runHandler already re-read for us) closes that window.
      if (existingMeta.audio_pending_at || existingMeta.audio_rendered_at) {
        return;
      }

      const pendingAt = new Date().toISOString();

      // Phase 1: claim the note synchronously so a concurrent update cannot
      // double-schedule synthesis. This write re-dispatches the hook, but
      // the predicate now excludes the note because audio_pending_at is set.
      try {
        store.updateNote(note.id, {
          metadata: { ...existingMeta, audio_pending_at: pendingAt },
        });
      } catch (err) {
        logger.error(
          `[tts-hook] failed to claim note ${note.id} (could not write audio_pending_at):`,
          err,
        );
        throw err;
      }

      let result: TtsSynthesisResult;
      try {
        result = await opts.provider.synthesize(note.content, { voice: opts.voice });
      } catch (err) {
        logger.error(
          `[tts-hook] provider ${providerName} failed to synthesize note ${note.id}; note left in audio_pending_at state (manual recovery required):`,
          err,
        );
        // Deliberately leave audio_pending_at set — clearing it would
        // re-dispatch the hook and infinite-loop on persistently-failing
        // providers. See this file's header for the reasoning.
        throw err;
      }

      // Persist the audio file under <assets>/tts/<date>/<noteId>-<ts>.<ext>.
      let relativePath: string;
      try {
        const assets = opts.resolveAssetsDir(store);
        const date = pendingAt.split("T")[0];
        const dir = join(assets, "tts", date);
        mkdirSync(dir, { recursive: true });
        const ext = mimeToExt(result.mime);
        const filename = `${note.id}-${Date.now()}${ext}`;
        const absPath = join(dir, filename);
        writeFileSync(absPath, result.audio);
        relativePath = `tts/${date}/${filename}`;
      } catch (err) {
        logger.error(
          `[tts-hook] failed to write audio file for note ${note.id}; note left in audio_pending_at state:`,
          err,
        );
        // Same reasoning as the synthesis catch block — leave pending set.
        throw err;
      }

      // Phase 2: attach the audio and mark the note as rendered. Read the
      // latest metadata first so we don't clobber concurrent edits.
      try {
        store.addAttachment(note.id, relativePath, result.mime, {
          source: "tts",
          provider: providerName,
          voice: opts.voice,
          size_bytes: result.audio.length,
          ...(result.duration !== undefined ? { duration: result.duration } : {}),
        });

        const fresh = store.getNote(note.id);
        const freshMeta = (fresh?.metadata as Record<string, unknown> | undefined) ?? existingMeta;
        const { audio_pending_at: _drop, ...restMeta } = freshMeta;
        store.updateNote(note.id, {
          metadata: {
            ...restMeta,
            audio_rendered_at: new Date().toISOString(),
            audio_voice: opts.voice,
            audio_provider: providerName,
          },
        });
      } catch (err) {
        logger.error(
          `[tts-hook] failed to attach/mark audio for note ${note.id}:`,
          err,
        );
        throw err;
      }
    },
  });
}
