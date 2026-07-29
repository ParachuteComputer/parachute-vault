/**
 * The local-transcription model catalog (whisper.cpp era).
 *
 * ## Why this replaced the transcribe.cpp plan
 *
 * The 2026-07-03 ratification adopted transcribe.cpp as the local provider.
 * That decision assumed a `transcribe-cli` binary would ship. It never did:
 * v0.1.3 (2026-07-12, latest as of this writing) still publishes only
 * `libtranscribe.{dylib,so}` + `libggml*` + `contract.json` in its release
 * tarballs — the CLI is build-from-source — and its N-API binding crashes on
 * Bun, so the in-process route is closed too. Four weeks and three releases
 * after the ratification, `parachute-vault transcription install` still could
 * not produce a runnable setup.
 *
 * whisper.cpp ships what transcribe.cpp doesn't: **prebuilt CLIs on both
 * platforms**. `brew install whisper-cpp` (bottled for arm64 macOS) installs
 * BOTH `whisper-cli` and `parakeet-cli`, and the Linux release tarballs carry
 * the same two binaries. Models are prebuilt too — `ggml-org/parakeet-GGUF`
 * and `ggerganov/whisper.cpp` — so nothing has to be converted, and no Python
 * is involved anywhere.
 *
 * Note that handy-computer's own GGUFs (68 repos, 16 model families) are NOT
 * format-compatible with whisper.cpp's `parakeet-cli` — verified: loading
 * `parakeet-tdt-0.6b-v3-Q4_K_M.gguf` fails with "failed to load Parakeet
 * model". They are two ecosystems, and this catalog lives in whisper.cpp's.
 * If transcribe.cpp ships a CLI later, its 16-family catalog becomes a
 * genuinely attractive swap — the provider seam is where that would land.
 *
 * ## Why Parakeet is the default
 *
 * On the Open ASR Leaderboard, Parakeet TDT 0.6b v3 beats Whisper large-v3 on
 * average WER (6.32% vs 7.44%) at roughly a third of the parameters, and runs
 * substantially faster. The property that matters most for voice memos:
 * **Parakeet does not hallucinate during silence**, which is Whisper's
 * best-known failure mode and precisely what a recording with pauses triggers.
 *
 * The trade-off is language coverage — Parakeet v3 handles 25 European
 * languages, Whisper 99 — which is why the Whisper models stay in the catalog
 * rather than being dropped. A vault whose audio isn't in Parakeet's range
 * picks a Whisper model and everything else works the same.
 */

/**
 * Which whisper.cpp CLI runs a given model. The two binaries take slightly
 * different flags and read different model formats, so this is not cosmetic —
 * it selects the argv builder and the readiness probe.
 */
export type TranscriptionEngine = "parakeet" | "whisper";

/** A model an operator can pick, with everything needed to fetch and run it. */
export interface TranscriptionModel {
  /** Stable id — what `TRANSCRIPTION_MODEL` is set to. */
  id: string;
  /** Short label for the admin UI. */
  label: string;
  /** Which CLI runs it. */
  engine: TranscriptionEngine;
  /** Download URL for the ggml `.bin`. */
  url: string;
  /** On-disk filename under `<root>/transcription/models/`. */
  filename: string;
  /** Approximate download size, MB. Real measured values, not estimates. */
  sizeMb: number;
  /**
   * Rough floor of usable system RAM, MB. Used to pick a sane default on a
   * given box and to warn when an operator picks something their machine will
   * struggle with — NOT a hard refusal; an operator may know better.
   */
  minRamMb: number;
  /** One line for the picker — what this trades away. */
  note: string;
}

/**
 * The catalog, smallest first.
 *
 * Sizes are measured from the HuggingFace API, not estimated. The Parakeet
 * entries come from `ggml-org/parakeet-GGUF` (whisper.cpp's own conversions,
 * which is what makes them loadable by `parakeet-cli`); the Whisper entries
 * from `ggerganov/whisper.cpp`, the canonical source `download-ggml-model.sh`
 * uses.
 */
export const TRANSCRIPTION_MODELS: readonly TranscriptionModel[] = [
  {
    id: "whisper-tiny.en",
    label: "Whisper Tiny (English)",
    engine: "whisper",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
    filename: "ggml-tiny.en.bin",
    sizeMb: 74,
    minRamMb: 1024,
    note: "Smallest option. Noticeably less accurate — for very constrained boxes.",
  },
  {
    id: "whisper-base.en",
    label: "Whisper Base (English)",
    engine: "whisper",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
    filename: "ggml-base.en.bin",
    sizeMb: 141,
    minRamMb: 2048,
    note: "Small and quick. English only.",
  },
  {
    id: "parakeet-tdt-0.6b-v3-q4",
    label: "Parakeet TDT 0.6b v3 (q4)",
    engine: "parakeet",
    url: "https://huggingface.co/ggml-org/parakeet-GGUF/resolve/main/ggml-parakeet-tdt-0.6b-v3-q4_0.bin",
    filename: "ggml-parakeet-tdt-0.6b-v3-q4_0.bin",
    sizeMb: 339,
    minRamMb: 2048,
    note: "Parakeet at the smallest quantization. 25 European languages.",
  },
  {
    id: "parakeet-tdt-0.6b-v3",
    label: "Parakeet TDT 0.6b v3 (recommended)",
    engine: "parakeet",
    url: "https://huggingface.co/ggml-org/parakeet-GGUF/resolve/main/ggml-parakeet-tdt-0.6b-v3-q4_k.bin",
    filename: "ggml-parakeet-tdt-0.6b-v3-q4_k.bin",
    sizeMb: 396,
    minRamMb: 3072,
    note: "Best accuracy-per-byte, and doesn't hallucinate on silence. 25 European languages.",
  },
  {
    id: "whisper-small.en",
    label: "Whisper Small (English)",
    engine: "whisper",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
    filename: "ggml-small.en.bin",
    sizeMb: 465,
    minRamMb: 4096,
    note: "More accurate Whisper. English only.",
  },
  {
    id: "parakeet-tdt-0.6b-v3-q8",
    label: "Parakeet TDT 0.6b v3 (q8)",
    engine: "parakeet",
    url: "https://huggingface.co/ggml-org/parakeet-GGUF/resolve/main/ggml-parakeet-tdt-0.6b-v3-q8_0.bin",
    filename: "ggml-parakeet-tdt-0.6b-v3-q8_0.bin",
    sizeMb: 638,
    minRamMb: 6144,
    note: "Parakeet at higher precision. Marginal gain over q4_k for most audio.",
  },
  {
    id: "whisper-large-v3-turbo",
    label: "Whisper Large v3 Turbo (multilingual)",
    engine: "whisper",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
    filename: "ggml-large-v3-turbo.bin",
    sizeMb: 1549,
    minRamMb: 8192,
    note: "All 99 Whisper languages. Pick this when Parakeet's 25 aren't enough.",
  },
] as const;

/**
 * The default model when nothing is configured.
 *
 * Parakeet q4_k rather than the smallest option: at 396 MB it is a reasonable
 * download on any machine that can host a vault, and choosing accuracy by
 * default is the right call for transcripts an operator will read months
 * later. `pickDefaultModel` steps down on low-RAM boxes.
 */
export const DEFAULT_MODEL_ID = "parakeet-tdt-0.6b-v3";

/** Look a model up by id. `undefined` for an unknown id. */
export function findModel(id: string): TranscriptionModel | undefined {
  return TRANSCRIPTION_MODELS.find((m) => m.id === id);
}

/**
 * Pick a sensible default for a machine with `totalRamMb`.
 *
 * Walks DOWN from the default to the largest model the box comfortably fits,
 * so a small VPS gets something that runs rather than something that swaps.
 * Never returns undefined — the smallest entry is the floor, and a box too
 * small even for that has bigger problems than model choice.
 */
export function pickDefaultModel(totalRamMb: number): TranscriptionModel {
  const preferred = findModel(DEFAULT_MODEL_ID);
  if (preferred && totalRamMb >= preferred.minRamMb) return preferred;
  // Largest model that fits, else the smallest we have.
  const fits = TRANSCRIPTION_MODELS.filter((m) => totalRamMb >= m.minRamMb);
  return fits.length > 0
    ? fits.reduce((a, b) => (b.sizeMb > a.sizeMb ? b : a))
    : TRANSCRIPTION_MODELS[0]!;
}
