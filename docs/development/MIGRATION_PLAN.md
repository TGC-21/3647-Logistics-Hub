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

#### 1. Inventory Reservation (reserveInstance flow) — ✅ DONE

Extracted into `services/InventoryReservationService.js` (`reserve`, `unreserve`, `releaseAll`), backed by `repositories/InventoryInstanceRepository.js` (wraps `reserve_inventory_units()` the same way `FabricationJobRepository` wraps `record_machined_units()`) and `repositories/PartNumberRepository.js` (the one `backfillComponentId` rule this domain needs). Route: `api/inventory-reservation.js` (`reserve` / `unreserve` actions), harness-token gated, no client caller yet. Rules covered: qty-cap-at-remaining-needed, fork via the already-DB-atomic RPC, part-number backfill on successful reserve, unreserve clearing `componentId` once the last linked instance is removed. Status derivation after a reservation change is delegated to `AssemblyPartService` (item 2) rather than reimplemented here — this service never computes `status` itself. Orphan cleanup on unreserve (deleting a component with zero remaining instances) is intentionally left as a caller-composed step (`ComponentService.deleteIfOrphaned` + an instance count from `InventoryInstanceRepository.countForComponent`) rather than folded into `unreserve()` itself, since "should this component be deleted" is a `ComponentService` decision, not a reservation one. Tests: `api/_lib/__tests__/InventoryInstanceRepository.test.js`, `api/_lib/__tests__/InventoryReservationService.test.js`.

#### 2. Assembly Parts core CRUD + status derivation — ✅ DONE

`computePartStatus`/`derivedAssemblyStatus` now have one canonical home as pure, exported functions in `services/AssemblyPartService.js`, with a `recomputeStatus()` method every other write-path service (currently: `InventoryReservationService`) calls after touching `quantityCollected` instead of computing status inline. `AssemblyPartRepository` grew `findForOwner`, `updateReservationFields`, and `updateQuantityNeeded` to support this. Route: `api/assembly-parts.js` (`updateQuantityNeeded` / `recomputeStatus` / `computeOwnerStatus` actions). Deliberately does **not** yet replace `src/designer/state.js`'s own copies of these functions — that's Phase 2 caller cutover, not this pass. `computeOwnerStatus` only *answers* what an assembly's status should be; writing it onto the `assemblies` row stays out of scope until Assembly/cascade delete (item 8) gives that write a proper home. Tests: `api/_lib/__tests__/AssemblyPartService.test.js`.

#### 3. Component identity / find-or-create — ✅ DONE

`services/ComponentService.js` (`findOrCreate`, `updateFallback`, `deleteIfOrphaned`) backed by `repositories/ComponentRepository.js` and `repositories/CategoryRepository.js` (the latter added narrowly, just to resolve `requiredKeysConfig` for signature-building — full category migration stays item 10). Deliberately reuses `src/componentMatch.js`'s `buildComponentSignature` directly rather than forking a second copy of the matching rules — "what makes two components the same" now has exactly one implementation shared by both the not-yet-migrated client call sites and this service. Route: `api/components.js` (`findOrCreate` / `updateFallback` actions). `deleteIfOrphaned` takes an already-known `instanceCount` from the caller rather than depending on `InventoryInstanceRepository` itself, keeping this service's dependencies scoped to its own domain. Tests: `api/_lib/__tests__/ComponentService.test.js`.

#### 4. Fabrication detection confirm/persist (spacer/shaft/plate) — ✅ DONE

`services/FabricationDetectionService.js` (`confirmDetection`, `ignoreDetection`) replaces the three near-identical `confirm*Detection` functions in `src/designer/fabDetection.js`. Built entirely on top of items 1–3 rather than re-deriving any of their rules: `ComponentService.findOrCreate` resolves the component, `FabricationJobService.createJob` owns the "one active job per part" rule and its own change-log entry, and `AssemblyPartRepository` grew one new method — `updateComponentAndMetadata` — so `componentId` and `fabrication_metadata` are written in a single call instead of two writes that could tear if the second failed. The three kinds' category name + `requiredKeysConfig` (previously `SPACER_CATEGORY_NAME`/`SPACER_REQUIRED_KEYS_CONFIG`, `AXIAL_SHAFT_*`, `PLATE_*` module-level constants duplicated across the client) now live once, in this service's `KIND_CONFIG` map. `CategoryRepository` grew `insert()` (deriving `requiredKeys` from `requiredKeysConfig`, never trusting a separately-passed list) to support the "ensure category exists" step this needs. Route: `api/fabrication-detection.js` (`confirm` / `ignore` actions), harness-token gated, no client caller yet. Deliberately does **not** own attribute-level validation (OD must be a positive number, etc.) — that stays `src/db.js`'s `validateAttribute`, a UI-form concern the confirm overlay already runs before submitting; this service trusts the `attrs` map it's given. Tests: `api/_lib/__tests__/FabricationDetectionService.test.js`, `api/_lib/__tests__/CategoryRepository.test.js`.

#### 5. Cart / Part Orders (cart_items, part_numbers, vendor_listings) — ✅ DONE

Shipped: repositories/CartItemRepository.js, repositories/CartRepository.js, repositories/PartNumberRepository.js, services/CartService.js, api/cart-items.js. Same shape as the Fabrication Jobs reference example:

CartService.createCartItem — cartId + positive-integer quantity required.
CartService.advanceItemStatus — enforces the pending → ordered → received lifecycle strictly forward, one step at a time (today's client-side handleAdvanceStatus in src/partOrders.js has no guard against calling it again on an already-received item — this closes that gap).
CartService.deleteItem — refuses to delete a received item outright (it's a completed purchase — same reasoning fabrication_jobs only lets a queued job be deleted). pending/ordered items delete freely.
CartService.findOrCreateCartForVendor / ensurePartNumberStub — server-side twins of db.js's client versions, for callers (routes, the harness) that aren't the browser's anon-key client.

api/cart-items.js is gated behind assertHarnessToken, same as api/fabrication-jobs.js — it has no client (browser) caller yet; src/partOrders.js still talks to Supabase directly via db.js. That cutover is Phase 2 work, done per-domain only after the route is proven out, per the plan's own rule.

vendor_listings itself was deliberately NOT given a repository — nothing in CartService needed to touch it yet (price/link resolution stays a client-side concern via resolveCartItemDisplay). Add a VendorListingRepository when a service actually needs one, not speculatively.

Tests: services/__tests__/CartService.test.js (fake repositories, no Supabase — proves the status-transition and delete-guard rules) and repositories/__tests__/CartItemRepository.test.js (fake Supabase client, proves table/column shape), following the exact convention FabricationJobService.test.js / FabricationJobRepository.test.js established in Phase 0.

#### 6. Onshape BOM import / reimport — ✅ DONE

Shipped: repositories/AssemblyRepository.js, repositories/AssemblyChildRepository.js, repositories/AssemblyPartRepository.js (extended with bulkInsert, findTreeForAssembly, deleteDirectForAssembly, applyCarryOver), repositories/InventoryInstanceRepository.js (new, releaseMany only), repositories/FabricationJobRepository.js and repositories/CartItemRepository.js (both extended with the carry-over methods reimport needs), services/OnshapeImportService.js, services/OnshapeReimportService.js, api/onshape-bom-v2.js.

Split exactly along the seam the plan called out:

OnshapeImportService — importAssembly (mirrors buildAssembly) and the shared seedAssemblyContents/seedSubassembliesConcurrently tree-walk (mirrors the same-named functions in api/onshape-bom.js). Reuses resolveBomWithSubassemblies/fetchBom/fetchDocumentOwnerId from api/_lib/onshape.js as-is — that file is this codebase's external-API-client layer, not a repository, so its Onshape-fetching logic was deliberately NOT re-homed, only composed.
OnshapeReimportService — reimportAssembly (snapshot → wipe → reseed → relink), with carryOverPromises and logReimportChanges broken out as their own testable methods. Composes OnshapeImportService for the reseed step (constructor-injectable, defaults to a real instance) rather than duplicating tree-seeding — reimport really is "wipe, then seed again."
Both reuse buildSourceKey / fabricationIdentityKey from api/_lib/onshape.js unchanged — the "same underlying Onshape part across two imports" identity rules stay in one place.

api/onshape-bom-v2.js is a new, thin, action-dispatched route (import / reimport), gated behind assertHarnessToken like the other two migrated routes — it does NOT replace the existing api/onshape-bom.js, which keeps serving src/designer/onshapePicker.js and src/designer/assemblyDetail.js unchanged. Once this path is proven out, api/onshape-bom-v2.js's contents can become the new api/onshape-bom.js and the old monolithic handler retired — that cutover is Phase 2 work, per the plan's rule against bundling extraction with cutover.

Known scope line, called out on purpose: this migration covers the BOM tree (parts + subassembly nodes) and promise carry-over (inventory links, fabrication jobs, cart items) — the two things MIGRATION_PLAN.md named. It does NOT cover onshape-detect-fabrication.js's spacer/ axial-shaft/plate geometry detection — that's Phase 1 part 7 ("Fabrication detectors"), listed next for a reason: those detectors are already pure functions with no SQL, so wiring them into a DetectionService is comparatively small, cheap work once this part's AssemblyPartRepository tree-walk methods exist for it to reuse (which they now do).

Tests: services/__tests__/OnshapeReimportService.test.js (fake repositories, no Supabase, no mocking of api/_lib/onshape.js — proves the carry-over/reconciliation rules: inventory carries over, orphaned inventory releases, jobs re-create against the new part id, a source-key collision never double-claims a new part, cart items re-earmark, and the change-log diff only logs genuine adds/removals) and repositories/__tests__/AssemblyRepository.test.js (fake Supabase, table/shape only). OnshapeImportService's own orchestration (importAssembly/seedAssemblyContents) is thinner glue over already- pure Onshape-fetching code and repository calls — not given a dedicated unit test in this pass, since it would mostly be re-asserting that mocked functions were called in order; worth a real integration check against a live/staging Onshape document before Phase 2 cutover instead of a mocked unit test that can't catch a real API-shape mismatch.

The largest, riskiest file (api/onshape-bom.js). Do this after 1–5 are proven, since it depends on assembly-part and change-log patterns already being settled. Split into OnshapeImportService (fetch/seed tree) and ReimportService (snapshot/carry-over/reconcile) rather than one giant service — the file already has this natural seam (buildAssembly vs reimportAssembly).

#### 7. Fabrication detectors (spacer/axial-shaft/plate geometry classifiers) — ✅ DONE

Shipped: services/DetectionService.js, api/onshape-detect-fabrication-v2.js. The three geometry classifiers under api/_lib/detectors/*.js (spacer, axial-shaft, plate) were already pure functions with no SQL and needed no changes — what moved is the orchestration that used to live directly in api/onshape-detect-fabrication.js: DetectionService.detectFabricationCandidates() now owns the whole-part-tree fetch (via AssemblyPartRepository.findTreeForAssembly, reused as-is from item 6), the terminal-status skip (confirmed/queued/ignored rows aren't rescanned), grouping candidates by source Part Studio so bodydetails is fetched once per studio regardless of how many candidate parts it contains, the claim-priority rule (spacer and axial-shaft claim first; plate only classifies rows nothing else claimed, per PLATE_DETECTION_ROADMAP.md), and the plate detector's async postGeometryCheck sheet-metal exclusion (cached per Part Studio for the duration of one detect run, not across requests).

api/_lib/fabrication-detectors.js (the DETECTORS registry) and api/_lib/onshape-bodydetails.js (fetchBodyDetails/bodyDetailsCacheKey/findBodyByPartId) are reused directly, not ported into a repository — same "pure external-API/algorithm layer" reasoning OnshapeImportService already applies to api/_lib/onshape.js. No fabrication_jobs are created here; a 'detected' row still requires a separate confirm step through FabricationDetectionService (item 4).

api/onshape-detect-fabrication-v2.js is gated behind assertHarnessToken and named "-v2", same convention item 6's api/onshape-bom-v2.js established — the existing api/onshape-detect-fabrication.js keeps serving live traffic from src/designer/assemblyDetail.js unchanged; client cutover is Phase 2 work, done only once this path is proven out.

Tests: services/__tests__/DetectionService.test.js — fake repositories plus lightweight mocked detectors/bodydetails fetch (vi.mock), proving the terminal-status skip, the outside-document ignore path, one-fetch-per-Part-Studio grouping, the claim-priority rule (a row spacer already detected never reaches plate's classifyGeometry), and the postGeometryCheck downgrade-to-needs_review path.

#### 8. Assembly / Assembly Children CRUD + cascade delete — ✅ DONE

Shipped: repositories/AssemblyRepository.js (extended with insert for plain "New assembly" creation and update for the Edit assembly modal's rename/status/description/URL fields — insertRoot/deleteById already existed from part 6), repositories/AssemblyChildRepository.js (extended with findWholeTree — a full-row recursive walk, for cascade delete's snapshot step), repositories/CartItemRepository.js (extended with deletePendingForAssemblyPartIds), services/AssemblyService.js, api/assemblies-v2.js.

Confirms the plan's own prediction: deleteAssemblyWithCascade really was mostly a lift-and-shift of src/designer/versionedMutations.js's deleteAssemblyWithHistory — same five-step order (snapshot → release inventory → clean up pending cart items → delete → log), same "every child/part gets its own DELETE change_log row, all under one commit, tagged causedByEntityType/causedByEntityId back to the root assembly" contract — just moved behind repositories instead of a raw Supabase client with the anon key.

Deliberately scoped to ROOT assemblies only, per the plan's bullet: assembly_children rows are never created or edited by a user directly (they only ever come from an Onshape import — see OnshapeImportService/ OnshapeReimportService from part 6) — so AssemblyService has no createChild/updateChild methods. AssemblyChildRepository's role here is read-only tree-walking so the cascade delete can snapshot the subtree before the DB's own FK cascade (ON DELETE CASCADE on both parent_child_id and assembly_child_id) removes it.

api/assemblies-v2.js is a new, thin, action-dispatched route (create / update / delete), gated behind assertHarnessToken like every other route in this migration pass — it does NOT replace src/designer/assemblyGrid.js's saveAssembly or assemblyDetail.js's deleteCurrentAssembly, both of which keep calling Supabase directly today. Cutover is Phase 2 work.

Tests: services/__tests__/AssemblyService.test.js (fake repositories, no Supabase — proves the cascade-delete call ORDER via a shared callOrder array, proves the change-log shape: one commit, correct causedBy* tagging, no causedBy* on the assembly's own delete row; proves updateAssembly only logs fields that actually changed) and repositories/__tests__/AssemblyChildRepository.test.js. The latter's findWholeTree test deliberately does NOT reuse the shared testUtils/fakeSupabase.js — that fake resolves every call to one static fixture, which would make a recursive query (this method pops a queue and re-queries per child) loop forever the first time the fixture contains any rows. Used a small scripted, call-order-aware fake instead, documented inline — worth calling out as a caveat for the next repository method that recurses (AssemblyPartRepository.findTreeForAssembly, already shipped in part 6, has the same untested edge for the same reason and was never covered either).

#### 9. Agenda (tasks/task_links) — ✅ DONE

Shipped: repositories/TaskRepository.js, repositories/TaskLinkRepository.js, services/AgendaService.js, api/agenda-tasks-v2.js.

Confirms the plan's own framing — this is the one domain in Phase 1 built service-first rather than migrated from an existing mutator. src/agenda.js's "layer 1" (data) / "layer 2" (view-model) / "layer 3" (render) split, described in that file's own doc comment, is exactly right and unchanged: layers 2 and 3 (isOverdue, sortForDayView, tasksForDay, the Day-view renderer) are pure display logic over an already-fetched list and have no business being in a service — only layer 1's mutations moved.

The one real business rule extracted: how completedAt reacts to a status change, previously computed identically in two places (saveTask()'s inline ternary and setTaskStatus()'s separate copy in src/agenda.js). Now lives once, as completedAtForStatus() in AgendaService: moving to complete stamps completedAt (but doesn't reset it if already complete), moving to archived preserves whatever completedAt already was (an archived-without-ever-completing task stays null), anything else clears it. createTask/updateTask both route through it — completedAt is never accepted directly from a caller in either method, only derived from status.

addTaskLink validates entityType against the same five values task_links_entity_type_valid enforces at the DB level (schema_agenda.sql) — friendly ValidationError before the Postgres CHECK constraint, same pattern every other service's DB-backstopped check follows elsewhere in this migration. It deliberately does NOT validate that entityId resolves to a real row in whichever of the five tables it names — task_links has no shared FK to check against, same "orphaned link is an app-layer concern" tradeoff its own schema comment already accepts (mirrors change_log's caused_by_entity_type/id columns).

No change_log integration, on purpose — schema_agenda.sql's own comment states tasks are deliberately unversioned for v1 ("Deliberately does NOT touch change_log (skipped for v1 per product decision)"). AgendaService matches that; wiring ChangeLogRepository in here later is a product decision to revisit, not something to add silently in a service-layer pass.

api/agenda-tasks-v2.js is a new, thin, action-dispatched route (create / update / setStatus / duplicate / delete / addLink / removeLink), gated behind assertHarnessToken like every other route in this migration pass. src/agenda.js keeps calling Supabase directly with the anon key, unchanged — cutover is Phase 2 work.

Tests: services/__tests__/AgendaService.test.js (fake repositories, no Supabase — six cases alone just for the completedAt/status coupling: first-time completion, re-saving an already-complete task, reopening, archiving a previously-completed task, and confirming a status-less update never touches completedAt at all) and repositories/__tests__/TaskRepository.test.js (fake Supabase, table/shape only).

#### 10. Categories + validation — ✅ DONE

Shipped: repositories/CategoryRepository.js (grown from its Plan-item-3 read-only slice to full CRUD — findAll/update/deleteById added), services/CategoryService.js, api/categories.js.

validateAttribute, validateRequiredAttributes, migrateRequiredKeysIfNeeded, and formatAttribute are ported from src/db.js's "Typed characteristic helpers" section verbatim, as standalone exported pure functions — no repository, no I/O — so ComponentService/FabricationDetectionService (or a future route) can validate an attrs map without instantiating CategoryService, the same way AssemblyPartService exports computePartStatus/derivedAssemblyStatus as free functions (item 2). Neither of those two services was changed to actually call this validation yet — they still trust the attrs map their caller gives them, per their own doc comments; wiring that in is a caller-cutover-adjacent decision, not something bundled into this extraction.

CategoryService.create/update add enforcement the client form doesn't currently run server-side: every requiredKeysConfig entry needs a non-blank key and a recognized type (string/quantity/enum/segments), and create() rejects a duplicate category name outright (ConflictError) rather than silently allowing two categories with the same name, which src/main.js's quickCreateCat/confirmNewCat never guarded against. Deletion does no cascade work itself — components.category_id is `references categories(id) on delete set null` at the schema level, so components are automatically un-categorized, matching main.js's existing "components outlive their category" behavior.

api/categories.js is gated behind assertHarnessToken, same as every other route from this migration pass — no client caller yet; src/main.js's category modal still calls src/db.js's fetchCategories/upsertCategory/deleteCategory directly.

Tests: services/__tests__/CategoryService.test.js (the four pure functions exercised directly with no mocking, plus CategoryService's CRUD rules against fake repositories) and repositories/__tests__/CategoryRepository.test.js (fake Supabase client, proves the requiredKeys-derived-from-requiredKeysConfig rule holds for both insert and update).

**Phase 1 is now fully done (items 1–10).** Next up per the plan is Phase 2 (per-domain caller cutover) or Phase 3 (auth boundary), whichever the team wants to tackle first — see those sections below for the sequencing rationale.

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