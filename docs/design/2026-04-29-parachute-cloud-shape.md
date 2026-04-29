# Parachute Cloud — what shape should it take?

**Date:** 2026-04-29
**Author:** vault tentacle (Uni)
**Status:** Research / decision-driving. Aaron asked for a deep-think before more cloud code lands. This doc lays out four candidate shapes, re-evaluates the parked code (#99 + #101) against them, and recommends one.
**Companions:**
- `parachute.computer/design/2026-04-20-cloud-offering-sketch.md` — the prior north-star sketch.
- vault PR [#99](https://github.com/ParachuteComputer/parachute-vault/pull/99) — `DoSqliteStore + SqlDb` adapter (parked draft).
- vault PR [#101](https://github.com/ParachuteComputer/parachute-vault/pull/101) — `BlobStore` FS + R2 backends (parked draft).
- issue [#5](https://github.com/ParachuteComputer/parachute-vault/issues/5) — Hosted vault service.

---

## 1. What we have today

Self-hosted, Bun-native, three deployment modes: Mac launchd, Docker on a VPS, and (operationally) Cloudflare-Tunnel-fronted variants of either. One physical machine per user; one or more vaults per machine; one SQLite file per vault; attachments on the local filesystem under `~/.parachute/vault/assets/<vault>/...`.

The relevant abstractions, and where each binds to the environment:

- **`core/`** — pure TypeScript: schema, ops (`notes.ts`, `links.ts`, `wikilinks.ts`, `tag-schemas.ts`, `attachments.ts` after PR #101), MCP tool definitions, expansion, paths. Runtime bindings: **`bun:sqlite`** (synchronous), and (in the parked PR #101 split) the filesystem behind `FsBlobStore`. Everything else is portable.
- **`src/`** — Bun host process: `Bun.serve()` HTTP, OAuth, MCP HTTP transport, route handlers, transcription worker, webhook triggers, CLI, daemon supervision, config in `~/.parachute/vault/`. Heavy `fs` / `path` / `process.env` usage; `Bun.password` (bcrypt); `setInterval` for the stop-signal sentinel and the transcription poller.
- **`Store` interface** is **already async** (every method returns `Promise<T>`). The `BunSqliteStore` is sync internally and wraps with `async`; the parked `DoSqliteStore` is genuinely async over Cloudflare's `ctx.storage.sql`. So the seam to swap engines is in place — what isn't is a swap of the host process itself.
- **Env coupling**: `bun:sqlite` (sync, native), `Bun.password.hash/verify` (bcrypt — bcrypt is pure JS-doable but we'd have to swap), `Bun.serve()` (Workers and Node both have stand-ins), `setInterval` (Workers cron is different), filesystem reads/writes for config + attachments (object store equivalents), launchd/systemd (only the operator changes).

Self-hosted MCP runs over HTTP at `/vault/<name>/mcp` (Streamable HTTP), authenticated by `pvt_*` tokens or hub-issued JWTs validated via JWKS. OAuth flows live entirely in vault. Hub on `:1939` is the user's portal; vault on `:1940` is the data plane.

The product is defensible because the data plane is local — your notes, your machine, your filesystem. Everything else (the agent, the UI, the auth) can live remotely without compromising that.

---

## 2. The four candidate shapes

For each: architecture, what changes vs today, who hosts what, costs (both infra and complexity), and the unique value vs the alternatives.

### Shape 1 — Cloudflare Workers (DO + R2)

What the parked PRs presume.

**Architecture.** Each tenant's vault is a [Durable Object](https://developers.cloudflare.com/durable-objects/) instance. The DO holds its own SQLite (via `ctx.storage.sql`), pinned to one colo, with strong write-after-read consistency inside the object. Attachments live in R2; the BlobStore from #101 abstracts the bucket. KV or DO storage holds OAuth state. A front-door Worker dispatches requests to the right DO by tenant subdomain (`aaron.parachute.computer/vault/.../mcp` → DO ID = hash(aaron)). Workers for Platforms is the multi-tenant scaling primitive if we need user-uploaded code; we don't yet.

**What changes vs today.**
- `Bun.serve()` → Workers `fetch` handler. Easy.
- `bun:sqlite` synchronous → `ctx.storage.sql` async. The PR #99 `SqlDb` adapter handles it.
- Filesystem → R2 (PR #101).
- `Bun.password` bcrypt → `crypto.subtle` PBKDF2 or scrypt. One file.
- `setInterval`-based pollers → Workers Cron triggers + Queues. Stop-signal sentinel disappears (no server to kill). The transcription worker becomes a queued job.
- Scribe still runs somewhere (Workers can't do CPU-heavy transcription) — likely Fly.io workers off a queue.
- Cloudflare for SaaS for per-tenant DNS + TLS + custom-domain support.

**Who hosts what.** Anthropic / Parachute hosts everything. Tenant has zero infra.

**Costs.**
- Infra: scale-to-zero. DO storage is $0.20/GB/mo, R2 is $0.015/GB/mo, Workers requests are 10M free. A 1k-user tier with avg 100MB/user is ~$25/mo storage + request costs. Cheap.
- Complexity (for us): high. Writing for Workers is a different runtime — no `node:fs`, no `node:net`, different hot-reload story, harder local dev (Miniflare is good but not seamless), and we've never operated it in prod. Vendor coupling is real even if portable in principle.
- Complexity (for users): zero. They sign up and a subdomain works.

**Unique value.** Lowest unit cost. Lowest user friction. True multi-tenant without ever provisioning machines.

**The hidden cost.** The vault's value proposition until now has been "your notes live on a machine you control." Shape 1 inverts that. We can offer export-anytime to keep the *promise* honest, but the data path goes through Anthropic / Parachute / Cloudflare every read.

### Shape 2 — Containerized service per tenant

A more conservative cloud, closer to the self-hosted shape.

**Architecture.** Vault runs as a Docker container on Fly.io (or Render, or K8s). One container per tenant — or one container hosting multiple tenants' SQLite files behind multi-vault routing as we already do. SQLite on a Fly volume. Attachments on the same volume or in S3/R2 (PR #101 still applies). Notes static bundle on Cloudflare Pages or Vercel. Scribe is a separate Fly app with a worker pool. Hub on a tiny shared instance handling auth + provisioning. Cloudflare in front for DNS automation + TLS.

**What changes vs today.** Almost nothing in the code. The Docker images already exist; we run them at scale instead of one-per-user. Possibly we adopt litestream or Turso (managed libsql) to get backups + replication without re-architecting. The Bun host is unchanged. SQLite stays sync. PR #99 becomes optional. PR #101's R2 backend is still useful for cross-region attachment availability or to escape volume sizing.

**Who hosts what.** Parachute hosts containers per tenant. Identity centralized at `auth.parachute.computer`. Same operational model as a typical SaaS company.

**Costs.**
- Infra: Fly.io machines are ~$1.94/mo each scale-to-zero, cold-start ~300ms. 1k tenants at $2/mo idle = $2k/mo just-for-existing — much higher than Shape 1. Volume costs are similar to R2.
- Complexity (for us): medium. We already know Docker. We don't have a multi-tenant control plane yet (provisioning, backup, failover) — that's the work. Operationally heavier than CF: machines drift, volumes need backup, regions matter.
- Complexity (for users): zero on the happy path; "what region?" possibly visible later.

**Unique value.** Code parity with self-hosted is total — same Bun, same SQLite, same filesystem, same edge cases. Self-hosted users moving to cloud move *zero bits*; their export + import works first try because cloud is just self-hosted with us as the operator. Less vendor coupling.

**The hidden cost.** We become a SaaS ops shop. Backups, monitoring, scaling, on-call. That's a real shift in what the company spends time on.

### Shape 3 — Anthropic-managed control plane + per-user Cloudflare tunnel

The "cloud is just an on-ramp" shape.

**Architecture.** Users still self-host vault on their Mac or VPS — same code, same install. What Parachute provides:
- A managed sign-up / billing / identity surface at `parachute.computer`.
- A managed `auth.parachute.computer` IDP that the user's vault delegates OAuth to (Phase 2 of the existing module-protocol design).
- A managed Cloudflare Tunnel that gives the user's local vault a stable public URL (`aaron.parachute.computer`) without the user having to wire up cloudflared themselves.
- Optionally, a managed scribe instance for transcription (since that's the part most users can't run locally on a phone).
- Optionally, a managed cron / webhook / agent runner that calls into the user's tunneled vault on schedule.

**What changes vs today.** Vault is unchanged. Hub gains a "register with cloud" button. We build a thin control plane (signup, billing, tunnel provisioning, cert management) and a thin auth service. Notes still talks to the user's vault — just over the tunnel instead of localhost.

**Who hosts what.** The user keeps their data. Parachute provides identity, on-ramp, billing, and managed compute (scribe, agent runners) — the parts that need to be central.

**Costs.**
- Infra: tiny. Tunnels are free for outbound to CF; we pay for the control plane (a single small container) and scribe pool. Scaling is linear in scribe usage, not in tenant count.
- Complexity (for us): low-medium. The control plane is small. Tunnel provisioning is well-trod (cloudflared API). We're already building auth.
- Complexity (for users): they need a machine that's on. Mac or VPS. That's the entire user filter.

**Unique value.** Preserves "your data on your machine" *literally*. Doesn't compete with self-hosting — it *is* self-hosting, with the rough edges sanded off (no cloudflared install, no port forwarding, no DNS, no certs). Highest alignment with Aaron's stated philosophy ("technology as extender of human cognition") because the user's notes are physically next to them.

**The hidden cost.** We can't market to users without a Mac or a VPS. The TAM is smaller. And "your machine has to be on for your notes to be reachable" is real friction for phone-first users — though the local-first PWA we already ship covers that for *capture*; only *agent reads* need the machine awake.

### Shape 4 — Hybrid: local-first synced to cloud

Vault becomes a CRDT with a cloud replica.

**Architecture.** Each note becomes a CRDT (likely Automerge or Yjs). Local vault holds the authoritative replica; a cloud replica (Workers + DO + R2) syncs continuously. Either replica can serve reads. Writes propagate via op-sync; conflicts resolve deterministically. Phone clients sync against the cloud replica when off-network from the home machine; against the local one when home.

**What changes vs today.** A lot. The data model becomes op-based, not row-based. The schema turns into a projection of the op log. Tag/link/path semantics need careful CRDT modeling (path uniqueness is fundamentally non-CRDT-friendly without a coordinator). Wikilink resolution becomes eventual. FTS indexes become projections we rebuild.

**Who hosts what.** Same as Shape 1 for the cloud side; the user keeps a local copy.

**Costs.**
- Infra: Shape-1 costs plus ongoing op-sync bandwidth.
- Complexity (for us): high. CRDT modeling for a relational store is hard. We'd be doing it in 2026 with limited mature tooling for "CRDT over SQLite" — Riffle / cr-sqlite are interesting but we'd be early-adopters. Probable timeline: a year of design before product.
- Complexity (for users): low-medium. The "always synced" experience is what they want.

**Unique value.** Best of both — works offline, works on phone, works without your machine awake, eventually consistent. This is the long-arc shape that competitors with bigger teams (Notion, Reflect, Mem) are also chasing. We could win it because we're small and the agent-native primitive is unique.

**The hidden cost.** Time. We'd be reinventing the data layer in the year we should be cementing product-market fit.

---

## 3. Re-evaluating the parked PRs (#99 + #101)

The parked PRs were written assuming Shape 1. Let me re-read them against all four.

**PR #99 — `DoSqliteStore + SqlDb` adapter.** The adapter (`SqlDb` interface in `core/src/sql-db.ts`) is genuinely runtime-portable: a thin "prepare / exec / iterate" surface. `BunSqliteStore` already implements it under the hood. A future `D1Store`, `LibsqlStore` (Turso), or even a `PostgresStore` could wrap the same surface. The DO-specific affordances (BEGIN/END splitter, PRAGMA skip) are confined to `DoSqliteStore`.

Verdict: **shape-portable**. Useful in Shape 1 (DO), Shape 2 (libsql/Turso for replication), and any future async backend. Disposable only in Shape 4 (CRDT replaces the SQL layer entirely). Worth preserving even if we don't pick Shape 1.

**PR #101 — `BlobStore` (FS + R2).** The `BlobStore` interface is shape-agnostic: `put / get / delete` keyed by opaque string, with `R2BucketLike` structurally typed so it doesn't pull `@cloudflare/workers-types` into the Bun bundle. `R2BucketLike` matches the S3 client shape with minor renames; an `S3BlobStore` is a one-file follow-up.

Verdict: **shape-portable**. Useful in every shape that has attachments (1, 2, possibly 4). Shape 3 doesn't strictly need it, but a managed-scribe path that holds audio for transcription would.

**Implication.** The parked PRs aren't Shape-1 lock-in. They're abstraction work that pays off across at least 1 + 2 + 4. The reason to merge them isn't "we're doing CF" — it's "we want async Store and pluggable blob storage as ecosystem hygiene." If we adopt Shape 2 or Shape 3, we still want this code shipped, just with `DoSqliteStore` and `R2BlobStore` parked or removed and the FS / abstract surface kept.

**Recommendation regardless of shape choice:** rebase + merge #99 + #101 with the cloud-specific store implementations gated behind the abstractions but not yet deployed. The interface lands; the runtime targets activate when we pick a shape.

---

## 4. The product question — who's the cloud user?

Aaron didn't pose this directly, but it's the load-bearing decision. Three candidate user profiles:

**(A) Existing self-hosted users wanting managed-something.** They like the vault's philosophy, trust their data with us, but don't want to run cloudflared / open ports / babysit a VPS. Tiny TAM today (~5 beta users), but high alignment — they're already paying with their attention. Best served by **Shape 3**: keep the data on their machine, give them the connective tissue. Or **Shape 2** at the cheap end if they want to migrate off their Mac to a managed Fly.io instance.

**(B) New users who can't or won't self-host.** They've never run a service. Phone-first. They want sign-up → vault → working agent in 60 seconds. Best served by **Shape 1** or **Shape 4** — the data has to be in the cloud because there's no other machine. Big TAM. Lower alignment with the open-source "your machine, your data" pitch but compatible with it via export.

**(C) Teams.** Multi-user vaults, shared tags, admin controls. Issue #5 mentions this for the Team tier. We don't have sharing primitives yet — vaults are single-tenant by data model. Genuinely a Year-2 problem; not load-bearing for the cloud-shape decision today.

**My read.** (A) is the natural first-paying-customer set — they exist, we know their workflow, they've already trusted us with their data. (B) is the bigger market but requires more product (mobile-first, no-machine onboarding, billing). Aaron's existing OSS commitment + the open-source story argues for (A) first, (B) when we're ready.

This points strongly to **Shape 3 first, Shape 1 second**. Build the on-ramp for users who already have a machine. Add the managed-vault offering when we have a phone-first onboarding flow that justifies it.

---

## 5. Recommendation

**Pick Shape 3 (Anthropic-managed control plane + per-user CF tunnel) as the v1 cloud offering, with Shape 1 (CF Workers + DO + R2) as the v2 managed-vault path that activates once Shape 3 has paying users.**

Why:

- **Aligns with existing users.** The 5 beta users already self-host. Shape 3 turns their existing install into a "cloud user" by giving them a stable URL, managed identity, and managed scribe — without asking them to migrate any bits.
- **Preserves the open-source story.** Self-hosted is the canonical deploy. Cloud is "we operate the on-ramp." That's a coherent pitch and matches Aaron's stated philosophy.
- **Compatible with later Shape 1.** A Shape-3 user who eventually wants "I don't want to run a Mac anymore" can be migrated to Shape 1 by exporting their vault and re-importing into a managed DO. The export already works.
- **Low capital outlay.** Shape 3's MVP is small enough that two stewards working two weeks could ship it. Shape 1's MVP is larger by a factor of 3–5x.
- **Doesn't burn the parked PRs.** #99 + #101 land as ecosystem hygiene now and become load-bearing when Shape 1 activates later.

### MVP for Shape 3

What specifically needs to ship to validate it:

1. **Managed `auth.parachute.computer`** as a centralized IDP that vault can delegate to. The hub-as-issuer architecture (already designed) extends here — instead of vault being its own IDP, it federates to `auth.parachute.computer` for cloud users. Self-hosted users without cloud opt-in keep vault as IDP.
2. **A control-plane service** at `cloud.parachute.computer` (or wherever) that handles:
   - signup (email + password or OAuth via Google/GitHub)
   - tunnel provisioning (Cloudflare API calls to allocate a tunnel + DNS record per user)
   - cert lifecycle (CF handles this; we surface the status)
   - billing (Stripe; tier = $X/mo for tunnel + scribe minutes)
3. **A vault CLI command** (`parachute-vault cloud-link`) that:
   - prompts for cloud credentials
   - registers the local vault with the control plane
   - installs cloudflared with the tunnel token
   - configures vault's OAuth issuer to delegate to `auth.parachute.computer`
4. **Managed scribe pool** (Fly.io app, queue-fed) that the user's vault can call as if it were local — same `SCRIBE_URL` env, but pointed at a Parachute-managed origin requiring the cloud token.

That's the minimum to charge for. Notes (the PWA) needs zero changes — it already talks to whatever `<origin>/notes` URL we tell it. Scribe needs zero changes — it's already a service over HTTP.

### Validation criteria

- 5 of the existing beta users opt in within 4 weeks.
- Signup → working tunneled URL → first note from phone takes under 5 minutes.
- Monthly revenue per user covers tunnel + scribe costs with 50% margin (target: $8/mo tier covers under $4/mo COGS).

### When to activate Shape 1

Once Shape 3 has 25+ paying users and we hear "I want to retire my Mac" from at least three of them, we ship the Shape-1 managed-vault tier. The parked PRs become the foundation; we add a control-plane DO router, billing per GB, and a migration tool that imports a self-hosted export into a fresh DO.

---

## 6. Open questions for Aaron

These I couldn't resolve from canon + current notes alone:

1. **Is "your machine has to be on" acceptable as the cloud's defining limitation in v1?** Shape 3 hinges on this. Mobile users on the road for a week with no machine awake at home will hit it — local-first PWA cushions capture but agent reads fail. Counter: Notion, Linear, etc. all assume the cloud is awake; we'd be unique in not, and that's either a feature ("your data is *yours*") or a bug ("why doesn't this work right now?").

2. **How committed are we to Cloudflare specifically?** Shapes 1, 2, 3, 4 all lean on CF for *something* (tunnel, DNS, Pages, R2). Shape 1 leans hardest. If we wanted to be cloud-portable on principle, Shape 2 with S3 + Fly.io + Vercel + Auth0 is closer. The April-20 sketch went CF-heavy without flagging the lock-in.

3. **What's the relationship between cloud and the channel pod?** Channel runs as a Docker container today. Telegram bot tokens are per-tenant. Does cloud host channel for tenants? Today's answer (April-20 sketch) is "parked until a tenant asks." Still right?

4. **Pricing posture.** $8/mo (Shape-3 MVP) vs $20/mo (Shape-1 Pro) vs free + paid metered. Founding-team conversation territory. The shape choice and the pricing posture interact (Shape 1 has near-zero idle cost so a free tier is cheaper to offer; Shape 3 has near-zero cost period so free tier is fine).

5. **Should `auth.parachute.computer` exist as a distinct service or be a function of `parachute.computer/oauth/*`?** Both work. Distinct service is cleaner for federation; combined keeps our deployable count smaller. Lean: distinct service when we're ready.

6. **Where does the agent live in cloud?** A Shape-1 user has no Mac running Claude Code. Do we host scheduled agents in cloud (a "cron Claude" that runs against the user's vault)? That's a real product surface — and it's agent-native, which is our differentiation. Worth a separate design doc once shape is picked.

---

## TL;DR

- **What we have**: self-hosted Bun + SQLite + filesystem; hub-on-tailnet; clear async Store seam already in place.
- **Four shapes**: CF Workers (parked PRs presume this), containerized SaaS, Anthropic-managed control plane + user tunnel, hybrid CRDT.
- **Parked PRs (#99 + #101) generalize** beyond Shape 1 — they're useful in Shapes 1, 2, and 4. Worth merging as ecosystem hygiene.
- **Recommendation**: Shape 3 (managed control plane + per-user tunnel) for v1, Shape 1 (managed DO vault) for v2 when there's demand.
- **Why**: aligns with existing users, preserves the open-source story, low capital outlay, compatible with later Shape 1 via export.
- **Six open questions** for Aaron — most importantly, "is your machine has to be on a feature or a bug?" That answer reshapes everything.
