# Frictionless channel setup — hub-orchestrated, UI-first

**Status:** design → build (2026-06-09). Cross-repo arc (vault + channel + hub).
**Goal:** "add a vault-backed channel" becomes **one hub action** (UI button; CLI is the escape hatch), with **zero hand-wiring** — no minted-and-pasted token, no shared secret, no hand-edited `config.yaml` trigger.

## Why

Today, wiring a vault-backed channel means a human: (1) mints a `vault:<v>:write` JWT and pastes it into `channels.json`, (2) invents a shared webhook secret and pastes it in two places, (3) hand-edits the vault's `config.yaml` to add a trigger. Three manual, fragile, un-Parachute artifacts. The hub is already the OAuth issuer + token minter + admin SPA — we should lean on it so the operator does *one thing* and authorizes once. Most users never touch the CLI; the **hub UI is the front door**.

## Target UX

Hub admin SPA → **Channels** → "Add channel" → pick a vault + name → **one click**. Behind it, the hub provisions everything. The UI then shows the copy-paste `claude mcp add --transport http <hub>/channel/mcp/<name>` + launch line to attach a Claude Code session (OAuth — already works). CLI parity: `parachute channel add <name> --vault <v>`.

## The three sins → their fixes

| Manual artifact today | Replaced by | Built in |
|---|---|---|
| hand-minted vault token in `channels.json` | hub mints it off the **operator's session** and wires it in | hub orchestration |
| shared webhook `?secret=` | a **hub JWT** the trigger presents; channel validates via scope-guard | vault trigger-auth + channel |
| hand-edited `config.yaml` trigger | a **runtime trigger-registration API** the hub calls | **vault (keystone)** |

## Architecture — the hub orchestrates; the vault gains a capability

A vault-backed channel is a **hub-brokered connection** between two modules. The hub (acting on the operator's authenticated session) is the orchestrator; the vault gains the *capability* (runtime triggers); the channel exposes a thin config surface and stops trusting a shared secret.

This is the first concrete slice of the earlier **"Connections"** vision — channel↔vault as the first instance of "wire module event → module action," which later generalizes to a hub Connections UI.

## PR sequence

### PR 1 — Vault: runtime trigger-registration API (keystone)

Triggers today are static `config.yaml`, loaded at boot, fired on the global hook registry (all vaults). Add runtime, persisted, **per-vault** triggers.

- **Storage:** a `triggers` table in each vault's SQLite DB (migration): `name` (PK), `events` (JSON), `when` (JSON predicate), `action` (JSON: `webhook`, `send`, `timeout`, **`auth`**), `created_at`, `updated_at`.
- **API** (`/vault/<v>/api/triggers`), **admin-scoped** (a webhook trigger exfiltrates note data to a URL — that's an admin capability, not `write`):
  - `POST` — upsert `{name, events, when, action}`; validates webhook URL; persists; registers on the live hook registry immediately.
  - `GET` — list this vault's triggers.
  - `DELETE /:name` — unregister + delete.
- **Per-vault firing:** the registered hook only acts when the event's vault matches (reuse `getVaultNameForStore`, as the live-query SSE does). Runtime triggers are scoped to the vault they were registered under; `config.yaml` triggers stay global (back-comat).
- **Webhook auth:** `action.auth = { bearer: "<JWT>" }` → the trigger sends `Authorization: Bearer <JWT>` instead of a URL secret. Retires `?secret=`.
- **Boot:** load persisted triggers from each vault DB alongside `config.yaml` ones. Reuse `registerTriggers`/`buildPredicate`; don't fork the two-phase claim logic.
- Backward-compatible: existing `config.yaml` triggers untouched.

### PR 2 — Channel: config API + webhook JWT auth

- **Config API** (hub-JWT-gated, `channel:admin`): `POST/GET/DELETE` vault-backed channels — writes `channels.json` programmatically (no hand-edit). The hub calls this.
- **Webhook auth:** `POST /api/vault/inbound` validates a **hub JWT** (scope-guard, e.g. `channel:send`) instead of the `?secret=` query param. Retires the shared secret.
- **Prescribed trigger as data:** the channel exposes the trigger definition it needs (the `#channel-message/inbound` → `/api/vault/inbound` shape) as module-owned data the hub reads to know what to register — same spirit as `CHANNEL_VAULT_TAG_SCHEMA`. Keep `ensureSchema`.

### PR 3 — Hub: orchestration endpoint + Channels UI (the front door)

- **`POST /admin/channels`** (operator-session gated): mint the channel's `vault:<v>:write` token off the operator session → call the channel config API to add the channel → register the prescribed inbound trigger in the vault (admin) with the hub-JWT webhook auth. Plus list/remove (which also tears down the vault trigger). The one action that does all of PR1+PR2's plumbing.
- **Channels admin-SPA surface:** add (pick vault + name → one click), list, remove, and show the copy-paste session-connect line. No tokens/secrets/YAML ever shown to or touched by the user.

## Auth decisions

- **Credential brokering:** the hub mints the channel's vault token **off the operator's authenticated session** (simplest; the operator's hub auth is the trust anchor) — not a separate channel OAuth client-credentials flow (more moving parts; revisit if channels must self-provision headlessly).
- **Trigger registration is admin** — it's a data-exfiltration capability. Only the hub (on the operator's behalf) registers triggers; the channel never needs trigger-admin (it only declares its *schema*, which is `write`).
- **Webhook is a hub JWT**, validated by the channel via the scope-guard it already uses. No secrets at rest beyond the brokered tokens (same posture as today's `channels.json` token).

## Test plan (per PR + end-to-end)

- PR1: API CRUD + persistence-across-restart + per-vault firing (a trigger on vault A doesn't fire for vault B) + JWT-auth webhook + admin-scope enforcement + config.yaml back-compat.
- PR2: config API CRUD writes channels.json; inbound webhook accepts a valid hub JWT and rejects a bad/absent one (no more secret).
- PR3: orchestration provisions all three; UI add/list/remove; remove tears down the vault trigger.
- **E2E:** UI "add channel" → connect a session via OAuth → inbound note wakes it → reply round-trips. Zero hand-wiring.
