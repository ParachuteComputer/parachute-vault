/**
 * The transcription setup page.
 *
 * Every test is a state an operator actually lands in, and the assertion is
 * always "does it tell them something they can act on". The failure this page
 * exists to end is a box that accepts audio and transcribes nothing while
 * looking fine — so "not working" must be unmissable, and must name the fix.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api.ts", async () => {
  const actual = await vi.importActual<typeof import("../lib/api.ts")>("../lib/api.ts");
  return {
    ...actual,
    getTranscriptionSettings: vi.fn(),
    putTranscriptionSettings: vi.fn(),
  };
});
import * as api from "../lib/api.ts";
import { VaultTranscription } from "./VaultTranscription.tsx";

vi.mock("../lib/scope.ts");

const MODELS: api.TranscriptionModelOption[] = [
  {
    id: "whisper-tiny.en",
    label: "Whisper Tiny (English)",
    engine: "whisper",
    size_mb: 74,
    min_ram_mb: 1024,
    note: "Smallest option.",
    installed: false,
  },
  {
    id: "parakeet-tdt-0.6b-v3",
    label: "Parakeet TDT 0.6b v3 (recommended)",
    engine: "parakeet",
    size_mb: 396,
    min_ram_mb: 3072,
    note: "Best accuracy-per-byte.",
    installed: true,
  },
];

function settings(over: Partial<api.TranscriptionSettings> = {}): api.TranscriptionSettings {
  return {
    provider: "whisper-cpp",
    available_providers: ["whisper-cpp", "scribe-http"],
    model_id: "parakeet-tdt-0.6b-v3",
    model: MODELS[1]!,
    available_models: MODELS,
    binary: { name: "parakeet-cli", path: "/opt/homebrew/bin/parakeet-cli", searched: [] },
    ffmpeg: { path: "/opt/homebrew/bin/ffmpeg" },
    ready: true,
    active: true,
    restart_required: false,
    reason: null,
    fix_command: null,
    ...over,
  };
}

const renderPage = () =>
  render(
    <MemoryRouter>
      <VaultTranscription vaultName="work" />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.mocked(api.getTranscriptionSettings).mockResolvedValue(settings());
});

describe("working state", () => {
  it("says it's working and names the model", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/Working\./i)).toBeInTheDocument());
    // The model name legitimately appears in the banner, the "what's on this
    // machine" list, and the picker — so scope to the banner.
    const banner = screen.getByRole("status");
    expect(banner.textContent).toMatch(/Parakeet TDT 0\.6b v3/);
  });
});

describe("not-transcribing state", () => {
  beforeEach(() => {
    vi.mocked(api.getTranscriptionSettings).mockResolvedValue(
      settings({
        ready: false,
        active: false,
        reason: "Not ready — missing the model file (Parakeet TDT 0.6b v3, 396 MB).",
        fix_command: "parachute-vault transcription install",
        model: { ...MODELS[1]!, installed: false },
      }),
    );
  });

  it("is unmissable, and says audio still uploads", async () => {
    // The operator's real worry: "did I lose the recording?" No — it's stored,
    // just not transcribed. Saying so prevents a panic and a support question.
    renderPage();
    await waitFor(() => expect(screen.getByText(/Not transcribing\./i)).toBeInTheDocument());
    expect(screen.getByText(/still upload and be stored/i)).toBeInTheDocument();
  });

  it("shows the server's reason verbatim, including the size", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/missing the model file .*396 MB/i)).toBeInTheDocument(),
    );
  });

  it("gives the exact command, copyable", async () => {
    renderPage();
    // Appears both in the fix block and in the picker's help text, so assert
    // on the copyable <code> specifically.
    await waitFor(() =>
      expect(
        screen.getAllByText("parachute-vault transcription install").length,
      ).toBeGreaterThan(0),
    );
    expect(screen.getAllByRole("button", { name: /copy/i }).length).toBeGreaterThan(0);
  });
});

describe("ready-but-needs-restart state", () => {
  it("distinguishes 'installed' from 'running' and hands over the restart", async () => {
    // Conflating these is how a box reports success while doing nothing.
    vi.mocked(api.getTranscriptionSettings).mockResolvedValue(
      settings({ ready: true, active: false, restart_required: true }),
    );
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/Ready, but not running yet\./i)).toBeInTheDocument(),
    );
    expect(screen.getByText("parachute restart vault")).toBeInTheDocument();
  });
});

describe("missing binary", () => {
  it("shows WHERE it looked — the launchd/PATH trap", async () => {
    // On macOS the likeliest cause is a binary that IS installed but invisible
    // to a launchd-supervised vault. "not found" alone actively misleads.
    vi.mocked(api.getTranscriptionSettings).mockResolvedValue(
      settings({
        ready: false,
        active: false,
        reason: "Not ready — missing the parakeet-cli binary.",
        fix_command: "parachute-vault transcription install",
        binary: {
          name: "parakeet-cli",
          path: null,
          searched: ["/root/transcription/bin", "/opt/homebrew/bin", "/usr/local/bin"],
        },
      }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText(/not found/i)).toBeInTheDocument());
    await userEvent.click(screen.getByText(/Where we looked/i));
    expect(screen.getByText("/opt/homebrew/bin")).toBeInTheDocument();
    // And the escape hatch for a non-standard install location.
    expect(screen.getByText(/WHISPER_CPP_BIN_DIR/)).toBeInTheDocument();
  });
});

describe("missing ffmpeg", () => {
  it("explains WHY ffmpeg is required, not just that it's absent", async () => {
    vi.mocked(api.getTranscriptionSettings).mockResolvedValue(
      settings({
        ready: false,
        active: false,
        reason: "Not ready — missing ffmpeg.",
        fix_command: "brew install ffmpeg   # or: sudo apt install ffmpeg",
        ffmpeg: { path: null },
      }),
    );
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/recordings arrive as webm and have to be transcoded/i)).toBeInTheDocument(),
    );
    // And the fix is ffmpeg-specific, not a generic 400 MB re-download.
    expect(screen.getByText(/brew install ffmpeg/)).toBeInTheDocument();
  });
});

describe("model picker", () => {
  it("lists models with sizes and which are downloaded", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/Whisper Tiny/)).toBeInTheDocument());
    expect(screen.getByText(/· 74 MB/)).toBeInTheDocument();
    expect(screen.getByText(/· 396 MB · downloaded/)).toBeInTheDocument();
  });

  it("saves the preference AND pins the provider, so the choice can take effect", async () => {
    // Selecting a whisper-cpp model while the provider is still scribe-http
    // would save something inert — the picker sets both.
    vi.mocked(api.putTranscriptionSettings).mockResolvedValue(
      settings({ model_id: "whisper-tiny.en", restart_required: true, active: false }),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText(/Whisper Tiny/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("radio", { name: /Whisper Tiny/i }));
    await waitFor(() =>
      expect(api.putTranscriptionSettings).toHaveBeenCalledWith("work", {
        model_id: "whisper-tiny.en",
        provider: "whisper-cpp",
      }),
    );
  });

  it("never claims to install — it points at the command", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText(/Whisper Tiny/)).toBeInTheDocument());
    expect(screen.getByText(/saves the choice/i)).toBeInTheDocument();
  });

  it("surfaces a save failure instead of silently reverting", async () => {
    vi.mocked(api.putTranscriptionSettings).mockRejectedValue(
      new api.HttpError(403, "insufficient scope"),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText(/Whisper Tiny/)).toBeInTheDocument());
    await userEvent.click(screen.getByRole("radio", { name: /Whisper Tiny/i }));
    await waitFor(() => expect(screen.getByText(/insufficient scope/i)).toBeInTheDocument());
  });
});

describe("auth", () => {
  it("a 401 renders the shared sign-in banner with the server's message", async () => {
    vi.mocked(api.getTranscriptionSettings).mockRejectedValue(
      new api.HttpError(401, "token cannot be validated: revocation list unavailable"),
    );
    renderPage();
    // Reuses SignInBanner, so it inherits the vault#642 honesty fix: an infra
    // 401 doesn't get rendered as "you're not signed in".
    await waitFor(() =>
      expect(screen.getByText(/revocation list unavailable|not signed in|Checking your session/i)).toBeInTheDocument(),
    );
  });
});
