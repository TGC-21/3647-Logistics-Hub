# Agent Dynamic Context
This document outlines a proposed change to agent prompting (read AGENTIC_HARNESS.md for context). The goal is to encapsulate the information passed on to the agent (tools and instructions) into categories, since partshelf has several different domains that might not ALL be needed for a single user prompt. This system aims to load the **appropriate** tools and context for any given user prompt.

## Implications
Since tools and context are loaded based on the user's request, the LLM won't load useless information that it doesn't need for the request. The main advantage I'm chasing is the ability to add very detailed descriptions to tools and LLM instructions; removing irrelevant context creates space for pertinent, in depth explanations and context.

## Implementation
Before a user prompt is forwarded to the LLM, it will be analyzed by JS functions and keyword-matched to find categories. ie. user says, "I want to know what parts in 0200-Pivot have been sent to fabrication" --> function sees "fabric" and loads fabrication tools and context. I'm leaning away from LLM analysis because it isn't strictly necessary and increases response delay from a user perspective.

## Things to Note

To guard against faulty processing (let's say the user misspells "asembly" or "ivntory"), tools and context should be packaged into a "tool" for the LLM to call in case it needs more info. This also addresses an issue with the example above: user says "I want to know what parts in 0200-Pivot have been sent to fabrication" --> function loads fabrication tools and context --> function doesn't know that 0200-Pivot is an assembly --> LLM *hopefully* reasons that 0200-Pivot is an assembly and requests the correct context 

# Dynamic Context Loading — Implementation Roadmap

## 0. Summary of what's being built

Extend the existing toolSelection.js keyword-domain system so that each domain also carries a context snippet (extra instructions), domain selection accumulates across a conversation instead of resetting per-turn, tool execution is never hard-blocked by selection (selection only affects what's offered to the model, not what executeTool will run), and the model gets a real, low-cost expand_scope tool it can call to pull in a domain it wasn't given by keyword match.

Nothing here touches HARNESS_TOOLS, harnessPolicy.js, or executeTool's authorization logic — this is purely a prompt-construction concern layered in front of the existing tool-calling loop.

## 1. Data model: domains gain a context snippet

File: backend/harness/toolSelection.js

Today DOMAIN_PATTERNS is { pattern, services }. Extend each entry with a contextId (or inline context string) pointing at a snippet of domain-specific instructions:

{ pattern: /fabricat|machin|spacer|plate|shaft|cnc/i,
  services: [...],
  contextId: 'fabrication' }

New file: backend/harness/domainContext.js

A map DOMAIN_CONTEXT = { fabrication: '...', assemblies: '...', inventory: '...', cart: '...', agenda: '...' }.
Each value is a short markdown/text block — the kind of thing currently crammed into CLINKER_RESPONSE_INSTRUCTIONS (e.g. "assemblyChildId identifies a specific subassembly instance... prefer child-specific tools...").
You (not me, per your note) will author the actual text; I'm just defining where it lives and how it's loaded.
Keep these short — a paragraph or two per domain, since the whole point is avoiding one giant blob.

This is additive and decoupled: toolSelection.js stays the single source of "which domain does this text belong to," and domainContext.js is a pure lookup table keyed by the same domain names already used for services.

## 2. Accumulating domain state across a conversation

Currently selectToolActions(messages) is recomputed fresh every loop iteration from latestUserText. To accumulate:

Persist selected domains on the conversation, not just derive them from message history each time. Cheapest option: don't add a new DB column — derive accumulated domains by scanning all user messages in the conversation (not just the latest) each time selectToolActions runs. This is stateless and reuses existing harness_conversations.messages — no schema change needed.
Change selectToolActions(messages) → selectToolActions(messages) internally scans every role: 'user' message (not just the latest) for domain-pattern matches, unions the matched domains, and unions their services/tool sets. Zero matches across the whole conversation → full registry (same fallback as today, now just conversation-wide instead of turn-wide).
Also union in any domain(s) explicitly pulled in via expand_scope calls (see §3) — these show up as tool_calls/tool messages in history, so scanning history already captures them if expand_scope's own call is domain-tagged (see below), meaning no separate persistence mechanism is needed — the existing message log is the accumulator.
Practically: refactor toolSelection.js into two pieces:
matchedDomainsForText(text) -> Set<domainKey> — the existing regex match, factored out.
accumulatedDomains(messages) -> Set<domainKey> — unions matchedDomainsForText over every user message, plus every domain named in a past expand_scope tool call/result.
selectToolActions(messages) and a new selectContextSnippets(messages) both build off accumulatedDomains.

This satisfies "domains accumulate" without new DB state, at the cost of rescanning full history each turn — cheap given message counts are small (bounded further by contextWindow.js's trimming, see §5).

## 3. The expand_scope tool

New file additions:

Add an entry to ACTION_SEVERITY-equivalent space without going through a real service. expand_scope isn't a ServiceClass.method call — it's pure prompt plumbing. Two implementation options: Option A (preferred): handle it inside conversationLoop.js, not executeTool. When parseToolCall yields toolName === 'expand_scope', short-circuit before calling executeTool at all: read args.domains (an array of domain keys, validated against DOMAIN_CONTEXT's keys), union them into the accumulated set, and immediately append a tool result message summarizing what was unlocked ("You now have context and tools for: inventory. Continue.") — then loop back to the LLM without incrementing MAX_TOOL_ITERATIONS (see below) and without ever touching HarnessGateway/trust levels, since this isn't a Partshelf mutation and shouldn't be confirmable/loggable as one. Option B: register it as a fake "service" in harnessServiceRegistry.js with SEVERITY.READ. Simpler to wire into the existing tool-call path, but pollutes the real action registry with a non-domain action and forces it through HarnessGateway/trust-level machinery for no reason. Go with Option A — it's cheaper and keeps expand_scope conceptually separate from real Partshelf actions.
Tool schema (added directly to buildToolSchema's output, not HARNESS_TOOLS, since it's not action-backed):
  { name: 'expand_scope', description: 'Loads additional tools and instructions for a Partshelf domain not currently available to you (e.g. if you need to look up inventory but only have fabrication tools). Call this before guessing or refusing.', parameters: { domains: { type: 'array', items: { type: 'string', enum: [...DOMAIN_CONTEXT keys] } } } }

This needs to always be present in tools, regardless of which domains are currently selected — it's the escape hatch, so it can't itself be scoped out.

"Doesn't count toward agent turns": per your fallback ("if too hard, forget it") — this is straightforward under Option A, since the loop's for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) increments per LLM round-trip. Handle expand_scope calls inside the tool-call-processing inner loop (same level as other toolCalls), and simply don't advance i for a turn that contained only expand_scope call(s) — i.e. wrap the outer for with a check: if the assistant's tool_calls were 100% expand_scope, decrement/hold the iteration counter before continuing. Concretely: track iterations in a separate mutable counter incremented only when at least one real tool was called that turn.
Never hard-blocked (your point 3, first sentence): this means executeTool/harnessToolRegistry need no change at all — the model can already call any registered tool by name; selectToolActions only filters what's advertised in the tools array sent to the LLM, it was never an enforcement layer. Confirm this is truly already the case: yes — buildToolSchema({ actionNames }) filters what's offered, but executeTool(toolName, args, ...) in conversationLoop.js's inner loop doesn't check membership in the offered set before calling getTool(name). So this requirement is already satisfied by the current architecture and needs no code change — worth a one-line comment in toolSelection.js clarifying this is intentional, so a future reader doesn't "fix" it into an enforcement gate.
## 4. Wiring the context snippet into the system prompt

File: backend/harness/contextWindow.js

buildContextWindow(messages, opts) currently builds a single static CLINKER_RESPONSE_INSTRUCTIONS block plus an optional trimming summary.
Add: after computing accumulatedDomains(messages) (imported from the refactored toolSelection.js), concatenate the matched domains' snippets from domainContext.js onto the system message, e.g.:
  systemContent = CLINKER_RESPONSE_INSTRUCTIONS
    + '\n\n' + domainSnippetsFor(accumulatedDomains)
    + (trimmed ? '\n\n' + summaryFor(omitted).content : '')
domainSnippetsFor(domains) in domainContext.js: joins each matched domain's snippet, each under a small header (e.g. ### Fabrication ) so the model can see they're distinct topics.
If accumulatedDomains is empty (or hits the 2+/ambiguous fallback case) → include all domain snippets, mirroring toolSelection.js's existing "ambiguous → full registry" behavior, so context and tools never diverge (never offer a tool whose usage notes weren't included, and vice versa).
## 5. Cost control / verifying the original motivation holds

The whole point of this system is freeing up context budget for deeper per-domain instructions. Two things to verify/build so that payoff is real:

Size ceiling per domain snippet — add a soft convention (e.g. a comment in domainContext.js) capping each snippet at some rough token budget (~150–300 tokens), and a cheap runtime assertion/log if domainSnippetsFor output exceeds some total ceiling (e.g. 1500 chars) — this is a canary, not a hard block, so a growing snippet degrades loudly rather than silently ballooning context.
Interaction with buildContextWindow's existing trimming (maxHistoryBytes): the domain snippet addition happens on the system message, which buildContextWindow already treats as always-included (never trimmed) — confirm this stays true after the change; the snippet addition should happen after trimming decisions, not count against maxHistoryBytes's budget for history chunks.
estimateRequestContext (llmClient.js) logging already reports requestBytes/estimatedTokens — no change needed, but worth eyeballing logs after this ships to confirm total request size with full-vs-scoped context actually differs the way this feature promises.
## 6. Testing plan

Mirror the existing test conventions (toolSelection.test.js, contextWindow.test.js):

toolSelection.test.js additions:
accumulatedDomains unions domains across multiple user messages in one conversation (not just the latest).
A conversation that starts in "fabrication" and later mentions "inventory" ends up with both domains' tools available, not just the latest.
expand_scope is always present in buildToolSchema's output regardless of selected domains.
contextWindow.test.js additions:
System message includes the fabrication snippet when fabrication keywords are present, and does not include the cart snippet.
Ambiguous/ombined-domain messages fall back to including every domain snippet (matching full-registry tool fallback).
New conversationLoop-level test (or extend toolSelection.test.js's spirit into a loop-level fixture):
An expand_scope-only tool-call turn does not increment the iteration counter used for MAX_TOOL_ITERATIONS.
Calling a tool outside the currently-offered set still succeeds (since executeTool doesn't check offered-set membership) — a regression guard for the "never hard-blocked" requirement.

## 7. Rollout order
Author DOMAIN_CONTEXT snippets for 1–2 domains only (e.g. fabrication + assemblies, the ones already causing the pain you described) — ship narrow, verify the mechanism, then backfill remaining domains once the plumbing is proven.
Refactor toolSelection.js into matchedDomainsForText / accumulatedDomains, no behavior change yet (still single-turn) — land this alone first since it's a pure refactor, easy to verify against existing tests.
Switch selectToolActions and the new selectContextSnippets to use accumulatedDomains (multi-turn) — this is the actual behavior change; watch for context bloat in long conversations that touch many domains (this is the natural tension: accumulation partially undoes the "don't load everything" goal over a long-enough conversation — acceptable per your spec, but worth watching).
Add expand_scope handling in conversationLoop.js (Option A), always-included tool schema entry, and the turn-counting exemption.
Wire domainSnippetsFor into contextWindow.js's system message construction.
Backfill remaining domain snippets.
Tests throughout each step, not deferred to the end.