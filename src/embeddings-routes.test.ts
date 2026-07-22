/**
 * Unit coverage for the semantic-search (embeddings) opt-in toggle surface
 * (0.7.3 fast-follow). Fully sandboxed — a throwaway `PARACHUTE_HOME` so the
 * config read/write path operates on a scratch `config.yaml`, and the running
 * "active" state is injected (never touches the real process-shared provider
 * memo or downloads a model).
 *
 * The snapshot builder is pure over (env, persisted, active) so most of the
 * matrix (env override wins, restart-required gap, default-off) is exercised
 * without any I/O; the handler tests verify the config write path + 400s.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readGlobalConfig, writeGlobalConfig } from "./config.ts";
import {
  buildEmbeddingsSnapshot,
  handleEmbeddingsGet,
  handleEmbeddingsPut,
  EMBEDDING_MODEL_DOWNLOAD_MB,
  type EmbeddingsSettings,
} from "./embeddings-routes.ts";

let tmpHome: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmpHome = join(tmpdir(), `vault-embed-routes-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tmpHome, "vault"), { recursive: true });
  prevHome = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = tmpHome;
  // Seed a config.yaml so readGlobalConfig has a file (port only — embeddings unset).
  writeGlobalConfig({ port: 1940 });
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

// An env with no EMBEDDINGS_ENABLED — the common self-host case.
const NO_ENV: NodeJS.ProcessEnv = {};

describe("buildEmbeddingsSnapshot", () => {
  test("default: persisted unset, no env, not active → all off, no restart", () => {
    const snap = buildEmbeddingsSnapshot({ env: NO_ENV, persistedEnabled: undefined, active: false });
    expect(snap).toEqual({
      enabled: false,
      env_override: null,
      env_forced: false,
      effective: false,
      active: false,
      restart_required: false,
      model_download_mb: EMBEDDING_MODEL_DOWNLOAD_MB,
    });
  });

  test("persisted on but not yet active → effective on, restart required", () => {
    const snap = buildEmbeddingsSnapshot({ env: NO_ENV, persistedEnabled: true, active: false });
    expect(snap.enabled).toBe(true);
    expect(snap.effective).toBe(true);
    expect(snap.active).toBe(false);
    expect(snap.restart_required).toBe(true);
  });

  test("persisted on and active → no restart required", () => {
    const snap = buildEmbeddingsSnapshot({ env: NO_ENV, persistedEnabled: true, active: true });
    expect(snap.restart_required).toBe(false);
  });

  test("env override ON wins over persisted OFF", () => {
    const snap = buildEmbeddingsSnapshot({
      env: { EMBEDDINGS_ENABLED: "true" },
      persistedEnabled: false,
      active: true,
    });
    expect(snap.enabled).toBe(false); // toggle still reflects persisted
    expect(snap.env_override).toBe(true);
    expect(snap.env_forced).toBe(true);
    expect(snap.effective).toBe(true); // env forces on
    expect(snap.restart_required).toBe(false); // active matches env-forced effective
  });

  test("env override OFF wins over persisted ON (with a pending restart while still active)", () => {
    const snap = buildEmbeddingsSnapshot({
      env: { EMBEDDINGS_ENABLED: "false" },
      persistedEnabled: true,
      active: true,
    });
    expect(snap.enabled).toBe(true); // persisted intent preserved
    expect(snap.env_override).toBe(false);
    expect(snap.env_forced).toBe(true);
    expect(snap.effective).toBe(false); // env forces off
    expect(snap.active).toBe(true);
    expect(snap.restart_required).toBe(true); // running still on, env wants off
  });

  test("unrecognized env value defers to persisted (no force)", () => {
    const snap = buildEmbeddingsSnapshot({
      env: { EMBEDDINGS_ENABLED: "maybe" },
      persistedEnabled: true,
      active: false,
    });
    expect(snap.env_override).toBeNull();
    expect(snap.env_forced).toBe(false);
    expect(snap.effective).toBe(true);
  });
});

describe("handleEmbeddingsGet", () => {
  test("reflects the persisted config.yaml value", async () => {
    writeGlobalConfig({ port: 1940, embeddings_enabled: true });
    const res = handleEmbeddingsGet(false);
    expect(res.status).toBe(200);
    const body = (await res.json()) as EmbeddingsSettings;
    expect(body.enabled).toBe(true);
    expect(body.effective).toBe(true);
    expect(body.active).toBe(false);
    expect(body.restart_required).toBe(true);
  });

  test("unset persisted → enabled false", async () => {
    const res = handleEmbeddingsGet(false);
    const body = (await res.json()) as EmbeddingsSettings;
    expect(body.enabled).toBe(false);
  });
});

describe("handleEmbeddingsPut", () => {
  function putReq(body: unknown): Request {
    return new Request("http://x/vault/default/.parachute/embeddings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  test("enabling persists embeddings_enabled: true via the config write path", async () => {
    const res = await handleEmbeddingsPut(putReq({ enabled: true }), false);
    expect(res.status).toBe(200);
    const body = (await res.json()) as EmbeddingsSettings;
    expect(body.enabled).toBe(true);
    expect(body.restart_required).toBe(true); // persisted on, injected active=false
    // The setting is actually on disk (config write path reused, not hand-rolled).
    expect(readGlobalConfig().embeddings_enabled).toBe(true);
  });

  test("disabling persists embeddings_enabled: false", async () => {
    writeGlobalConfig({ port: 1940, embeddings_enabled: true });
    const res = await handleEmbeddingsPut(putReq({ enabled: false }), true);
    expect(res.status).toBe(200);
    expect(readGlobalConfig().embeddings_enabled).toBe(false);
  });

  test("preserves other config fields on write (round-trips through serialize)", async () => {
    writeGlobalConfig({ port: 1940, discovery: "disabled", autostart: true });
    await handleEmbeddingsPut(putReq({ enabled: true }), false);
    const cfg = readGlobalConfig();
    expect(cfg.embeddings_enabled).toBe(true);
    expect(cfg.discovery).toBe("disabled");
    expect(cfg.autostart).toBe(true);
    expect(cfg.port).toBe(1940);
  });

  test("non-boolean enabled → 400", async () => {
    const res = await handleEmbeddingsPut(putReq({ enabled: "yes" }), false);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { field?: string };
    expect(body.field).toBe("enabled");
  });

  test("missing enabled → 400", async () => {
    const res = await handleEmbeddingsPut(putReq({}), false);
    expect(res.status).toBe(400);
  });

  test("non-object body → 400", async () => {
    const res = await handleEmbeddingsPut(putReq("[]"), false);
    expect(res.status).toBe(400);
  });

  test("invalid JSON → 400", async () => {
    const res = await handleEmbeddingsPut(putReq("{not json"), false);
    expect(res.status).toBe(400);
  });
});
