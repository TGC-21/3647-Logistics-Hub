# AGENTIC_HARNESS.md

## ⚠️ Reality check against the current Partshelf codebase

This roadmap was written in fairly generic terms and doesn't line up
with how Partshelf is actually built. Before Phase 1 goes further than
the one worked example below, four things are worth resolving on
purpose:

1. **There is no Express server, no hand-written SQL, and no `/server`
   directory today.** Partshelf's backend is (a) stateless Vercel
   serverless functions under `api/` — each a one-shot handler, not a
   long-running app — and (b) browser code (`src/db.js`) calling
   Supabase's JS client directly. There's no `Routes → Services →
   Repositories → SQL` stack to "extract" — it has to be built. "SQL"
   in this codebase means Supabase's query builder plus a handful of
   named Postgres functions (`reserve_inventory_units`,
   `record_machined_units`, `get_assembly_part_tree`), never a raw query
   string assembled in app code.
2. **Business logic is currently split across the browser, not
   centralized.** Real "service" behavior already exists, but as
   client-side modules: `src/componentMatch.js` (component identity
   rules), `src/designer/fabDetection.js` (category + component
   resolution for spacers/shafts/plates), `src/designer/versionedMutations.js`
   (diff + change-log wrapping), plus invariants like "one active
   fabrication job per part" that are enforced by a Postgres partial
   unique index rather than app code anywhere. There's also an existing
   client/server "twin" pattern worth not tripling — `src/changeLog.js`
   (anon key, browser) and `api/_lib/changeLog.js` (service key, server)
   already do the same job for two different callers; a service layer
   should reconcile that, not add a third copy.
3. **There's no always-on process to host llama.cpp.** Vercel functions
   are stateless and short-lived — no persistent GPU, no resident model
   between invocations. The doc's "RTX 3070 Ti" hardware note implies a
   specific local/on-prem machine. Where the harness itself runs (a
   person's dev machine? a new dedicated box, given 25 users?) decides
   almost everything downstream, including whether it can even reach
   `SUPABASE_SERVICE_KEY`/`ONSHAPE_ACCESS_KEY` safely.
4. **The current security model is intentionally light.**
   `schema.sql`'s RLS policies are `using (true)` on every table (fully
   open to the anon key), and `members.js` is explicit that its 7-digit
   ID login is "identification, not authentication." The doc's Security
   section (auth, tool whitelist, rate limiting) assumes a boundary
   Partshelf doesn't enforce anywhere yet.
5. `fixes/TODO.md` already lists "Introduce a centralized OnshapeClient"
   as the single **Critical** priority, separate from this doc — worth
   deciding whether that's a prerequisite for Phase 1 (a harness tool
   that touches Onshape would otherwise inherit all of that client's
   current lack of centralized retry/rate-limit handling) or genuinely
   independent work.

None of this means the plan is wrong — it means Phase 1 needed a
concrete example against the real codebase before it could be trusted,
not just a relabeling of the doc's generic diagram.

## Reference implementation: Fabrication Jobs

A full worked example of the routes/services/repositories pattern,
applied to one real Partshelf domain, now exists at
[`MIGRATION_EXAMPLE.md`](./MIGRATION_EXAMPLE.md) alongside:

```
repositories/supabaseClient.js
repositories/errors.js
repositories/FabricationJobRepository.js
repositories/AssemblyPartRepository.js
services/FabricationJobService.js
api/fabrication-jobs.js
```

Read `MIGRATION_EXAMPLE.md` first — it explains how the doc's
Express-shaped terms (Route/Service/Repository/SQL) map onto Partshelf's
actual shape (Vercel function/plain class/plain class/Supabase query
builder + RPC), which business rule it rescues from a UI click handler
(`src/fabricate.js`'s `handleDeleteJob`) and why that mattered, and what
debt it leaves in place on purpose (change-log still takes a raw
Supabase client; nothing on the client has been switched over to call
the new route yet). Use it as the template for the next domain rather
than re-deriving the pattern from scratch each time.

## Open questions (blocking anything past the one example above)

1. **Where does the harness/local LLM actually run?** Vercel can't host
   a persistent llama.cpp process. Options worth picking between: a
   personal/admin-only local machine, a new dedicated always-on
   self-hosted server, or swapping the local-LLM plan for a hosted LLM
   API instead. This decides the deployment story for everything else.
2. **What should "the service layer" concretely be, given there's no
   Express app?** The reference implementation above assumes *plain JS
   modules imported directly by Vercel functions* (fastest, no network
   hop, but only reachable by something running in the same Node
   ecosystem). The alternative is *services exposed as their own
   serverless functions* that both the website and a separately-hosted
   harness call over HTTP. These lead to different harness architectures.
3. **What's the intended access boundary for the agent**, given fully
   open RLS and a non-real login today? Should it act as whichever
   member is chatting (which would require building real
   authentication first), as a separate "system" actor limited to
   read-and-propose (no autonomous writes) for now, or be an admin-only
   tool to start and expand later?

# Partshelf Agentic Harness Roadmap

## Goals
Build a local AI orchestration layer that converts natural-language requests into safe, validated operations against Partshelf.

### Core principles
- LLM plans, backend executes.
- Never allow arbitrary SQL generation.
- Never expose internal helper functions directly.
- All actions flow through a service layer.
- Read operations may execute immediately; destructive writes require confirmation.
- Every tool invocation is logged.

## High-level architecture

User
→ Chat UI
→ Agent Harness API
→ Prompt Builder
→ Local LLM (llama.cpp)
→ Tool Planner Loop
→ Service Layer
→ Repository Layer
→ SQL Database

## Suggested project structure

```text
/server
  /agent
    harness.js
    planner.js
    promptBuilder.js
    registry.js
    executor.js
    memory.js
    retrieval.js
    validator.js
    confirmation.js
    audit.js

  /services
  /repositories
```

## Phases

### Phase 1 -- Refactor Application into a Service-Oriented Architecture

#### Objective
Create a strict separation between
> HTTP
> ↓
> Routes
> ↓
> Services
> ↓
> Repositories
> ↓
> SQL Database

After this phase is complete:

- Every piece of business logic exists inside a service.
- Routes become thin HTTP wrappers.
- SQL exists only inside repositories.
- Services become the only API used by both the website and the future AI harness.
- No future code should bypass the service layer.

#### Why?
The AI harness should never know:

- Express
- SQL
- HTTP
- Database schemas
- Transactions

Instead it should simply call:
> PartService.createPart(...)
> InventoryService.moveInventory(...)
> SupplierService.search(...)
> PurchaseOrderService.create(...)

The service layer becomes the application's public API.

Every interface—including:

- website
- REST API
- AI agent
- CLI tools

must call exactly the same services.

#### Architecture After Phase 1
User
      │
      ▼
Express Route
      │
      ▼
Service
      │
      ▼
Repository
      │
      ▼
SQL

Routes should never call SQL. AI should never call SQL. Repositories should never contain business rules

#### Responsibilities

##### Routes 
Routes are responsible for HTTP only.

They should:

- authenticate user
- parse request body
- validate basic request format
- call exactly one service
- convert service response into JSON
- return HTTP status

Routes should never:

- build SQL
- contain inventory logic
- calculate quantities
- perform permissions
- manipulate multiple tables
- know database implementation

Example:
> router.post("/parts", async (req, res) => {
> 
>     const result =
>         await PartService.createPart(req.body);
> 
>     res.json(result);
> 
> });

Nothing more.

##### Services
Services contain every business rule. A service answers: "How should the application behave?"

Examples:
- createPart()
- deletePart()
- moveInventory()
- reserveInventory()
- receivePurchaseOrder()
- consumeInventory()
- renameSupplier()
- archiveProject()

Services may: 
- call multiple repositories
- perform validation
- enforce permissions
- enforce inventory rules
- calculate values
- start transactions
- call other services

Services must never:

- parse HTTP
- access Express
- return HTTP codes
- construct SQL

##### Repositories
Repositories only communicate with SQL. They answer questions like: 
- findPartById()
- searchParts()
- insertPart()
- updateQuantity()
- deleteSupplier()
- getLocations()
- findPurchaseOrders()
Repositories should:

- execute SQL
- map SQL rows into objects
- return plain JavaScript objects

Repositories should NEVER:

- decide permissions
- calculate inventory
- reject business operations
- know who the user is
- call Express

Think of repositories as "database drivers."


#### Business Logic Migration Strategy
Search every route. For each route identify:

##### Validation
move into Service.
Example: 
> if(quantity < 0) 
belongs in Service.

##### Inventory Rules
Move into Service.
Example: 
> cannot consume more than available
belongs in Service.

##### Multi-table ops
Move into Service.
Example: 
> create purchase order
> ↓
> create PO
> create line items
> reserve inventory
> create audit entry

This entire workflow belongs inside one service

##### SQL
Move into Repository.
Example:
> SELECT *
> FROM Parts
> WHERE id=?

Never appears anywhere except repository classes.

#### Folder Structure

server/

    routes/

        parts.js
        suppliers.js
        inventory.js

    services/

        PartService.js
        InventoryService.js
        SupplierService.js
        PurchaseOrderService.js

    repositories/

        PartRepository.js
        InventoryRepository.js
        SupplierRepository.js
        PurchaseOrderRepository.js

#### Example Refactor

###### Before
Route
↓
Parse request
↓
Validate
↓
Run SQL
↓
Calculate inventory
↓
Run more SQL
↓
Return JSON

##### after
Route

> router.post("/inventory/move", async (req,res)=>{
> 
>    const result =
>        await InventoryService.moveInventory(req.body);
>
>    res.json(result);

});

Inventory Service

> moveInventory()
> ↓
> validate request
> ↓
> verify locations exist
> ↓
> verify quantity available
> ↓
> start transaction
> ↓
> InventoryRepository.remove()
> ↓
> InventoryRepository.add()
> ↓
> AuditRepository.log()
> ↓
> commit

InventoryRepository

> removeInventory()
> ↓
> UPDATE Inventory

Nothing else.

#### Service Design Rules

Every public service function should:

perform one business operation
return structured objects
throw typed errors
never return HTTP responses
never access req/res
never generate HTML

Example return:
> {
>    success: true,
>    inventoryId: 42
> }

#### Dependency Rules
Allowed:
> Route
>    ↓
> Service
>    ↓
> Repository

Allowed:
> Service
>     ↓
> Multiple repositories

Forbidden:
> Route
>    ↓
> Repository

Forbidden:
> Repository
>    ↓
> Service

Forbidden:
> Repository
>    ↓
> Repository

Forbidden: 
> Route
>     ↓
> SQL

#### Transaction Ownership
Transactions belong to services. Never inside repositories.

Correct:
> Service
> BEGIN
> Repository A
> Repository B
> Repository C
> COMMIT

Repositories should assume they are executing inside whatever transaction context the service provides.

#### Error Handling
Repositories throw database errors
↓
Servies convert them into business errors.
↓
Routes convert business errors into HTTP responses
Example:
> SQL duplicate key
> ↓
> DuplicatePartNumberError
> ↓
> HTTP 409

#### Success Criteria
Phase 1 is complete only when all of the following are true:

- No Express route executes SQL directly.
- No Express route contains business logic.
- Every business operation is exposed as a service method.
- Every SQL query resides in a repository.
- All multi-step workflows execute within services.
- All database transactions are initiated by services.
- Services can be invoked directly without any HTTP context.
- The web application functions exactly as before, with no user-visible behavioral changes.
- An external caller (such as the future agent harness) can perform every supported operation by calling service methods alone, without requiring knowledge of Express routes or SQL.

### Phase 2
Create tool registry.

Each tool contains:
- name
- description
- JSON schema
- execute()

Example tools:
- search_parts
- create_part
- update_quantity
- move_part
- delete_part
- create_purchase_order
- search_suppliers
- inventory_statistics
- describe_database

### Phase 3
Implement planner loop.

1. Receive user request.
2. Build prompt.
3. Call local LLM.
4. Parse tool call.
5. Validate parameters.
6. Execute service.
7. Return result.
8. Repeat until complete.

### Phase 4
Context retrieval.

Retrieve only relevant records before prompting.

Never place the full database into context.

### Phase 5
Conversation memory.

Maintain:
- current task
- prior tool outputs
- pending confirmations

### Phase 6
Confirmation system.

Require approval for:
- delete
- bulk edits
- inventory resets
- schema changes

### Phase 7
Audit log

Record:
- prompt
- tool
- parameters
- user
- timestamp
- result

## Prompt template

System prompt:
- You are an inventory planning assistant.
- Never invent tools.
- Use only registered tools.
- Ask for clarification if required.
- Prefer searches before updates.

## Model recommendations
Models should be highly intelligent, speed can be sacrificed for accuracy and precision in this case. 

RTX 3070 Ti (8 GB)

Recommended:
- Qwen3 8B Q4_K_M
- Qwen3 14B Q4_K_M (if acceptable latency)
- 

Host with llama.cpp server.

## Security

- No raw SQL from model.
- Parameter validation.
- Transactions for writes.
- Rate limiting.
- Authentication.
- Tool whitelist.
- Read-only schema access.

## Future

- Vision (image-based inventory)
- Voice interface
- Supplier APIs
- BOM reasoning
- Predictive purchasing
- Multi-agent architecture

## Milestone checklist

- [ ] Service layer complete
- [ ] Tool registry
- [ ] Prompt builder
- [ ] Planner loop
- [ ] Retrieval
- [ ] Validation
- [ ] Confirmation
- [ ] Audit logging
- [ ] Chat UI
- [ ] Local model integration
- [ ] Benchmarking
- [ ] Production hardening
