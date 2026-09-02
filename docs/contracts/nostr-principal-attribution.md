# Nostr principal attribution — `permissions.principal_pubkey`

**Status:** live (vault#698 · hub#937). **Enforced by:** parachute-vault.
**Emitted by:** parachute-hub's account-MCP → vault hop mint.

## The problem

When an agent writes to a vault through the hub's NIP-98 `/mcp` door, the hub
mints a short-lived vault token with `sub = <hub user id>`. Several agents,
each holding a *different* Nostr key, can be linked to the *same* hub user — so
every one of their writes lands with the same `created_by` / `last_updated_by`,
and `created_via` / `last_updated_via` were flattened to the literal `mcp`.
Two agents were indistinguishable on every attribution axis.

## The claim

The hub stamps the signing pubkey into the JWT's `permissions` object:

```json
{ "permissions": { "principal_pubkey": "<64 lowercase hex chars>" } }
```

- **Value:** a NIP-01 pubkey — 32 bytes, lowercase hex, no `npub`, no prefix.
- **Emitted only** for a principal that authenticated with a NIP-98 signature.
  Password / cookie / OAuth / Bearer sessions never carry it; there is no key
  to name, and inventing one would fabricate attribution.
- **Why inside `permissions` and not a top-level claim:**
  `@openparachute/scope-guard` returns a *fixed* claim surface (`sub`,
  `scopes`, `aud`, `jti`, `client_id`, `vault_scope`, `permissions`) and drops
  everything else. `permissions` is its documented verbatim passthrough, so it
  is the only carrier a vault on a published scope-guard can read without a
  scope-guard release.

## What the vault does with it

`created_by` / `last_updated_by` are **unchanged** — they stay the hub user id.
The signer lands on the *other* axis:

```
created_via = last_updated_via = "nostr:<64-hex>"
```

`nostr:<pubkey>` joins the existing open-ended `via` vocabulary (`mcp` ·
`surface:<name>` · `agent:<id>` · `operator` · `api`) — same `<class>:<id>`
shape as `agent:<id>`. The columns are plain TEXT with exact-match filters
(`created_via` / `last_updated_via` on `query-notes` and `GET /api/notes`), so
no filter, index, or schema changes.

It applies on **every** write path — create, batch create, update, append /
prepend, `content_edit`, and the `if_missing: "create"` upsert — because the
value rides the single `WriteContext.via` already threaded through all of them.

Unlike every other credential class, `nostr:<pubkey>` is **not** refined away
to `mcp` by the MCP handler: every hub `/mcp` caller is on the `mcp` channel,
so the channel cannot tell two agents apart and the key can.

## Failure behavior — fail SOFT

A missing, non-string, wrong-length, uppercase, or non-hex `principal_pubkey`
is **ignored**: `via` falls back to the generic credential class (`api`, then
refined to `mcp`). This is deliberately the opposite of
[`permissions.scoped_tags`](./tag-scoped-tokens.md), which fails *closed* with
a 401. `scoped_tags` is an access decision; `principal_pubkey` is only a label,
so a bad value must not reject a legitimate write — nor be stored verbatim.

## Deployment ordering

**The vault side must ship before the hub side.** A hub that emits the claim
against an older vault is harmless: the only pre-existing reader of
`permissions` is the `scoped_tags` parser, which returns "unscoped" when
`scoped_tags` is absent, so a `permissions` object carrying only
`principal_pubkey` changes nothing. The reverse order is equally safe (the
vault simply never sees the claim) — the ordering is about when attribution
starts working, not about safety.

## Pinned by

- `src/attribution-threading.test.ts` — claim parsing, fail-soft cases,
  coexistence with `scoped_tags`, the ordering guarantee, and every write path.
- `core/src/attribution.test.ts` — the store-layer column + filter behavior.
