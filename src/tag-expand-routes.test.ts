/**
 * REST `?expand=` parsing for `parseNotesQueryOpts` — vault tag `expand` axis
 * (design 2026-06-09). Validates the four-value enum, the 400 on a bad value,
 * and that an ABSENT param leaves `expand` undefined (so the store resolves it
 * to "subtypes" → byte-identical to pre-axis behavior).
 */

import { describe, it, expect } from "bun:test";
import { parseNotesQueryOpts } from "./routes.ts";

function parse(qs: string) {
  return parseNotesQueryOpts(new URL(`http://localhost/api/notes?${qs}`));
}

describe("parseNotesQueryOpts — expand axis", () => {
  it("absent → queryOpts.expand is undefined (default = subtypes at the store)", () => {
    const r = parse("tag=entity");
    expect(r.error).toBeUndefined();
    expect(r.queryOpts!.expand).toBeUndefined();
  });

  for (const mode of ["subtypes", "namespace", "both", "exact"] as const) {
    it(`expand=${mode} parses through`, () => {
      const r = parse(`tag=entity&expand=${mode}`);
      expect(r.error).toBeUndefined();
      expect(r.queryOpts!.expand).toBe(mode);
    });
  }

  it("empty expand= is treated as absent (undefined)", () => {
    const r = parse("tag=entity&expand=");
    expect(r.error).toBeUndefined();
    expect(r.queryOpts!.expand).toBeUndefined();
  });

  it("unknown expand value → 400 with INVALID_QUERY", async () => {
    const r = parse("tag=entity&expand=bogus");
    expect(r.queryOpts).toBeUndefined();
    expect(r.error).toBeDefined();
    expect(r.error!.status).toBe(400);
    const body = await r.error!.json();
    expect(body.code).toBe("INVALID_QUERY");
    expect(body.error).toContain("expand");
  });
});
