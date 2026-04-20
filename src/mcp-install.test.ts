/**
 * Tests for the MCP URL picker used by `mcp-install`. The picker must match
 * vault's advertised OAuth issuer for the origin a client will reach it on —
 * otherwise Claude Code (and any strict RFC 8414 client) rejects the
 * discovery response on issuer/origin mismatch.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chooseMcpUrl } from "./mcp-install.ts";

describe("chooseMcpUrl", () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    origHome = process.env.PARACHUTE_HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "vault-mcp-install-"));
    process.env.PARACHUTE_HOME = tmpHome;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.PARACHUTE_HOME;
    else process.env.PARACHUTE_HOME = origHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test("prefers PARACHUTE_HUB_ORIGIN when set", () => {
    const res = chooseMcpUrl("default", 1940, {
      PARACHUTE_HUB_ORIGIN: "https://hub.example",
    });
    expect(res).toEqual({
      url: "https://hub.example/vault/default/mcp",
      source: "hub-origin",
    });
  });

  test("strips trailing slash on PARACHUTE_HUB_ORIGIN", () => {
    const res = chooseMcpUrl("default", 1940, {
      PARACHUTE_HUB_ORIGIN: "https://hub.example/",
    });
    expect(res.url).toBe("https://hub.example/vault/default/mcp");
  });

  test("falls back to tailnet/public FQDN from expose-state.json when hub env unset", () => {
    fs.writeFileSync(
      path.join(tmpHome, "expose-state.json"),
      JSON.stringify({
        version: 1,
        layer: "tailnet",
        mode: "path",
        canonicalFqdn: "parachute.taildf9ce2.ts.net",
        port: 1940,
        funnel: false,
        entries: [],
      }),
    );
    const res = chooseMcpUrl("default", 1940, {});
    expect(res).toEqual({
      url: "https://parachute.taildf9ce2.ts.net/vault/default/mcp",
      source: "expose-state",
    });
  });

  test("uses public FQDN from expose-state.json when layer is public", () => {
    fs.writeFileSync(
      path.join(tmpHome, "expose-state.json"),
      JSON.stringify({
        version: 1,
        layer: "public",
        mode: "subdomain",
        canonicalFqdn: "vault.parachute.computer",
        port: 1940,
        funnel: true,
        entries: [],
      }),
    );
    const res = chooseMcpUrl("default", 1940, {});
    expect(res.url).toBe("https://vault.parachute.computer/vault/default/mcp");
    expect(res.source).toBe("expose-state");
  });

  test("falls back to loopback when no hub env and no expose-state", () => {
    const res = chooseMcpUrl("default", 1940, {});
    expect(res).toEqual({
      url: "http://127.0.0.1:1940/vault/default/mcp",
      source: "loopback",
    });
  });

  test("hub env wins over an active exposure", () => {
    fs.writeFileSync(
      path.join(tmpHome, "expose-state.json"),
      JSON.stringify({
        version: 1,
        layer: "tailnet",
        mode: "path",
        canonicalFqdn: "parachute.taildf9ce2.ts.net",
        port: 1940,
        funnel: false,
        entries: [],
      }),
    );
    const res = chooseMcpUrl("default", 1940, {
      PARACHUTE_HUB_ORIGIN: "https://hub.example",
    });
    expect(res.source).toBe("hub-origin");
    expect(res.url).toBe("https://hub.example/vault/default/mcp");
  });

  test("falls back to loopback on a malformed expose-state.json", () => {
    fs.writeFileSync(path.join(tmpHome, "expose-state.json"), "{ not json");
    const res = chooseMcpUrl("default", 1940, {});
    expect(res.source).toBe("loopback");
  });

  test("honors the passed-in vault name in the URL path", () => {
    const res = chooseMcpUrl("work", 1940, {
      PARACHUTE_HUB_ORIGIN: "https://hub.example",
    });
    expect(res.url).toBe("https://hub.example/vault/work/mcp");
  });
});
