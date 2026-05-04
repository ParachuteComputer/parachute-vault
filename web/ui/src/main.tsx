import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import { captureTokenFromFragment } from "./lib/auth.ts";
import { getBasename } from "./lib/mount.ts";
import "./styles.css";

// Capture a hub-issued JWT from the URL fragment if present (e.g. when the
// operator clicked "Manage Vault" in the hub directory). Strip it from the
// visible URL so a refresh, copy/paste, or screenshot can't leak the token.
captureTokenFromFragment();

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

// `basename` is detected at runtime, not baked from `import.meta.env.BASE_URL`:
// vault#252 mounts this SPA per-vault at `/vault/<name>/admin/*`, and `<name>`
// isn't known at build time. Build sets a relative `base` (`./`) so asset URLs
// resolve under whichever path served `index.html`; React Router needs the
// matching runtime mount so `<Link to="/vault/foo/tokens">` resolves under
// `/vault/<name>/admin/...` rather than at the origin root.
createRoot(root).render(
  <StrictMode>
    <BrowserRouter basename={getBasename()}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
