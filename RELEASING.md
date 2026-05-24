# Releasing `@openparachute/vault`

Releases are automated via [`.github/workflows/release.yml`](./.github/workflows/release.yml). Pushing a git tag triggers CI which:

1. Runs `bun run typecheck` + `bun test ./src/`
2. Publishes to npm (with provenance attestation, via Trusted Publishing OIDC)

Vault has no container image artifact — the `ghcr.io` step that ships with the hub workflow is intentionally omitted here. If a vault image ever becomes useful, add a `publish-image` job mirroring hub's.

## Tag conventions

Per [parachute-patterns governance rule 2](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/governance.md):

| Tag shape | Example | npm `dist-tag` |
|---|---|---|
| `vX.Y.Z-rc.N` | `v0.4.8-rc.7` | `rc` |
| `vX.Y.Z` | `v0.4.8` | `latest` |

The workflow auto-detects rc vs stable from the tag string (`-rc.` substring).

## Release flow

### For an rc bump (each code-touching PR merge)

After your PR merges to `main` with a bumped `rc.N`:

```sh
git fetch && git checkout main && git pull --ff-only
VERSION="v$(node -p "require('./package.json').version")"
git tag "$VERSION"
git push origin "$VERSION"
```

CI takes over from there — watch the run at [Actions](https://github.com/ParachuteComputer/parachute-vault/actions).

### Promoting an rc chain to stable

When the rc chain is ready to release:

1. Open a PR that drops the `-rc.N` suffix from `package.json` (e.g. `0.4.8-rc.7` → `0.4.8`).
2. Reviewer + merge as usual.
3. Tag the merged commit with the bare version: `git tag v0.4.8 && git push origin v0.4.8`.
4. CI publishes with `dist-tag=latest`.

### Doc-only PRs

Per governance, doc-only PRs are EXEMPT from rc.N bumping — they merge without a version bump and get picked up by the next code-touching PR's rc bump (or by the stable promotion, whichever comes first). Don't fragment a release into many patch bumps mid-validation.

If you DO need to ship a doc-only fix outside an active rc chain (i.e. main is on a stable version with no rc.N in flight), bump the next patch (`0.4.8` → `0.4.9`), tag, ship.

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
- Tag + push; CI republishes with the higher version under the same dist-tag.

## Troubleshooting

- **Workflow doesn't trigger**: confirm the tag matches the workflow's `on.push.tags` pattern (`v[0-9]+.[0-9]+.[0-9]+` or `v[0-9]+.[0-9]+.[0-9]+-rc.[0-9]+`).
- **`version mismatch` error in publish-npm**: package.json version differs from the tag. Re-tag the correct commit.
- **`npm ERR! 403 You do not have permission to publish`**: Trusted Publisher rule on npm doesn't match this workflow. Verify org/repo/workflow filename are exactly `ParachuteComputer` / `parachute-vault` / `release.yml`. If the workflow file was renamed, the rule needs updating on npm.
- **`npm ERR! 401 Unauthorized` with no OIDC token**: the workflow is missing `permissions: id-token: write` at the job level. Verify the YAML.
