import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import { captureTokenFromFragment } from "./lib/auth.ts";
import "./styles.css";

// Capture a hub-issued JWT from the URL fragment if present (e.g. when the
// operator clicked "Manage Vault" in the hub directory). Strip it from the
// visible URL so a refresh, copy/paste, or screenshot can't leak the token.
captureTokenFromFragment();

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

// `basename` is mount-aware: production builds use `/admin/`, dev uses `/`.
// Stripping the trailing slash matches react-router's expectation. Without
// this the SPA's <Link to="/vault/..."> would resolve at the origin root,
// blowing past vault's /admin/* mount and 404ing.
createRoot(root).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
