# Clinker

Clinker is Partshelf's in-app AI agent. A member chats with it (sidebar panel
on desktop, an "AI" tab on mobile) and it looks up or mutates inventory data
by calling the exact same service layer the browser UI calls — nothing about
`CategoryService`, `ComponentService`, or `InventoryInstanceService` knows or
cares that Clinker exists.

This doc replaces the older, now-obsolete `AGENTIC_HARNESS*.md` and
`agent_dynamic_context.md` docs, which described a much larger planned
scope (Designer/Fabrication/Cart/Agenda/Onshape) that Partshelf no longer
has. Everything below reflects what's actually implemented today.

## Status

Fully built and live: auth/trust levels, confirmation flow, tool registry,
conversation loop, LLM inference connection, chat sidebar UI (including the
image → inventory proposal flow). Not yet built: nothing major — remaining
work is incremental (see "Open items" at the end).

## Where things live

```
backend/harness/                 The conversation loop itself
  conversationLoop.js              runTurn / resumeTurn / continueLoop
  llmClient.js                     Thin OpenAI-compatible chat-completions client
  toolSchema.js                    HARNESS_TOOLS -> OpenAI `tools` array
  toolSelection.js                 Picks which tools/domains are in scope for a turn
  domainContext.js                 Per-domain instruction snippets
  contextWindow.js                 Bounds request size, injects system prompt
  toolResultCompactor.js           Trims tool results before they hit the LLM
  turnLock.js / turnProgress.js    Concurrency guard + "thinking..." status
  inventoryProposalTool.js         The propose_inventory_instance virtual tool

backend/_lib/
  harnessPolicy.js                 ACTION_SEVERITY map, trust-level thresholds
  harnessTools.js                  Tool schemas, derived 1:1 from ACTION_SEVERITY
  harnessToolRegistry.js           listTools() / executeTool() — the actual dispatch
  harnessServiceRegistry.js        actionName -> service instance
  harnessAuth.js                   Shared-secret gate for harness-only routes

src/services/
  HarnessGateway.js                 The ONE place trust-level gating happens
  HarnessConversationService.js     Conversation state machine

src/repositories/
  PendingActionRepository.js
  HarnessConversationRepository.js

backend/routes/
  agent-chat.js                    POST turn / GET conversation history
  pending-actions.js                Inbox + approve/deny, drives resume
  agent-proposals.js                Resolve an image-sourced inventory proposal
  harness-invoke.js                 Harness-process-only entry (token-gated)

src/agentPanel.js                  The chat sidebar / mobile tab UI itself
```

## How a turn works

1. Member sends a message (optionally with an attached image) via
   `agentPanel.js` → `POST /api/agent-chat`.
2. `conversationLoop.runTurn()` loads or starts a `harness_conversations`
   row, appends the message, and enters a loop (capped at
   `MAX_TOOL_ITERATIONS`):
   - `toolSelection.js` scopes which tools/domains are offered this turn
     (see "Tool scoping" below).
   - `contextWindow.js` builds a bounded request: system prompt + recent
     history, trimmed to fit a byte budget, with a summary standing in for
     anything dropped.
   - `llmClient.chatCompletion()` calls the model.
   - If the reply has no `tool_calls`, the turn is done — return the text.
   - If it does, each tool call is executed via
     `harnessToolRegistry.executeTool()`, which:
     - validates args against the tool's JSON Schema,
     - resolves the action to a `{ serviceInstance, methodName }` pair via
       `harnessServiceRegistry.js`,
     - calls through `HarnessGateway.invoke()`, which checks the member's
       effective trust level against the action's severity.
   - Tool results are compacted (`toolResultCompactor.js`) and appended as
     `role: 'tool'` messages, then the loop calls the LLM again.

## Trust levels & confirmation

`effectiveTrustLevel = min(member.trust_level, MAX_TRUST_LEVEL)` —
`MAX_TRUST_LEVEL` is a hardcoded ceiling in `harnessPolicy.js` (currently
`1`); a member can only ever lower their own effective level, never exceed
the developer-set max.

Every callable action has a severity (`read` | `write` | `destructive`) in
`ACTION_SEVERITY`. An action not in that map is not callable by Clinker at
all, confirmation or not — fail closed.

If the member's trust level is below what an action's severity requires,
`HarnessGateway.invoke()` writes a `pending_actions` row and throws
`ConfirmationRequiredError`. The loop:
- stubs out any remaining tool calls in the same batch as "deferred" (so
  message history stays protocol-valid),
- flips the conversation to `awaiting_confirmation`,
- returns `{ status: 'awaiting_confirmation', pendingActionId, message }`.

The member approves/denies from the sidebar's inline confirmation card
(`pending-actions.js`'s `resolve` action). Approval flips the conversation
back to `active` and calls `conversationLoop.resumeTurn()`, which finds the
one unanswered tool call, replays it with `confirmed: true`, and continues
the loop. Denial abandons back to `active` without replaying.

## Tool registry

One tool per `ACTION_SEVERITY` entry — strictly 1:1 with a service method,
no compound/multi-step tools. `harnessTools.js` derives each tool's JSON
Schema (hand-written for the ~20 non-trivial actions, auto-generated for
simple id-shaped ones) and asserts at load time that severities can't drift
from `harnessPolicy.js`.

`backend/_lib/__tests__/harnessToolCoverage.test.js` is a drift guard: every
public method on a registered service must either appear in
`ACTION_SEVERITY` or have an explicit, reasoned entry in
`KNOWN_NON_ACTIONS`. This is what catches "a service method exists and
works but was never wired up as a tool" before it becomes a silent gap the
LLM has to route around.

## Tool scoping (dynamic context)

Because Partshelf's domain surface is now small (Categories, Components,
Inventory Instances), tool/context scoping is much less load-bearing than
it was when Designer/Fabrication/Cart/Agenda also existed. It's kept because
it's cheap and still trims prompt size, but there's currently only one real
domain worth narrowing around: **inventory**.

`toolSelection.js`:
- `matchedDomainsForText(text)` — regex match against one message.
- `accumulatedDomains(messages)` — unions matches across every user message
  in the conversation, plus any domain a tool call has already touched, so
  a domain doesn't drop out of scope mid-conversation.
- `selectToolActions(messages)` — the tools actually offered to the LLM this
  turn. Falls back to the full registry when nothing has matched yet.
- `expand_scope` — a virtual, always-offered tool (not a real service
  action) the model can call to pull in a domain it wasn't given by keyword
  match. Handled inline in `conversationLoop.js`; never counts against
  `MAX_TOOL_ITERATIONS`.

`domainContext.js` carries the matching instruction snippets
(`DOMAIN_CONTEXT`), joined into the system prompt by `contextWindow.js` for
whichever domains are in scope. Only `inventory` is authored today — add a
new domain's snippet here (and a matching `DOMAIN_PATTERNS` entry in
`toolSelection.js`) if a new tool family is ever added.

## Image → inventory proposals

A member can attach a photo and ask Clinker to add it to inventory. Rather
than writing an instance directly, the model calls the virtual
`propose_inventory_instance` tool (`inventoryProposalTool.js`) once per
distinct part visible in the photo. Each call is queued onto the
conversation's `pending_proposals` array
(`HarnessConversationService.queueProposals`), and the turn ends with
`status: 'proposal'`.

`agentPanel.js` renders one proposal at a time as an editable card
(category picker, typed characteristic fields, quantity/location/notes).
Confirming calls the **same** `createInventoryInstance` the manual "Add
component" modal uses — Clinker never gets a separate, weaker write path.
Confirming or discarding syncs back via `agent-proposals.js` so the queue
state is consistent across sessions/devices, but the local in-memory queue
in `agentPanel.js` is authoritative for "what shows next," so a slow/failed
sync can never strand the member mid-review.

## Auth model

Clinker acts **as the member**, not as a separate system identity —
`change_log` rows written via Clinker look identical to ones the member
made by hand (same `actor_id`), so history reads the same regardless of
surface. There is no separate "harness" identity in the data model.

`backend/_lib/harnessAuth.js` (`assertHarnessToken`) gates the one
process-to-process route (`harness-invoke.js`) with a shared secret — it
proves "this caller is the harness process," not "this caller is entitled
to act as member X." Every member-facing route (`agent-chat.js`,
`pending-actions.js`, `agent-proposals.js`) currently trusts `memberId`
from the request body, same posture every other route in this app takes
(no real per-request session verification exists yet — see
`src/repositories/errors.js`'s `UnauthorizedError` for where that would
plug in if it's ever added).

## Open items

- Tests for `harnessTools.js` / `harnessToolRegistry.js` schema drift and
  `HarnessConversationService` — deferred by product decision, not
  forgotten.
- Backfilling `domainContext.js` snippets for any newly-added domain, if
  Clinker's tool surface grows again.
- Revisiting `MAX_TRUST_LEVEL` (currently capped at `1`) once trust-level
  1 behavior has been exercised enough in real use.