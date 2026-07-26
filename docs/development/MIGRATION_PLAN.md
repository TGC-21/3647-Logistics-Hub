# Migration Plan: Routes → Services → Repositories
## 0. Principles carried forward from the reference example

- One vertical slice at a time, each shippable independently (schema/UI never left half-migrated).
- Repository = only file touching .from(table)/.rpc() for that table; narrow surface, grown on demand, not ported wholesale from db.js.
- Service = plain class, no @supabase/supabase-js, no req/res; owns business rules currently scattered across UI click handlers.
- Route = thin, action-dispatched (body.action) per existing onshape-bom.js/fabrication-jobs.js convention — not REST-nested files.
- Client callers (src/*.js) are not switched over in the same PR as the extraction — migration of callers is a separate, later step per domain.
- Errors: only typed errors from repositories/errors.js cross the service boundary; routes translate via statusForError.
- Change-log stays a known wart until its own pass (see Phase 1 below) — don't invent a second copy per service.

### Phase 0 — Shared infrastructure debt (do first, unblocks everything else) — ✅ DONE

1. ✅ **ChangeLogRepository** — `repositories/ChangeLogRepository.js`. `FabricationJobService` now takes `changeLogRepo` in its constructor instead of a raw `supabase` client; it has zero references to `@supabase/supabase-js`, even indirectly, as a result. Every subsequent service should depend on this the same way.
2. ✅ **Confirmed**: services are plain modules imported directly by Vercel functions (`AGENTIC_HARNESS.md`'s Decisions section). The harness itself never imports these modules — it's an external process on a home server and reaches Partshelf over HTTP through the routes, same surface the browser uses. This didn't change any file's shape, it just made the existing choice load-bearing.
3. ✅ **Repository test convention established, not just described.** `repositories/__tests__/testUtils/fakeSupabase.js` is a minimal fake chainable query-builder client (`.calledWith({ table, method, args })` for assertions) — used by `repositories/__tests__/FabricationJobRepository.test.js` and `repositories/__tests__/ChangeLogRepository.test.js`. Went with constructor-injected fakes over `resetSupabaseClientForTests` for the actual test files, since every repository already accepts a client via its constructor and that's simpler to reason about per-test than a module-level singleton reset in `beforeEach`/`afterEach`; `resetSupabaseClientForTests` stays available in `supabaseClient.js` for the rarer case something can't take a constructor arg. One level up, `services/__tests__/FabricationJobService.test.js` never touches even the fake Supabase client — only plain fake repository objects — which is only possible now that item 1 above removed the service's last direct Supabase dependency. Run with `npm test` (vitest; added as a devDependency).

**Also shipped alongside Phase 0** (agreed in the same conversation, cheap enough not to defer): a shared-secret gate for harness-only routes — `api/_lib/harnessAuth.js` (`assertHarnessToken`, throws the new `UnauthorizedError` from `repositories/errors.js`), wired into `api/fabrication-jobs.js`. Requires `HARNESS_API_TOKEN` to be set identically in Vercel's env vars and the harness's own `.env`; fails closed if unset. This is explicitly NOT the Phase 3 auth boundary — it only answers "may this process call this route at all," not "which member should this action be attributed to."

### Phase 1 — Domain migration order

Order chosen by: (a) how much cross-cutting business logic is currently trapped in UI click handlers, (b) how many other domains depend on it, (c) blast radius if done wrong.

#### 1. Inventory Reservation (reserveInstance flow)

Currently spread across src/designer/inventoryLink.js. Rules to extract: qty-cap-at-remaining-needed, fork/delete-if-emptied (already DB-enforced via reserve_inventory_units), part-number backfill on link, unreserve + component orphan cleanup. Repositories: InventoryInstanceRepository, extend AssemblyPartRepository. This is next per MIGRATION_EXAMPLE.md's own suggestion and unblocks Fabricate/Designer overlap.

#### 2. Assembly Parts core CRUD + status derivation

computePartStatus, derivedAssemblyStatus, quantity-needed/collected invariants — currently duplicated in state.js, partsTable.js, and server-side in onshape-bom.js. Extract into AssemblyPartService so status derivation has one home instead of three.

#### 3. Component identity / find-or-create

componentMatch.js + findOrCreateComponent in db.js — pure logic already, just needs a ComponentRepository wrapper and a ComponentService.findOrCreate() that both Inventory's Add/Edit modal and every fab-detection confirm flow (spacer/shaft/plate) can call identically instead of three near-duplicate client-side call sites (fabDetection.js, main.js, fabricateFlow.js).

#### 4. Fabrication detection confirm/persist (spacer/shaft/plate)

The three confirm*Detection functions in fabDetection.js each do: ensure category → find-or-create component → upsert part → create job → toast. This is the biggest duplicated-business-logic surface in the repo. One FabricationDetectionService.confirmDetection(kind, ...) replaces all three, built on top of #1–3.

#### 5. Cart / Part Orders (cart_items, part_numbers, vendor_listings)

Mirrors Fabrication Jobs' shape closely (queued→ordered→received lifecycle, one-active-ish constraints). Good second full worked example beyond the reference — CartItemRepository, PartNumberRepository, CartService.

#### 6. Onshape BOM import / reimport

The largest, riskiest file (api/onshape-bom.js). Do this after 1–5 are proven, since it depends on assembly-part and change-log patterns already being settled. Split into OnshapeImportService (fetch/seed tree) and ReimportService (snapshot/carry-over/reconcile) rather than one giant service — the file already has this natural seam (buildAssembly vs reimportAssembly).

#### 7. Fabrication detectors (spacer/axial-shaft/plate geometry classifiers)

These (api/_lib/detectors/*.js) are already pure functions with no SQL — they don't need repositories, just need to be called from a DetectionService that owns the Part-Studio-grouping/caching/claim-priority logic currently living directly in onshape-detect-fabrication.js.

#### 8. Assembly / Assembly Children CRUD + cascade delete

versionedMutations.js's deleteAssemblyWithHistory is already service-shaped (snapshot → cleanup → delete → log) — mostly a lift-and-shift into AssemblyService/AssemblyRepository, AssemblyChildRepository.

#### 9. Agenda (tasks/task_links)

Newest, smallest domain — good candidate to build service-first from day one rather than migrating existing logic, since agenda.js's data layer is already cleanly separated (their own comment notes the 3-layer split). Low risk, good practice run for "build it right the first time."

#### 10. Categories + validation

validateAttribute/validateRequiredAttributes/migrateRequiredKeysIfNeeded in db.js — pure logic, low urgency, but every other service above touches categories indirectly (required-keys-config), so a CategoryRepository/CategoryService should exist by the time #3–4 land, even if it's a thin pass.

### Phase 2 — Caller cutover (per domain, after its extraction is proven)

For each domain above, once the route exists and has been exercised:

1. Swap exactly one client call site to hit the new route.
2. Watch for regressions before swapping the rest of that domain's call sites.
3. Only after all call sites for a domain are migrated, delete the now-dead direct-Supabase code path from db.js/src/*.js.

Never bundle a caller swap with the extraction PR (explicit rule from MIGRATION_EXAMPLE.md).

### Phase 3 — Auth boundary (blocking for real harness use)

Decide the access model (act-as-member vs. read-only system actor vs. admin-only) before wiring the harness to any of the above services — every service currently trusts actorId verbatim. This should land after a few domains are stable, not before, so the auth layer is designed against real service shapes rather than guessed.

### Phase 4 — Tool registry + harness wiring (per AGENTIC_HARNESS.md Phases 2+)

Only start once at least domains 1–5 have services with a stable method surface — tools should wrap Service.method() calls 1:1, so a thrashing service surface means constant tool-schema churn.

#### Sequencing rationale summary
Order	Domain	                                                        Why here
0	    Shared infra (change-log, decision on service hosting)	        Blocks everything
1	    Inventory reservation	                                        Explicitly next per existing docs; unblocks 2–4
2	    Assembly part CRUD/status	                                    Triplicated logic, high blast radius if wrong
3	    Component find-or-create	                                    Small, reused by 4
4	    Fab detection confirm (spacer/shaft/plate)	                    Biggest duplication payoff
5	    Cart/Part Orders	                                            Second full reference slice, structurally similar to Jobs
6	    Onshape BOM import/reimport	                                    Highest risk — do once patterns are proven
7	    Fabrication detectors wiring	                                Pure functions, just needs service-level orchestration
8	    Assembly/cascade delete	                                        Already service-shaped, easy lift
9	    Agenda	                                                        Build service-first as a clean second example
10	    Categories/validation	                                        Low urgency but a dependency of 3–4