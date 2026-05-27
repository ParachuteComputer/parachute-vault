/**
 * HTTP surface for the mirror lifecycle.
 *
 *   GET  /vault/<name>/.parachute/mirror         — read current config + runtime status
 *   PUT  /vault/<name>/.parachute/mirror         — update config + reload watch loop
 *   POST /vault/<name>/.parachute/mirror/run-now — fire a one-shot export+commit+push pass
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
 * `GET /vault/<name>/.parachute/mirror` — return the persisted config +
 * the runtime status the manager is currently tracking.
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
 * `PUT /vault/<name>/.parachute/mirror` — accept a JSON body with the
 * mirror config block, validate, persist, restart the in-process
 * lifecycle.
 *
 * Request shape: same JSON as the MirrorConfig type — { enabled,
 * location, external_path, watch, auto_commit, auto_push,
 * commit_template, interval_seconds }. All fields optional; missing
 * fields fall back to defaults.
 *
 * Validation surface:
 *   - JSON shape: location ∈ {internal, external}, types match, etc.
 *     Returns 400 with `field`-localized error on failure.
 *   - For enabled=true + location=external: the supplied external_path
 *     must exist on the filesystem AND be a git repo. Returns 400
 *     with an actionable error message on failure.
 *   - For enabled=false (any location): skip BOTH the cross-field
 *     "external requires external_path" check AND the filesystem
 *     check. Disable should never fail validation on path-related
 *     issues — the operator's just trying to turn off a mirror whose
 *     path may have gone away.
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
 * `POST /vault/<name>/.parachute/mirror/run-now` — fire a one-shot export
 * cycle right now (export → optional commit → optional push), using the
 * persisted config. Same response shape as GET so the admin SPA reuses
 * one decoder for both initial-load and after-trigger refresh.
 *
 * Refuses to fire (400) when the mirror is disabled: `runNow()` would
 * already no-op in that case, but returning a 200 with stale status
 * lets a misclick look successful. The 400 is the actionable surface
 * — "enable the mirror first, then re-trigger."
 *
 * Mutating verb, vault:admin-gated upstream in `routing.ts` (alongside
 * the GET/PUT). Auth is already enforced by the time this handler runs.
 */
export async function handleMirrorRunNow(
  manager: MirrorManager,
): Promise<Response> {
  const status = manager.getStatus();
  if (!status.enabled) {
    return Response.json(
      {
        error: "Mirror not enabled",
        message:
          "Mirror must be enabled (and successfully bootstrapped) before a manual run can fire. Enable it via PUT /.parachute/mirror first.",
      },
      { status: 400 },
    );
  }
  const updated = await manager.runNow();
  return Response.json(
    {
      config: manager.getConfig(),
      status: updated,
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
