# Parachute Cloud — what shape should it take?

**Date:** 2026-04-29 (v2 added 2026-04-29 evening; v3 added 2026-04-29 night)
**Author:** vault tentacle (Uni)
**Status:** Research / decision-driving. Aaron read v2 and validated the hub-and-spokes frame; v3 grounds it in the operating reality — cloud is offered through **Parachute Computer LLC** as a paid managed tier, with Claude-login as flagship UX for paraclaw and a multi-provider/multi-IDP backstop against Anthropic-dependency risk. Section 8 (V3) is the active deliverable. §7 (V2) supplies the architectural frame; §§1–6 (V1) are kept as historical context for the original four-shape exploration.
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

## TL;DR (v1 — superseded by §7)

- **What we have**: self-hosted Bun + SQLite + filesystem; hub-on-tailnet; clear async Store seam already in place.
- **Four shapes**: CF Workers (parked PRs presume this), containerized SaaS, Anthropic-managed control plane + user tunnel, hybrid CRDT.
- **Parked PRs (#99 + #101) generalize** beyond Shape 1 — they're useful in Shapes 1, 2, and 4. Worth merging as ecosystem hygiene.
- **Recommendation (v1, superseded)**: Shape 3 (managed control plane + per-user tunnel) for v1, Shape 1 (managed DO vault) for v2 when there's demand.
- **Why this got pushed back**: the framing treated cloud as "where does vault run?" (vault-in-isolation), but the real unit of design is the **hub** and its **spokes** (vault, scribe, notes, paraclaw). Section 7 re-derives the shapes through that lens.
- **See §7 for the active recommendation.**

---

## 7. V2 — Hub-and-spokes frame

### 7.1 The frame change

V1 asked "where does vault run?" That was the wrong question. Vault is one spoke among several, and Parachute now has a **hub** (formerly `parachute-cli`, the OAuth issuer + service catalog + portal on `:1939`) and four **spokes** that attach to it: vault (`:1940`), scribe (`:1942`), notes (PWA), and paraclaw (Claude Code distribution + vault integration). Each spoke validates JWTs from the hub via the hub's JWKS endpoint, registers itself in the hub's service catalog via `/.well-known/parachute.json`, and is discovered/managed through the hub's portal UI.

The cloud question, properly framed, is therefore four-axis:

1. **Where does the hub live?** Local (laptop, VPS the user owns) or cloud (Parachute infra).
2. **Where does each spoke live?** Each can independently be local or cloud — vault on the laptop, scribe in cloud, notes static-bundled at `notes.parachute.computer`, paraclaw inherently local.
3. **How does the hub authenticate the user?** Native (vault's existing user accounts), federated (Google/GitHub via the hub), or device-local (laptop session).
4. **How do spokes reach the hub for token validation?** LAN/localhost, public DNS, tunnel, or no-network (cached JWKS).

Cloud is not a separate product; it's a re-binding of one or more of these four axes. A self-hosted user who points `SCRIBE_URL` at a Parachute-hosted scribe is *already* mixed-deployment today — one spoke in cloud, the rest local — they just don't think of it as "cloud." The product surface is choosing what to flip and giving the user a hub that can mediate the choices.

### 7.2 Re-deriving candidate shapes through the hub/spokes lens

The original four shapes mapped to the *vault* axis only. Re-derived against the four-axis lens, the cloud surface looks like this:

**(α) All-local (today's shipped product).** Hub on `:1939`, all spokes local. Hub authenticates with native accounts. Spokes reach hub at `127.0.0.1:1939`. JWKS cache is irrelevant — sub-millisecond fetch. This is the baseline; everything else is a re-binding of one axis.

**(β) Hub local, scribe cloud (already operational for some users).** Hub on the user's Mac, `SCRIBE_URL` points at a Parachute-managed scribe. Scribe must reach the hub's JWKS endpoint to validate the user's token — which, on a laptop, requires either a tunnel or token introspection over a different channel. Today's deployments side-step this by having scribe trust a long-lived `pvt_*` token issued by the hub, which works but doesn't compose with hub-as-issuer. Honoring OAuth across this boundary is the v1 work.

**(γ) Hub cloud, all spokes local via tunnel.** Hub at `aaron.parachute.computer`. Spokes (vault, scribe, paraclaw) on the user's Mac, exposed back to the hub via cloudflared tunnel. The hub's portal sees a unified surface; the data stays local; the user gets a stable URL and a reliable IDP. This is V1's "Shape 3" reformulated correctly: it's the **hub** that goes cloud, not the vault. Spokes follow.

**(δ) Hub cloud, vault cloud, scribe cloud (full SaaS).** Everything in Parachute infra. The user has a sign-up flow, a managed vault on Workers/DO (V1 Shape 1), a managed scribe pool, and the notes PWA. JWKS is internal to Parachute infra. This is V1's "Shape 1," but reframed: the vault-in-cloud is a consequence of the hub-in-cloud + "the user has no machine to run a spoke on."

**(ε) Mixed: hub cloud, vault local, scribe cloud.** The user keeps notes on their machine but doesn't want to run scribe (CPU-heavy, mobile-unfriendly). Hub mediates. Vault validates JWTs against the cloud hub via cached JWKS and a tunnel for inbound requests from agents. Scribe validates against the same hub. The user's data plane is local; the auth + heavy-compute planes are cloud.

**(ζ) BYO-Cloud: tenant-owned Workers account.** Aaron's "something different" instantiated. The user signs up at parachute.computer, but the deploy target is *the user's own Cloudflare account*. Parachute provisions a Workers app + DO + R2 bucket *into the user's tenant*. We have a control plane that orchestrates deployments, but we don't *own* the runtime — the user does. This preserves "your data, your machine" in a serverless world: serverless, but the user is the AWS/CF customer.

**(η) Single-binary VPS bundle.** Bun's `--compile` ships hub + vault + scribe (sans heavy ML deps) as one fat binary. Parachute partners with Hetzner/DO/Linode for one-click deploy: $5/mo VPS, the binary auto-updates, DNS + TLS handled. Cloud is "we sell the bundle, not the service." User owns the box.

### 7.3 OAuth across cloud/local boundaries

The architectural keystone is the JWT. The hub signs JWTs with `iss = <hub-origin>`, `aud = <spoke-origin>`, `scope = vault:<name>:read` (etc.), and rotating ECDSA keys exposed at `/.well-known/jwks.json`. A spoke validates by fetching JWKS from the hub origin (typically once per startup + on rotation) and checking iss/aud/scope/exp/sig.

This means the JWT is a **portable bearer credential**. A token issued by a hub on a user's laptop can be presented to a vault running on R2/DO, and vault validates it — *if* it can reach the hub's JWKS endpoint. The cross-boundary question reduces to "is the hub's JWKS reachable from where the spoke runs?"

The implications by axis:

- **Hub on laptop, spokes in cloud (β/ε with tunneled hub).** Cloud spokes need to reach the laptop's JWKS endpoint over the internet — i.e., the hub itself must be tunneled. Laptop sleeps → JWKS cache stays warm for hours, but eventually expires. **Net: hub uptime = auth uptime.** Refresh tokens can't mint new access tokens while the hub is offline.
- **Hub in cloud, spokes on laptop (γ).** The cloud hub's JWKS is always reachable. Laptop spokes fetch on startup + rotation. Local agents make calls to the laptop spoke with cloud-issued JWTs — works fine. Inbound calls from cloud (e.g., a scheduled agent in Parachute infra calling vault) go via the user's tunnel.
- **Both in cloud (δ).** JWKS is internal; no boundary problem.
- **BYO-Cloud (ζ).** The user's hub *is* in their CF tenant; their vault is in their CF tenant; they reach each other via Workers fetch or Service Bindings. Parachute's control plane never sees the JWTs — it provisions and updates code, that's it. Cleanest crypto story; weirdest billing model.

The scope semantics are unchanged across shapes. `vault:default:read` means "this token can read the `default` vault." The vault enforces scope regardless of where it runs. What changes is who *issues* the token (which hub) and what token-binding stories make sense — for example, a cloud hub can bind tokens to a TLS client cert or a CF Access identity, while a laptop hub can't.

The fundamental new failure mode introduced by hub-as-issuer is **hub-offline = system-offline** (after JWKS cache expires). This is mitigated by long cache TTLs (hours), but it's the reason the **hub belongs in cloud** for any deployment that wants reliability — even if all spokes stay local.

### 7.4 What "deeply integrated" means concretely

V1's Shape 3 was directionally right but framed it as "Parachute provides identity + tunnel as a side service to self-hosting." The hub-and-spokes lens sharpens it: **Parachute provides the hub, optionally, in cloud — and the user keeps their spokes wherever**. The hub becoming cloud-able is the cloud product's foundation. Once the hub is cloud-able:

- Self-hosted users can flip a switch and have their hub move to cloud (export `parachute-hub` state, import on `aaron.parachute.computer`). Spokes stay local but auth becomes reliable.
- Phone-first users get a cloud hub from day one. They can attach a cloud vault (V1 Shape 1) or, later, a local vault on a NAS / mini-PC.
- Mixed users park scribe in cloud (already doable), vault locally, hub in cloud — the natural shape.
- BYO-Cloud users point their hub at their own CF tenant and we orchestrate.

This re-orders the build sequence. V1 said "ship the on-ramp (Shape 3), then add managed vault later (Shape 1)." V2 says: **ship cloud hub first**. Cloud hub is small (per-tenant SQLite for user accounts + OAuth state, Bun-on-Fly or Bun-on-Workers, DCR + JWKS + portal UI). Once it exists, every shape (γ, δ, ε, ζ, η) is unblocked. Cloud vault is an optional follow-on for users who need it.

### 7.5 Re-recommendation

**Cloud Hub first. Cloud spokes optional, opt-in, per-user.**

1. **Phase 1 — Cloud Hub MVP.** Host `parachute-hub` (the existing codebase) on Fly.io with per-tenant subdomain `<user>.parachute.computer`. User signs up, gets a hub URL, and a CLI command (`parachute-hub link --cloud`) that flips their local install to delegate identity to the cloud hub. Local spokes continue to run; their auth is now reliable. Hub revenue covers Fly costs ($2/mo idle/tenant). Validation: 5 beta users opt in within 4 weeks. **This is the V1 cloud product.**
2. **Phase 2 — Managed Scribe.** A Parachute-hosted scribe pool that the user's cloud hub points at. Charge for transcription minutes. Already half-built (operationally).
3. **Phase 3 — Cloud Vault (V1 Shape 1).** When users say "I want to retire my Mac," ship the Workers + DO vault path. The parked PRs (#99 + #101) become load-bearing. Scope: net-new tenants only at first; migration tool follows.
4. **Phase 4 — BYO-Cloud (ζ) experiment.** Pick one motivated user, deploy a vault Workers app *into their CF account*, validate the orchestration story. If it works, productize as the "your data, your bill, our code" tier — a real differentiator vs Notion/Reflect/Mem.

Phases are sequential; each is independently shippable. Phase 1 alone would generate revenue and validate the hub-as-cloud-attachment thesis.

The parked PRs (#99 + #101) still merge as ecosystem hygiene — they're load-bearing for Phase 3 and useful before then for Turso/libsql experiments. Recommendation from V1 stands.

### 7.6 Updated open questions

V1's six are subsumed; here are the load-bearing questions for V2:

1. **Cloud hub vs cloud vault as v1.** V2 argues the hub is the right cloud-attachment point. Does Aaron agree? If so, the parked PRs become Phase 3 (a year out), not Phase 1.
2. **Hub-offline = system-offline.** Is multi-hour JWKS caching + a documented "your hub uptime is your auth uptime" caveat acceptable for self-hosted hubs? Or does this push us toward "hub belongs in cloud" as a hard recommendation?
3. **BYO-Cloud (ζ) — is it real?** It's a strong fit with the open-source / sovereignty story but operationally it's the most complex shape (we don't control the runtime). Worth a Phase 4 spike, or a distraction?
4. **Single-binary VPS bundle (η).** Compelling for the homelab / sovereignty audience and architecturally clean, but it's a different product than cloud-hub. Do we explore it as a fifth shape, or park it for the hardware-bundled future?
5. **What does the cloud hub authenticate with?** Native (email/password), Google/GitHub OAuth federation, or both? Federation is easier to ship; native preserves the "no third-party dependencies" story.
6. **Pricing posture.** Cloud Hub at $5/mo (covers Fly + margin) is a low-friction entry. Scribe metered on top. Cloud Vault as a $20/mo tier later. Or one bundle. Founding-team conversation; the shape choice doesn't force the answer.

The framing change makes question 1 the load-bearing one. Everything else flows from it.

---

## TL;DR (v2 — superseded by §8)

- **The frame**: not "where does vault run?" — but "where does the **hub** live, and how do spokes attach?" Four axes: hub location, spoke location, IDP type, hub reachability.
- **OAuth is the connective tissue.** JWTs are portable; spokes validate against the hub's JWKS regardless of where either lives. The boundary cost is JWKS reachability + hub-offline-as-system-offline.
- **Re-derived shapes** (α–η) cover the existing all-local default, hub-cloud + spokes-local (the right reformulation of V1 Shape 3), full SaaS (V1 Shape 1), mixed deployments, BYO-Cloud (tenant-owned Workers), and single-binary VPS.
- **Recommendation (v2, superseded)**: ship **Cloud Hub first** (Phase 1 — Fly.io-hosted `parachute-hub` per tenant). Cloud Vault becomes Phase 3 (V1 Shape 1, parked PRs activate). Scribe + BYO-Cloud are intermediate phases.
- **What v2 missed**: the question of *who operates* the cloud, *how the user buys it*, and *how Claude-login can be the flagship UX*. v3 grounds this — cloud is shipped through **Parachute Computer LLC** as a managed offering, with provider abstraction (VM-on-cheap-cloud, vendor-portable) and Anthropic-dependency mitigations. **See §8 for the active recommendation.**

---

## 8. V3 — Parachute Computer as managed offering

### 8.1 The product entity and value prop

V2 said "ship Cloud Hub first" and was abstract about *who* runs it and *how the user buys it*. V3 grounds that: the cloud product is offered by **Parachute Computer LLC** as a paid managed tier. The user has **one** billing relationship — with Parachute. The hosting partner underneath (Hetzner, Render, Fly, or whoever's currently cleanest) is an implementation detail.

Aaron's framing: "lots of folks who won't want to go to hetzner and get all this configured. So whether it's hetzner or render or something else, assuming we're just going to do all of this via parachute computer, we want to add some light framing around it so that people can just pay us some money and have all this configured."

The product is two sentences:

> **Pay Parachute, get a working stack.** Hub running, spokes installed, auth wired, scribe pool attached, your URL is `<you>.parachute.computer` (or your custom domain) — credit card and a sign-up form, sixty seconds later you're writing.

This is meaningfully different from "we sell Hetzner-with-extra-steps." It's a managed service whose internal substrate happens to be commodity VMs. The user never names a provider, never picks a region beyond a high-level tier, never installs cloudflared. Their mental model is: "I have Parachute Computer."

Pricing posture (working estimate, not a commitment): a $15/mo Starter tier covers the VM + light scribe quota; metered scribe minutes above quota; $30/mo Pro tier with larger quota and custom domain. Team/Enterprise later. The economics hinge on the underlying VM being cheap (Hetzner CX22 is ~€4/mo for 2 vCPU / 4GB RAM, comfortable headroom on $15) — see §8.5.

### 8.2 Signup → provision → connected (UX sketch)

The flow we want, at the UX level (not impl):

1. User goes to `parachute.computer`, clicks "Get Parachute Cloud."
2. Sign up: email + password, OR "Continue with Claude" (their Anthropic account becomes their Parachute identity — see §8.3).
3. Pick a plan, enter payment, choose a subdomain (`<you>.parachute.computer`) or skip for now.
4. Behind the scenes: Parachute Computer's control plane provisions a VM on the current preferred provider, runs a hardened Bun image, starts `parachute-hub` configured with the user's identity and JWKS, installs the spokes the user picked (vault by default; scribe metered; paraclaw on request).
5. Within ~60 seconds the user lands on `<you>.parachute.computer/portal` — the hub's portal UI, already authenticated, with their vault waiting.
6. They open the notes PWA, point it at their hub URL, and they're writing.
7. paraclaw users: they install paraclaw locally on their dev machine, sign in with Claude, and paraclaw federates to their cloud hub. Their notes/codebase context lives in their cloud vault; LLM compute uses their Anthropic key.

The "magic link" piece Aaron mentioned is the keystone — there's no password to remember if you sign in with Claude; the URL we hand back is the only thing the user needs to bookmark.

### 8.3 Claude login as flagship auth UX (paraclaw)

The deepest UX win lives in the paraclaw path. paraclaw is the Parachute Claude Code distribution — the user is already running Claude Code, already has an Anthropic account, already has Anthropic OAuth working (it's how Claude Code authenticates). Layering Parachute on top:

- User logs into Parachute Computer via Anthropic OAuth (third-party app, redirect to Anthropic's auth, scope grants).
- Their Anthropic identity is mapped to a Parachute account.
- Their cloud hub is provisioned tied to that identity.
- paraclaw running locally federates to the cloud hub via the same Anthropic identity — a token from their Claude session validates against the cloud hub, which knows about the Anthropic federation.
- The user's Claude API quota powers paraclaw's LLM calls — same as today's self-hosted paraclaw.
- The user has *one* account end-to-end: Anthropic. Parachute is a thin layer.

That's the killer demo. Aaron's quote captures it: "all they need is an anthropic account and they're good to go." Sign in with Claude → hub + vault provisioned + paraclaw locally federated → Claude has memory.

For vault and scribe specifically, the Anthropic-login path still works (identity is identity), but the **value** is smaller — vault is storage, scribe is transcription, neither calls Claude directly. They benefit from "one less account" but not from "your Claude quota powers this." So the flagship is paraclaw; vault and scribe ride along.

### 8.4 Anthropic-dependency risk + the agent-provider tension

Aaron's TBD: "how long until anthropic shuts us down."

The risk surface, ordered by reach:

- **Anthropic OAuth third-party use.** If Anthropic restricts OAuth to first-party Claude integrations, the "log in with Claude" UX closes. Parachute falls back to email/password or Google/GitHub, but loses the flagship demo.
- **Claude API access for orchestration.** Even with logins working, Anthropic could rate-limit or revoke API access for orchestration-style use. Self-hosted paraclaw is fine (the user is using their own Claude key); Parachute-orchestrated paraclaw is more visible.
- **Scope / endpoint changes.** Anthropic could narrow available scopes, breaking specific flows.

Mitigation paths:

**(a) Multi-IDP from day one.** Cloud hub ships with email/password native, Google OAuth, GitHub OAuth, *and* Anthropic federation. The Claude path is the flagship; the others are the safety net. Vault-only and scribe-only customers use one of the others.

**(b) Multi-API-provider for paraclaw — the live tension.** Issue paraclaw#13 was the agent-provider abstraction rip-out, justified as "premature for self-hosted single-Claude users." Cloud changes the calculus: a Parachute-hosted paraclaw operator absolutely wants to swap providers without touching user code. OpenAI, Gemini, OpenRouter, local Ollama on the cloud VM — each a viable backstop if Anthropic becomes unavailable. **The abstraction we just removed is the abstraction cloud needs back.** This is the single most concrete architectural decision v3 surfaces; flag for Aaron's call.

Two paths:
- **Bring it back, scoped to cloud.** A `provider:` config field in cloud-paraclaw with a runtime switch; self-hosted defaults to Claude with no UX visible. Lighter than the abstraction we removed.
- **Don't bring it back, bet on Anthropic.** Design for the world where Claude is the substrate; revisit if reality forces it. Faster ship, more risk.

Suggestion: bring it back in the lighter form. The cost is small (env var + a thin LLM-client interface); the optionality is large.

**(c) Independent identity primitive.** Parachute Computer issues its own user accounts that *can be* federated to Anthropic but don't *require* Anthropic. Even if Anthropic OAuth disappears tomorrow, accounts persist and re-bind to a different IDP. This is table stakes and aligns with hub-as-issuer (the hub already has its own user accounts; OAuth federation is an option, not the substrate).

**(d) Self-hosting always works.** If Parachute Computer the company stops shipping cloud, the OSS code keeps running on the user's own infra. This is the open-source promise and a meaningful customer reassurance — "even if Parachute shuts down, your data is yours and your stack runs without us."

### 8.5 Provider abstraction (VM-on-cheap-cloud, not a specific vendor)

The doc explicitly does not pick Hetzner, Render, or Fly. The pattern is **VM-on-cheap-cloud**, with these properties:

- A small Linux VM (~1-2 vCPU, 2-4GB RAM, 10-20GB disk).
- Bun + the Parachute stack pre-installed (image baked in CI).
- DNS managed by Parachute (subdomain → VM IP, or custom-domain CNAME).
- TLS via Cloudflare in front (ACM-style auto-provision) or Caddy on-host.
- Backups: nightly snapshot to Parachute-managed object storage; per-tenant export-on-demand.
- Provider currently: TBD. Hetzner is cheapest; Fly is most operationally polished; Render is closer to PaaS. Pick one for v1, hold the option to switch.

The control plane needs:
- A **provisioner abstraction** (`createInstance(spec) → handle`) with implementations per provider.
- A **migrator** (`moveInstance(handle, fromProvider, toProvider)`) for backstop migrations and price-driven moves.
- A **health-check + auto-restart** layer.
- A **billing integration** (Stripe; track which tenant owns which instance).

Users never see the provider name. They see "your Parachute Computer instance." Migration risk lives entirely on Parachute's side — if Render dies or prices spike, we move users overnight without a UX hiccup.

This is the "Parachute Computer as managed offering" promise made concrete: we absorb provider-switching risk; the user doesn't even know it exists.

### 8.6 Architecture changes v3 flags for Aaron

In rough order of stakes:

1. **Reverse paraclaw#13?** Bring back a lightweight agent-provider abstraction, scoped initially to cloud. The case from §8.4(b). Single largest architectural call v3 forces.
2. **Cloud hub ships multi-IDP from day one.** Email/password (native), Google, GitHub, Anthropic-federation. Today's hub has native accounts; federation glue is the new work.
3. **Provisioner control plane.** A small Bun service that orchestrates VM lifecycle across providers, handles billing (Stripe), tracks tenant state, and runs migrations when providers change. New surface area to build — not large, but it's a real service.
4. **Anthropic-OAuth federation work.** Implementing "login with Claude" requires Anthropic-side OAuth client registration + the federation glue in the hub. Doable; not currently scaffolded.
5. **Custom-domain support in cloud hub.** Users want `notes.aarongabriel.com`, not just `<aaron>.parachute.computer`. Cloudflare for SaaS or similar.

None of these require code yet — they're follow-on decisions for after Aaron weighs in on §8.4(b) and the phase plan.

### 8.7 Phase plan (revised from v2)

V2's phases stand; v3 layers operating reality on top:

- **Phase 1 — Parachute Computer Cloud Hub (v3-flavored).** Provisioner control plane + pre-baked stack image + signup at parachute.computer + multi-IDP with Anthropic-federation as flagship + Stripe billing. Validation: 5 paying users in 4 weeks; "log in with Claude → working hub → first agent call" under 5 minutes for paraclaw users. **This is the v1 cloud product.** Roughly two stewards × three weeks; dominated by the provisioner + the Anthropic federation.
- **Phase 2 — Managed scribe pool.** Same as v2.
- **Phase 3 — Cloud vault (full SaaS).** Same as v2; parked PRs (#99 + #101) activate.
- **Phase 4 — BYO-Cloud experiment.** Same as v2.
- **Concurrent (small): paraclaw agent-provider abstraction back.** §8.4(b). Lightweight version, cloud-first; available to self-hosted as opt-in. Pending Aaron's call.

### 8.8 Updated open questions

V2's six are still alive. V3 adds:

7. **Reverse paraclaw#13 for cloud?** The single load-bearing architectural decision. Cloud needs the abstraction; self-hosted didn't. Suggestion is yes-but-lightweight; Aaron's call.
8. **Anthropic OAuth — how much do we lean on it?** Build the flagship UX around it knowing it's revocable, or hedge from day one with email/password as the primary path? Spectrum, not binary.
9. **Provider for v1 — Hetzner, Fly, Render, or other?** This is a price/ops/ergonomics tradeoff that needs founder-level input. Doc doesn't recommend; flags as a call.
10. **Custom domains at what tier?** Pro-only ($30) or universal? CNAME setup is moderate ops cost.

---

## TL;DR (v3)

- **The product entity is Parachute Computer LLC.** The user pays us; we provision a thin VM on whichever provider is currently cleanest (Hetzner, Render, Fly — abstracted); we hand back a working hub + spokes + a URL. One billing relationship, one mental model.
- **Claude-login is the flagship UX for paraclaw.** Sign in with Anthropic → hub provisioned + paraclaw federated + Claude has memory. "All they need is an Anthropic account." For vault and scribe the value is just "one less account."
- **Anthropic-dependency risk is real and explicitly mitigated.** Multi-IDP from day one (email + Google + GitHub + Anthropic-federation); independent identity primitive; multi-API-provider in paraclaw if we reverse #13; self-hosting as the always-available backstop.
- **Provider abstraction (VM-on-cheap-cloud) is a Parachute-side concern, not user-facing.** We migrate users between providers without UX disruption.
- **The single biggest architectural call v3 surfaces**: reverse paraclaw#13 to bring back a lightweight agent-provider abstraction. Cloud needs it; self-hosted didn't. Aaron's call.
- **Phase plan**: Phase 1 = Parachute Computer Cloud Hub with Anthropic federation as flagship. Two stewards × three weeks. Phases 2–4 stand from v2.
