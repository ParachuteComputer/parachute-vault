import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
const codec = await import("./delta.js").catch(() => null);
function randomHex(size: number) {
  const bytes = new Uint8Array(size / 2);
  for (let i = 0; i < bytes.length; i += 65536)
    crypto.getRandomValues(bytes.subarray(i, i + 65536));
  return Buffer.from(bytes).toString("hex");
}
for (const [name, seed] of [["ASCII", "hello world"], ["CJK", "日本語"], ["emoji", "🐢 café naïve"], ["combining", "école résumé"], ["high Latin", "ÿþý"]]) {
  test(`P1 ${name} mid-body roundtrip`, () => {
    expect(codec).not.toBeNull();
    const lines = Array.from({ length: 500 }, (_, i) => `${i}: ${seed}`);
    const base = lines.join("\n");
    lines[200] = "new 🐙 line";
    lines.splice(300, 0, "inserted");
    const target = lines.join("\n"), payload = codec!.encodeDelta(base, target);
    expect(payload).toMatch(/^[A-Za-z0-9+/=]*$/);
    expect(codec!.decodeDelta(base, payload)).toBe(target);
  });
}
test("P1 large independent bodies exercise a large delta without spread", () => {
  expect(codec).not.toBeNull();
  const base = randomHex(2000000), target = randomHex(2000000);
  const payload = codec!.encodeDelta(base, target);
  expect(atob(payload).length).toBeGreaterThanOrEqual(1000000);
  expect(codec!.decodeDelta(base, payload)).toBe(target);
});
test("P1 identity is small and corrupted checksum / copied base throws", () => {
  expect(codec).not.toBeNull();
  const base = "unique numbered line\n".repeat(500);
  expect(codec!.encodeDelta(base, base).length).toBeLessThan(32);
  const payload = codec!.encodeDelta(base, base + "tail");
  const bytes = Buffer.from(payload, "base64");
  // Alter a checksum digit, not a framing byte.
  bytes[bytes.length - 2] = bytes[bytes.length - 2] === 48 ? 49 : 48;
  expect(() => codec!.decodeDelta(base, bytes.toString("base64"))).toThrow("bad checksum");
  expect(() => codec!.decodeDelta(base.replaceAll("u", "X"), payload)).toThrow("bad checksum");
});
test("P2 vendor provenance and removed string surface", () => {
  expect(codec).not.toBeNull();
  for (const key of ["createStringDelta", "applyStringDelta", "getStringDeltaTargetSize"])
    expect(key in codec!).toBe(false);
  const source = readFileSync(new URL("./vendor/fossil-delta.ts", import.meta.url), "utf8");
  expect(source.startsWith("// @" + "ts-nocheck\n")).toBe(true);
  expect(source).toContain("BSD 2-Clause");
  expect(source).toContain("29d795837d08ff9305e145d20611e721e52aa29969c10c39c8f9d3d51be67b6c");
  expect(source).toContain("sha512-rcvnd0xjV7KNkEbXhTCsjHhONvdami+WWhTYGf4ORkPk9ixkQDmVeII96F6wBD/6qa9zBjH15bOzSARKsQ/rKg==");
});
