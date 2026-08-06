// services/HarnessConversationService.js
//
// Owns harness_conversations state transitions — start, append a
// message, pause on ConfirmationRequiredError, resume on approval,
// complete. Does NOT call the LLM itself (that's the conversation
// loop's job, in backend/harness/ — this service is the persistence +
// state-machine layer it calls into, same separation every other
// domain in this codebase keeps between orchestration and storage).
//
// No @supabase/supabase-js import, no req/res.

import { HarnessConversationRepository } from '../repositories/HarnessConversationRepository.js'
import { ValidationError, ConflictError } from '../repositories/errors.js'

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

export class HarnessConversationService {
  constructor({
    conversationRepo = new HarnessConversationRepository(),
  } = {}) {
    this.conversationRepo = conversationRepo
  }

  /** Starts a brand-new conversation with the member's first message
   *  already in history. Returns the created row. */
  async start({ memberId, initialMessage }) {
    if (!memberId) throw new ValidationError('memberId is required')
    if (!initialMessage) throw new ValidationError('initialMessage is required')

    return this.conversationRepo.insert({
      id: genId(),
      memberId,
      status: 'active',
      messages: [{ role: 'user', content: initialMessage }],
    })
  }

  /** Appends a message (any role — assistant text, tool result, etc.)
   *  to an active conversation. Refuses on a conversation that's
   *  paused/completed — those need resume()/reopen semantics instead,
   *  not a silent append that would desync from the pending action. */
  async appendMessage({ conversationId, message }) {
    const convo = await this.conversationRepo.requireById(conversationId)
    if (convo.status !== 'active') {
      throw new ConflictError(`Conversation is "${convo.status}" — cannot append while not active.`)
    }
    return this.conversationRepo.appendMessage(conversationId, message)
  }

  /** Suspends a conversation when a tool call throws
   *  ConfirmationRequiredError. Called by the conversation loop's
   *  catch block, not by HarnessGateway itself — the gateway doesn't
   *  know about conversations, only about the one tool call. */
  async pauseForConfirmation({ conversationId, pendingActionId }) {
    const convo = await this.conversationRepo.requireById(conversationId)
    if (convo.status !== 'active') {
      throw new ConflictError(`Conversation is "${convo.status}" — cannot pause from this state.`)
    }
    return this.conversationRepo.update(conversationId, {
      status: 'awaiting_confirmation',
      pendingActionId,
    })
  }

  /** Called once the loop is ready to replay the blocked tool call
   *  (after PendingActionRepository.resolve flipped it to 'approved')
   *  — flips the conversation back to active and clears the pointer.
   *  The loop itself is responsible for the actual replay + appending
   *  the tool's result as a message afterward via appendMessage(). */
  async resumeAfterApproval({ conversationId }) {
    const convo = await this.conversationRepo.requireById(conversationId)
    if (convo.status !== 'awaiting_confirmation') {
      throw new ConflictError(`Conversation is "${convo.status}" — nothing to resume.`)
    }
    return this.conversationRepo.update(conversationId, {
      status: 'active',
      pendingActionId: null,
    })
  }

  /** A denied pending action ends the conversation rather than looping
   *  forever waiting for an approval that isn't coming — matches "the
   *  agent proceeds once user makes the decision," where denial is
   *  itself a decision, just a terminal one for this conversation. */
  async abandonAfterDenial({ conversationId }) {
    const convo = await this.conversationRepo.requireById(conversationId)
    if (convo.status !== 'awaiting_confirmation') {
      throw new ConflictError(`Conversation is "${convo.status}" — nothing to abandon.`)
    }
    return this.conversationRepo.update(conversationId, {
      status: 'abandoned',
      pendingActionId: null,
    })
  }

  async complete({ conversationId }) {
    return this.conversationRepo.update(conversationId, { status: 'completed' })
  }

  async getById(conversationId) {
    return this.conversationRepo.requireById(conversationId)
  }

  async listOpenForMember(memberId) {
    return this.conversationRepo.findOpenForMember(memberId)
  }

  /** How the resume path (pending-actions.js's `resolve` action)
   *  finds its way back to the right conversation from just a
   *  pendingActionId. */
  async findByPendingActionId(pendingActionId) {
    return this.conversationRepo.findByPendingActionId(pendingActionId)
  }
}