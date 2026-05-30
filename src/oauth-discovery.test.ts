import { describe, expect, test } from "bun:test";
import { handleAuthorizationServer, handleProtectedResource } from "./oauth-discovery.ts";

/**
 * Regression: the per-vault discovery documents MUST advertise resource-narrowed
 * `vault:<name>:<verb>` scopes, never broad `vault:<verb>`. A broad scope makes a
 * spec-following MCP client (Claude) request `vault:read`, which the hub stamps
 * `aud=vault`, which the per-vault MCP endpoint rejects ("audience mismatch:
 * expected vault.<name>, got vault") — the live "Authorization with the MCP
 * server failed" bug. See oauth-discovery.ts + auth.ts findBroadVaultScopes.
 */
describe("oauth-discovery per-vault scopes_supported is resource-narrowed", () => {
  const req = new Request("https://hub.example.com/vault/default/.well-known/oauth-protected-resource");

  test("protected-resource metadata advertises vault:<name>:<verb>, never broad", async () => {
    const body = (await handleProtectedResource(req, "default").json()) as {
      resource: string;
      scopes_supported: string[];
    };
    expect(body.scopes_supported).toEqual([
      "vault:default:read",
      "vault:default:write",
      "vault:default:admin",
    ]);
    // No broad scope leaks through — vault rejects those on audience mismatch.
    for (const s of body.scopes_supported) {
      expect(s).not.toBe("vault:read");
      expect(s).not.toBe("vault:write");
      expect(s).not.toBe("vault:admin");
    }
    expect(body.resource).toContain("/vault/default/mcp");
  });

  test("scopes are narrowed to the specific vault name", async () => {
    const body = (await handleProtectedResource(req, "work-notes").json()) as {
      scopes_supported: string[];
    };
    expect(body.scopes_supported).toEqual([
      "vault:work-notes:read",
      "vault:work-notes:write",
      "vault:work-notes:admin",
    ]);
  });

  test("authorization-server forwarding doc also advertises narrowed scopes", async () => {
    const body = (await handleAuthorizationServer(req, "default").json()) as {
      scopes_supported: string[];
    };
    expect(body.scopes_supported).toEqual([
      "vault:default:read",
      "vault:default:write",
      "vault:default:admin",
    ]);
  });
});
