# Releasing `@openparachute/vault`

Releases are automated via [`.github/workflows/release.yml`](./.github/workflows/release.yml). **Merging a version bump to `next` or `main` is the release signal** — CI compares `package.json`'s version against npm and publishes when it's new:

1. Runs `bun run typecheck` + `bun test ./src/`
2. Publishes to npm (with provenance attestation, via Trusted Publishing OIDC)

`next` only ever publishes an rc — a stable (non-`-rc.`) version pushed to `next` is skipped with a `::warning::`, not published; stable promotion is still a dedicated PR to `main` (see below). Pushing a git tag still works as an explicit override — useful for a re-release, or a version that predates this workflow's publish-on-merge behavior.

Vault has no container image artifact — the `ghcr.io` step that ships with the hub workflow is intentionally omitted here. If a vault image ever becomes useful, add a `publish-image` job mirroring hub's.

## Tag conventions

Per [governance rule 2](https://github.com/ParachuteComputer/parachute-workspace/blob/main/docs/process/governance.md):

| Tag shape | Example | npm `dist-tag` |
|---|---|---|
| `vX.Y.Z-rc.N` | `v0.4.8-rc.7` | `rc` |
| `vX.Y.Z` | `v0.4.8` | `latest` |

The workflow auto-detects rc vs stable from the tag string (`-rc.` substring).

## Release flow

### For an rc bump (each code-touching PR merge)

Open a release PR bumping the `rc.N` suffix in `package.json`, targeting `next`:

```sh
git fetch && git checkout -b release/vault-X.Y.Z-rc.N origin/next
# Bump ./package.json to X.Y.Z-rc.N + CHANGELOG.
git commit -am "release: vault X.Y.Z-rc.N — <what shipped>"
gh pr create --base next
# Merging this PR publishes @rc.
```

CI takes over from there — watch the run at [Actions](https://github.com/ParachuteComputer/parachute-vault/actions).

### Promoting an rc chain to stable

When the rc chain is ready to release:

1. Open a PR **to `main`** that drops the `-rc.N` suffix from `package.json` (e.g. `0.4.8-rc.7` → `0.4.8`). Do not merge `next` — anything landed on `next` after the rc waits for the next rc.
2. Reviewer + merge as usual.
3. Merging publishes with `dist-tag=latest`. No manual tag needed — CI tags the commit afterward as a record.

### Doc-only PRs

Per governance, doc-only PRs are EXEMPT from rc.N bumping — they merge without a version bump and get picked up by the next code-touching PR's rc bump (or by the stable promotion, whichever comes first). Don't fragment a release into many patch bumps mid-validation.

If you DO need to ship a doc-only fix outside an active rc chain (i.e. main is on a stable version with no rc.N in flight), bump the next patch (`0.4.8` → `0.4.9`) in a PR to `main` and merge — that publishes it.

## One-time setup (operator)

Before the workflow can publish, this repo needs:

1. **npm Trusted Publisher**: log into npmjs.com → package `@openparachute/vault` → Settings → Trusted Publishers → "Add a new publisher" → choose **GitHub Actions**. Fill:
   - Organization: `ParachuteComputer`
   - Repository name: `parachute-vault`
   - Workflow filename: `release.yml`
   - Environment name: (leave blank)

   No `NPM_TOKEN` secret needed — the workflow uses OIDC.

## Verifying a release

```sh
npm view @openparachute/vault@<version> dist.tarball
npm view @openparachute/vault dist-tags
```

The npm tarball page links to the GitHub Actions run that produced it (provenance attestation).

## Rolling back

There's no "unpublish" path for npm (strict 72-hour unpublish policy that you should avoid for published packages anyway). To roll back:

- Cut a new patch from a known-good commit (e.g. `0.4.8` → `0.4.9` reverting the bad change).
- PR + merge to `next` (rc) or `main` (stable); CI republishes with the higher version under the same dist-tag.

## Troubleshooting

- **Workflow doesn't trigger**: for the merge path, confirm the merge landed on `next` or `main`, and that it touched `package.json` (the `paths` filter — a merge that doesn't bump the version never fires this workflow, by design). For a tag push, confirm the tag matches the workflow's `on.push.tags` pattern (`v[0-9]+.[0-9]+.[0-9]+` or `v[0-9]+.[0-9]+.[0-9]+-rc.[0-9]+`).
- **Workflow ran on `next` but nothing published, and it wasn't already on npm**: check for a `::warning::` in the `plan` job log — a stable (non-`-rc.`) version pushed to `next` is skipped on purpose. Retarget the release PR to `main`.
- **`version mismatch` error in publish-npm**: tag path only — package.json version differs from the tag. Re-tag the correct commit.
- **`npm ERR! 403 You do not have permission to publish`**: Trusted Publisher rule on npm doesn't match this workflow. Verify org/repo/workflow filename are exactly `ParachuteComputer` / `parachute-vault` / `release.yml`. If the workflow file was renamed, the rule needs updating on npm.
- **`npm ERR! 401 Unauthorized` with no OIDC token**: the workflow is missing `permissions: id-token: write` at the job level. Verify the YAML.
