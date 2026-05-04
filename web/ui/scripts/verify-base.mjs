// Regression check: the per-vault SPA mount (vault#252) needs asset URLs to
// resolve under `/vault/<name>/admin/` — and `<name>` isn't known at build
// time, so the only shape that works is *relative* (`./assets/...`). If
// `vite.config.ts`'s `base` ever drifts to an absolute prefix like `/admin/`,
// the bundle HTML loses portability and 404s under any non-`/admin/` mount —
// the same silent failure paraclaw#25 codified in mount-path-convention.md.
//
// Skipped when VITE_BASE_PATH is set explicitly (legitimate override).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const override = process.env.VITE_BASE_PATH;
if (override && override !== "./") {
  console.log(`verify-base: VITE_BASE_PATH=${override} (override) — skipping default-mount check.`);
  process.exit(0);
}

const html = readFileSync(resolve("dist/index.html"), "utf8");
const wantPrefix = "./assets/";
const hasRelative = html.includes(`src="${wantPrefix}`) || html.includes(`href="${wantPrefix}`);
if (!hasRelative) {
  console.error(
    "✖ verify-base: dist/index.html is missing relative (./assets/...) asset URLs.\n" +
      "  This means vite's `base` resolved to something other than `./`.\n" +
      "  Check web/ui/vite.config.ts (default should be `./`) and any\n" +
      "  VITE_BASE_PATH env var leaking into the build environment.\n" +
      "  Per-vault mount (/vault/<name>/admin/) requires relative asset URLs\n" +
      "  since <name> isn't known at build time.",
  );
  process.exit(1);
}
console.log("verify-base: ✓ dist/index.html references relative ./assets/ paths.");
