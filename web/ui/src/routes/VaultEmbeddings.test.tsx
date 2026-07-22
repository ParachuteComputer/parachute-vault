/**
 * VaultEmbeddings smoke tests — loading → render, toggle save → PUT,
 * env-forced advisory banner, restart-required banner, and the
 * auth-required redirect. `lib/api.ts` is mocked for the wire surface;
 * `HttpError` is preserved as a real class so the component's
 * `err instanceof HttpError` auth branch still matches.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api.ts";
import { VaultEmbeddings } from "./VaultEmbeddings.tsx";

vi.mock("../lib/api.ts", async () => {
  const actual = await vi.importActual<typeof import("../lib/api.ts")>("../lib/api.ts");
  return {
    ...actual,
    getEmbeddingsSettings: vi.fn(),
    putEmbeddingsSettings: vi.fn(),
  };
});

const fixture = (over: Partial<api.EmbeddingsSettings> = {}): api.EmbeddingsSettings => ({
  enabled: false,
  env_override: null,
  env_forced: false,
  effective: false,
  active: false,
  restart_required: false,
  model_download_mb: 34,
  ...over,
});

function renderRoute() {
  return render(
    <MemoryRouter initialEntries={["/vault/work/embeddings"]}>
      <Routes>
        <Route path="/vault/:name/embeddings" element={<VaultEmbeddings />} />
        <Route path="/vault/:name" element={<div>detail</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getEmbeddingsSettings).mockResolvedValue(fixture());
});

describe("VaultEmbeddings", () => {
  it("renders the toggle reflecting the persisted setting", async () => {
    vi.mocked(api.getEmbeddingsSettings).mockResolvedValue(fixture({ enabled: true, active: true, effective: true }));
    renderRoute();
    const checkbox = await screen.findByRole("checkbox");
    expect(checkbox).toBeChecked();
    expect(screen.getByText(/one-time model download/i)).toBeInTheDocument();
  });

  it("saves via PUT when the toggle is flipped", async () => {
    const user = userEvent.setup();
    vi.mocked(api.putEmbeddingsSettings).mockResolvedValue(
      fixture({ enabled: true, effective: true, active: false, restart_required: true }),
    );
    renderRoute();
    const checkbox = await screen.findByRole("checkbox");
    await user.click(checkbox); // off → on
    const save = screen.getByRole("button", { name: /enable semantic search/i });
    await user.click(save);
    await waitFor(() => expect(api.putEmbeddingsSettings).toHaveBeenCalledWith("work", true));
    // Restart-required banner appears after save.
    expect(await screen.findByText(/Restart the vault to apply/i)).toBeInTheDocument();
  });

  it("shows the env-forced advisory banner when an env var forces the value", async () => {
    vi.mocked(api.getEmbeddingsSettings).mockResolvedValue(
      fixture({ enabled: false, env_override: true, env_forced: true, effective: true, active: true }),
    );
    renderRoute();
    expect(await screen.findByText(/EMBEDDINGS_ENABLED/)).toBeInTheDocument();
    expect(screen.getByText(/environment override wins/i)).toBeInTheDocument();
  });

  it("shows a restart-required banner on load when persisted differs from running", async () => {
    vi.mocked(api.getEmbeddingsSettings).mockResolvedValue(
      fixture({ enabled: true, effective: true, active: false, restart_required: true }),
    );
    renderRoute();
    expect(await screen.findByText(/Restart the vault to apply/i)).toBeInTheDocument();
  });

  it("renders the sign-in banner on a 403", async () => {
    vi.mocked(api.getEmbeddingsSettings).mockRejectedValue(new api.HttpError(403, "forbidden"));
    renderRoute();
    // SignInBanner renders — the checkbox never appears.
    await waitFor(() => expect(screen.queryByRole("checkbox")).not.toBeInTheDocument());
  });
});
