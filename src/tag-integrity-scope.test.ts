/**
 * Tag-scope scrub on the two vault#552 taxonomy-integrity guards:
 * `tag_referenced_as_parent` (delete-tag's referential-integrity refusal)
 * and `parent_cycle` (upsertTagRecord's write-time cycle guard). Same "in
 * doubt, scrub" posture as `tag_field_conflict` (see
 * tag-field-conflict-scope.test.ts) — the write stays rejected regardless
 * of scope, but an out-of-scope tag name must never appear in the response.
 *
 * Reachability note: for BOTH guards, the offending tag(s) the scrub would
 * redact are, by construction, always descendants of the tag the caller is
 * already scoped to (deleteTag's `referencing_tags` are children of the
 * doomed tag; `findParentCycle`'s conflicting parent + path are members of
 * `getTagDescendants(hierarchy, tag)`, the SAME computation
 * `expandTokenTagScope` uses to build the caller's allowlist for that same
 * `tag`). So under the CURRENT hierarchy-based tag-scope model, a live
 * end-to-end request can't actually construct an out-of-scope referrer —
 * the scrub is defense-in-depth for a future change to either guard (e.g. if
 * `deleteTag`'s search ever widens past direct parent_names children). These
 * tests exercise the scrub functions directly against a synthetic
 * out-of-scope input to pin the CONTRACT ("an out-of-scope name never
 * survives"), independent of today's reachability.
 */
import { describe, test, expect } from "bun:test";
import { scrubReferencingTagsByScope, scrubParentCycleError } from "./tag-scope.ts";
import { ParentCycleError } from "../core/src/tag-schemas.ts";

describe("scrubReferencingTagsByScope (vault#552)", () => {
  test("unscoped caller (allowed === null): passthrough, no redaction", () => {
    const result = scrubReferencingTagsByScope(["child-a", "secret-child"], null);
    expect(result).toEqual(["child-a", "secret-child"]);
  });

  test("scoped caller: in-scope names kept, out-of-scope names redacted to a generic label — never the real name", () => {
    const allowed = new Set(["child-a"]);
    const result = scrubReferencingTagsByScope(["child-a", "secret-child"], allowed);
    expect(result[0]).toBe("child-a");
    expect(result[1]).not.toBe("secret-child");
    expect(result.join(" ")).not.toContain("secret-child");
    expect(result[1]).toContain("outside your token's tag scope");
  });

  test("every referencing tag out of scope: every entry redacted, count preserved", () => {
    const allowed = new Set<string>(["unrelated"]);
    const result = scrubReferencingTagsByScope(["secret-1", "secret-2"], allowed);
    expect(result).toHaveLength(2);
    for (const r of result) {
      expect(r).not.toBe("secret-1");
      expect(r).not.toBe("secret-2");
    }
  });

  test("empty referencing list stays empty", () => {
    expect(scrubReferencingTagsByScope([], new Set())).toEqual([]);
  });
});

describe("scrubParentCycleError (vault#552)", () => {
  test("unscoped caller (allowed === null): passthrough, same instance semantics (message/tag/cycle unchanged)", () => {
    const err = new ParentCycleError("mine", ["mine", "secret-hop", "mine"]);
    const scrubbed = scrubParentCycleError(err, null);
    expect(scrubbed).toBe(err);
  });

  test("every hop in scope: passthrough, original error returned untouched", () => {
    const err = new ParentCycleError("mine", ["mine", "child", "mine"]);
    const allowed = new Set(["mine", "child"]);
    const scrubbed = scrubParentCycleError(err, allowed);
    expect(scrubbed).toBe(err);
    expect(scrubbed.cycle).toEqual(["mine", "child", "mine"]);
  });

  test("an out-of-scope hop is generalized: the caller's own tag stays named, the out-of-scope hop does not, and the write is still reported rejected", () => {
    const err = new ParentCycleError("mine", ["mine", "secret-hop", "mine"]);
    const allowed = new Set(["mine"]); // "secret-hop" deliberately excluded
    const scrubbed = scrubParentCycleError(err, allowed);

    expect(scrubbed).not.toBe(err); // a REPLACEMENT error, not the original
    expect(scrubbed.error_type).toBe("parent_cycle");
    expect(scrubbed.tag).toBe("mine"); // the caller's own tag — always in-scope, never redacted
    expect(scrubbed.cycle[0]).toBe("mine");
    expect(scrubbed.cycle[2]).toBe("mine");
    expect(scrubbed.cycle[1]).not.toBe("secret-hop");
    expect(scrubbed.cycle.join(" ")).not.toContain("secret-hop");
    expect(scrubbed.message).not.toContain("secret-hop");
    expect(scrubbed.message).toContain("cycle");
  });

  test("multiple out-of-scope hops in a longer chain are each redacted independently", () => {
    const err = new ParentCycleError("mine", ["mine", "secret-1", "secret-2", "mine"]);
    const allowed = new Set(["mine"]);
    const scrubbed = scrubParentCycleError(err, allowed);
    expect(scrubbed.cycle[1]).not.toBe("secret-1");
    expect(scrubbed.cycle[2]).not.toBe("secret-2");
    expect(scrubbed.cycle.join(" ")).not.toContain("secret-1");
    expect(scrubbed.cycle.join(" ")).not.toContain("secret-2");
  });
});
