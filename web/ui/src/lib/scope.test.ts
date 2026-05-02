/**
 * JWT scope decoding. Synthetic tokens — we never verify, only inspect, so
 * any header/signature suffices. The scope shape under test is the one
 * scope-narrowing-and-audience pins: `vault:<name>:<verb>`. Broad
 * `vault:admin` should NOT satisfy `hasAdminScope("work")` because the
 * server's hub-JWT gate rejects broad shapes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { _setTokenForTest, clearToken } from "./auth.ts";
import { decodeJwtPayload, hasAdminScope, scopesFromJwt } from "./scope.ts";

function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const body = btoa(JSON.stringify(payload))
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${header}.${body}.signature-stub`;
}

describe("decodeJwtPayload", () => {
  it("returns the parsed claims object", () => {
    const token = makeJwt({ sub: "alice", scope: "vault:work:read" });
    expect(decodeJwtPayload(token)).toEqual({ sub: "alice", scope: "vault:work:read" });
  });

  it("returns null for a non-JWT input", () => {
    expect(decodeJwtPayload("not-a-jwt")).toBeNull();
    expect(decodeJwtPayload("a.b")).toBeNull();
  });

  it("returns null when the body isn't valid base64-url JSON", () => {
    expect(decodeJwtPayload("aaa.@@@.bbb")).toBeNull();
  });
});

describe("scopesFromJwt", () => {
  it("returns [] for null token", () => {
    expect(scopesFromJwt(null)).toEqual([]);
  });

  it("splits the OAuth-canonical space-separated `scope` claim", () => {
    const token = makeJwt({ scope: "vault:work:read vault:work:write" });
    expect(scopesFromJwt(token)).toEqual(["vault:work:read", "vault:work:write"]);
  });

  it("falls back to the array-shaped `scopes` claim", () => {
    const token = makeJwt({ scopes: ["vault:work:admin"] });
    expect(scopesFromJwt(token)).toEqual(["vault:work:admin"]);
  });

  it("returns [] when neither claim is present", () => {
    const token = makeJwt({ sub: "alice" });
    expect(scopesFromJwt(token)).toEqual([]);
  });
});

describe("hasAdminScope", () => {
  afterEach(() => {
    clearToken();
  });

  it("true when narrowed admin scope for the named vault is present", () => {
    _setTokenForTest(makeJwt({ scope: "vault:work:admin" }));
    expect(hasAdminScope("work")).toBe(true);
  });

  it("false when only read/write scopes are present", () => {
    _setTokenForTest(makeJwt({ scope: "vault:work:read vault:work:write" }));
    expect(hasAdminScope("work")).toBe(false);
  });

  it("false when admin is for a different vault", () => {
    _setTokenForTest(makeJwt({ scope: "vault:other:admin" }));
    expect(hasAdminScope("work")).toBe(false);
  });

  it("false when the token carries broad `vault:admin` (server rejects this shape from hub)", () => {
    _setTokenForTest(makeJwt({ scope: "vault:admin" }));
    expect(hasAdminScope("work")).toBe(false);
  });

  it("false when no token is cached", () => {
    _setTokenForTest(null);
    expect(hasAdminScope("work")).toBe(false);
  });
});
