import { describe, test, expect } from "bun:test";
import { resolveBindHostname } from "./bind.ts";

describe("resolveBindHostname", () => {
  test("defaults to 127.0.0.1 when VAULT_BIND is unset", () => {
    expect(resolveBindHostname({})).toBe("127.0.0.1");
  });

  test("honors VAULT_BIND=0.0.0.0 for Docker / LAN", () => {
    expect(resolveBindHostname({ VAULT_BIND: "0.0.0.0" })).toBe("0.0.0.0");
  });

  test("honors a specific interface IP in VAULT_BIND", () => {
    expect(resolveBindHostname({ VAULT_BIND: "10.0.0.5" })).toBe("10.0.0.5");
  });

  test("treats empty VAULT_BIND as unset", () => {
    expect(resolveBindHostname({ VAULT_BIND: "" })).toBe("127.0.0.1");
  });

  test("treats whitespace-only VAULT_BIND as unset", () => {
    expect(resolveBindHostname({ VAULT_BIND: "   " })).toBe("127.0.0.1");
  });

  test("trims surrounding whitespace", () => {
    expect(resolveBindHostname({ VAULT_BIND: "  127.0.0.1  " })).toBe("127.0.0.1");
  });
});
