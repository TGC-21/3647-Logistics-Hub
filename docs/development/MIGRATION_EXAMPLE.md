# Migration example: Fabrication Jobs

This is a worked example of AGENTIC_HARNESS.md's Phase 1
(routes → services → repositories) applied to one real vertical slice
of Partshelf. It's meant to be copied as a *pattern*, not as the only
slice that needs migrating — read this doc, then repeat the shape for
the next domain (Inventory reservation, Assembly Parts, Cart Items, ...).

## Why fabrication jobs

It's small enough to read in one sitting but has everything worth
demonstrating:

- **A real cross-cutting business rule** — "one active job per part" —
  that today is checked ad hoc by callers (`fetchActiveJobForPart` in
  `src/db.js`) rather than owned by one place.
- **A rule that's currently a latent bug magnet**: deleting a queued job
  must also reopen its linked part for re-detection
  (`fabrication_metadata.status`), or `/api/onshape-detect-fabrication.js`
  will silently never scan that part again. That fix-up lives inside a
  button's click handler today (`src/fabricate.js`'s `handleDeleteJob`)
  — anything else that ever deletes a queued job (a script, a different
  UI, the agent harness) would have to remember to copy it.
- **A real atomic multi-table operation already pushed into the DB**
  (`record_machined_units()` in `schema.sql`) — a good example of a
  repository wrapping a Postgres function instead of re-deriving a
  transaction in JS, since Supabase's JS client has no multi-statement
  transaction API.

## What changed

```
repositories/supabaseClient.js         — one place that builds the service-role client
repositories/errors.js                 — typed errors (Validation/NotFound/Conflict/Database)
repositories/FabricationJobRepository.js
repositories/AssemblyPartRepository.js — narrow slice: only what this service needs
services/FabricationJobService.js      — createJob / recordMachinedUnits / deleteQueuedJob
api/fabrication-jobs.js                — thin route, action-dispatched
```

Drop these into the real repo at the same relative paths (repo root
gets new top-level `services/` and `repositories/` folders, siblings of
`api/` and `src/`). Nothing existing is deleted or changed by this
example — see "What's deliberately NOT done yet" below.

## How the pattern maps onto Partshelf specifically

AGENTIC_HARNESS.md's Phase 1 was written for a generic
`Routes → Services → Repositories → SQL` Express app. Partshelf doesn't
have an Express app — every `api/*.js` file is a stateless Vercel
serverless function, and "SQL" mostly means Supabase's query builder
plus a few Postgres functions, never a raw SQL string assembled in app
code. The mapping used here:

| Doc's term   | Partshelf's real equivalent |
|---|---|
| Route        | One Vercel function in `api/*.js` — HTTP parsing + one service call + response mapping, nothing else |
| Service      | A plain class in `services/*.js` — no HTTP, no SQL, only calls repositories and other services |
| Repository   | A plain class in `repositories/*.js` — only file allowed to call `.from(table)` or `.rpc(fn)` on the Supabase client for that table |
| "SQL"        | Supabase's query builder, or a named Postgres function (`record_machined_units`, `reserve_inventory_units`, `get_assembly_part_tree`) — repositories call these, never assemble query strings |

This is why `FabricationJobRepository.recordMachinedUnits()` calls
`.rpc('record_machined_units', ...)` instead of reimplementing that
function's three-table transaction in JavaScript: the DB function
already *is* the atomic unit of work; the repository's job is to give
it a clean name and a mapped return shape, not to re-derive it.

## Update — Phase 0 (MIGRATION_PLAN.md) is done

Since this doc was first written, `MIGRATION_PLAN.md`'s Phase 0 shipped:

- **`repositories/ChangeLogRepository.js`** exists and
  `FabricationJobService` now depends on it instead of a raw Supabase
  client — debt item 1 below is resolved, kept in the list crossed out
  rather than deleted so the "why" is still visible.
- **The service-shape question is confirmed** (plain modules imported
  directly by Vercel functions — see `AGENTIC_HARNESS.md`'s Decisions
  section). Nothing changes shape as a result; it's now load-bearing
  instead of provisional.
- **A repository test convention exists and is exercised**, not just
  described: `repositories/__tests__/testUtils/fakeSupabase.js` is a
  minimal fake query-builder client (chainable, `.calledWith(...)` for
  assertions) that every repository test constructs instead of touching
  real Supabase. Service tests go one level further and never even see
  a fake Supabase client — they inject plain fake repository objects
  directly, which is only possible now that `ChangeLogRepository`
  removed the service's last direct Supabase dependency. See
  `repositories/__tests__/FabricationJobRepository.test.js`,
  `repositories/__tests__/ChangeLogRepository.test.js`, and
  `services/__tests__/FabricationJobService.test.js` for the pattern to
  copy on the next domain. Run with `npm test` (vitest).
- **`api/fabrication-jobs.js` is now gated behind a shared harness
  token** (`backend/_lib/harnessAuth.js`) — see that file's own doc comment
  for why this is scoped narrowly and isn't a substitute for real
  per-member auth.

## Known debt this example intentionally leaves in place

Don't "fix" these while copying the pattern elsewhere — they're called
out on purpose so the next migration doesn't quietly diverge:

1. ~~`recordChangeServer` still takes a raw Supabase client, not a
   repository.~~ **Resolved by Phase 0** — see above.
2. **Nothing on the client (`src/db.js`, `src/fabricate.js`,
   `src/designer/fabricateFlow.js`, `src/designer/fabDetection.js`) has
   been switched to call `/api/fabrication-jobs` yet.** They still call
   Supabase directly with the anon key, exactly as before. Swapping them
   over is a separate, deliberately later step (`MIGRATION_PLAN.md`
   Phase 2) — do it only after this route has been exercised for real,
   so a bad migration doesn't take down a working UI flow at the same
   time as the refactor. Note this is now ALSO gated behind the harness
   token, so a client cutover for this specific route needs its own
   auth decision first, not just a fetch() call added to the frontend.
3. **Auth (for humans) is still a no-op.** `actorId` is trusted as
   whatever the caller sends, same as the rest of the app today
   (`getCurrentMemberId()` is client-supplied, not verified). The
   harness token added in Phase 0 only gates *which process* may call
   the route at all — it says nothing about which member the action
   should be attributed to. That's `MIGRATION_PLAN.md`'s Phase 3, still
   open.
4. **`AssemblyPartRepository` only has two methods.** It is not a port
   of every `assembly_parts` query in `src/db.js`. Grow it (or add
   sibling repositories) only when the next service actually needs
   another method — resist pre-building a full repository surface
   speculatively; that's exactly the kind of work that goes stale before
   it's ever exercised.

## How to repeat this for the next domain

1. Pick ONE current user-facing action (not a whole file like `db.js`) —
   e.g. "reserve inventory for a part" (`reserveInstance` +
   `upsertAssemblyPart` + `linkPartNumberToComponent`, today spread
   across `src/designer/inventoryLink.js`).
2. List every business rule involved, in plain English, before writing
   code — e.g. "can't reserve more than `quantityNeeded - quantityCollected`
   remaining," "forking an instance to exactly empty it deletes the
   source row" (already true, enforced by `reserve_inventory_units`).
   Each rule becomes either a service-level check (with a typed error)
   or a note that the DB already enforces it and the service just needs
   to translate the failure.
3. Write the repository first — one method per actual call the service
   will make, named after what it does (`reserveUnits`, not `update`).
4. Write the service — no `@supabase/supabase-js` import, no `req`/`res`.
5. Write the route last — it should be almost boring to read, the same
   shape as `api/fabrication-jobs.js` above.
6. Leave the existing client-side code alone until the new route is
   proven out. Migration of callers is its own PR, not bundled with the
   extraction.

## Open question this still doesn't answer

This example assumes "services are plain JS modules imported directly
by Vercel functions" — one of the options from AGENTIC_HARNESS.md's
open questions, not yet confirmed. If the answer ends up being "new
serverless functions that both the website and the harness call over
HTTP" instead, `services/FabricationJobService.js` wouldn't change, but
how the agent harness *reaches* it would — via `import` (fast, no
network hop) if it runs in the same Node process, or via an HTTP call to
`/api/fabrication-jobs` if it runs elsewhere. Worth deciding before this
pattern gets copied 10 more times.