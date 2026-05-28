/**
 * vault#400 — per-vault mirror config + manager + routes.
 *
 * The bug this file pins: before vault#400, the vault admin SPA showed the
 * SAME git remote (the default vault's) on EVERY vault's mirror page, because
 * the server held a SINGLE MirrorManager bound to the default/first vault and
 * every mirror route resolved to it — ignoring the URL's vault name. Config
 * was a single server-wide `mirror:` block, so configuring vault B clobbered
 * vault A. vault#399 fixed credential STORAGE per-vault; this completes the
 * job with per-vault CONFIG + per-vault MANAGER + routes that resolve by URL
 * vault name.
 *
 * These tests exercise the REAL production seams end-to-end — real per-vault
 * config files, the real registry, the real route handlers, real per-vault
 * SQLite stores via `buildMirrorDeps` — against a fresh PARACHUTE_HOME. Two
 * vaults (A, B) with DIFFERENT configs prove no bleed + no clobber.
 */

import { describe, test, expect, afterEach, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  defaultMirrorConfig,
  mirrorConfigPath,
  readMirrorConfigForVault,
  writeMirrorConfigForVault,
  migrateLegacyServerWideConfig,
  type MirrorConfig,
} from "./mirror-config.ts";
import {
  clearMirrorManagers,
  getMirrorManager,
  setMirrorManager,
  setMirrorManagerFactory,
} from "./mirror-registry.ts";
import { MirrorManager } from "./mirror-manager.ts";
import { buildMirrorDeps } from "./mirror-deps.ts";
import {
  handleMirrorGet,
  handleMirrorPut,
  handleAuthGet,
} from "./mirror-routes.ts";
import {
  writeCredentials,
  emptyCredentials,
  mirrorCredentialsPath,
  type MirrorCredentials,
} from "./mirror-credentials.ts";
import { writeVaultConfig } from "./config.ts";

const ORIG_HOME = process.env.HOME;
const ORIG_PARACHUTE_HOME = process.env.PARACHUTE_HOME;

afterEach(() => {
  clearMirrorManagers();
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_PARACHUTE_HOME === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = ORIG_PARACHUTE_HOME;
});
afterAll(() => {
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
});

function tmpHome(prefix: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.PARACHUTE_HOME = home;
  process.env.HOME = home;
  return home;
}

/** Create a real vault on disk (data dir + vault.yaml + SQLite store). */
function makeVault(name: string): void {
  fs.mkdirSync(path.join(process.env.PARACHUTE_HOME!, "vault", "data", name), {
    recursive: true,
  });
  writeVaultConfig({
    name,
    api_keys: [],
    created_at: new Date().toISOString(),
  });
}

/** A real, registered, started manager for `name` via production deps. */
async function standUpVault(name: string): Promise<MirrorManager> {
  const mgr = new MirrorManager(buildMirrorDeps(name));
  setMirrorManager(name, mgr);
  await mgr.start();
  return mgr;
}

function patCredentials(remoteUrl: string): MirrorCredentials {
  return {
    ...emptyCredentials(),
    active_method: "pat",
    pat: { token: "ghp_faketoken1234567890", remote_url: remoteUrl, label: "test" },
  };
}

// ---------------------------------------------------------------------------
// Per-vault config storage (vault#400)
// ---------------------------------------------------------------------------

describe("per-vault config storage", () => {
  let home: string;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test("writes to data/<vault>/mirror-config.yaml; reads back per-vault", () => {
    home = tmpHome("pv-config-");
    makeVault("alpha");
    makeVault("beta");

    const cfgA: MirrorConfig = {
      ...defaultMirrorConfig(),
      enabled: true,
      location: "external",
      external_path: "/tmp/alpha-mirror",
      auto_commit: false,
    };
    writeMirrorConfigForVault("alpha", cfgA);

    // File landed in alpha's data dir, not beta's, not server-wide.
    expect(fs.existsSync(mirrorConfigPath("alpha"))).toBe(true);
    expect(fs.existsSync(mirrorConfigPath("beta"))).toBe(false);
    expect(mirrorConfigPath("alpha")).toContain(path.join("data", "alpha"));

    // Read back is alpha's; beta is undefined (never configured).
    const back = readMirrorConfigForVault("alpha");
    expect(back?.enabled).toBe(true);
    expect(back?.external_path).toBe("/tmp/alpha-mirror");
    expect(back?.auto_commit).toBe(false);
    expect(readMirrorConfigForVault("beta")).toBeUndefined();
  });

  test("writing beta does NOT mutate alpha's config file (no clobber)", () => {
    home = tmpHome("pv-noclobber-");
    makeVault("alpha");
    makeVault("beta");

    writeMirrorConfigForVault("alpha", {
      ...defaultMirrorConfig(),
      enabled: true,
      external_path: "/tmp/alpha",
    });
    const alphaBefore = fs.readFileSync(mirrorConfigPath("alpha"), "utf8");

    writeMirrorConfigForVault("beta", {
      ...defaultMirrorConfig(),
      enabled: true,
      location: "external",
      external_path: "/tmp/beta",
    });

    const alphaAfter = fs.readFileSync(mirrorConfigPath("alpha"), "utf8");
    expect(alphaAfter).toBe(alphaBefore); // byte-identical — untouched
    expect(readMirrorConfigForVault("beta")?.external_path).toBe("/tmp/beta");
  });
});

// ---------------------------------------------------------------------------
// Per-vault manager registry (vault#400)
// ---------------------------------------------------------------------------

describe("per-vault manager registry", () => {
  let home: string;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test("get/set keyed by vault; distinct instances", () => {
    home = tmpHome("pv-registry-");
    makeVault("alpha");
    makeVault("beta");
    const a = new MirrorManager(buildMirrorDeps("alpha"));
    const b = new MirrorManager(buildMirrorDeps("beta"));
    setMirrorManager("alpha", a);
    setMirrorManager("beta", b);
    expect(getMirrorManager("alpha")).toBe(a);
    expect(getMirrorManager("beta")).toBe(b);
    expect(getMirrorManager("alpha")).not.toBe(getMirrorManager("beta"));
    expect(getMirrorManager("alpha")!.getVaultName()).toBe("alpha");
    expect(getMirrorManager("beta")!.getVaultName()).toBe("beta");
  });

  test("no factory + no entry → null; factory builds on demand + binds vault", () => {
    home = tmpHome("pv-lazy-");
    makeVault("gamma");
    expect(getMirrorManager("gamma")).toBeNull(); // no factory installed yet

    setMirrorManagerFactory((name) => new MirrorManager(buildMirrorDeps(name)));
    const built = getMirrorManager("gamma");
    expect(built).not.toBeNull();
    expect(built!.getVaultName()).toBe("gamma");
    // Cached — second get returns the same lazily-built instance.
    expect(getMirrorManager("gamma")).toBe(built);
  });

  test("lazily-built manager reports THIS vault's persisted config (getEffectiveConfig)", () => {
    home = tmpHome("pv-effective-");
    makeVault("delta");
    // delta has enabled config on disk but no live (started) manager.
    writeMirrorConfigForVault("delta", {
      ...defaultMirrorConfig(),
      enabled: true,
      location: "external",
      external_path: "/tmp/delta",
    });
    setMirrorManagerFactory((name) => new MirrorManager(buildMirrorDeps(name)));
    const mgr = getMirrorManager("delta")!;
    // Never started, so live getConfig() is still the default (disabled) —
    // but getEffectiveConfig() reads the persisted truth.
    expect(mgr.getConfig().enabled).toBe(false);
    expect(mgr.getEffectiveConfig().enabled).toBe(true);
    expect(mgr.getEffectiveConfig().external_path).toBe("/tmp/delta");
  });
});

// ---------------------------------------------------------------------------
// THE BUG: routes resolve per-vault — GET A returns A's, GET B returns B's
// ---------------------------------------------------------------------------

describe("mirror routes resolve per-vault (the 'same remote on every page' bug)", () => {
  let home: string;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test("GET A returns A's config; GET B returns B's — never A's on B's page", async () => {
    home = tmpHome("pv-get-distinct-");
    makeVault("alpha");
    makeVault("beta");

    // Two DIFFERENT configs persisted per-vault.
    writeMirrorConfigForVault("alpha", {
      ...defaultMirrorConfig(),
      enabled: true,
      location: "external",
      external_path: "/tmp/alpha-mirror",
      auto_push: false,
    });
    writeMirrorConfigForVault("beta", {
      ...defaultMirrorConfig(),
      enabled: true,
      location: "external",
      external_path: "/tmp/beta-mirror",
      auto_push: false,
    });

    setMirrorManagerFactory((name) => new MirrorManager(buildMirrorDeps(name)));

    // Resolve EACH vault's manager via the registry exactly as routing.ts does.
    const resA = handleMirrorGet(getMirrorManager("alpha")!);
    const resB = handleMirrorGet(getMirrorManager("beta")!);
    const bodyA = (await resA.json()) as { config: MirrorConfig };
    const bodyB = (await resB.json()) as { config: MirrorConfig };

    expect(bodyA.config.external_path).toBe("/tmp/alpha-mirror");
    expect(bodyB.config.external_path).toBe("/tmp/beta-mirror");
    // The exact symptom: B's page must NOT show A's remote.
    expect(bodyB.config.external_path).not.toBe(bodyA.config.external_path);
  });

  test("GET on an unconfigured vault returns 'not configured' (disabled), not the default vault's", async () => {
    home = tmpHome("pv-get-unconfigured-");
    makeVault("alpha"); // default/first — configured + enabled
    makeVault("beta"); // never configured

    writeMirrorConfigForVault("alpha", {
      ...defaultMirrorConfig(),
      enabled: true,
      location: "external",
      external_path: "/tmp/alpha-mirror",
    });
    setMirrorManagerFactory((name) => new MirrorManager(buildMirrorDeps(name)));

    const resB = handleMirrorGet(getMirrorManager("beta")!);
    const bodyB = (await resB.json()) as { config: MirrorConfig; status: { enabled: boolean } };
    // beta is disabled + has no external_path — NOT alpha's "/tmp/alpha-mirror".
    expect(bodyB.config.enabled).toBe(false);
    expect(bodyB.config.external_path).toBeNull();
    expect(bodyB.status.enabled).toBe(false);
  });

  test("PUT B does not mutate A's persisted config (no clobber via route)", async () => {
    home = tmpHome("pv-put-noclobber-");
    makeVault("alpha");
    makeVault("beta");

    // A configured + persisted first.
    writeMirrorConfigForVault("alpha", {
      ...defaultMirrorConfig(),
      enabled: true,
      location: "internal",
      auto_commit: false,
      sync_mode: "manual",
    });
    const alphaBefore = readMirrorConfigForVault("alpha")!;

    setMirrorManagerFactory((name) => new MirrorManager(buildMirrorDeps(name)));

    // PUT B's config via the real handler (resolved per-vault).
    const req = new Request("http://x/vault/beta/.parachute/mirror", {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        location: "internal",
        sync_mode: "manual",
        auto_commit: true, // DIFFERENT from A
      }),
    });
    const res = await handleMirrorPut(req, getMirrorManager("beta")!);
    expect(res.status).toBe(200);

    // A's persisted config is unchanged.
    const alphaAfter = readMirrorConfigForVault("alpha")!;
    expect(alphaAfter).toEqual(alphaBefore);
    expect(alphaAfter.auto_commit).toBe(false); // A still false
    // B got its own config.
    expect(readMirrorConfigForVault("beta")!.auto_commit).toBe(true);

    await getMirrorManager("beta")!.stop();
    await getMirrorManager("alpha")!.stop();
  });
});

// ---------------------------------------------------------------------------
// Per-vault credentials surface (vault#399 storage, vault#400 routing)
// ---------------------------------------------------------------------------

describe("getMirrorAuth resolves per-vault (never bleeds A's creds onto B)", () => {
  let home: string;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test("auth GET returns B's remote, or none — never A's", async () => {
    home = tmpHome("pv-auth-");
    makeVault("alpha");
    makeVault("beta");

    // A has a PAT pointing at A's repo. B has its OWN PAT at B's repo.
    writeCredentials("alpha", patCredentials("https://x-access-token:tok@github.com/me/alpha.git"));
    writeCredentials("beta", patCredentials("https://x-access-token:tok@github.com/me/beta.git"));

    // Files are per-vault.
    expect(mirrorCredentialsPath("alpha")).toContain(path.join("data", "alpha"));
    expect(mirrorCredentialsPath("beta")).toContain(path.join("data", "beta"));

    const a = new MirrorManager(buildMirrorDeps("alpha"));
    const b = new MirrorManager(buildMirrorDeps("beta"));
    setMirrorManager("alpha", a);
    setMirrorManager("beta", b);

    const bodyA = (await handleAuthGet(a).json()) as { pat: { remote_url: string } | null };
    const bodyB = (await handleAuthGet(b).json()) as { pat: { remote_url: string } | null };
    // Redacted, but host/path survive sanitization — assert the repo differs.
    expect(bodyA.pat?.remote_url).toContain("alpha.git");
    expect(bodyB.pat?.remote_url).toContain("beta.git");
    expect(bodyB.pat?.remote_url).not.toContain("alpha.git");
  });

  test("B with no credentials returns none even when A has some", async () => {
    home = tmpHome("pv-auth-none-");
    makeVault("alpha");
    makeVault("beta");
    writeCredentials("alpha", patCredentials("https://x-access-token:tok@github.com/me/alpha.git"));
    // beta: no credentials file written.

    const b = new MirrorManager(buildMirrorDeps("beta"));
    const bodyB = (await handleAuthGet(b).json()) as { active_method: string | null; pat: unknown };
    expect(bodyB.active_method).toBeNull();
    expect(bodyB.pat).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Both vaults enabled simultaneously — boot stands up both managers
// ---------------------------------------------------------------------------

describe("both vaults enabled simultaneously", () => {
  let home: string;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test("two internal mirrors both bootstrap + run with independent paths", async () => {
    home = tmpHome("pv-both-enabled-");
    makeVault("alpha");
    makeVault("beta");

    writeMirrorConfigForVault("alpha", {
      ...defaultMirrorConfig(),
      enabled: true,
      location: "internal",
      sync_mode: "manual",
      auto_commit: false,
    });
    writeMirrorConfigForVault("beta", {
      ...defaultMirrorConfig(),
      enabled: true,
      location: "internal",
      sync_mode: "manual",
      auto_commit: false,
    });

    const a = await standUpVault("alpha");
    const b = await standUpVault("beta");

    const statusA = a.getStatus();
    const statusB = b.getStatus();
    expect(statusA.enabled).toBe(true);
    expect(statusB.enabled).toBe(true);
    // Independent on-disk mirror paths under each vault's own data dir.
    expect(statusA.mirror_path).toContain(path.join("data", "alpha", "mirror"));
    expect(statusB.mirror_path).toContain(path.join("data", "beta", "mirror"));
    expect(statusA.mirror_path).not.toBe(statusB.mirror_path);
    // Both are real git repos.
    expect(fs.existsSync(path.join(statusA.mirror_path!, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(statusB.mirror_path!, ".git"))).toBe(true);

    await a.stop();
    await b.stop();
  });
});

// ---------------------------------------------------------------------------
// Config migration — legacy server-wide `mirror:` block → owning vault
// ---------------------------------------------------------------------------

describe("legacy server-wide config migration (vault#400)", () => {
  let home: string;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  test("migrates the legacy block to the owning vault; others unaffected", () => {
    home = tmpHome("pv-migrate-");
    makeVault("first"); // owning vault (default/first)
    makeVault("second");

    const legacy: MirrorConfig = {
      ...defaultMirrorConfig(),
      enabled: true,
      location: "external",
      external_path: "/tmp/legacy-mirror",
      auto_push: true,
    };
    let commented = false;
    const result = migrateLegacyServerWideConfig(legacy, "first", () => {
      commented = true;
    });

    expect(result.migrated).toBe(true);
    if (result.migrated) expect(result.targetVaultName).toBe("first");
    expect(commented).toBe(true);

    // first got the legacy config; second got nothing.
    const firstCfg = readMirrorConfigForVault("first");
    expect(firstCfg?.enabled).toBe(true);
    expect(firstCfg?.external_path).toBe("/tmp/legacy-mirror");
    expect(firstCfg?.auto_push).toBe(true);
    expect(readMirrorConfigForVault("second")).toBeUndefined();
  });

  test("idempotent — second run is a no-op when target already configured", () => {
    home = tmpHome("pv-migrate-idem-");
    makeVault("first");

    const legacy: MirrorConfig = {
      ...defaultMirrorConfig(),
      enabled: true,
      external_path: "/tmp/legacy",
      location: "external",
    };
    const first = migrateLegacyServerWideConfig(legacy, "first", () => {});
    expect(first.migrated).toBe(true);
    const afterFirst = readMirrorConfigForVault("first");

    // Operator then edits first's config; a second migration must NOT clobber.
    writeMirrorConfigForVault("first", {
      ...afterFirst!,
      external_path: "/tmp/operator-edited",
    });
    const second = migrateLegacyServerWideConfig(legacy, "first", () => {});
    expect(second.migrated).toBe(false);
    if (!second.migrated) expect(second.reason).toBe("target_already_configured");
    // Operator's edit survives.
    expect(readMirrorConfigForVault("first")?.external_path).toBe("/tmp/operator-edited");
  });

  test("no legacy block → no-op", () => {
    home = tmpHome("pv-migrate-noblock-");
    makeVault("first");
    const result = migrateLegacyServerWideConfig(undefined, "first", () => {});
    expect(result.migrated).toBe(false);
    if (!result.migrated) expect(result.reason).toBe("no_legacy_block");
    expect(readMirrorConfigForVault("first")).toBeUndefined();
  });

  test("no target vault → no-op (leaves block for a future boot)", () => {
    home = tmpHome("pv-migrate-notarget-");
    const legacy: MirrorConfig = { ...defaultMirrorConfig(), enabled: true };
    const result = migrateLegacyServerWideConfig(legacy, null, () => {});
    expect(result.migrated).toBe(false);
    if (!result.migrated) expect(result.reason).toBe("no_target_vault");
  });
});
