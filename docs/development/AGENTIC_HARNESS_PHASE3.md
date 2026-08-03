# AGENTIC_HARNESS_PHASE3.md

## Status

Planning. Phases 1–2 of `AGENTIC_HARNESS.md` are done (service layer exists
for 10 domains; tool registry / harness wiring per Phase 2 is complete).
This document is Phase 3: "Decide the access model... before wiring the
harness to any of the above services."

## Decision: act-as-member, not a system actor

The harness (an LLM running on a home PC, per the current plan) processes
a member's prompt and calls Partshelf's services **as that member** — not
as a separate "AI" identity. A `change_log` row written via the harness
should look exactly like the member did it themselves, with one thin
extra marker (see `via` below) purely for audit visibility, not for
authorization logic.

```
Member (already signed in to Partshelf via members.js)
  → pairs the harness with their memberId once (see Pairing, below)
  → later: sends a prompt to the harness
  → harness resolves the prompt into one or more service calls
  → harness calls Partshelf's harness-only routes, presenting
    (a) the harness process token, and (b) the member's session token
  → routes derive actorId from the verified session — never from the
    request body — and call the existing Service methods unchanged
```

**Nothing in `services/*.js` changes.** Every service already accepts a
plain `actorId` parameter and threads it into `ChangeLogRepository`. The
gap Phase 3 closes is entirely at the route/auth layer: today `actorId`
is client-supplied and unverified, which is fine for the browser (nobody
but the member can drive their own browser) but not fine for the harness
(a second process that could otherwise assert *any* memberId).

## Why not simpler options

- **Read-only system actor**: doesn't match the product goal — the person
  explicitly wants the harness to take real actions on the member's
  behalf, not just propose them for someone else to click through.
- **Admin-only tool**: too coarse: every write would be attributed to one
  fixed identity regardless of who actually asked for it, which breaks
  the "history reads like the member did it" goal and removes any
  meaningful per-member accountability.
- **Trust `actorId` straight from the harness's request body** (i.e. the
  harness just says "I'm acting as member X"): this is the status quo
  and the thing Phase 3 exists to fix. The harness-token shared secret
  (`api/_lib/harnessAuth.js`) only proves "this caller is the harness
  process" — it says nothing about which member actually authorized a
  given action, so a bug in intent-extraction or a compromised harness
  could silently attribute (or misattribute) writes to any member.

## Scope: web-app only, Discord deliberately deferred

Identity lives entirely inside Partshelf for now — a member's identity
is their existing 7-digit `members.id`, established the same way it
already is (`members.js`'s ID-lookup login). The harness never learns
about Discord, Slack, or any other surface in this phase.

This is not a dead end for later Discord integration: the pairing
mechanism below (a short-lived code minted from inside the logged-in
web app) is exactly the same shape a future "type `/connect ABC123` in
Discord" flow would use — the code is surface-agnostic, it's just a
proof that *someone* who already controls this Partshelf identity wants
to authorize this harness session. Nothing here needs to be redesigned
to add a second pairing surface later; you'd just add a second place
that *submits* a code, not a second identity model.

## The two-token model

- **`X-Harness-Token`** — unchanged. Proves "this caller is a legitimate
  harness process." Existing `assertHarnessToken()` stays exactly as-is.
- **`X-Member-Session`** — new. A signed, short-lived, revocable token
  that resolves to exactly one `memberId`. Proves "the person who owns
  this Partshelf identity authorized this harness to act for them."

A harness-only route requires **both**. `actorId` is never read from the
request body on these routes — it's derived server-side from the
verified session token. This is the actual fix: even a fully compromised
harness process (has the shared secret) still can't act as an arbitrary
member without also holding that member's own session token.

This deliberately mirrors the existing "identification, not
authentication" posture (`members.js`'s own comment) rather than
introducing passwords or OAuth — a session token proves roughly the same
thing today's 7-digit login already proves, just resistant to a blind
guess/replay from a process that isn't the member's own browser.

## Pairing flow (web-app only)

1. Member is logged in to Partshelf normally (`loginMember`).
2. Member opens a "Connect harness" action (a button/modal — exact UI is
   a later, small decision, not architectural). Partshelf mints a
   short-lived pairing code (e.g. 6 characters, ~10 minute expiry) tied
   to their `memberId`, shown on screen.
3. Member enters that code into the harness (its own prompt/config UI,
   wherever that lives on the home PC).
4. Harness exchanges the code, once, for a longer-lived `X-Member-Session`
   token via a dedicated route. The code is single-use and expires
   immediately on redemption or timeout, whichever comes first.
5. From then on, the harness attaches that member's session token to
   every service call it makes while fulfilling that member's prompts.

No Discord IDs, no external identity providers — the code is just a
short-lived bridge between "the browser, where the member is definitely
themselves" and "the harness, which isn't."

## Confirmation policy

Only **destructive** actions require confirmation before the harness is
allowed to actually call the service — matches the original
`AGENTIC_HARNESS.md` Phase 6 intent, and matches what was agreed here:
start strict, loosen deliberately, not accidentally.

Destructive, in this codebase's terms, means: assembly delete (cascade),
part delete, fabrication job delete, category delete, cart item delete
of a non-pending item. (Deliberately reuses whatever each Service already
treats as irreversible or hard-to-undo — nothing new to define here.)

**Confirmation policy is one config value, not a schema concept.** The
harness (not Partshelf's services) owns a `confirmationPolicy` setting,
e.g.:

- `strict` (default/starting point) — every destructive action requires
  an explicit "yes" from the member in the same conversation before the
  harness calls the service at all.
- `relaxed` — only a configurable subset needs confirmation (e.g. cascade
  deletes only, not single-part deletes).
- `autonomous` — no confirmation gate; relies entirely on the two-token
  auth boundary plus `change_log` for accountability.

This lives entirely in the harness's own planner-loop config (per
`AGENTIC_HARNESS.md`'s `/agent/confirmation.js`), not in Partshelf's
services or routes — a service has no way to know whether "the member
said yes" happened, and shouldn't need to. This is what makes "give the
harness more control little by little" a one-line config change on the
harness side, not a Partshelf redeploy.

## The `via` distinguisher

One nullable column, `change_log.via` (`'ui' | 'harness'`, default
`null` treated as `'ui'` for every existing row and every existing call
site that doesn't pass it). Additive, same spirit as `caused_by_entity_type
/ caused_by_entity_id` being bolted onto `change_log` for cascade
deletes — no existing behavior changes.

Purely observational:
- `historyPanel.js` can show a small "via harness" tag on a commit card.
- Lets anyone audit `WHERE via = 'harness'` if something looks wrong.
- Never participates in authorization — that's entirely the two-token
  check at the route layer, before any service method is even called.

## What changes, concretely

**Unchanged:**
- Every `services/*.js` file — zero changes.
- Every existing browser-facing route (`api/categories.js`,
  `api/cart-items.js`, etc.) — no auth gate added; that's still the
  correct call per those routes' own documented reasoning ("no real
  per-member auth boundary exists yet, gating one route is theater").
- `api/_lib/harnessAuth.js` / `assertHarnessToken` — reused as-is for
  the process-level half of the check.

**New:**
- `member_sessions` table (`id`, `member_id`, `token_hash`, `created_at`,
  `expires_at`, `revoked_at`).
- `pairing_codes` table (`id`, `code_hash`, `member_id`, `created_at`,
  `expires_at`, `redeemed_at`) — short-lived, single-use.
- `repositories/MemberSessionRepository.js`, `repositories/PairingCodeRepository.js`
  — same fake-Supabase test convention as every other repository here.
- `services/MemberAuthService.js` — `createPairingCode(memberId)`,
  `redeemPairingCode(code) -> sessionToken`, `verifySession(token) ->
  memberId`, `revokeSession(token)`.
- `api/member-pairing.js` — browser-facing, no gate (same as every other
  member-facing route today): `create` (mint a code while logged in),
  and nothing else — redemption happens from the harness side.
- `api/_lib/harnessMemberAuth.js` — `assertHarnessMemberToken(req) ->
  memberId`, requiring both `X-Harness-Token` and `X-Member-Session`,
  throwing the existing `UnauthorizedError` on any failure. This is the
  one new piece of shared plumbing every harness-reachable route calls.
- A small number of new or extended routes that are harness-reachable —
  scoped to 2–3 already-stable domains first (see Rollout below), using
  `assertHarnessMemberToken` instead of trusting `body.actorId`.

## Rollout

### 3a — Pairing + session infrastructure
Ship `member_sessions`, `pairing_codes`, `MemberAuthService`,
`api/member-pairing.js`. No harness wiring yet — this phase only proves
codes mint, redeem once, expire, and sessions verify/revoke correctly.
Testable in isolation the same way every other service in this codebase
is (fake repositories, no real Supabase).

### 3b — `assertHarnessMemberToken` + first harness-reachable routes
Add the shared auth helper. Pick 2–3 low-blast-radius, already-stable
domains — Categories, Cart Items, and Assembly Parts (non-delete
actions) are good first candidates — and give them harness-reachable
paths that derive `actorId` from the verified session. Explicitly do
NOT wire anything destructive yet.

### 3c — `via` column + destructive-action confirmation wiring
Add `change_log.via`. Thread `source: 'harness'` through
`ChangeLogRepository.record()` for calls made through harness-gated
routes (optional param, defaults preserve every existing call site).
Wire the harness's own `confirmationPolicy = 'strict'` default so every
destructive action (assembly/part/job/category delete) requires an
explicit member "yes" in-conversation before the corresponding
harness-reachable route is ever called.

### 3d — Visibility + revocation UX
Small `via: 'harness'` badge in `historyPanel.js`. A simple "Connected
harness" view (could live in a settings-style modal, doesn't need its
own top-level mode) where a member can see their active session(s) and
revoke one — this is the real, member-controlled kill switch if the
harness ever misbehaves, independent of anything happening on the
harness's own machine.

### 3e (later, not blocking) — loosen confirmation policy per data
Once 3a–3d are stable in real use, revisit whether `confirmationPolicy`
should default to `relaxed` for a subset of actions. This is a config
change on the harness side, not a Partshelf migration — deliberately
kept cheap to revisit.

## Explicitly out of scope for Phase 3

- Discord (or any non-Partshelf) identity linking — the pairing code
  mechanism is designed to extend to it later without rework, but no
  actual Discord code is written here.
- Any change to browser-facing routes' existing "no auth gate" decision.
- A general "real password-based login" system — session tokens here are
  scoped narrowly to "prove this harness may act as this member," not a
  replacement for `members.js`'s existing identification model.
