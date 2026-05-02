import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Vault mounts this SPA at `/admin/` (see src/admin-spa.ts dispatch). Build
// default IS the canonical mount so asset URLs resolve under the admin path
// when the bundle is served by the vault server — same drift paraclaw#25
// codified in mount-path-convention.md. Override with `VITE_BASE_PATH=/` for
// stand-alone dev served at the origin root.
const basePath = normalizeBase(process.env.VITE_BASE_PATH ?? "/admin/");

function normalizeBase(input: string): string {
  let b = input.startsWith("/") ? input : `/${input}`;
  if (!b.endsWith("/")) b += "/";
  return b;
}

export default defineConfig({
  base: basePath,
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      // Dev server runs under /admin/ to mirror production. Vault's own
      // surfaces — per-vault metadata, public discovery — live under
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
