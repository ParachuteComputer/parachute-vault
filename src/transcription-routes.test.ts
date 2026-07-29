/**
 * The transcription setup snapshot.
 *
 * The behaviour worth pinning is that "configured" and "working" are DIFFERENT
 * — a box can have the right env vars and still transcribe nothing, which is
 * how audio silently went nowhere for weeks (vault#643). So every test here is
 * about the snapshot telling the truth about which piece is missing, rather
 * than collapsing to a single boolean an operator can't act on.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTranscriptionSnapshot, handleTranscriptionGet } from "./transcription-routes.ts";

const ORIG = { ...process.env };
let home: string;
/** Fake filesystem: only paths explicitly installed by a test exist. */
let present: Set<string>;
/** Resolution driven entirely by `present`, never by the real machine. */
function deps(active = false) {
  return {
    active,
    existsImpl: (p: string) => present.has(p),
    resolveBinaryImpl: (engine: "parakeet" | "whisper") => {
      const name = engine === "whisper" ? "whisper-cli" : "parakeet-cli";
      const p = join(home, "transcription", "bin", name);
      return present.has(p) ? p : undefined;
    },
    resolveFfmpegImpl: () => {
      const p = join(home, "ff", "ffmpeg");
      return present.has(p) ? p : undefined;
    },
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tr-routes-"));
  present = new Set();
  process.env.PARACHUTE_HOME = home;
  // Isolate from the developer's real machine: an empty PATH plus no override
  // means nothing resolves unless a test puts it there.
  process.env.PATH = "";
  delete process.env.WHISPER_CPP_BIN_DIR;
  delete process.env.TRANSCRIPTION_PROVIDER;
  delete process.env.TRANSCRIPTION_MODEL;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const k of ["PARACHUTE_HOME", "PATH", "WHISPER_CPP_BIN_DIR", "TRANSCRIPTION_PROVIDER", "TRANSCRIPTION_MODEL"]) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
});

/** Put a fake binary on the resolution ladder. */
function installBinary(name: string) {
  present.add(join(home, "transcription", "bin", name));
}
/** Put a model file where the resolver looks. */
function installModel(filename: string) {
  present.add(join(home, "transcription", "models", filename));
}
/** ffmpeg, via the explicit bin-dir override. */
function installFfmpeg() {
  present.add(join(home, "ff", "ffmpeg"));
}

describe("snapshot — the default (stale) provider", () => {
  test("scribe-http with no backend reports NOT ready and says why", () => {
    // The fresh-install state: nothing configured, so the provider resolves to
    // scribe-http and there is no scribe. This is the case that used to be
    // invisible.
    const s = buildTranscriptionSnapshot(deps(false));
    expect(s.provider).toBe("scribe-http");
    expect(s.ready).toBe(false);
    expect(s.reason).toMatch(/no reachable backend/);
    expect(s.reason).toMatch(/whisper-cpp/);
    expect(s.fix_command).toBeTruthy();
  });
});

describe("snapshot — whisper-cpp readiness names the MISSING piece", () => {
  beforeEach(() => {
    process.env.TRANSCRIPTION_PROVIDER = "whisper-cpp";
  });

  test("nothing installed → names binary, model AND ffmpeg", () => {
    const s = buildTranscriptionSnapshot(deps(false));
    expect(s.ready).toBe(false);
    expect(s.reason).toMatch(/parakeet-cli/);
    expect(s.reason).toMatch(/model file/);
    expect(s.reason).toMatch(/ffmpeg/);
  });

  test("binary + model but NO ffmpeg → ffmpeg-specific fix, not a generic install", () => {
    // Different problem, different command. Telling someone to re-run
    // `transcription install` when the real gap is a system package wastes a
    // 400 MB download and doesn't fix it.
    installBinary("parakeet-cli");
    installModel("ggml-parakeet-tdt-0.6b-v3-q4_k.bin");
    const s = buildTranscriptionSnapshot(deps(false));
    expect(s.ready).toBe(false);
    expect(s.reason).toMatch(/ffmpeg/);
    expect(s.fix_command).toMatch(/brew install ffmpeg|apt install ffmpeg/);
  });

  test("everything present → ready, no reason, no fix", () => {
    installBinary("parakeet-cli");
    installModel("ggml-parakeet-tdt-0.6b-v3-q4_k.bin");
    installFfmpeg();
    const s = buildTranscriptionSnapshot(deps(false));
    expect(s.ready).toBe(true);
    expect(s.reason).toBeNull();
    expect(s.fix_command).toBeNull();
  });

  test("a whisper model asks for whisper-cli, not parakeet-cli", () => {
    process.env.TRANSCRIPTION_MODEL = "whisper-base.en";
    const s = buildTranscriptionSnapshot(deps(false));
    expect(s.binary.name).toBe("whisper-cli");
    expect(s.reason).toMatch(/whisper-cli/);
  });

  test("an unknown model id is reported, not silently defaulted", () => {
    process.env.TRANSCRIPTION_MODEL = "whisper-enormous";
    const s = buildTranscriptionSnapshot(deps(false));
    expect(s.model).toBeNull();
    expect(s.ready).toBe(false);
    expect(s.reason).toMatch(/isn't in the catalog/);
  });
});

describe("snapshot — ready vs active", () => {
  beforeEach(() => {
    process.env.TRANSCRIPTION_PROVIDER = "whisper-cpp";
    installBinary("parakeet-cli");
    installModel("ggml-parakeet-tdt-0.6b-v3-q4_k.bin");
    installFfmpeg();
  });

  test("ready but not active → restart_required", () => {
    // The operator just set a preference; the running worker hasn't picked it
    // up. Conflating the two would report success on a box still doing nothing.
    const s = buildTranscriptionSnapshot(deps(false));
    expect(s.ready).toBe(true);
    expect(s.active).toBe(false);
    expect(s.restart_required).toBe(true);
  });

  test("ready and active → nothing to do", () => {
    const s = buildTranscriptionSnapshot(deps(true));
    expect(s.restart_required).toBe(false);
  });
});

describe("snapshot — actionability", () => {
  test("reports the directories searched, so 'not found' is debuggable", () => {
    // On macOS the likeliest failure is a binary that IS installed but
    // invisible to a launchd-supervised vault (no login-shell PATH). A boolean
    // can't express that; a list of probed directories can.
    // Intentionally the real ladder — this asserts what we SHOW the operator.
    const s = buildTranscriptionSnapshot(false);
    expect(s.binary.searched.length).toBeGreaterThan(0);
    expect(s.binary.searched.some((d) => d.includes("homebrew") || d.includes("/usr/local"))).toBe(true);
  });

  test("offers the whole catalog with real sizes and per-model install state", () => {
    installModel("ggml-tiny.en.bin");
    const s = buildTranscriptionSnapshot(deps(false));
    expect(s.available_models.length).toBeGreaterThan(3);
    const tiny = s.available_models.find((m) => m.id === "whisper-tiny.en");
    expect(tiny?.installed).toBe(true);
    expect(tiny?.size_mb).toBe(74);
    // A model we didn't write is correctly reported as absent.
    expect(s.available_models.find((m) => m.id === "whisper-small.en")?.installed).toBe(false);
  });

  test("catalog is smallest-first, so the picker reads as a ladder", () => {
    const sizes = buildTranscriptionSnapshot(deps(false)).available_models.map((m) => m.size_mb);
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
  });
});

describe("GET handler", () => {
  test("200 + no-store (a polled status must never be cached stale)", async () => {
    const res = handleTranscriptionGet(false);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { ready: boolean };
    expect(typeof body.ready).toBe("boolean");
  });
});
