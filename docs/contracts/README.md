# Vault-enforced contracts

Contract docs the vault enforces. These moved here verbatim from `parachute-patterns` — two from `patterns/`, one from `cookbook/` — (2026-07-04, patterns-archive decision: the patterns repo archives; each live-cited contract doc moves to the repo that enforces it). Other repos cite some of these cross-repo, so treat renames or removals here as ecosystem-facing changes.

| Contract | Governs |
|---|---|
| [`tag-data-model.md`](./tag-data-model.md) | The tag data model: one tag = one SQL row (description, indexed fields, opaque relationship vocabulary, `parent_names`); schema inheritance walk semantics with `_default` as implicit universal parent; the transactional tag-rename cascade. |
| [`tag-scoped-tokens.md`](./tag-scoped-tokens.md) | Tag-allowlist token narrowing: the `permissions.scoped_tags` JWT claim, fail-closed enforcement, hierarchy + string-form scope expansion, subset-of-minter mint attenuation, and the rename/delete lifecycle. |
| [`vault-portable-export.md`](./vault-portable-export.md) | The portable-markdown export/import surface: lossless round-trip guarantees, frontmatter + sidecar-schema shape, and the git-projection / cold-storage / migration recipes built on it. |

The hub-enforced contracts (module protocol, manifest shape, OAuth scopes, design system, and friends) live at [`parachute-hub/docs/contracts/`](https://github.com/ParachuteComputer/parachute-hub/blob/main/docs/contracts/README.md).

Note: the docs are verbatim copies (plus a provenance header). Relative links between the three docs resolve where the link was written sibling-relative (e.g. `./tag-data-model.md` from `tag-scoped-tokens.md`); links written against the patterns repo's layout (e.g. `../patterns/tag-data-model.md` from the cookbook recipe) do not. Relative links to patterns that did **not** move (e.g. `./vault-mcp-discovery.md`, `../guides/multi-writer-workspace.md`, `../adoption/migration-notes.md`) are **dead in this repo** — they were written for the patterns repo's layout. Find those files in the read-only archive: <https://github.com/ParachuteComputer/parachute-patterns/tree/main/patterns>. For hub-enforced targets (e.g. `./oauth-scopes.md`, `./hub-as-issuer.md`), the living copy is in [`parachute-hub/docs/contracts/`](https://github.com/ParachuteComputer/parachute-hub/tree/main/docs/contracts). (Kept verbatim on purpose: editorial fixes to a moved contract are their own PRs, not part of the move.)
