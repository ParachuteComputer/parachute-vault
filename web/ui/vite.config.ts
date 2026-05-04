import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Vault#252 moves the SPA from origin-rooted `/admin/*` to per-vault
// `/vault/<name>/admin/*`. The vault name isn't known at build time, so we
// can't bake an absolute base path into asset URLs the way hub does. The
// build default is RELATIVE (`./`): asset references in `dist/index.html`
// look like `./assets/index-abc.js` and resolve correctly under whichever
// `/vault/<name>/admin/` mount served the HTML.
//
// Dev (`bun run dev`) still serves under `/admin/` to mirror the legacy
// origin-rooted mount — the proxy below forwards `/vault/*` and `/vaults/*`
// to the running vault server so SPA fetches land on real per-vault APIs.
// Override with `VITE_BASE_PATH=/` for stand-alone dev served at the
// origin root.
const basePath = process.env.VITE_BASE_PATH ?? "./";

export default defineConfig({
  base: basePath,
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      // Dev server runs under /admin/ to mirror the legacy mount. Vault's
      // own surfaces — per-vault metadata, public discovery — live under
      // /vault/* and /vaults/* on the origin; proxy those so SPA fetches
      // hit the running vault server (default http://127.0.0.1:1940).
      "/vault": {
        target: process.env.VAULT_ORIGIN ?? "http://127.0.0.1:1940",
        changeOrigin: true,
      },
      "/vaults": {
        target: process.env.VAULT_ORIGIN ?? "http://127.0.0.1:1940",
        changeOrigin: true,
      },
    },
  },
});
