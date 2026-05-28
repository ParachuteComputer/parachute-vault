import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import { captureTokenFromFragment, tryMintTokenFromHubSession } from "./lib/auth.ts";
import { getBasename, getMountedVaultName } from "./lib/mount.ts";
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

// Fallback bootstrap path (closes vault#382 / hub-side discovery-tile bug):
// when the operator clicked the **discovery-page** vault tile (hub.ts
// renders one per vault via `uiUrl: "/admin/"`), the browser landed here
// without a `#token=...` fragment — the discovery tile is a plain anchor,
// not a Manage-flow button. Without a token the SPA boots into the
// "auth-required" empty state ("Open this page from the hub's directory"),
// which is exactly what the operator just *did*. So if we're under a
// per-vault mount AND the fragment didn't carry a token, try to mint one
// from the hub session cookie before mounting React. The hub exposes
// `/admin/vault-admin-token/<name>` for exactly this trade; same-origin
// fetch carries the cookie automatically. Silent failure → fall through to
// the existing auth-required empty state.
//
// We chain off a Promise instead of top-level `await` because Vite's
// default esbuild target (chrome87/safari14) doesn't transpile TLA, and
// the bundle would fail to build. The mount happens in a `.then()`/
// `.catch()` continuation; the brief delay between document-ready and
// React mount is invisible to the operator (no static skeleton renders
// in `#root` — it's empty until React takes it).
const mountedVault = getMountedVaultName();
if (mountedVault) {
  tryMintTokenFromHubSession(mountedVault).then(mount, mount);
} else {
  mount();
}
