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
  async start({ memberId, initialMessage, attachments = [] }) {
    if (!memberId) throw new ValidationError('memberId is required')
    if (!initialMessage) throw new ValidationError('initialMessage is required')

    return this.conversationRepo.insert({
      id: genId(),
      memberId,
      status: 'active',
      messages: [{ role: 'user', content: initialMessage, attachments }],
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

  /** Batched counterpart to appendMessage() — see
   *  HarnessConversationRepository.appendMessages()'s doc comment for
   *  why this exists. Same active-only guard as appendMessage(); a
   *  no-op (returns the conversation unchanged) when messages is empty
   *  so a caller can call this unconditionally without a length check. */
  async appendMessages({ conversationId, messages }) {
    if (!messages?.length) return this.conversationRepo.requireById(conversationId)
    const convo = await this.conversationRepo.requireById(conversationId)
    if (convo.status !== 'active') {
      throw new ConflictError(`Conversation is "${convo.status}" — cannot append while not active.`)
    }
    return this.conversationRepo.appendMessages(conversationId, messages)
  }


  /** Reopens a completed conversation when the member explicitly selects it
   * from history and sends a new message. Conversations paused for approval
   * must go through the approval flow instead, so they remain non-resumable
   * through the ordinary chat endpoint. */
  async reopenForTurn({ conversationId }) {
    const convo = await this.conversationRepo.requireById(conversationId)
    if (convo.status !== 'completed') {
      throw new ConflictError(`Conversation is "${convo.status}" — cannot reopen for a new turn.`)
    }
    return this.conversationRepo.update(
      conversationId,
      { status: 'active' },
      { expectedUpdatedAt: convo.updatedAt }
    )
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
    return this.conversationRepo.update(
      conversationId,
      { status: 'awaiting_confirmation', pendingActionId },
      { expectedUpdatedAt: convo.updatedAt }
    )
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
    return this.conversationRepo.update(
      conversationId,
      { status: 'active', pendingActionId: null },
      { expectedUpdatedAt: convo.updatedAt }
    )
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
    return this.conversationRepo.update(
      conversationId,
      { status: 'active', pendingActionId: null },
      { expectedUpdatedAt: convo.updatedAt }
    )
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

  async listRecentForMember(memberId, limit) {
    return this.conversationRepo.findRecentForMember(memberId, limit)
  }

  /** How the resume path (pending-actions.js's `resolve` action)
   *  finds its way back to the right conversation from just a
   *  pendingActionId. */
  async findByPendingActionId(pendingActionId) {
    return this.conversationRepo.findByPendingActionId(pendingActionId)
  }

  /** Queues one or more image-sourced inventory proposals onto the
   *  conversation's durable pending_proposals array, each stamped
   *  with a fresh id/status/createdAt. This is what makes a proposal
   *  survive a reload or a different session opening the same
   *  conversation — the confirmation card is derived from this array,
   *  never from an in-memory HTTP response alone. Does NOT touch
   *  conversation status (unlike pauseForConfirmation) — a pending
   *  proposal is informational, not a hard gate on the next turn; the
   *  member can keep chatting with other proposals still queued. */
  async queueProposals({ conversationId, proposals }) {
    if (!proposals?.length) throw new ValidationError('proposals must be a non-empty array')
    const stamped = proposals.map(p => ({
      id: genId(),
      status: 'pending',
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      instanceId: null,
      ...p,
    }))
    return this.conversationRepo.appendProposals(conversationId, stamped)
  }

  /** Flips one queued proposal to 'confirmed' (instanceId set, once
   *  the member's edited form actually created the instance
   *  client-side) or 'discarded'. Returns { conversation, nextProposal }
   *  so the caller can immediately chain into showing the next queued
   *  item from the SAME photo without the member re-prompting —
   *  nextProposal is the oldest remaining entry with status 'pending',
   *  or null if the queue is empty. */
  async resolveProposal({ conversationId, proposalId, decision, instanceId = null }) {
    if (!['confirmed', 'discarded'].includes(decision)) {
      throw new ValidationError(`decision must be "confirmed" or "discarded"`)
    }
    const updated = await this.conversationRepo.resolveProposal(conversationId, proposalId, { status: decision, instanceId })
    if (!updated) throw new ValidationError('This proposal was already resolved or no longer exists.')
    const nextProposal = updated.pendingProposals.find(p => p.status === 'pending') || null
    return { conversation: updated, nextProposal }
  }
}
