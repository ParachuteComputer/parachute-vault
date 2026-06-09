/**
 * Wire-shape pins for the multi-vault home's data plane.
 *
 * The load-bearing contracts:
 *   - the LIST reads the hub's public well-known doc (never the daemon's
 *     `/vaults` — not hub-proxied, rejects hub JWTs), and a 404 means
 *     "no hub front door" (direct-on-:1940 degraded mode);
 *   - CREATE posts `{name}` to hub `POST /vaults` through the host-admin
 *     authed fetch (the Bearer attachment itself is pinned by
 *     host-admin-auth.test.ts);
 *   - DELETE sends the retype-the-name `{"confirm": "<name>"}` body to
 *     `DELETE /vaults/<name>` and surfaces the structured cascade summary;
 *     the 409 last-vault refusal arrives as a VaultsApiError carrying the
 *     hub's guidance message;
 *   - per-vault usage mints a fresh (uncached) vault-admin bearer per call
 *     so the one-vault-per-document token cache is never churned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostAdminAuthedFetch } from "./host-admin-auth.ts";
import {
  VaultsApiError,
  createVaultViaHub,
  deleteVaultViaHub,
  fetchVaultUsage,
  formatBytes,
  listWellKnownVaults,
  validateNewVaultName,
} from "./multi-vault-api.ts";

vi.mock("./host-admin-auth.ts");

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listWellKnownVaults", () => {
  it("reads vaults[] from the origin-relative well-known doc", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        vaults: [
          { name: "default", url: "https://hub.example/vault/default", version: "0.5.2" },
          { name: "work", url: "https://hub.example/vault/work", version: "0.5.2" },
        ],
        services: [{ name: "parachute-vault", path: "/vault/default" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await listWellKnownVaults();
    expect(fetchMock).toHaveBeenCalledWith(
      "/.well-known/parachute.json",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.vaults.map((v) => v.name)).toEqual(["default", "work"]);
    }
  });

  it("404 → no-hub (direct-on-:1940 degraded mode)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 404 })));
    const result = await listWellKnownVaults();
    expect(result.kind).toBe("no-hub");
  });

  it("5xx → error with the status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 502 })));
    const result = await listWellKnownVaults();
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("502");
  });
});

describe("createVaultViaHub", () => {
  it("POSTs {name} to /vaults via the host-admin authed fetch; 201 → created", async () => {
    vi.mocked(hostAdminAuthedFetch).mockResolvedValue(
      jsonResponse(201, {
        name: "scratch",
        url: "https://hub.example/vault/scratch",
        version: "0.5.2",
        token: "jwt.one.shot",
        token_guidance: "shown once",
      }),
    );

    const result = await createVaultViaHub("scratch");
    expect(hostAdminAuthedFetch).toHaveBeenCalledWith("/vaults", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "scratch" }),
    });
    expect(result.created).toBe(true);
    expect(result.token).toBe("jwt.one.shot");
  });

  it("200 (idempotent re-POST) → created:false; empty token omitted", async () => {
    vi.mocked(hostAdminAuthedFetch).mockResolvedValue(
      jsonResponse(200, { name: "dup", url: "u", version: "v", token: "" }),
    );
    const result = await createVaultViaHub("dup");
    expect(result.created).toBe(false);
    expect(result.token).toBeUndefined();
  });

  it("4xx → VaultsApiError carrying the hub's error_description", async () => {
    vi.mocked(hostAdminAuthedFetch).mockResolvedValue(
      jsonResponse(400, { error: "invalid_request", error_description: "reserved name" }),
    );
    await expect(createVaultViaHub("admin")).rejects.toMatchObject({
      name: "VaultsApiError",
      status: 400,
      message: "reserved name",
    });
  });
});

describe("deleteVaultViaHub", () => {
  it("DELETEs /vaults/<name> with the retype-the-name confirm body", async () => {
    vi.mocked(hostAdminAuthedFetch).mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        name: "scratch",
        cascade: {
          tokens_revoked: 3,
          grants_rewritten: 1,
          grants_dropped: 0,
          user_vaults_removed: 2,
          invites_invalidated: 1,
          connections_torn_down: 1,
          orphaned_channels: ["legacy-tg"],
          vault_removed: true,
          module_restarted: true,
        },
        warnings: [{ step: "channel_scan", detail: "channel list returned 502" }],
      }),
    );

    const result = await deleteVaultViaHub("scratch");
    expect(hostAdminAuthedFetch).toHaveBeenCalledWith("/vaults/scratch", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "scratch" }),
    });
    expect(result.cascade.tokens_revoked).toBe(3);
    expect(result.cascade.orphaned_channels).toEqual(["legacy-tg"]);
    expect(result.warnings).toHaveLength(1);
  });

  it("409 last_vault → VaultsApiError with the hub's guidance message", async () => {
    vi.mocked(hostAdminAuthedFetch).mockResolvedValue(
      jsonResponse(409, {
        error: "last_vault",
        error_description:
          '"solo" is the last vault on this hub. Create another vault first, or use the CLI.',
      }),
    );
    let caught: unknown;
    try {
      await deleteVaultViaHub("solo");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VaultsApiError);
    const err = caught as VaultsApiError;
    expect(err.status).toBe(409);
    expect(err.code).toBe("last_vault");
    expect(err.message).toContain("last vault");
  });
});

describe("fetchVaultUsage", () => {
  it("mints a fresh per-vault bearer and reads the usage report", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === "/admin/vault-admin-token/work") {
        return Promise.resolve(jsonResponse(200, { token: "fresh.jwt" }));
      }
      if (url === "/vault/work/.parachute/usage") {
        return Promise.resolve(
          jsonResponse(200, { counts: { notes: 42 }, bytes: { total: 2048 } }),
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const usage = await fetchVaultUsage("work");
    expect(usage).toEqual({ notes: 42, totalBytes: 2048 });
    // The usage read carried the freshly-minted bearer.
    const usageCall = fetchMock.mock.calls.find((c) => c[0] === "/vault/work/.parachute/usage");
    expect(usageCall?.[1]?.headers?.authorization).toBe("Bearer fresh.jwt");
  });

  it("throws on mint failure so the row collapses to the '—' placeholder", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })),
    );
    await expect(fetchVaultUsage("work")).rejects.toThrow("mint failed");
  });
});

describe("validateNewVaultName", () => {
  it("rejects every reserved name (incl. admin)", () => {
    for (const name of ["list", "new", "assets", "admin"]) {
      expect(validateNewVaultName(name)).toContain("reserved");
    }
  });

  it("accepts near-misses and normal names", () => {
    for (const name of ["adminx", "admin2", "work", "my_vault-1"]) {
      expect(validateNewVaultName(name)).toBeNull();
    }
  });

  it("enforces charset and 2–32 length", () => {
    expect(validateNewVaultName("MyVault")).toContain("Lowercase");
    expect(validateNewVaultName("a")).toContain("2–32");
    expect(validateNewVaultName("a".repeat(33))).toContain("2–32");
    // Untouched field stays quiet.
    expect(validateNewVaultName("")).toBeNull();
  });
});

describe("formatBytes", () => {
  it("renders B / KB / MB tiers", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
