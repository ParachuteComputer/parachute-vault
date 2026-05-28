import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // `vi.stubGlobal("fetch", ...)` (used by tokens-api / host-admin-auth
  // tests) is NOT undone by `restoreAllMocks` — it needs an explicit
  // unstub. Without this, a stubbed `fetch` leaks into whichever file the
  // worker schedules next; it surfaced as a flaky VaultMirror "Push now"
  // failure (the leaked global perturbed the credential-load render timing).
  // Unstubbing here keeps every suite's global surface clean between tests.
  vi.unstubAllGlobals();
});
