# Vault config provisioning + per-vault scope semantics

**Status:** draft for review
**Date:** 2026-04-28
**Author:** vault tentacle (research pass)
**Repos touched:** parachute-vault, parachute-hub, paraclaw, parachute-patterns

## Why this doc exists

Three questions Aaron raised, all tangled around the same knot:

1. **Hub-managed vault config** — the hub web UI should be able to create a new vault end-to-end. Today only the `parachute-vault` CLI can. What does "create a vault" mean architecturally, and where does it live in the hub UI?
2. **Paraclaw provisioning vaults** — should paraclaw's wizard be able to mint a new vault, or should it only attach to vaults that already exist?
3. **Vault scope semantics** — when an OAuth client requests `vault:read`, which vault is it asking for? One? All? Whatever the operator picks? The wire format leaves this undefined and the enforcement layer doesn't notice.

The questions look adjacent but they share one root: **a vault is a first-class resource, but the OAuth surface treats `vault` as a singleton service.** Until we resolve the resource model, every UI flow that says "create a vault" or "give this app access" has to paper over it.

## Current state

### How vaults exist today

A vault is a tuple of (SQLite DB file, `vault.yaml`, entry in `~/.parachute/services.json`, well-known JSON published by the running server). The CLI is the only construction path:

- `parachute-vault create <name>` writes the DB + yaml + an initial `pvt_*` token, and `upsertService` adds the path `/vault/<name>` under the **single** service entry keyed `parachute-vault`.
- The well-known endpoint enumerates all vaults as `vaults: WellKnownVaultEntry[]` (already an array — the shape anticipates plurality).
- The services.json registry collapses every vault under one entry. A second vault overwrites the first's `paths` field; today the system effectively assumes one vault per host.

This is the structural source of the ambiguity. Code already half-knows there are many vaults (URL space, well-known doc, per-vault tokens). Configuration and scope still pretend there's one.

### How auth works today

- **Vault as OAuth issuer (Phase 0/1):** vault mints `pvt_*` opaque tokens. `oauth.ts` checks `authCode.vault_name !== vaultName` before issuing — vault-issued tokens are vault-pinned by construction.
- **Hub as OAuth issuer (Phase B2):** hub signs JWTs (RS256), vault validates via JWKS fetched from the hub origin. `validateHubJwt` enforces `iss` strictly. **`aud` is parsed but not strict-checked** (acknowledged TODO in the source). Scopes ride in the `scope` claim as a whitespace-separated string.
- **Routing:** `routing.ts` dispatches `/vault/<name>/...` and calls `requireScope(auth, scopeForMethod(method))`. The check knows which vault is being accessed (it's right there in the URL) but never compares that to anything in the token.
- **Scope shape:** `scopes.ts` parses `vault:<name>:<verb>` but `normalizeScope` collapses it to `vault:<verb>` ("Phase 2 synonym"). The shape exists; the enforcement does not.

### What that means for clients

Today a hub-issued token with `vault:read` lets the bearer read **every vault on the host**. Any service catalog entry pointing to any `/vault/<name>` URL works. Vault-issued tokens are pinned, hub-issued tokens are not. This is not a bug we've shipped to a wide audience yet — but every additional integration (paraclaw, notes, scribe) writes that assumption into another consumer.

## The ambiguity

The OAuth scope `vault:read` is doing four jobs at once:

1. **Verb intent** — "this app wants to read, not write."
2. **Service intent** — "the verb applies to vault, not scribe."
3. **Resource selector** — implicitly: "all vaults, on this host."
4. **Audience selector** — `inferAudience(scopes)` in the hub picks `aud=vault` from the prefix.

Job 1 and 2 are well-served. Job 3 is what's broken: the scope can't name a resource. Job 4 hides the breakage — `aud=vault` looks like an audience but it's the *service*, not a specific resource within it.

Compare to peers:

- **Slack** — bot tokens are workspace-scoped at issuance time. The token *is* the workspace binding; scopes describe verbs. There is no "all my workspaces" token.
- **GitHub Apps** — installation tokens are repository-scoped. A user-to-server token can be narrowed via `repository_ids`. Scopes are verb-scoped, resource-scoping is parameter-scoped.
- **Google** — `drive.readonly` is verb-only; per-file binding is via the resource ID at API call time, not the token. They get away with it because the user is always in the loop via picker UIs.

The clean-architecture answer is Slack's: bind the resource at issuance, keep scopes purely verb-scoped. The pragmatic answer is to support both — let scopes optionally carry a resource selector when the issuer wants to narrow, and let the resource server enforce it.

The same ambiguity will hit any future first-class resource we expose: scribe transcripts, channel rooms, notes notebooks. Solving it once, in the parser + the resource-server enforcement seam, pays compounding interest.

## Candidate approaches

### A. Scope narrowing (cheap, additive)

Flip `vault:<name>:<verb>` from synonym to enforced. The parser already accepts the form; `normalizeScope` already detects it. Three edits make it real:

1. `normalizeScope` stops collapsing `vault:<name>:<verb>` to `vault:<verb>`. Both forms remain parseable; only the unnamed form means "any vault."
2. `scopes.ts` adds `hasScopeForVault(scopes, vaultName, verb)`: true if either `vault:<verb>` or `vault:<vaultName>:<verb>` (with admin⊇write⊇read inheritance) is present.
3. `routing.ts` replaces `requireScope(auth, scopeForMethod(method))` with `hasScopeForVault(auth.scopes, urlVaultName, verbForMethod(method))`.

**Pros:** smallest diff. No JWT shape change. Backwards-compatible: existing tokens with `vault:read` continue to mean "all vaults on this host" — operators can keep that posture if they want, or narrow at issuance time.
**Cons:** `vault:read` (unnamed) is still ambient and dangerous. We carry a "broad token" footgun forever unless we deprecate it.

### B. Per-vault audience (defense-in-depth)

Hub stamps `aud=vault.<name>` on issued JWTs (vs. today's `aud=vault`). `validateHubJwt` strict-checks audience against the URL-derived vault name.

**Pros:** the load-bearing trust check is on the resource-server side where it belongs, like RFC 8707 resource indicators. Cleaner conceptual story: scopes are verbs, audience is resource.
**Cons:** scope shape stays untyped from the user's POV — the consent screen still says `vault:read` and the user has to know the audience disambiguates. UI-side legibility is worse than (A).

### C. Per-vault tokens (Slack-style, heaviest)

Each vault gets its own JWT. Connecting an app to two vaults means two attaches, two tokens, two refresh streams. The token *is* the binding; scopes are pure verbs.

**Pros:** cleanest model. Eliminates the resource-selector problem at the source. Maps onto `aud=<client_id>` semantics naturally.
**Cons:** doubles every connection flow. Breaks the current single-`/oauth/authorize` pass for users who want one app to read all their vaults. Forces hub UI to model "an app, attached to N vaults" instead of "an app, with these scopes."

### D. Hub-managed vault provisioning (orthogonal axis)

Independent of the scope question: should the hub be able to create a vault? Today it shells out to `parachute-vault` CLI via `dispatchVault`. Two options:

- **D1. Hub orchestrates the CLI.** Web UI hits a hub endpoint; hub calls vault's REST API (`POST /vaults`) which creates DB + yaml + initial token, then hub re-reads services.json and refreshes its catalog. CLI becomes one of two orchestration paths.
- **D2. Hub becomes the source of truth.** Vault config moves into the hub; vault server reads its registry from the hub on boot. Heavy — and inverts the current dependency direction (vault doesn't depend on hub today).

D1 is the obvious move. D2 is a five-year question.

### E. Paraclaw provisions vaults (vs. only attaches)

Paraclaw's wizard today calls `fetchHubVaults()` and lets the user pick. The "create" path doesn't exist; it falls back to a hardcoded `/vault/default` URL.

Adding "create new vault" to paraclaw is a *one-line* call to D1 once D1 exists — paraclaw POSTs to the hub's vault-create endpoint and gets back a vault descriptor + token. The argument against is purely UX: paraclaw is for setting up agent groups, not for vault administration. A "create vault" affordance there blurs the boundary.

**Recommendation on E:** offer a thin "create vault" link in the picker that deep-links to the hub's create-vault page. Don't reimplement the form. Paraclaw stays a consumer.

## Recommendation

**Combine A + B + D1.** Each is independently shippable; together they close the loop.

1. **A (scope narrowing)** is the user-facing contract. The consent screen and token issuance gain the ability to say "vault:work:write" — explicit, legible, narrow.
2. **B (per-vault audience)** is the resource-server backstop. Even if a scope check is bypassed somewhere down the line, the JWT `aud` claim won't validate against the wrong vault URL.
3. **D1 (hub orchestrates vault CLI via REST)** unblocks the hub UI and paraclaw's "create new" affordance without inverting the dependency graph.

**Defer C.** It's the right end-state for some users (organizations who want hard isolation between vaults) but the cost is high and (A+B) covers the trust gap without forcing the heavier model on everyone. C can be enabled later as a per-installation policy: "hub may only mint vault-scoped tokens for one vault per auth flow."

### Concrete enforcement contract

After this work lands, the matrix is:

| Token shape | URL | Allowed? |
|---|---|---|
| `pvt_*` issued by vault `work` | `/vault/work/...` | yes (today) |
| `pvt_*` issued by vault `work` | `/vault/personal/...` | no — different DB, different token (today) |
| JWT with `vault:read`, `aud=vault` | `/vault/work/...` | **no** — broad scope deprecated |
| JWT with `vault:work:read`, `aud=vault.work` | `/vault/work/...` | yes |
| JWT with `vault:work:read`, `aud=vault.work` | `/vault/personal/...` | no — scope mismatch + audience mismatch |
| JWT with `vault:admin`, `aud=vault.work` | `/vault/personal/...` | no — admin inherits within a vault, not across |

The unnamed `vault:read` keeps working in dev for one release cycle with a deprecation warning, then is rejected. The deprecation lands in the same release as the new form so consumers can migrate atomically.

### Phasing

- **Phase 1 (this sprint):** ship (A) — scope narrowing in vault, hub mints `vault:<name>:<verb>` when the OAuth request includes a vault param. Consent screen learns the new form.
- **Phase 2:** ship (B) — hub stamps `aud=vault.<name>`, vault enforces it. Land the "remove unnamed `vault:read`" deprecation warning at the same time so the migration window is one release, not two.
- **Phase 3:** ship (D1) — `POST /vaults` REST endpoint on vault, hub UI for create-vault, services.json refresh hook.
- **Phase 4:** rip out the unnamed-scope shim. Audience strict-check goes from warn-on-mismatch to reject-on-mismatch.

## Hub UI implications

The hub already has a vault picker for OAuth flows; the missing piece is administrative.

1. **Vaults page** in the hub UI lists every vault on the host with last-used + size. Add `+ New vault` button.
2. **Create vault flow:** name (validated against existing names + path-safe), optional description, optional template (blank vs. import). Submit hits `POST /vaults` on vault, hub re-reads services.json + well-known, returns descriptor + first `pvt_*` token to the operator (one-time display, copy-to-clipboard pattern).
3. **OAuth consent flow** gains a vault selector when the requested scope is `vault:<verb>` (no name). The selector controls which `vault:<name>:<verb>` scope the issued JWT carries and which `aud=vault.<name>` audience is stamped.
4. **Connections list** shows attached apps per-vault, not per-host. "Drift Notes is connected to vault `work` for read+write" reads more clearly than "Drift Notes has vault:write."

The CLI does not go away. `parachute-vault create` keeps working — it talks to the same `POST /vaults` endpoint as the UI does, or the UI shells out to the CLI under the hood (D1). Pick whichever direction feels lighter; my prior is "REST endpoint in vault, UI calls REST, CLI calls REST" — uniform surface, one validation path.

## Open questions

These need an Aaron decision; the rest of the design follows from them.

1. **Default-vault posture.** When a user's OAuth flow doesn't specify a vault, do we (a) reject and force a picker, (b) default to `default_vault`, or (c) issue an unnamed `vault:read` and let the operator narrow later? My prior is (a) for new OAuth flows — picker is the right place to disambiguate — but (b) preserves today's UX for setups with one vault. **Decide before Phase 1 ships.**

2. **Migration window for unnamed scopes.** One release with deprecation warning, then reject? Or longer? Affects how aggressive Phase 4 can be.

3. **Cross-vault `vault:admin`.** Does `vault:admin` (unnamed) exist as a meaningful scope? Use case: an operator-level dashboard that needs to list/create vaults. If yes, it's distinct from `vault:<name>:admin` and needs a separate name (`vault:host:admin`? `parachute:admin`?). My prior: **yes, but call it `parachute:host:admin` to keep the `vault:` namespace clean.**

4. **Paraclaw "create vault" affordance.** Deep-link to hub's create-vault page (my recommendation), or implement the create form in paraclaw too? Latter is more clicks-saved for the wizard UX, former is cleaner module boundaries.

5. **services.json schema.** Today one entry, key `parachute-vault`, multi-path. With multi-vault first-class, do we (a) keep one entry with `paths: ["/vault/work", "/vault/personal"]`, or (b) split into `parachute-vault-work` + `parachute-vault-personal`? `isVaultEntry` already does prefix matching, so (b) is mechanically supported. **Decision affects hub's catalog presentation.** My prior: (a) — one service entry with multi-path is closer to the actual model (one server, many resources).

## Adjacent areas worth a follow-up

- **Notes notebooks.** When notes ships its picker, the same scope-resource problem appears. The (A+B) shape generalizes — `notes:<notebook>:read` + `aud=notes.<notebook>`.
- **Scribe transcripts.** Less obvious — transcripts may be ephemeral enough that resource-binding adds friction without protection. Defer until there's a concrete consumer.
- **Well-known shape.** `vaults: WellKnownVaultEntry[]` is already plural-aware; no schema change needed for (A+B). Phase 3 may add a `created_at` per entry for the hub UI.
- **`PARACHUTE_HUB_ORIGIN` resolution.** Currently env-var-only. If the hub UI is going to manage many vaults, consider per-vault hub-origin overrides for hosted/multi-tenant deployments. Not blocking — flag for the cloud sketch.

---

**TL;DR:** Vaults are first-class resources but OAuth scopes treat `vault` as a singleton service. Recommend scope narrowing (`vault:<name>:<verb>`) plus per-vault audience (`aud=vault.<name>`) plus a REST `POST /vaults` so the hub UI can provision vaults without owning vault state. Paraclaw stays a consumer with a deep-link to the hub's create-vault page. The five open questions are Aaron-call.
