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
import { executeTool } from '../../backend/_lib/harnessToolRegistry.js'
import { chatCompletion } from './llmClient.js'
import { buildToolSchema, parseToolCall } from './toolSchema.js'
import { getTool } from '../../backend/_lib/harnessToolRegistry.js'
import { compactToolResult } from './toolResultCompactor.js'
import { buildContextWindow } from './contextWindow.js'
import { selectToolActions } from './toolSelection.js'

const MAX_TOOL_ITERATIONS = 16   // hard ceiling against a runaway tool-call loop (model never settling on plain text)

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
export async function runTurn({ memberId, message, conversationId = null, isAgent = true }) {
  const conversationService = new HarnessConversationService()

  const convo = conversationId
    ? await conversationService.getById(conversationId)
    : await conversationService.start({ memberId, initialMessage: message })

  if (conversationId && convo.status !== 'active') {
    throw new Error(`Conversation ${conversationId} is "${convo.status}" — cannot continue a turn on it.`)
  }

  // If resuming an existing active conversation with a fresh message
  // (not the just-started case above, whose initialMessage already IS
  // this message), append it before looping.
  let messages = convo.messages
  if (conversationId) {
    const updated = await conversationService.appendMessage({ conversationId, message: { role: 'user', content: message } })
    messages = updated.messages
  }

  return continueLoop({ conversationId: convo.id, memberId, isAgent, messages })

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
export async function resumeTurn({ conversationId, memberId, isAgent = true }) {
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

  // Re-derive the approved pending_actions row for its stored args as
  // the source of truth (rather than trusting the message history's
  // args blindly) — belt-and-suspenders since the two should always
  // match given HarnessGateway wrote both from the same call.
  const pendingActions = await pendingActionRepo.findAwaitingForMember(memberId).catch(() => [])
  const toolActionName = getTool(toolName)?.actionName
  const matchingPending = pendingActions.find(p => p.actionName === toolActionName)
  const resolvedArgs = matchingPending ? matchingPending.actionArgs : args

  let toolResultContent
  try {
    const result = await executeTool(toolName, { ...resolvedArgs, confirmed: true }, { memberId, isAgent, reason: null })
    toolResultContent = JSON.stringify(compactToolResult(result ?? { success: true }))
  } catch (err) {
    // A second ConfirmationRequiredError here would mean trust level
    // dropped between pause and approval, or a policy bug — surface it
    // as a tool error rather than re-pausing silently, since the human
    // already made a decision on this specific call.
    toolResultContent = JSON.stringify({ error: err.message || 'Tool execution failed on resume' })
  }

  const withToolResult = await conversationService.appendMessage({
    conversationId,
    message: { role: 'tool', tool_call_id: toolCallId, content: toolResultContent },
  })

  return continueLoop({ conversationId, memberId, isAgent, messages: withToolResult.messages })
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

/** Shared tail of runTurn()'s loop, factored out so resumeTurn() can
 *  rejoin the same iteration logic after appending its one replayed
 *  tool result, instead of duplicating the LLM round-trip/tool-call
 *  handling a second time. */
async function continueLoop({ conversationId, memberId, isAgent, messages }) {
  const conversationService = new HarnessConversationService()
  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const context = buildContextWindow(messages)
    const tools = buildToolSchema({ actionNames: selectToolActions(context.messages) })
    const assistantMessage = await chatCompletion({ messages: context.messages, tools })
    const withAssistant = await conversationService.appendMessage({ conversationId, message: assistantMessage })
    messages = withAssistant.messages

    const toolCalls = assistantMessage.tool_calls || []
    if (!toolCalls.length) {
      // Conversations are chat-style and infinitely continuable now — a
      // plain-text reply just means this TURN is done, not that the
      // conversation itself is over. We deliberately do NOT flip the DB
      // status to 'completed' here anymore: doing so used to make
      // runTurn() refuse a same-conversationId follow-up message ("import
      // this assembly" -> reply -> "now run detection" would throw,
      // because a completed conversation can only be read, never
      // continued). The conversation stays 'active' indefinitely; nothing
      // in this codebase currently marks it 'completed' except the old
      // call removed here. If an explicit "end conversation" action is
      // ever added, call conversationService.complete() there instead.
      return { conversationId, status: 'completed', reply: assistantMessage.content || '' }
    }

    for (let callIndex = 0; callIndex < toolCalls.length; callIndex++) {
      const rawCall = toolCalls[callIndex]
      const { toolName, args, toolCallId } = parseToolCall(rawCall)
      let toolResultContent
      try {
        const result = await executeTool(toolName, args, { memberId, isAgent, reason: null })
        toolResultContent = JSON.stringify(compactToolResult(result ?? { success: true }))
      } catch (err) {
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
          await conversationService.pauseForConfirmation({ conversationId, pendingActionId: err.reason })

          for (let deferredIndex = callIndex + 1; deferredIndex < toolCalls.length; deferredIndex++) {
            const deferred = parseToolCall(toolCalls[deferredIndex])
            await conversationService.appendMessage({
              conversationId,
              message: {
                role: 'tool', tool_call_id: deferred.toolCallId,
                content: JSON.stringify({ error: 'Deferred — waiting on confirmation for an earlier action in this batch. This action was not executed.' }),
              },
            })
          }

          return {
            conversationId, status: 'awaiting_confirmation',
            pendingActionId: err.reason,
            message: `Waiting on your confirmation for "${toolName}" before continuing.`,
          }
        }
        toolResultContent = JSON.stringify({ error: err.message || 'Tool execution failed' })
      }
      const withToolResult = await conversationService.appendMessage({
        conversationId, message: { role: 'tool', tool_call_id: toolCallId, content: toolResultContent },
      })
      messages = withToolResult.messages
    }
  }

  throw new Error(`Conversation ${conversationId} exceeded ${MAX_TOOL_ITERATIONS} tool-call iterations without resolving — aborting to avoid a runaway loop.`)
}
