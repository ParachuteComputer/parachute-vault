/**
 * HTTP surface for the mirror lifecycle.
 *
 *   GET  /vault/<name>/.parachute/mirror — read current config + runtime status
 *   PUT  /vault/<name>/.parachute/mirror — update config + reload watch loop
 *
 * URL note: the design doc names this `/admin/mirror`, but vault's
 * existing routing already mounts the admin SPA's static-file bundle at
 * `/vault/<name>/admin/*` (vault#252). Putting the API endpoint there
 * would collide with the SPA mount. We use the existing `.parachute/`
 * namespace instead — sibling to `.parachute/config`, `.parachute/info`,
 * `.parachute/icon.svg` — which matches the module-protocol convention
 * for per-module API surfaces. The hub admin SPA (Phase A2) will call
 * this URL; operators issuing `curl` calls use it directly.
 *
 * Both endpoints gate on `vault:admin` — see `routing.ts` for the
 * upstream auth wiring. This module is the after-auth handler; the
 * caller has already verified the scope.
 *
 * These two endpoints unblock the Phase A2 hub admin SPA from configuring
 * vault-side mirrors. For Phase A1 the only consumers are direct API
 * callers (curl, the future SPA) and operators editing config.yaml by
 * hand + restarting the vault.
 */

import {
  defaultMirrorConfig,
  validateExternalPath,
  validateMirrorConfigShape,
  type MirrorConfig,
} from "./mirror-config.ts";
import type { MirrorManager } from "./mirror-manager.ts";

/**
 * `GET /vault/<name>/admin/mirror` — return the persisted config + the
 * runtime status the manager is currently tracking.
 *
 * Always returns 200 (auth was already enforced upstream). When no
 * mirror config has ever been written, returns the defaults — the
 * operator + the hub SPA see a consistent shape regardless of whether
 * any persistence has happened yet.
 */
export function handleMirrorGet(manager: MirrorManager): Response {
  const config = manager.getConfig();
  const status = manager.getStatus();
  return Response.json(
    {
      config,
      status,
    },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}

/**
 * `PUT /vault/<name>/admin/mirror` — accept a JSON body with the mirror
 * config block, validate, persist, restart the in-process lifecycle.
 *
 * Request shape: same JSON as the MirrorConfig type — { enabled,
 * location, external_path, watch, auto_commit, auto_push,
 * commit_template, interval_seconds }. All fields optional; missing
 * fields fall back to defaults.
 *
 * Validation surface:
 *   - JSON shape: location ∈ {internal, external}, types match, etc.
 *     Returns 400 with `field`-localized error on failure.
 *   - For location=external + enabled=true: the supplied external_path
 *     must exist on the filesystem AND be a git repo. Returns 400
 *     with an actionable error message on failure.
 *   - For location=external + enabled=false: skip the filesystem
 *     check (operator might be disabling a no-longer-valid path).
 *
 * Response: 200 with the new config + status snapshot.
 */
export async function handleMirrorPut(
  req: Request,
  manager: MirrorManager,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch (err) {
    return Response.json(
      {
        error: "Invalid JSON body",
        message: (err as Error).message ?? String(err),
      },
      { status: 400 },
    );
  }

  const shape = validateMirrorConfigShape(body);
  if (!shape.ok) {
    return Response.json(
      {
        error: "Invalid mirror config",
        field: shape.field,
        message: shape.error,
      },
      { status: 400 },
    );
  }

  const config: MirrorConfig = shape.config;

  // Filesystem-level validation runs only when the operator is asking us
  // to *do* something with an external path. Disabling the mirror by-
  // flipping enabled to false shouldn't fail because the path went away.
  if (config.enabled && config.location === "external" && config.external_path) {
    const pathCheck = await validateExternalPath(config.external_path);
    if (!pathCheck.ok) {
      return Response.json(
        {
          error: "Invalid external_path",
          field: "external_path",
          message: pathCheck.error,
        },
        { status: 400 },
      );
    }
  }

  // Persist + restart lifecycle. `reload` writes the config first and
  // then calls `start()`, so a crash between the two leaves the operator-
  // intended state on disk (next boot applies it).
  const status = await manager.reload(config);
  return Response.json(
    {
      config: manager.getConfig(),
      status,
    },
    { headers: { "Access-Control-Allow-Origin": "*" } },
  );
}

/**
 * Convenience for tests + future callers: build the GET response from a
 * known-good config without needing a real MirrorManager.
 */
export function buildMirrorGetResponse(
  config: MirrorConfig | undefined,
  status: ReturnType<MirrorManager["getStatus"]>,
): { config: MirrorConfig; status: ReturnType<MirrorManager["getStatus"]> } {
  return {
    config: config ?? defaultMirrorConfig(),
    status,
  };
}
