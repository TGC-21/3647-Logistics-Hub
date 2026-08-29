// backend/harness/conversationLoop.js
//
// The orchestration loop itself. Given one member message, drives:
//   load/start conversation -> call LLM -> execute any tool_calls ->
//   loop back to LLM with results -> return once the LLM replies with
//   plain text (or the loop pauses on a ConfirmationRequiredError).
//
// Colocated in the same process as executeTool() — no HTTP hop to call
// it, just a function call. The only network call this file makes is
// to the LLM (via llmClient.js). See AGENTIC_HARNESS_PHASE3_EXECUTION.md.
//
// Deliberately simple on tool_calls batching: if the LLM requests
// multiple tool calls in one turn and ANY of them hits
// ConfirmationRequiredError, the loop pauses immediately rather than
// executing the rest of the batch first — simplest correct behavior
// per the doc's own note; revisit only if a real workflow needs
// partial-batch execution.

import { HarnessConversationService } from '../../src/services/HarnessConversationService.js'
import { PendingActionRepository } from '../../src/repositories/PendingActionRepository.js'
import { executeTool, structuredToolError, fetchMemberTrust } from '../../backend/_lib/harnessToolRegistry.js'
import { PROPOSE_INVENTORY_TOOL_NAME } from './inventoryProposalTool.js'
import { chatCompletion } from './llmClient.js'
import { buildToolSchema, parseToolCall } from './toolSchema.js'
import { getTool } from '../../backend/_lib/harnessToolRegistry.js'
import { compactToolResult } from './toolResultCompactor.js'
import { buildContextWindow } from './contextWindow.js'
import { selectToolActions, scopedDomains } from './toolSelection.js'
import { domainSnippetsFor, allDomainSnippets } from './domainContext.js'
import { CategoryService } from '../../src/services/CategoryService.js'
import { updateTurnProgress } from './turnProgress.js'

const MAX_TOOL_ITERATIONS = 16   // hard ceiling against a runaway tool-call loop (model never settling on plain text)
const MAX_IDENTICAL_FAILURES = 2

function toolSuccess(data = null, meta = {}) {
  return { success: true, data, error: null, meta }
}

function toolFailure(error, meta = {}) {
  return { success: false, data: null, error, meta }
}

/**
 * Runs one turn of a conversation for a member's message. Returns:
 *   { conversationId, status: 'completed', reply: string }
 *   { conversationId, status: 'awaiting_confirmation', pendingActionId, message: string }
 * Throws only on genuine infrastructure failure (LLM unreachable,
 * malformed model output that can't be recovered from) — a tool
 * execution failure that ISN'T a ConfirmationRequiredError is instead
 * fed back to the LLM as a tool error result, same as OpenAI's own
 * function-calling convention, so the model can react to it rather
 * than the whole turn crashing.
 */
export async function runTurn({ memberId, message, conversationId = null, attachments = [], isAgent = true, progressId = null }) {
  const conversationService = new HarnessConversationService()

  let convo = conversationId
    ? await conversationService.getById(conversationId)
    : await conversationService.start({ memberId, initialMessage: message, attachments })

  // A saved, completed conversation is intentionally resumable when the
  // member explicitly selects it from history. Reopen it before appending
  // the new user message. Awaiting-confirmation conversations still must go
  // through the pending-action approval flow to preserve tool-call state.
  if (conversationId && convo.status === 'completed') {
    convo = await conversationService.reopenForTurn({ conversationId })
  }

  if (conversationId && convo.status !== 'active') {
    throw new Error(`Conversation ${conversationId} is "${convo.status}" — cannot continue a turn on it.`)
  }

  // If resuming an existing active conversation with a fresh message
  // (not the just-started case above, whose initialMessage already IS
  // this message), append it before looping.
  let messages = convo.messages
  if (conversationId) {
    const updated = await conversationService.appendMessage({ conversationId, message: { role: 'user', content: message, attachments } })
    messages = updated.messages
  }

  return continueLoop({ conversationId: convo.id, memberId, isAgent, messages, progressId })

}

/**
 * Resumes a conversation paused on ConfirmationRequiredError, after a
 * member has approved the blocked pending_actions row.
 * pending-actions.js's `resolve` action already flips both the
 * pending_actions row and the conversation's own status/pending_action_id
 * (via HarnessConversationService.resumeAfterApproval) — this function
 * does the actual replay: finds the specific tool_call that was left
 * without a matching 'tool' response, re-executes it with
 * confirmed: true, appends the result, then continues the normal loop.
 */
export async function resumeTurn({ conversationId, memberId, isAgent = true, resolvedPendingAction = null, progressId = null }) {
  const conversationService = new HarnessConversationService()
  const pendingActionRepo = new PendingActionRepository()

  const convo = await conversationService.getById(conversationId)
  if (convo.status !== 'active') {
    throw new Error(`Conversation ${conversationId} is "${convo.status}" — expected 'active' (resumeAfterApproval should already have flipped it before calling resumeTurn).`)
  }

  const blockedCall = findUnansweredToolCall(convo.messages)
  if (!blockedCall) {
    throw new Error(`Conversation ${conversationId} has no unanswered tool_call to resume — nothing to replay.`)
  }
  const { toolCallId, toolName, args } = blockedCall

  // Fetched once, same reasoning as continueLoop()'s single fetch below —
  // this function only ever replays one call, but the cost is identical
  // either way, so keep the calling convention (pass memberTrustLevel
  // through) consistent between the two entry points.
  const memberTrustLevel = await fetchMemberTrust(memberId)
  const toolActionName = getTool(toolName)?.actionName


  const normalize = obj => JSON.stringify(obj, Object.keys(obj || {}).sort())

  // pending-actions.js already resolved this exact row via
  // HarnessGateway.resolvePendingAction before calling resumeTurn — by
  // now its status is 'approved'/'denied', not 'awaiting_confirmation',
  // so searching for it via findAwaitingForMember() always comes back
  // empty (this was the bug: resume failed for every action, not just
  // this one, because the row we need is never "awaiting" anymore by
  // the time we look). Use the already-resolved row the caller hands
  // us directly instead of re-deriving it via a query that can no
  // longer see it.
  let matchingPending = null
  if (resolvedPendingAction) {
    if (resolvedPendingAction.actionName === toolActionName && normalize(resolvedPendingAction.actionArgs) === normalize(args)) {
      matchingPending = resolvedPendingAction
    }
  } else {
    const pendingActions = await pendingActionRepo.findAwaitingForMember(memberId).catch(() => [])
    matchingPending = pendingActions.find(p =>
      p.actionName === toolActionName && normalize(p.actionArgs) === normalize(args)
    )
  }

  if (!matchingPending) {
    throw new Error(
      `No pending confirmation found matching the blocked tool call "${toolName}" with these exact arguments — ` +
      `it may have already been resolved, or belongs to a different conversation.`
    )
  }
  const resolvedArgs = matchingPending ? matchingPending.actionArgs : args

  let toolResultContent
  try {
    const result = await executeTool(toolName, { ...resolvedArgs, confirmed: true }, { memberId, isAgent, reason: null, memberTrustLevel })
    toolResultContent = JSON.stringify(compactToolResult(result ?? toolSuccess()))
  } catch (err) {
    // A second ConfirmationRequiredError here would mean trust level
    // dropped between pause and approval, or a policy bug — surface it
    // as a tool error rather than re-pausing silently, since the human
    // already made a decision on this specific call.
    toolResultContent = JSON.stringify(toolFailure({ code: 'TOOL_EXECUTION_FAILED', message: err.message || 'Tool execution failed on resume', retryable: false }, { phase: 'resume' }))
  }

  const withToolResult = await conversationService.appendMessage({
    conversationId,
    message: { role: 'tool', tool_call_id: toolCallId, content: toolResultContent },
  })

  return continueLoop({ conversationId, memberId, isAgent, messages: withToolResult.messages, progressId })
}

/** Walks message history backward to the most recent assistant message
 *  carrying tool_calls, then returns whichever of ITS tool_calls has no
 *  matching 'tool' role response after it — the one call the loop
 *  paused on. Per the loop's own "pause on first failure within a
 *  batch" policy, this is expected to be exactly one entry. */
function findUnansweredToolCall(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'assistant' || !msg.tool_calls?.length) continue

    const answeredIds = new Set(
      messages.slice(i + 1).filter(m => m.role === 'tool').map(m => m.tool_call_id)
    )
    const unanswered = msg.tool_calls.find(tc => !answeredIds.has(tc.id))
   if (!unanswered) return null

   const { toolName, args } = parseToolCall(unanswered)
    return { toolCallId: unanswered.id, toolName, args }
  }
  return null
}


function callKey(toolName, args) {
  return `${toolName}::${JSON.stringify(args, Object.keys(args || {}).sort())}`
}

/** Runs one tool call and normalizes its outcome to the same shape
 *  Promise.allSettled() produces — { status: 'fulfilled', value } |
 *  { status: 'rejected', reason } — so a prefetched (parallel) outcome
 *  and a freshly-awaited (sequential) outcome can be handled by
 *  identical code afterward in continueLoop()'s tool-call loop.
 *  `value` is already the compacted, JSON-stringified tool-result
 *  content, ready to append as a message — same shape the old inline
 *  try/catch produced. */
async function invokeToolCall(toolName, args, ctx) {
  try {
    const result = await executeTool(toolName, args, { ...ctx, reason: null })
    return { status: 'fulfilled', value: JSON.stringify(compactToolResult(result ?? { success: true })) }
  } catch (err) {
    return { status: 'rejected', reason: err }
  }
}

/** Shared tail of runTurn()'s loop, factored out so resumeTurn() can
 *  rejoin the same iteration logic after appending its one replayed
 *  tool result, instead of duplicating the LLM round-trip/tool-call
 *  handling a second time. */
async function continueLoop({ conversationId, memberId, isAgent, messages, progressId = null }) {
  const conversationService = new HarnessConversationService()
  const seenCallsThisTurn = new Map()   // callKey -> already-compacted result string
  const failureCounts = new Map()   // callKey -> consecutive failure count
  const hasAttachment = messages.some(message => message.role === 'user' && message.attachments?.some(a => a?.url))
  const categoryGuidance = hasAttachment
    ? await new CategoryService().list()
    : []


  // Fetched once for the whole turn (every tool call below reuses this),
  // instead of once per tool call — see fetchMemberTrust()'s doc comment.
  const memberTrustLevel = await fetchMemberTrust(memberId)

  // Domain scope — and therefore the tool list AND the domain-guidance
  // text baked into the system prompt — is resolved ONCE for the whole
  // turn, not recomputed on every one of this turn's LLM round-trips.
  // A single turn can make several round trips back-to-back (one per
  // tool-call batch) before returning to the member. If the offered
  // tools or system prompt shifted between those round trips — e.g.
  // because a tool call made mid-turn happened to touch a keyword-
  // matched domain — every round trip would hand the inference server
  // a DIFFERENT prompt prefix, defeating whatever prompt/KV-cache reuse
  // it would otherwise get across those back-to-back calls and forcing
  // it to reprocess the whole request from scratch each time instead of
  // just the newly-appended tail. expand_scope remains the deliberate,
  // cross-turn way to widen scope (see toolSelection.js's own doc
  // comment) — this freeze only removes the ACCIDENTAL widening that
  // used to happen from rescanning tool_calls already made earlier in
  // this same turn.
  const tools = buildToolSchema({ actionNames: selectToolActions(messages) })
  const domains = scopedDomains(messages)
  const domainGuidance = domains.size ? domainSnippetsFor(domains) : allDomainSnippets()
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    updateTurnProgress(progressId, 'thinking')
    const context = buildContextWindow(messages, { domainGuidance })

    const modelMessages = categoryGuidance.length
      ? context.messages.map((message, index) => index === 0 ? {
          ...message,
          content: `${message.content}\n\nAuthoritative category requirements for inventory proposals:\n${categoryGuidance.map(category => `- ${category.name} (categoryId: ${category.id}): ${(category.requiredKeysConfig || []).map(cfg => `${cfg.key} [${cfg.type}]`).join(', ') || 'no required characteristics'}`).join('\n')}`,
        } : message)
      : context.messages
    const assistantMessage = await chatCompletion({ messages: modelMessages, tools })
    const withAssistant = await conversationService.appendMessage({ conversationId, message: assistantMessage })
    messages = withAssistant.messages

    const toolCalls = assistantMessage.tool_calls || []
    if (!toolCalls.length) {
      return { conversationId, status: 'completed', reply: assistantMessage.content || '' }
    }

    // A single photo can contain several distinct physical parts — the
    // model is instructed (see inventoryProposalTool.js's description)
    // to call propose_inventory_instance once PER distinct part in the
    // SAME batch rather than stopping after the first. Scan the whole
    // batch up front for any such calls: if present, every propose
    // call becomes one queued proposal (not just the first), and any
    // OTHER tool call in that same batch is deferred — mixing a
    // real write/read with "here are N things to review" in one
    // batch isn't a pattern worth supporting, and deferring keeps the
    // OpenAI protocol valid (every tool_call still gets a 'tool' reply).
    const proposeCallIndices = toolCalls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.function?.name === PROPOSE_INVENTORY_TOOL_NAME)

    if (proposeCallIndices.length) {
      const attachmentUrl = mostRecentAttachmentUrl(messages)
      const proposals = []

      for (let callIndex = 0; callIndex < toolCalls.length; callIndex++) {
        const rawCall = toolCalls[callIndex]
        const { toolName, toolCallId, args } = parseToolCall(rawCall)

        if (toolName === PROPOSE_INVENTORY_TOOL_NAME) {
          proposals.push({ ...args, attachmentUrl })
          const withAck = await conversationService.appendMessage({
            conversationId,
            message: {
              role: 'tool', tool_call_id: toolCallId,
              content: JSON.stringify(toolSuccess(null, {
                tool: toolName, outcome: 'proposal',
                note: 'Queued for member review — do not attempt this write again in this turn.',
              })),
            },
          })
          messages = withAck.messages
        } else {
          const withDeferred = await conversationService.appendMessage({
            conversationId,
            message: {
              role: 'tool', tool_call_id: toolCallId,
              content: JSON.stringify(toolFailure({ code: 'DEFERRED', message: 'This action was not executed because one or more inventory proposals were created in the same batch.', retryable: false }, { deferred: true })),
            },
          })
          messages = withDeferred.messages
        }
      }

      const { pendingProposals } = await conversationService.queueProposals({ conversationId, proposals })
      await conversationService.complete({ conversationId })

      const stillPending = pendingProposals.filter(p => p.status === 'pending')

      return {
        conversationId,
        status: 'proposal',
        proposals: stillPending,
        proposal: stillPending[0] || null,   // back-compat single-proposal field for older clients
        reply: stillPending.length > 1
          ? `I found ${stillPending.length} items in the photo — review them one at a time below.`
          : `I've put together a proposed inventory item from the image — review it below.`,
      }
    }
    // Independent read-only tool calls at the START of a batch (before
    // any write/destructive call) have no ordering dependency on each
    // other, so run them concurrently instead of one at a time — this
    // is the common case (the model asking for a search plus a couple
    // of lookups in one round). The run stops at the first non-read
    // call, since anything after a write could depend on that write's
    // effects, and at the first call whose tool can't be resolved to a
    // severity at all (conservative default: don't parallelize what we
    // can't classify).
    //
    // Only the OUTCOME (success/failure) is prefetched here — the
    // actual history-append and confirmation-pause handling below is
    // completely unchanged and still runs sequentially per call in
    // original order, so a failure or a ConfirmationRequiredError
    // behaves exactly as if every call had run sequentially. This just
    // removes the "wait for read #1 before starting read #2" latency
    // for the common all-succeed case.
    const leadingReadRun = []
    for (const rawCall of toolCalls) {
      const parsed = parseToolCall(rawCall)
      if (getTool(parsed.toolName)?.severity !== 'read') break
      leadingReadRun.push(parsed)
    }
    const prefetched = new Map()
    if (leadingReadRun.length >= 2) {
      updateTurnProgress(progressId, `calling ${leadingReadRun.length} tools`)
      const settled = await Promise.all(
        leadingReadRun.map(({ toolName, args }) => invokeToolCall(toolName, args, { memberId, isAgent, memberTrustLevel }))
      )
      leadingReadRun.forEach(({ toolName, args }, idx) => prefetched.set(callKey(toolName, args), settled[idx]))
    }

    for (let callIndex = 0; callIndex < toolCalls.length; callIndex++) {
      const rawCall = toolCalls[callIndex]
      const { toolName, args, toolCallId } = parseToolCall(rawCall)
      const key = callKey(toolName, args)
      updateTurnProgress(progressId, `calling ${toolName}`)

      let toolResultContent

      if (seenCallsThisTurn.has(key)){
        // Same tool, same args, already answered this turn — hand back
        // the cached result with a note, rather than re-hitting the DB
        // (or, worse, letting a second identical call silently return a
        // DIFFERENT answer mid-turn and confuse the model further).
        const cached = JSON.parse(seenCallsThisTurn.get(key))
        toolResultContent = JSON.stringify({ ...cached, meta: { ...cached.meta, cached: true, note: 'Identical call already made earlier this turn; reused cached result.' } })
      } else {
        // Reuse the prefetched outcome if this call was part of the
        // leading read run above; otherwise run it now, same as before.
        const outcome = prefetched.has(key)
          ? prefetched.get(key)
          : await invokeToolCall(toolName, args, { memberId, isAgent, memberTrustLevel })

        if (outcome.status === 'fulfilled') {
          toolResultContent = outcome.value
          seenCallsThisTurn.set(key, toolResultContent)
          failureCounts.delete(key)
        } else {
          const err = outcome.reason
          if (err.name === 'ConfirmationRequiredError') {
            // The assistant message carrying this whole tool_calls batch is
            // already in history. If this isn't the LAST call in the batch,
            // every call AFTER this one still has no matching 'tool' reply —
            // and never will, since we're about to pause and return. Left
            // unanswered, the next chatCompletion() call would send a
            // protocol-invalid history (an assistant tool_calls entry with no
            // reply), which strict chat templates reject — same failure class
            // as the earlier system-message bug. Stub each remaining call out
            // with a deferred marker so history always stays valid;
            // resumeTurn()'s findUnansweredToolCall() then finds exactly the
            // one real unanswered call (this one), not one of these stubs.
    
            for (let deferredIndex = callIndex + 1; deferredIndex < toolCalls.length; deferredIndex++) {
              const deferred = parseToolCall(toolCalls[deferredIndex])
              await conversationService.appendMessage({
                conversationId,
                message: {
                  role: 'tool', tool_call_id: deferred.toolCallId,
                  content: JSON.stringify(toolFailure({ code: 'DEFERRED', message: 'This action was not executed because an earlier action in the batch is waiting for confirmation.', retryable: false }, { deferred: true })),
                },
              })
            }

	    await conversationService.pauseForConfirmation({ conversationId, pendingActionId: err.reason })

              return {
                conversationId, status: 'awaiting_confirmation',
                pendingActionId: err.reason,
                message: `Waiting on your confirmation for "${toolName}" before continuing.`,
            }
          }
          const failures = (failureCounts.get(key) || 0) + 1
          failureCounts.set(key, failures)

          toolResultContent = JSON.stringify({
            success: false,
            data: null,
            error: {
              ...structuredToolError(err),
              ...(failures >= MAX_IDENTICAL_FAILURES ? {
                code: 'REPEATED_FAILURE',
                message: `This exact call failed ${failures} times. Use a different tool or arguments.`,
                retryable: false,
              } : {}),
            },
            meta: { tool: rawCall.function?.name, attempt: failures },
          })
        }
      }
      
      const withToolResult = await conversationService.appendMessage({
        conversationId, message: { role: 'tool', tool_call_id: toolCallId, content: toolResultContent },
      })
      messages = withToolResult.messages
    }
  }

  const context = buildContextWindow(messages)
  const fallbackMessages = [
    ...context.messages,
    {
      role: 'user',
      content: 'You have used all available tool-call steps for this turn. Summarize what you found so far, including anything still uncertain or unfinished, without calling any more tools.',
    },
  ]
  const fallbackReply = await chatCompletion({ messages: fallbackMessages, tools: [] })
  const withFallback = await conversationService.appendMessage({ conversationId, message: fallbackReply })

  return {
    conversationId,
    status: 'completed',
    reply: fallbackReply.content || 'I ran out of steps before finishing — try narrowing the request.',
    truncated: true,
  }
}

/** Finds the most recent attachment URL anywhere in conversation
 *  history — the server's own source of truth for "what image was
 *  actually attached," never trusted from the model's tool-call args
 *  (a model could otherwise fabricate/mistype a URL and have it
 *  written straight into an inventory instance). Walks backward since
 *  the propose call is always reacting to the LATEST attached image. */
function mostRecentAttachmentUrl(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'user' && Array.isArray(msg.attachments)) {
      const withUrl = msg.attachments.find(a => a?.url)
      if (withUrl) return withUrl.url
    }
  }
  return null
}
