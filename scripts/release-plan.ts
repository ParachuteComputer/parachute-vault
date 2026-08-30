/**
 * Decide whether @openparachute/vault should publish, for the publish-on-merge
 * workflow.
 *
 * Port of parachute-app's `scripts/release-plan.ts` (itself from hub#790),
 * replacing the untested inline shell in `.github/workflows/release.yml`.
 * Release logic that can double-publish or silently drop a release deserves
 * unit tests, not a `run:` block.
 *
 * Vault's previous plan job curled
 * `https://registry.npmjs.org/@openparachute%2fvault/$VERSION` and treated
 * HTTP 404 as "not published → publish". A 404 on that URL is also what a
 * package that does not exist at all returns, and npm trusted publishing
 * (OIDC) cannot CREATE a package (surface#220 / hub#930 / app#189). This
 * file's `readRegistry` fetches the package document, so "never published"
 * (empty `publishedVersions`) is distinct from "this version is new".
 *
 * Unlike hub, this function has no matchingRcVersions()/suffix-drop check —
 * the from-main gate is the only thing stopping a stable on `next` from
 * going straight to `@latest`, matching the shell this replaces.
 *
 * `@openparachute/vault` is already on npm. The skip is so a second
 * package, or a forgotten `publishedVersions` plumbing, cannot 404 the
 * Release run.
 */

/** Where a version stands relative to what's already published. */
export type PublishDecision =
  | { publish: true; reason: string }
  | { publish: false; reason: string }
  | { refuse: true; reason: string };

export interface RegistryView {
  /** True when this exact version is already on npm. */
  versionExists: boolean;
  /** Current version behind the dist-tag we'd move (`rc` or `latest`). */
  currentDistTagVersion?: string;
  /**
   * Every version currently on npm. When it is empty AND no dist-tag
   * resolves, the package has never been published at all (surface#220).
   * Omitted is treated as empty, which means "never published" and skips.
   * That is the safe direction for a plumbing mistake: a forgotten list can
   * only cost a skip, never an attempted first-publish npm will 404. An
   * unreadable registry is `{ ambiguous: true }`, not an empty list.
   */
  publishedVersions?: readonly string[];
}

/** `rc` for a prerelease, `latest` otherwise. */
export function distTagFor(version: string): "rc" | "latest" {
  return /-rc\./.test(version) ? "rc" : "latest";
}

/**
 * Compare two semver-ish versions. Returns <0, 0, >0.
 *
 * Deliberately small rather than pulling a dependency into CI: handles
 * `X.Y.Z` and `X.Y.Z-rc.N`, which is the entire shape governance allows. A
 * release version always sorts ABOVE its own prereleases (0.7.5 > 0.7.5-rc.9),
 * matching semver.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split("-");
    const nums = (core ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
    // No prerelease sorts above any prerelease → Infinity.
    const preNum = pre
      ? Number.parseInt(pre.replace(/^rc\./, ""), 10) || 0
      : Number.POSITIVE_INFINITY;
    return { nums, preNum };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.preNum === pb.preNum) return 0;
  return pa.preNum < pb.preNum ? -1 : 1;
}

/**
 * The decision. `isTagPush` short-circuits the registry guards for **rc**
 * versions — an explicit rc tag is a human saying "release this". It does
 * **not** short-circuit the stable-from-main gate: a write token can push a
 * tag, and that is not the same as merging to `main`.
 */
export function decidePublish(
  version: string,
  registry: RegistryView | { ambiguous: true },
  opts: { isTagPush?: boolean; branch?: string } = {},
): PublishDecision {
  // Stables publish from `main` only. Checked first so a tag push of
  // `vX.Y.Z` (or a suffix-drop merged to `next`) cannot promote `@latest`.
  if (distTagFor(version) !== "rc") {
    const fromMain = !opts.isTagPush && opts.branch === "main";
    if (!fromMain) {
      return {
        publish: false,
        reason: `${version} is a stable version — stable promotions publish from main only (not next, not a tag push)`,
      };
    }
  }
  if (opts.isTagPush) {
    return { publish: true, reason: `explicit tag push for ${version}` };
  }
  if ("ambiguous" in registry) {
    return {
      refuse: true,
      reason:
        "couldn't determine what's published (registry error) — refusing to guess, " +
        "since a wrong answer either double-publishes or drops a release",
    };
  }
  if (registry.versionExists) {
    return { publish: false, reason: `${version} is already on npm` };
  }
  // Nothing on npm under this name AT ALL — not "this version is new", but
  // "this package does not exist". Trusted publishing cannot create it, so a
  // merge-driven run would 404 (surface#220). Distinct from `ambiguous`
  // above: that is a registry we couldn't read, this is a registry that
  // answered 404. Only the second one is knowledge.
  if ((registry.publishedVersions ?? []).length === 0 && !registry.currentDistTagVersion) {
    return {
      publish: false,
      reason: `nothing is published under this name yet, and ${version} would be its first release — a first publish is a deliberate act, not a merge side-effect. npm trusted publishing cannot create a package, only add versions to one that already trusts this workflow. Publish once by hand (or push an explicit rc tag), wire up the trusted publisher, and merge-driven releases take over from the second version on.`,
    };
  }
  const current = registry.currentDistTagVersion;
  if (current && compareVersions(version, current) < 0) {
    return {
      refuse: true,
      reason: `${version} is OLDER than the current ${distTagFor(version)} (${current}) — publishing would move the dist-tag backwards and downgrade anyone installing it. This usually means parallel PRs merged out of version order; bump and re-merge.`,
    };
  }
  return { publish: true, reason: `${version} is not on npm` };
}

/** Query npm for a package's state. Ambiguity is reported, never guessed. */
export async function readRegistry(
  npmName: string,
  version: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RegistryView | { ambiguous: true }> {
  const encoded = npmName.replace("/", "%2f");
  try {
    const res = await fetchImpl(`https://registry.npmjs.org/${encoded}`);
    if (res.status === 404) {
      // Package does not exist. publishedVersions: [] (present-and-empty)
      // is what decidePublish reads as never-published (surface#220).
      return { versionExists: false, publishedVersions: [] };
    }
    if (!res.ok) return { ambiguous: true };
    const body = (await res.json()) as {
      versions?: Record<string, unknown>;
      "dist-tags"?: Record<string, string>;
    };
    return {
      versionExists: Boolean(body.versions?.[version]),
      currentDistTagVersion: body["dist-tags"]?.[distTagFor(version)],
      publishedVersions: Object.keys(body.versions ?? {}),
    };
  } catch {
    return { ambiguous: true };
  }
}

/**
 * Commits sitting on `main` that no published version contains.
 *
 * Advisory only: it warns, never fails. Pure so it's testable without a
 * repo; the caller supplies the log lines.
 */
export function unpublishedDrift(commitSubjects: readonly string[]): {
  drifted: boolean;
  count: number;
  summary: string;
} {
  const commits = commitSubjects.map((c) => c.trim()).filter((c) => c.length > 0);
  if (commits.length === 0) {
    return { drifted: false, count: 0, summary: "nothing unpublished" };
  }
  return {
    drifted: true,
    count: commits.length,
    summary: `${commits.length} commit(s) are NOT in any published version:\n${commits.map((c) => `  - ${c}`).join("\n")}\nOpen a release PR to ship them.`,
  };
}

// --- CLI -------------------------------------------------------------------
// Usage: bun scripts/release-plan.ts <package-dir> <npm-name> [--tag-push]
// Emits GitHub Actions outputs; exits non-zero on refusal.
//
// appendFileSync, not Bun.write: Bun.write truncates, so emitting three
// outputs in a row would leave only the last one in $GITHUB_OUTPUT
// (hub#829). Vault's publish-npm reads `version` and `dist_tag` as well
// as `should_publish`, so that bug would ship the wrong tag.
if (import.meta.main) {
  const { readFileSync, appendFileSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");

  const [dir, npmName, ...rest] = process.argv.slice(2);
  if (!dir || !npmName) {
    console.error("usage: release-plan.ts <package-dir> <npm-name> [--tag-push]");
    process.exit(2);
  }
  const pkg = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
  const version: string = pkg.version;
  const registry = await readRegistry(npmName, version);
  const decision = decidePublish(version, registry, {
    isTagPush: rest.includes("--tag-push"),
    branch: process.env.GITHUB_REF_NAME,
  });

  const out = process.env.GITHUB_OUTPUT;
  const emit = (k: string, v: string) => {
    if (out) appendFileSync(out, `${k}=${v}\n`);
    console.log(`${k}=${v}`);
  };

  if ("refuse" in decision) {
    console.error(`::error::${npmName}@${version}: ${decision.reason}`);
    process.exit(1);
  }
  if (!decision.publish && !rest.includes("--no-drift-check")) {
    try {
      const proc = spawnSync("git", ["log", `v${version}..HEAD`, "--oneline", "--no-merges"], {
        encoding: "utf8",
      });
      if (proc.status === 0) {
        const drift = unpublishedDrift((proc.stdout ?? "").split("\n"));
        if (drift.drifted) {
          console.log(`::warning::${npmName}: ${drift.summary}`);
          const sum = process.env.GITHUB_STEP_SUMMARY;
          if (sum) {
            appendFileSync(sum, `### Unpublished work\n\n\`\`\`\n${drift.summary}\n\`\`\`\n`);
          }
        }
      }
    } catch {
      // Never fail a run over the advisory check — a missing tag or a shallow
      // clone just means we can't tell, not that something is wrong.
    }
  }
  emit("version", version);
  emit("dist_tag", distTagFor(version));
  emit("should_publish", String(decision.publish));
  console.log(`${npmName}@${version}: ${decision.reason}`);
}
