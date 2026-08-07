# AGENTIC_HARNESS_PHASE3_EXECUTION.md

Continuation of AGENTIC_HARNESS_PHASE3.md (which covers the access-model
decision: act-as-member, trust levels, confirmation policy). This doc
tracks actual implementation progress and the concrete architecture for
the harness process itself — read AGENTIC_HARNESS_PHASE3.md first for
the *why*, this doc for the *what's built* and *what's next*.

## Status at a glance

| Piece | Status |
|---|---|
| Auth loop (password + Supabase Auth, trust_level) | ✅ Done |
| `ConfirmationRequiredError` + `pending_actions` | ✅ Done |
| `HarnessGateway` (trust-level chokepoint) | ✅ Done |
| Tool registry (`harnessPolicy.js` / `harnessTools.js` / `harnessToolRegistry.js`) | ✅ Done |
| Routes: `harness-invoke.js`, `pending-actions.js` | ✅ Done |
| Confirm/deny inbox UI (standalone modal) | ✅ Done (placeholder — see Future Direction) |
| `harness_conversations` schema + repository + service | ✅ Done |
| Resume/abandon wiring into `pending-actions.js`'s `resolve` action | ✅ Done |
| **Conversation loop** (`backend/harness/`) | ✅ `llmClient.js`, `toolSchema.js`, `conversationLoop.js` (runTurn + resumeTurn) done |
| **LLM inference server** (home PC) | ✅ Live — Qwen3.5-9B, reachable at `http://10.100.0.2:8080` over WireGuard |
| Chat entry route (e.g. `agent-chat.js`) | ⬜ Not started — next step |
| Agent sidebar UI | ⬜ Not started (future direction) |
| Tests for tool registry / conversation service | ⬜ Deferred by product decision |

---

## What "the harness" actually is (resolved ambiguity)

Three things were previously conflated under "the harness." Resolved:

1. **Harness orchestration logic** — conversation loop, tool-schema
   translation, `HarnessGateway`/`executeTool()` invocation,
   confirmation pause/resume. **Plain JavaScript, lives in this repo**,
   under `backend/harness/` (decided over `src/harness/` since none of
   it runs in the browser — it's server-only, same reasoning that puts
   routes under `backend/` rather than `src/`). No separate process,
   no separate language.
2. **LLM inference** — a real model-serving process. Necessarily
   separate regardless of language choice; this is the ONLY piece that
   isn't part of this codebase. Runs on the home PC.
3. **Member-facing chat surface** — future sidebar UI. Talks to (1),
   never directly to (2).

## Architecture
Oracle VM (existing Partshelf backend, Node/Hono)
│
├── backend/routes/harness-invoke.js ✅ list/invoke, token-gated (harness-only)
├── backend/routes/pending-actions.js ✅ inbox/resolve, member-facing (ungated)
├── api/_lib/harnessPolicy.js ✅ severity map + trust thresholds
├── api/_lib/harnessTools.js ✅ JSON Schema per tool (1:1 w/ service methods)
├── api/_lib/harnessToolRegistry.js ✅ listTools/getTool/executeTool
├── src/services/HarnessGateway.js ✅ trust-level gate + pending_actions write
├── src/repositories/PendingActionRepository.js ✅
├── src/repositories/HarnessConversationRepository.js ✅
├── src/services/HarnessConversationService.js ✅ state machine (start/append/pause/resume/abandon/complete)
│
└── backend/harness/ ⬜ NOT YET BUILT — the conversation loop
- receives a member prompt (via a new chat-entry route)
- HarnessConversationService.start() or resume from an
existing open conversation
- builds an OpenAI-shaped chat request: messages history +
tools: harnessToolRegistry.listTools() translated into
OpenAI's tools array shape
- POSTs to the home PC's inference endpoint over WireGuard
- on tool_calls response: calls executeTool() DIRECTLY as a
function call (same process, no HTTP hop) for each call,
appends results via HarnessConversationService.appendMessage(),
loops back to the LLM
- on ConfirmationRequiredError from executeTool(): calls
HarnessConversationService.pauseForConfirmation(), returns/
suspends — does NOT keep looping
- on plain-text reply with no tool_calls: conversation turn is
done; either wait for the next member message or
HarnessConversationService.complete()

WireGuard tunnel — VM initiates outbound to home PC's tunnel IP
    │
    ▼
Home PC (RTX 3070 Ti 8GB VRAM, 32GB RAM, i5-11400)
└── llama.cpp server (or Ollama) — OpenAI-compatible
POST /v1/chat/completions
Model: Qwen3-14B-Instruct, Q4_K_M GGUF (released April 2025)
Fallback if too slow: Qwen3-8B-Instruct (or Qwen2.5-7B-Instruct
if Qwen3-8B isn't stable yet)

UPDATE: actually running Qwen3.5-9B (chosen for VRAM/speed balance on
the RTX 3070 Ti 8GB). Live and reachable from the Oracle VM at
http://10.100.0.2:8080 over WireGuard. LLM_BASE_URL should be set to
http://10.100.0.2:8080/v1, LLM_MODEL to whatever model name the
server's /v1/models (or its own config) reports — confirm the exact
string llama.cpp/Ollama expects in the `model` field before the first
real chatCompletion() call, since llama.cpp servers are sometimes
permissive about this field and sometimes strict.

### Why the loop lives in the Partshelf process, not a separate service

`executeTool()` already lives in this codebase and calls services
directly — no HTTP hop needed since it's the same process. The
orchestration loop importing `executeTool()` as a function is strictly
simpler and lower-latency than round-tripping through
`harness-invoke.js` over HTTP to itself. `harness-invoke.js` remains
useful as a genuinely external interface (if a fully separate harness
process is ever wanted later) but the loop we're building now doesn't
need it.

The only outbound network call the loop makes is to the home PC's
inference server, over WireGuard (VM → home PC, home PC needs no public
IP or inbound port-forwarding).

## What's been built (detail)

### Auth + trust
`members.trust_level` (int, per-member ceiling, `min(memberTrustLevel,
MAX_TRUST_LEVEL)` where `MAX_TRUST_LEVEL` is a hardcoded constant in
`api/_lib/harnessPolicy.js`, currently `1`). Password auth via Supabase
Auth (`members.auth_user_id`, synthetic `{id}@partshelf.local` email
under the hood, member never sees it). `src/members.js` rewritten;
`src/loginScreen.js` has three panes (login / create / set-password for
legacy pre-migration members).

### Confirmation flow
`ConfirmationRequiredError` (repositories/errors.js, statusCode 202) →
`HarnessGateway.invoke()` catches the trust-level shortfall, writes a
`pending_actions` row, throws. A member resolves it via
`pending-actions.js`'s `resolve` action, which now ALSO looks up the
owning `harness_conversations` row (if any) via
`HarnessConversationService.findByPendingActionId()` and flips it to
`active` (approved) or `abandoned` (denied) — see schema below. The
actual REPLAY of the approved tool call is still the loop's job (not
yet built) — today, resolving a pending action correctly updates state
but nothing automatically re-executes the call yet.

### Tool registry
`harnessPolicy.js`'s `ACTION_SEVERITY` map (one entry per callable
service method, 1:1 — no compound/multi-step tools, per product
decision to defer those) is the single source of truth for severity.
`harnessTools.js` derives `HARNESS_TOOLS` from it, pairing each action
with a JSON Schema (hand-written for ~20 non-trivial actions, auto-
generated for ~10 simple id-shaped ones) and throws at module load if
anything drifts between the two maps. `harnessToolRegistry.js` exposes
`listTools()` (prompt-safe, no service refs), `getTool(name)`, and
`executeTool(name, args, {memberId, isAgent, reason})` — the last one
does basic schema validation, resolves trust level, and calls through
`HarnessGateway`.

### `harness_conversations` schema

```sql
create table harness_conversations (
  id                 text primary key,
  member_id          text not null references members(id) on delete cascade,
  status             text not null default 'active',
    -- 'active' | 'awaiting_confirmation' | 'completed' | 'abandoned'
  messages           jsonb not null default '[]',
    -- OpenAI-shaped: [{ role, content, tool_calls?, tool_call_id? }, ...]
  pending_action_id  text references pending_actions(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
```
Full migration: `random schemas/schema_harness_conversations.sql`.
Repository: `src/repositories/HarnessConversationRepository.js`.
Service: `src/services/HarnessConversationService.js` — `start`,
`appendMessage`, `pauseForConfirmation`, `resumeAfterApproval`,
`abandonAfterDenial`, `complete`, `getById`, `listOpenForMember`,
`findByPendingActionId`.

---

## Next step: `backend/harness/` conversation loop

This is the next thing to build. Concretely, in order:

1. **`backend/harness/llmClient.js`** — thin wrapper around a `fetch`
   to the home PC's `/v1/chat/completions`, OpenAI request/response
   shape. Should be buildable and unit-testable against a **mocked**
   response before the real inference server exists — don't block this
   on the home PC setup.
* claude has written the file, but with two questions: 

a. LLM_BASE_URL / LLM_MODEL env vars — I assumed these belong in the same env-var convention as HARNESS_API_TOKEN/ONSHAPE_ACCESS_KEY (set on the Oracle VM). LLM_BASE_URL should point at the WireGuard tunnel IP once that's set up (e.g. http://10.x.x.x:8080/v1 — llama.cpp's server default port is 8080, adjust if you configure differently).
- yes, the env vars can slot in alongside the Harness_api_token and onshape-access-key. 

b. tool_choice: 'auto' — this is the standard OpenAI default (model decides whether to call a tool), only sent when tools is non-empty. Worth confirming Qwen3's llama.cpp chat template actually honors this field correctly once the server's up — some local chat templates have had rougher tool-calling support than OpenAI's actual API; if Qwen3-14B's tool-calling turns out flaky, that's a template/server config issue to debug against the real server, not something fixable from this client code.
-true. not confirmable at this point in time.

2. **`backend/harness/toolSchema.js`** — pure function translating
   `harnessToolRegistry.listTools()`'s output into OpenAI's `tools`
   array format (`{ type: 'function', function: { name, description,
   parameters } }` per entry).
3. **`backend/harness/conversationLoop.js`** — the actual loop:
   `runTurn({ conversationId, memberId, message })`:
   - load or start conversation via `HarnessConversationService`
   - append the member's message
   - call `llmClient` with full history + tools
   - if `tool_calls` present: for each, call `executeTool()`; on
     `ConfirmationRequiredError`, call `pauseForConfirmation()` and
     return a "waiting on you" result immediately (don't process
     remaining tool calls in the same batch — simplest correct
     behavior until there's a reason to get fancier); on success,
     append the tool result message and loop back to the LLM
   - if plain text: append assistant message, return it as the turn's
     reply
4. **`backend/routes/agent-chat.js`** — thin HTTP entry point,
   `POST { memberId, message, conversationId? }`, calls
   `conversationLoop.runTurn()`, returns the reply or the
   `confirmationRequired` shape (mirror `harness-invoke.js`'s existing
   response shape for that case so client-side handling is consistent).
5. **Resume wiring**: `pending-actions.js`'s `resolve` action currently
   only flips conversation status on approval/denial (done). It should
   ALSO trigger `conversationLoop`'s replay-and-continue on approval —
   likely by having that route call into `backend/harness/` directly
   once it exists, rather than requiring a second separate "resume"
   HTTP call from wherever this route runs. Revisit this wiring once
   the loop exists — the current implementation deliberately stops
   short of it.

Everything above except step 5's final wiring can be built and tested
with a **mocked LLM response** — no need to wait on the home PC.

## Next step (parallel track): LLM inference server

1. Pull `Qwen3.6-8B-Instruct` GGUF, Q4_K_M quantization.
2. Run via `llama-server` (llama.cpp) with tool-calling / chat-template
   support enabled — confirm `/v1/chat/completions` responds correctly
   to a raw curl with a `tools` array before wiring anything else to it.
3. Set up WireGuard: home PC as a peer, Oracle VM as the initiator.
   Confirm the VM can `curl` the home PC's tunnel IP:port before
   touching any Partshelf code.
4. Benchmark 14B vs. the 7B fallback for real inference latency on this
   hardware (RTX 3070 Ti 8GB, 32GB RAM) — decide only after measuring,
   not before.

## Interim testing

No chat UI yet. Once `agent-chat.js` exists, test via curl:

curl -X POST http://<vm>/api/agent-chat
-H 'Content-Type: application/json'
-d '{"memberId":"1234567","message":"..."}'

The inference server should be curl-tested independently first (step 2
above) before the loop depends on it.

## Future direction (not started, no schema/code yet)

- **Agent sidebar UI** — member-facing chat surface, separate from the
  main Inventory/Designer/Fabricate/Part Orders/Agenda modes. Once
  built, the standalone confirm/deny inbox modal
  (`src/pendingActions.js`) should be folded into this sidebar instead
  of staying separate — product direction is: member prompts the agent
  → agent responds with confirmation-needed dialogue inline → member
  decides in the same surface → agent proceeds. The current modal is a
  functional placeholder, not the intended final UX.
- Tests for `harnessTools.js`/`harnessToolRegistry.js` (drift guard,
  `executeTool` plumbing) and `HarnessConversationService` — explicitly
  deferred by product decision, not forgotten.
- Compound/multi-step tools — explicitly out of scope per the 1:1
  granularity decision; revisit only if a real workflow proves too
  clunky as sequential single-tool calls.

