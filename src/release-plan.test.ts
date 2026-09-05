/**
 * The publish-on-merge decision.
 *
 * Release logic that can double-publish or silently drop a release is exactly
 * the kind that should not live untested in a YAML `run:` block. Every case
 * here is one where a wrong answer costs something real. Ported from
 * parachute-app's `scripts/release-plan.test.ts` onto bun:test (this repo's
 * `bun test ./src/` surface).
 */

import { describe, expect, test } from "bun:test";
import {
  compareVersions,
  coreVersion,
  decidePublish,
  distTagFor,
  matchingRcVersions,
  readRegistry,
  unpublishedDrift,
} from "../scripts/release-plan.ts";

describe("distTagFor", () => {
  test("prerelease → rc, release → latest", () => {
    expect(distTagFor("0.7.9-rc.2")).toBe("rc");
    expect(distTagFor("0.7.9")).toBe("latest");
  });
});

describe("compareVersions", () => {
  test("orders patch versions", () => {
    expect(compareVersions("0.7.5", "0.7.4")).toBeGreaterThan(0);
    expect(compareVersions("0.7.4", "0.7.5")).toBeLessThan(0);
    expect(compareVersions("0.7.5", "0.7.5")).toBe(0);
  });

  test("orders rc chains numerically, not lexically", () => {
    // The lexical trap: "rc.10" < "rc.9" as strings.
    expect(compareVersions("0.7.5-rc.10", "0.7.5-rc.9")).toBeGreaterThan(0);
    expect(compareVersions("0.7.5-rc.5", "0.7.5-rc.6")).toBeLessThan(0);
  });

  test("a release sorts above its own prereleases", () => {
    expect(compareVersions("0.7.5", "0.7.5-rc.99")).toBeGreaterThan(0);
  });

  test("major/minor dominate the prerelease suffix", () => {
    expect(compareVersions("0.8.0-rc.1", "0.7.9")).toBeGreaterThan(0);
  });
});

describe("decidePublish", () => {
  test("a fresh version publishes", () => {
    const d = decidePublish("0.7.9-rc.2", {
      versionExists: false,
      currentDistTagVersion: "0.7.9-rc.1",
    });
    expect(d).toMatchObject({ publish: true });
  });

  test("an already-published version is skipped — the idempotency guarantee", () => {
    const d = decidePublish("0.7.9-rc.1", { versionExists: true });
    expect(d).toMatchObject({ publish: false });
  });

  test("a never-published package SKIPS on a branch push — a first publish is deliberate", () => {
    // surface#220 / hub#930 / app#189: a 404 package used to read "0.1.0 is
    // not on npm" → should_publish=true, and the OIDC publish 404'd. Vault's
    // inline shell had the same hole: curling /vault/$VERSION 404s for both
    // "version missing" and "package missing".
    const d = decidePublish(
      "0.1.0",
      { versionExists: false, publishedVersions: [] },
      { branch: "main" },
    );
    expect(d).toMatchObject({ publish: false });
    expect("reason" in d && d.reason).toMatch(/first publish is a deliberate act/);
    expect("reason" in d && d.reason).toMatch(/cannot create a package/);
  });

  test("an rc of a never-published package skips too — it's the package, not the channel", () => {
    const d = decidePublish(
      "0.1.0-rc.1",
      { versionExists: false, publishedVersions: [] },
      { branch: "next" },
    );
    expect(d).toMatchObject({ publish: false });
    expect("reason" in d && d.reason).toMatch(/nothing is published under this name yet/);
  });

  test("omitted publishedVersions with no dist-tag reads as never-published — skip, don't publish", () => {
    const d = decidePublish("0.1.0-rc.1", { versionExists: false });
    expect(d).toMatchObject({ publish: false });
    expect("reason" in d && d.reason).toMatch(/nothing is published under this name yet/);
  });

  test("a never-published package on an rc TAG PUSH still tries — a human said release this", () => {
    const d = decidePublish(
      "0.1.0-rc.1",
      { versionExists: false, publishedVersions: [] },
      { isTagPush: true },
    );
    expect(d).toMatchObject({ publish: true });
    expect("reason" in d && d.reason).toMatch(/explicit tag push/);
  });

  test("a never-published STABLE on a tag push is still refused by the from-main gate", () => {
    const d = decidePublish(
      "0.1.0",
      { versionExists: false, publishedVersions: [] },
      { isTagPush: true },
    );
    expect(d).toMatchObject({ publish: false });
    expect("reason" in d && d.reason).toMatch(/from main only/);
  });

  test("an existing package is unaffected — one published version is enough", () => {
    const d = decidePublish(
      "0.7.9-rc.2",
      {
        versionExists: false,
        currentDistTagVersion: "0.7.9-rc.1",
        publishedVersions: ["0.7.9-rc.1"],
      },
      { branch: "next" },
    );
    expect(d).toMatchObject({ publish: true });
    expect("reason" in d && d.reason).toMatch(/is not on npm/);
  });

  test("an unreadable registry is still a REFUSAL, not a never-published skip", () => {
    const ambiguous = decidePublish("0.7.9-rc.1", { ambiguous: true }, { branch: "next" });
    expect(ambiguous).toMatchObject({ refuse: true });
    expect("refuse" in ambiguous && ambiguous.reason).toMatch(/refusing to guess/);
  });

  test("REFUSES to move a dist-tag backwards — the parallel-merge hazard", () => {
    const d = decidePublish("0.7.5-rc.5", {
      versionExists: false,
      currentDistTagVersion: "0.7.5-rc.6",
    });
    expect(d).toMatchObject({ refuse: true });
    expect("refuse" in d && d.reason).toMatch(/OLDER than the current rc/);
    expect("refuse" in d && d.reason).toMatch(/merged out of version order/);
  });

  test("rc and latest are tracked independently", () => {
    const d = decidePublish("0.8.0-rc.1", {
      versionExists: false,
      currentDistTagVersion: "0.7.9-rc.5",
    });
    expect(d).toMatchObject({ publish: true });
  });

  test("an ambiguous registry REFUSES rather than guessing", () => {
    const d = decidePublish("0.7.9", { ambiguous: true }, { branch: "main" });
    expect(d).toMatchObject({ refuse: true });
    expect("refuse" in d && d.reason).toMatch(/refusing to guess/);
  });

  test("an explicit rc tag push overrides the registry checks — a human said release this rc", () => {
    const d = decidePublish(
      "0.7.0-rc.1",
      {
        versionExists: false,
        currentDistTagVersion: "0.8.0",
      },
      { isTagPush: true },
    );
    expect(d).toMatchObject({ publish: true });
  });

  test("an rc tag push even overrides ambiguity", () => {
    const d = decidePublish("0.7.9-rc.1", { ambiguous: true }, { isTagPush: true });
    expect(d).toMatchObject({ publish: true });
  });

  test("next skips a stable version — stables publish from main only", () => {
    const d = decidePublish("0.7.9", { versionExists: false }, { branch: "next" });
    expect(d).toMatchObject({ publish: false });
    expect("reason" in d && d.reason).toMatch(/stable promotions publish from main only/);
  });

  test("next still publishes an rc", () => {
    const d = decidePublish(
      "0.7.9-rc.1",
      { versionExists: false, currentDistTagVersion: "0.7.8-rc.5" },
      { branch: "next" },
    );
    expect(d).toMatchObject({ publish: true });
  });

  test("main is unaffected — stable publishes as before", () => {
    const d = decidePublish(
      "0.7.9",
      {
        versionExists: false,
        currentDistTagVersion: "0.7.8",
        publishedVersions: ["0.7.8", "0.7.9-rc.1"],
      },
      { branch: "main" },
    );
    expect(d).toMatchObject({ publish: true });
  });

  test("a stable without a matching rc is refused — vault#697", () => {
    // Hub 0.7.13–0.7.16 shipped @latest with no rc of the same X.Y.Z.
    // Vault's previous plan (and the inline shell it replaced) did the same.
    const d = decidePublish(
      "0.7.9",
      {
        versionExists: false,
        currentDistTagVersion: "0.7.8",
        publishedVersions: ["0.7.8", "0.7.8-rc.2"],
      },
      { branch: "main" },
    );
    expect(d).toMatchObject({ refuse: true });
    expect("refuse" in d && d.reason).toMatch(/0\.7\.9-rc/);
    expect("refuse" in d && d.reason).toMatch(/suffix-drop|Cut an rc first/i);
  });

  test("a stable whose only published rcs are a different X.Y.Z is still refused", () => {
    const d = decidePublish(
      "0.7.9",
      {
        versionExists: false,
        currentDistTagVersion: "0.7.8",
        publishedVersions: ["0.7.8", "0.7.8-rc.1"],
      },
      { branch: "main" },
    );
    expect(d).toMatchObject({ refuse: true });
  });

  test("a stable with a matching rc publishes from main", () => {
    const d = decidePublish(
      "0.7.9",
      {
        versionExists: false,
        currentDistTagVersion: "0.7.8",
        publishedVersions: ["0.7.8", "0.7.9-rc.1"],
      },
      { branch: "main" },
    );
    expect(d).toMatchObject({ publish: true });
  });

  test("omitted publishedVersions still refuses a stable when latest already exists", () => {
    const d = decidePublish(
      "0.7.9",
      {
        versionExists: false,
        currentDistTagVersion: "0.7.8",
      },
      { branch: "main" },
    );
    expect(d).toMatchObject({ refuse: true });
  });

  test("an rc publishes even with no prior rc of the same core", () => {
    const d = decidePublish(
      "0.7.9-rc.1",
      {
        versionExists: false,
        currentDistTagVersion: "0.7.8-rc.5",
        publishedVersions: ["0.7.8", "0.7.8-rc.5"],
      },
      { branch: "next" },
    );
    expect(d).toMatchObject({ publish: true });
  });

  test("a tag push of a stable does NOT override the main-only gate", () => {
    const d = decidePublish(
      "0.7.9",
      { versionExists: false },
      { branch: "next", isTagPush: true },
    );
    expect(d).toMatchObject({ publish: false });
    expect("reason" in d && d.reason).toMatch(/from main only/);
  });

  test("a stable with no branch is refused — fail closed, don't guess the trigger", () => {
    const d = decidePublish("0.7.9", { versionExists: false });
    expect(d).toMatchObject({ publish: false });
    expect("reason" in d && d.reason).toMatch(/from main only/);
  });
});

describe("readRegistry", () => {
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  test("reads existence + the relevant dist-tag", async () => {
    const v = await readRegistry("@openparachute/vault", "0.7.9-rc.2", (() =>
      json({
        versions: { "0.7.9-rc.1": {}, "0.7.9-rc.2": {} },
        "dist-tags": { rc: "0.7.9-rc.2", latest: "0.7.8" },
      })) as unknown as typeof fetch);
    expect(v).toMatchObject({ versionExists: true, currentDistTagVersion: "0.7.9-rc.2" });
  });

  test("picks the dist-tag matching the version's channel", async () => {
    const v = await readRegistry("@openparachute/vault", "0.7.9", (() =>
      json({
        versions: {},
        "dist-tags": { rc: "0.7.9-rc.2", latest: "0.7.8" },
      })) as unknown as typeof fetch);
    expect(v).toMatchObject({ currentDistTagVersion: "0.7.8" });
  });

  test("a never-published package is not ambiguous — a 404 is knowledge", async () => {
    const v = await readRegistry("@openparachute/new", "0.1.0", (() =>
      json({}, 404)) as unknown as typeof fetch);
    expect(v).toMatchObject({ versionExists: false, publishedVersions: [] });
  });

  test("the 404 view composes into a skip — the two halves of surface#220 line up", async () => {
    const v = await readRegistry("@openparachute/new", "0.1.0", (() =>
      json({}, 404)) as unknown as typeof fetch);
    expect("ambiguous" in v).toBe(false);
    if ("ambiguous" in v) return;
    const d = decidePublish("0.1.0", v, { branch: "main" });
    expect(d).toMatchObject({ publish: false });
    expect("reason" in d && d.reason).toMatch(/first publish is a deliberate act/);
  });

  test("a populated registry returns publishedVersions", async () => {
    const v = await readRegistry("@openparachute/vault", "0.7.9-rc.3", (() =>
      json({
        versions: { "0.7.9-rc.1": {}, "0.7.9-rc.2": {} },
        "dist-tags": { rc: "0.7.9-rc.2", latest: "0.7.8" },
      })) as unknown as typeof fetch);
    expect(v).toMatchObject({
      versionExists: false,
      currentDistTagVersion: "0.7.9-rc.2",
      publishedVersions: ["0.7.9-rc.1", "0.7.9-rc.2"],
    });
  });

  test("a 5xx is ambiguous", async () => {
    const v = await readRegistry("@openparachute/vault", "1.0.0", (() =>
      json({}, 503)) as unknown as typeof fetch);
    expect(v).toMatchObject({ ambiguous: true });
  });

  test("a network throw is ambiguous, not a crash", async () => {
    const v = await readRegistry("@openparachute/vault", "1.0.0", (() =>
      Promise.reject(new Error("ECONNRESET"))) as unknown as typeof fetch);
    expect(v).toMatchObject({ ambiguous: true });
  });
});

describe("matchingRcVersions", () => {
  test("matches only the same X.Y.Z rc chain", () => {
    expect(
      matchingRcVersions("0.7.9", ["0.7.8", "0.7.8-rc.1", "0.7.9-rc.1", "0.7.9-rc.2"]),
    ).toEqual(["0.7.9-rc.1", "0.7.9-rc.2"]);
  });

  test("a prerelease still matches siblings of its core", () => {
    expect(matchingRcVersions("0.7.9-rc.3", ["0.7.9-rc.1", "0.7.8-rc.1"])).toEqual(["0.7.9-rc.1"]);
  });
});

describe("coreVersion", () => {
  test("strips the rc suffix and leaves a stable alone", () => {
    expect(coreVersion("0.7.9-rc.1")).toBe("0.7.9");
    expect(coreVersion("0.7.9")).toBe("0.7.9");
  });
});

describe("unpublishedDrift", () => {
  test("no commits → not drifted", () => {
    expect(unpublishedDrift([]).drifted).toBe(false);
    expect(unpublishedDrift(["", "  "]).drifted).toBe(false);
  });

  test("commits → drifted, counted, and LISTED", () => {
    const d = unpublishedDrift(["abc feat: one", "def fix: two"]);
    expect(d.drifted).toBe(true);
    expect(d.count).toBe(2);
    expect(d.summary).toContain("feat: one");
    expect(d.summary).toContain("fix: two");
    expect(d.summary).toMatch(/release PR/i);
  });

  test("blank lines from git's trailing newline don't inflate the count", () => {
    expect(unpublishedDrift(["abc one", ""]).count).toBe(1);
  });
});
