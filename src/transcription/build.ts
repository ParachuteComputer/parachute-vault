/**
 * Building `transcribe-cli` from source at install time (scribe-fold Phase 2b).
 *
 * transcribe.cpp v0.1.1 ships a **library** (`libtranscribe.{dylib,so}` +
 * `libggml*`), NOT a prebuilt `transcribe-cli` executable — see
 * `install.ts` + the provider-seam design doc. This module closes that gap: it
 * fetches the CLI's source (`examples/cli/main.cpp` + `examples/common/wav.cpp`
 * + the public headers) from the transcribe.cpp repo pinned at the v0.1.1 tag
 * commit, then compiles it with the host C++ compiler against the extracted
 * prebuilt dylibs. The result is a ~127KB driver that links the prebuilt
 * `libtranscribe` at runtime — **no ggml / Metal rebuild**.
 *
 * ## The proven recipe (live-verified 2026-07-03, macOS arm64 M4)
 *
 *   c++ -std=c++17 -O2 \
 *     -I<srcDir>/include \
 *     -I<srcDir>/examples/common \
 *     <srcDir>/examples/cli/main.cpp \
 *     <srcDir>/examples/common/wav.cpp \
 *     -L<libsDir> -ltranscribe \
 *     -Wl,-rpath,@loader_path/../libs \        # Linux: $ORIGIN/../libs
 *     -o <binDir>/transcribe-cli
 *
 * The rpath is load-bearing: `libtranscribe.dylib`'s install_name is
 * `@rpath/libtranscribe.dylib` (with no rpath of its own), so the CLI carries
 * `@loader_path/../libs` to resolve it from a sibling `libs/` dir. In turn
 * `libtranscribe` references `libggml*` via `@loader_path/libggml*.dylib`, so
 * having all dylibs in the same `libs/` dir is enough — the CLI never needs to
 * know about libggml. On Linux the analogous `$ORIGIN/../libs` is passed as a
 * single argv element (we spawn the compiler directly, NOT through a shell, so
 * `$ORIGIN` is NOT expanded — it lands literally in the ELF RUNPATH for the
 * runtime loader to expand).
 *
 * ## Testability
 *
 * `buildTranscribeCli` is a pure orchestrator over injected side effects
 * (`which` / `fetchSource` / `compile` / `exists` / `removeBin`), mirroring the
 * provider's `SpawnRunner` seam. Tests exercise every branch — toolchain
 * absent, fetch failure, compile failure, success — with no network and no real
 * compiler. The real compile is exercised only by the install-time live verify.
 */

import { join } from "path";

/**
 * Pinned source ref for the CLI build: the transcribe.cpp **v0.1.1 tag commit**.
 * Kept in lockstep with `TRANSCRIBE_CPP_VERSION` in `install.ts` — bump both
 * together (a newer CLI source may need different headers or flags, and the
 * provider's output parsing is validated against a specific version).
 */
export const TRANSCRIBE_CPP_SOURCE_REF = "d89ecb75062e8457681c563994675dc60e31db80";

const RAW_BASE = `https://raw.githubusercontent.com/handy-computer/transcribe.cpp/${TRANSCRIBE_CPP_SOURCE_REF}`;

/**
 * Repo-relative source files needed to build `transcribe-cli`, laid out under a
 * local source dir so the include paths resolve exactly as upstream expects.
 * `main.cpp` includes `transcribe.h` + `transcribe/{parakeet,voxtral_realtime,
 * whisper}.h` + `wav.h`; `wav.cpp` includes `wav.h` + `dr_wav.h`. We fetch the
 * complete `include/` header set (the two extra sub-headers are tiny and keep
 * the tree self-consistent). Verified sufficient by a real compile at this ref.
 */
export const CLI_SOURCE_FILES: readonly string[] = [
  "include/transcribe.h",
  "include/transcribe/extensions.h",
  "include/transcribe/moonshine_streaming.h",
  "include/transcribe/parakeet.h",
  "include/transcribe/voxtral_realtime.h",
  "include/transcribe/whisper.h",
  "examples/common/wav.h",
  "examples/common/wav.cpp",
  "examples/common/dr_wav.h",
  "examples/cli/main.cpp",
];

/** Full raw.githubusercontent URL for a repo-relative path at the pinned ref. */
export function cliSourceUrl(repoPath: string): string {
  return `${RAW_BASE}/${repoPath}`;
}

/** C++ compiler binaries we probe for, in preference order. */
export const CXX_CANDIDATES = ["c++", "clang++", "g++"] as const;

/**
 * Resolve a C++ compiler path via the injected `which` (production:
 * `Bun.which`). Returns the first candidate found, or `null` when none is on
 * PATH — the caller keeps the current provider and prints a platform hint.
 */
export function detectCompiler(which: (cmd: string) => string | null | undefined): string | null {
  for (const c of CXX_CANDIDATES) {
    const p = which(c);
    if (p) return p;
  }
  return null;
}

/** A short "install a compiler" hint tailored to the host platform. */
export function compilerInstallHint(platform: string): string {
  if (platform === "darwin") return "install the Xcode command-line tools: xcode-select --install";
  if (platform === "linux") {
    return "install a C++ toolchain: apt install build-essential (Debian/Ubuntu) | dnf install gcc-c++ (Fedora/RHEL)";
  }
  return "install a C++ compiler (c++/clang++/g++) on PATH";
}

export interface CompileCommandInput {
  /** Host platform (`process.platform`) — selects the rpath flavor. */
  platform: string;
  /** Resolved compiler path (`detectCompiler`). */
  compiler: string;
  /** The local source dir the CLI sources were fetched into. */
  srcDir: string;
  /** The extracted prebuilt dylibs dir to link `-ltranscribe` from. */
  libsDir: string;
  /** Where the compiled `transcribe-cli` lands. */
  outPath: string;
}

/**
 * Build the compiler argv (the proven recipe). Pure — a test pins the shape,
 * mirroring `buildTranscribeArgs` for the provider. The rpath resolves the
 * sibling `libs/` dir from `bin/`: `@loader_path/../libs` (macOS) /
 * `$ORIGIN/../libs` (Linux, passed literally — no shell expansion).
 */
export function buildCompileCommand(input: CompileCommandInput): string[] {
  const includeDir = join(input.srcDir, "include");
  const commonDir = join(input.srcDir, "examples", "common");
  const mainCpp = join(input.srcDir, "examples", "cli", "main.cpp");
  const wavCpp = join(input.srcDir, "examples", "common", "wav.cpp");
  const rpath = input.platform === "darwin" ? "@loader_path/../libs" : "$ORIGIN/../libs";
  return [
    input.compiler,
    "-std=c++17",
    "-O2",
    `-I${includeDir}`,
    `-I${commonDir}`,
    mainCpp,
    wavCpp,
    `-L${input.libsDir}`,
    "-ltranscribe",
    `-Wl,-rpath,${rpath}`,
    "-o",
    input.outPath,
  ];
}

/** Result of running the compiler: exit code + captured stderr. */
export interface CompileResult {
  exitCode: number;
  stderr: string;
}

/** Injected side effects for `buildTranscribeCli` (tests pass mocks). */
export interface BuildCliDeps {
  /** Host platform (`process.platform`). */
  platform: string;
  /** Compiler probe (production: `Bun.which`). */
  which: (cmd: string) => string | null | undefined;
  /** Fetch `files` (repo-relative) into `srcDir`. Throws on network failure. */
  fetchSource: (files: readonly string[], srcDir: string) => Promise<void>;
  /** Run the compiler argv. */
  compile: (cmd: string[]) => CompileResult | Promise<CompileResult>;
  /** Existence probe (production: `fs.existsSync`). */
  exists: (p: string) => boolean;
  /** Remove a stale / half-built binary (production: `fs.rmSync{force}`). */
  removeBin: (p: string) => void;
  /** Move a file into place (production: `fs.renameSync`). Used to promote the
   *  freshly-built binary atomically, so a failed rebuild never clobbers a
   *  previously working binary. */
  rename: (from: string, to: string) => void;
}

export interface BuildCliInput {
  /** Local dir to fetch the CLI sources into. */
  srcDir: string;
  /** The extracted prebuilt dylibs dir. */
  libsDir: string;
  /** Output binary path. */
  binPath: string;
}

/** The outcome of a build attempt — a discriminated union the CLI branches on. */
export type CliBuildResult =
  | { ok: true; binPath: string; compiler: string; command: string }
  | {
      ok: false;
      /** Which stage failed — drives the operator guidance. */
      stage: "toolchain" | "fetch" | "compile";
      message: string;
      compiler?: string;
      /** The compile argv (as a string) when we got far enough to build one. */
      command?: string;
    };

/**
 * Fetch the CLI source at the pinned ref and compile it against the extracted
 * dylibs. Non-throwing: every failure is a typed `{ ok: false }` so the caller
 * keeps the current provider and reports honestly. Never leaves a half-built
 * binary — a nonzero compile (or a missing output) removes `binPath` so
 * `available()` can't mistake a partial artifact for a runnable CLI.
 */
export async function buildTranscribeCli(
  input: BuildCliInput,
  deps: BuildCliDeps,
): Promise<CliBuildResult> {
  const compiler = detectCompiler(deps.which);
  if (!compiler) {
    return {
      ok: false,
      stage: "toolchain",
      message: `no C++ compiler on PATH (looked for ${CXX_CANDIDATES.join(", ")}) — ${compilerInstallHint(deps.platform)}`,
    };
  }

  try {
    await deps.fetchSource(CLI_SOURCE_FILES, input.srcDir);
  } catch (err) {
    return {
      ok: false,
      stage: "fetch",
      compiler,
      message: `failed to fetch transcribe-cli source at ${TRANSCRIBE_CPP_SOURCE_REF}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const common = { platform: deps.platform, compiler, srcDir: input.srcDir, libsDir: input.libsDir };
  // The reported command targets the FINAL binPath (what an operator would run
  // by hand to reproduce). The actual compile writes to a temp sibling and is
  // promoted on success — so a failed rebuild (e.g. `--force` that then fails)
  // never clobbers a previously working binary, and no half-built artifact is
  // ever left where available() would treat it as runnable. The temp is a
  // sibling in the same dir, so the @loader_path/../libs rpath is unaffected.
  const command = buildCompileCommand({ ...common, outPath: input.binPath }).join(" ");
  const tmpOut = `${input.binPath}.building`;
  const argv = buildCompileCommand({ ...common, outPath: tmpOut });

  deps.removeBin(tmpOut); // clear any stale temp from a prior interrupted build
  const res = await deps.compile(argv);
  if (res.exitCode !== 0 || !deps.exists(tmpOut)) {
    deps.removeBin(tmpOut); // drop any partial output; the existing binary stands
    return {
      ok: false,
      stage: "compile",
      compiler,
      command,
      message: (res.stderr || "").trim() || `compiler exited ${res.exitCode}`,
    };
  }

  deps.rename(tmpOut, input.binPath); // atomic promote over any prior binary
  return { ok: true, binPath: input.binPath, compiler, command };
}
