import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import { captureTokenFromFragment, tryMintTokenFromHubSession } from "./lib/auth.ts";
import { getBasename, getMountedVaultName, isMultiVaultMount } from "./lib/mount.ts";
import "./styles.css";

// Capture a hub-issued JWT from the URL fragment if present (e.g. when the
// operator clicked "Manage Vault" in the hub admin SPA's vault list). Strip
// it from the visible URL so a refresh, copy/paste, or screenshot can't
// leak the token.
captureTokenFromFragment();

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

// `basename` is detected at runtime, not baked from `import.meta.env.BASE_URL`:
// vault#252 mounts this SPA per-vault at `/vault/<name>/admin/*`, and `<name>`
// isn't known at build time. Build sets a relative `base` (`./`) so asset URLs
// resolve under whichever path served `index.html`; React Router needs the
// matching runtime mount so `<Link to="/vault/foo/tokens">` resolves under
// `/vault/<name>/admin/...` rather than at the origin root.
function mount(): void {
  createRoot(root!).render(
    <StrictMode>
      <BrowserRouter basename={getBasename()}>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
}

// Silent-refresh bootstrap (covers vault#382 / hub-side discovery-tile
// bug AND the page-refresh papercut). Two ways the SPA boots without a
// fragment-supplied token:
//
//   1. Operator clicked the **discovery-page** vault tile (hub.ts renders
//      one per vault via `uiUrl: "/admin/"`). The tile is a plain anchor,
//      not a Manage-flow button — no token in the URL.
//   2. Operator hit Cmd+R on an authenticated admin page. The fragment
//      was scrubbed by `captureTokenFromFragment` on the prior boot and
//      the in-memory token died with the page. Aaron hits this often
//      enough that it was a real papercut.
//
// In both cases, if we're under a per-vault mount AND the fragment didn't
// carry a token, mint a fresh one from the hub session cookie before
// mounting React. The hub exposes `/admin/vault-admin-token/<name>` for
// exactly this trade; same-origin fetch carries the cookie automatically.
// On success the SPA boots into a fully-authenticated state. On failure
// (no hub session, expired session, vault not on this hub) the SPA
// boots into the `SignInBanner` empty state, which polls + auto-recovers
// once the operator signs in to the hub in another tab.
//
// We chain off a Promise instead of top-level `await` because Vite's
// default esbuild target (chrome87/safari14) doesn't transpile TLA, and
// the bundle would fail to build. The mount happens in a `.then()`/
// `.catch()` continuation; the brief delay between document-ready and
// React mount is invisible to the operator (no static skeleton renders
// in `#root` — it's empty until React takes it).
//
// Multi-vault mode (the daemon-level `/vault/admin/` home, B3) SKIPS the
// per-vault boot mint entirely: there is no single vault to mint against,
// and the per-vault token cache is one-vault-per-document by design. The
// home view mints what it needs lazily — a host-admin bearer for
// create/delete (`lib/host-admin-auth.ts`) and short-lived per-vault
// bearers for the usage cells (`lib/multi-vault-api.ts`, uncached).
const mountedVault = getMountedVaultName();
if (!isMultiVaultMount() && mountedVault) {
  tryMintTokenFromHubSession(mountedVault).then(mount, mount);
} else {
  mount();
}
