/**
 * `GET|PUT /vault/<name>/.parachute/transcription` — the transcription setup
 * surface for the admin SPA.
 *
 * ## Why this exists
 *
 * Configuring local transcription meant reading source: which provider is
 * resolved, whether a binary is anywhere findable, whether the model is on
 * disk, and — the part nobody could see — whether the running worker actually
 * picked any of it up. All of it lived in env vars and a boot log line the
 * operator had usually scrolled past. A box could sit for weeks accepting audio
 * and transcribing nothing with no way to tell from the UI (vault#643).
 *
 * So this endpoint answers, in one shot, the three questions an operator
 * actually has:
 *
 *   1. **Is transcription working right now?** (`ready` + `active`)
 *   2. **If not, exactly what's missing?** (`reason`, `binary`, `model`)
 *   3. **What do I run to fix it?** (`fix_command`)
 *
 * Deliberately reports paths and the directories searched, not just booleans.
 * "Not installed" is unactionable when it could mean two different things with
 * two different fixes — and on macOS the likeliest cause is that the binary IS
 * installed but a launchd-supervised vault can't see it (no login-shell PATH),
 * which a boolean can never express.
 *
 * ## What PUT does, and deliberately doesn't
 *
 * PUT writes the *preference* — provider + model — to the vault's `.env`. It
 * does NOT download anything or run a package manager. Installing needs to
 * fetch hundreds of megabytes and shell `brew`/`tar`, which is a CLI job with a
 * progress bar, not a web request that a browser tab can abandon halfway. The
 * UI's job is to make the state legible and hand over the exact command; the
 * CLI's job is to do the work. `restart_required` is honest about the gap
 * between a persisted preference and the running worker, exactly like the
 * embeddings toggle it mirrors.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { readEnvFile, setEnvVar } from "./config.ts";
import { getTranscriptionWorker } from "./transcription-registry.ts";
import {
  DEFAULT_MODEL_ID,
  findModel,
  TRANSCRIPTION_MODELS,
  type TranscriptionModel,
} from "./transcription/models.ts";
import {
  binaryNameFor,
  candidateBinDirs,
  managedModelDir,
  resolveCliBinary,
  resolveFfmpeg,
} from "./transcription/resolve-binary.ts";
import {
  resolveTranscriptionModelId,
  resolveTranscriptionProviderName,
  TRANSCRIPTION_PROVIDERS,
} from "./transcription/select.ts";

/** One entry in the model picker. */
export interface TranscriptionModelOption {
  id: string;
  label: string;
  engine: "parakeet" | "whisper";
  size_mb: number;
  min_ram_mb: number;
  note: string;
  /** Whether this specific model's file is already downloaded. */
  installed: boolean;
}

export interface TranscriptionSnapshot {
  /** Resolved provider name (`whisper-cpp`, `scribe-http`, …). */
  provider: string;
  /** Every provider the build knows about, for the picker. */
  available_providers: readonly string[];
  /** Configured model id (only meaningful for `whisper-cpp`). */
  model_id: string;
  /** The resolved model, or `null` when `model_id` names nothing known. */
  model: TranscriptionModelOption | null;
  /** Catalog for the picker, smallest first. */
  available_models: TranscriptionModelOption[];
  /** The CLI this model needs, and whether we can find it. */
  binary: {
    name: string;
    path: string | null;
    /** Directories probed, in order — so a "not found" is debuggable. */
    searched: string[];
  };
  /** ffmpeg, required for transcoding regardless of provider. */
  ffmpeg: { path: string | null };
  /**
   * True when everything needed to transcribe is present. Distinct from
   * `active`: flipping a preference changes `ready` immediately, but the
   * running worker only picks it up on restart.
   */
  ready: boolean;
  /** Whether the running process has a transcription worker live. */
  active: boolean;
  /** `true` when `ready !== active` — restart to apply. */
  restart_required: boolean;
  /** Human-readable reason when `ready` is false; `null` when ready. */
  reason: string | null;
  /** The exact command that fixes a not-ready state; `null` when ready. */
  fix_command: string | null;
}

function toOption(
  m: TranscriptionModel,
  modelDir: string,
  exists: (p: string) => boolean = existsSync,
): TranscriptionModelOption {
  return {
    id: m.id,
    label: m.label,
    engine: m.engine,
    size_mb: m.sizeMb,
    min_ram_mb: m.minRamMb,
    note: m.note,
    installed: exists(join(modelDir, m.filename)),
  };
}

/**
 * Injection seams. All optional; production passes nothing.
 *
 * These exist because binary resolution deliberately probes Homebrew's
 * prefixes whether or not they're on PATH (the launchd case — see
 * `resolve-binary.ts`). That's correct in production and makes the snapshot
 * NON-HERMETIC in tests: a developer with `brew install whisper-cpp` would see
 * "installed" no matter what the test set up, so a test asserting the
 * not-installed path would pass for the wrong reason on one machine and fail on
 * another. Injecting resolution is what makes those assertions mean something.
 */
export interface SnapshotDeps {
  /** Whether a worker is live. Production reads the shared registry. */
  active?: boolean;
  resolveBinaryImpl?: (engine: "parakeet" | "whisper") => string | undefined;
  resolveFfmpegImpl?: () => string | undefined;
  existsImpl?: (p: string) => boolean;
}

/**
 * Build the snapshot. `deps.active` is how the server tells us whether a worker
 * is actually running — this module can't know that on its own, and guessing
 * would reintroduce the exact "looks configured, transcribes nothing" gap the
 * endpoint exists to close.
 *
 * Accepts a bare boolean for back-compat with the `handleTranscription*`
 * callers, which only ever passed `active`.
 */
export function buildTranscriptionSnapshot(
  depsOrActive?: SnapshotDeps | boolean,
): TranscriptionSnapshot {
  const deps: SnapshotDeps =
    typeof depsOrActive === "boolean" ? { active: depsOrActive } : (depsOrActive ?? {});
  const activeOverride = deps.active;
  const exists = deps.existsImpl ?? existsSync;
  const resolveBin = deps.resolveBinaryImpl ?? resolveCliBinary;
  const resolveFf = deps.resolveFfmpegImpl ?? resolveFfmpeg;

  const provider = resolveTranscriptionProviderName();
  const modelId = resolveTranscriptionModelId();
  const model = findModel(modelId);
  const modelDir = managedModelDir();

  const engine = model?.engine ?? "parakeet";
  const binPath = resolveBin(engine) ?? null;
  const ffmpegPath = resolveFf() ?? null;
  const modelInstalled = model ? exists(join(modelDir, model.filename)) : false;

  // Readiness is provider-specific. `whisper-cpp` needs binary + model +
  // ffmpeg; the remote provider needs a URL, which the worker resolves itself.
  let ready: boolean;
  let reason: string | null = null;
  let fix: string | null = null;

  if (provider === "whisper-cpp") {
    const missing: string[] = [];
    if (!model) missing.push(`the model id "${modelId}" isn't in the catalog`);
    if (!binPath) missing.push(`the ${binaryNameFor(engine)} binary`);
    if (model && !modelInstalled) missing.push(`the model file (${model.label}, ${model.sizeMb} MB)`);
    if (!ffmpegPath) missing.push("ffmpeg (needed to transcode audio to 16 kHz mono WAV)");
    ready = missing.length === 0;
    if (!ready) {
      reason = `Not ready — missing ${missing.join("; ")}.`;
      fix = !ffmpegPath && binPath && modelInstalled
        ? "brew install ffmpeg   # or: sudo apt install ffmpeg"
        : "parachute-vault transcription install";
    }
  } else {
    // Any other provider: we can't introspect it from here, so defer to
    // whether the server actually started a worker. Saying "ready" about a
    // provider we haven't checked is how the silent-no-op bug happened.
    ready = activeOverride ?? getTranscriptionWorker() !== null;
    if (!ready) {
      reason =
        `Provider "${provider}" has no reachable backend. Local transcription needs ` +
        `TRANSCRIPTION_PROVIDER=whisper-cpp.`;
      fix = "parachute-vault transcription install";
    }
  }

  // Read the SHARED registry the server populates at boot, mirroring how the
  // embeddings snapshot reads its provider state. Defaulting to `false` here
  // would report "not active" on a perfectly working box.
  const active = activeOverride ?? getTranscriptionWorker() !== null;

  return {
    provider,
    available_providers: TRANSCRIPTION_PROVIDERS,
    model_id: modelId,
    model: model ? toOption(model, modelDir, exists) : null,
    available_models: TRANSCRIPTION_MODELS.map((m) => toOption(m, modelDir, exists)),
    binary: {
      name: binaryNameFor(engine),
      path: binPath,
      // Only the first few — the full PATH is noise, and the ones that matter
      // (our managed dir, then Homebrew) lead.
      searched: candidateBinDirs().slice(0, 5),
    },
    ffmpeg: { path: ffmpegPath },
    ready,
    active,
    restart_required: ready !== active,
    reason,
    fix_command: fix,
  };
}

/** `GET` — the snapshot. Admin-gated upstream in routing.ts. */
export function handleTranscriptionGet(activeOverride?: boolean): Response {
  return Response.json(buildTranscriptionSnapshot(activeOverride), {
    headers: { "Access-Control-Allow-Origin": "*", "cache-control": "no-store" },
  });
}

/**
 * `PUT` — persist a provider and/or model preference to the vault `.env`.
 *
 * Writes only; never downloads. See the module docstring for why installing
 * stays a CLI job. Returns the fresh snapshot so the UI can render the new
 * state — including `restart_required`, which will now be true.
 */
export async function handleTranscriptionPut(
  req: Request,
  activeOverride?: boolean,
): Promise<Response> {
  let body: { provider?: unknown; model_id?: unknown };
  try {
    body = (await req.json()) as { provider?: unknown; model_id?: unknown };
  } catch (err) {
    return Response.json(
      {
        error: "Invalid JSON body",
        error_type: "invalid_json",
        message: (err as Error).message ?? String(err),
      },
      { status: 400 },
    );
  }

  if (body.provider !== undefined) {
    if (
      typeof body.provider !== "string" ||
      !(TRANSCRIPTION_PROVIDERS as readonly string[]).includes(body.provider)
    ) {
      return Response.json(
        {
          error: "provider invalid",
          error_type: "validation",
          field: "provider",
          message: `provider must be one of: ${TRANSCRIPTION_PROVIDERS.join(", ")}.`,
        },
        { status: 400 },
      );
    }
  }

  if (body.model_id !== undefined) {
    if (typeof body.model_id !== "string" || !findModel(body.model_id)) {
      return Response.json(
        {
          error: "model_id invalid",
          error_type: "validation",
          field: "model_id",
          message:
            `model_id must be a known model. Valid ids: ` +
            `${TRANSCRIPTION_MODELS.map((m) => m.id).join(", ")}.`,
        },
        { status: 400 },
      );
    }
  }

  if (body.provider === undefined && body.model_id === undefined) {
    return Response.json(
      {
        error: "nothing to set",
        error_type: "validation",
        message: "Provide `provider` and/or `model_id`.",
      },
      { status: 400 },
    );
  }

  // Touch the env file only for keys actually supplied, so setting a model
  // doesn't silently pin a provider the operator didn't choose.
  if (typeof body.provider === "string") setEnvVar("TRANSCRIPTION_PROVIDER", body.provider);
  if (typeof body.model_id === "string") setEnvVar("TRANSCRIPTION_MODEL", body.model_id);

  // `setEnvVar` writes the file; the running process's `process.env` is what
  // `resolve*` reads, so mirror the write in-process or the snapshot we return
  // would describe the OLD preference and look like the write failed.
  const env = readEnvFile();
  if (env.TRANSCRIPTION_PROVIDER) process.env.TRANSCRIPTION_PROVIDER = env.TRANSCRIPTION_PROVIDER;
  if (env.TRANSCRIPTION_MODEL) process.env.TRANSCRIPTION_MODEL = env.TRANSCRIPTION_MODEL;

  return Response.json(buildTranscriptionSnapshot(activeOverride), {
    headers: { "Access-Control-Allow-Origin": "*", "cache-control": "no-store" },
  });
}

/** Re-exported for the SPA's typing convenience. */
export { DEFAULT_MODEL_ID };
