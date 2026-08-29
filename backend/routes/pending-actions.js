// backend/routes/pending-actions.js
//
// Member-facing half of the confirmation flow — split out of
// harness-invoke.js (which stays token-gated, harness-process-only).
// No auth gate here, same decision every other member-facing route in
// this codebase has made (categories.js, cart-items.js, etc.) — a
// member viewing/deciding on their OWN pending actions is no more
// sensitive than any other write already exposed this way, and there's
// no real per-request session verification anywhere yet to gate behind.
//
// POST /api/pending-actions
//   { action: 'inbox',   memberId }
//   { action: 'resolve', pendingActionId, decision, resolvedBy }

import { Hono } from 'hono'
import { HarnessGateway } from '../../src/services/HarnessGateway.js'
import { PendingActionRepository } from '../../src/repositories/PendingActionRepository.js'
import { HarnessConversationService } from '../../src/services/HarnessConversationService.js'
import { resumeTurn } from '../harness/conversationLoop.js'
import { withTurnLock } from '../harness/turnLock.js'
import { statusForError } from '../../src/repositories/errors.js'
import { beginTurnProgress, endTurnProgress } from '../harness/turnProgress.js'

const pendingActions = new Hono()

pendingActions.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const gateway = new HarnessGateway()

  try {
    switch (body.action) {
      case 'inbox': {
        const repo = new PendingActionRepository()
        const items = await repo.findAwaitingForMember(body.memberId)
        return c.json({ success: true, items })
      }

      case 'resolve': {
        const conversationService = new HarnessConversationService()
        const convo = await conversationService.findByPendingActionId(body.pendingActionId)
        
        const updated = await gateway.resolvePendingAction({
          pendingActionId: body.pendingActionId,
          decision:        body.decision,
          resolvedBy:      body.resolvedBy,
        })
        
        if (!convo) {
          return c.json({ success: true, pendingAction: updated })
        }

        if (body.decision === 'denied') {
          await conversationService.abandonAfterDenial({ conversationId: convo.id })
          return c.json({ success: true, pendingAction: updated })
        }

        // Approved: flip conversation back to active, then immediately
        // replay the blocked tool call and continue the loop — the
        // member's approval click is what drives resumption, not a
        // separate poll/wake step.
        await conversationService.resumeAfterApproval({ conversationId: convo.id })

        // Same lock key scheme as agent-chat.js (`${memberId}:${conversationId}`)
        // — this is Fix #2's whole point: a runTurn() the member fires
        // off from the chat box and a resumeTurn() triggered by an
        // approve/deny click must never run concurrently against the
        // same conversation row.
        const lockKey = `${updated.memberId}:${convo.id}`
        const progressId = String(body.progressId || '')
        if (progressId) beginTurnProgress(progressId)
        try {
            const turnResult = await withTurnLock(lockKey, () =>
            resumeTurn({
              conversationId: convo.id,
              memberId: updated.memberId,
              isAgent: updated.isAgent,
              resolvedPendingAction: updated,
              progressId,
            })
          )
          if (progressId) endTurnProgress(progressId)
          return c.json({ success: true, pendingAction: updated, turn: turnResult })
        } catch (err) {
          if (progressId) endTurnProgress(progressId)
          if (err.code === 'TURN_LOCKED') {
            return c.json({ success: true, pendingAction: updated, turnError: err.message })
          }
          // Resume failing shouldn't mask that the approval itself
          // succeeded — surface both: the pending_actions row IS
          // resolved, but the conversation didn't advance. Caller
          // (chat UI) can retry the resume separately if needed.
          console.error('[pending-actions] resumeTurn failed after approval', err)
          return c.json({ success: true, pendingAction: updated, turnError: err.message })
        }
      }

      default:
        return c.json({ error: `Unknown action "${body.action}" — expected one of: inbox, resolve.` }, 400)
    }
  } catch (err) {
    console.error('[pending-actions]', err)
    return c.json({ error: err.message ?? 'Internal server error' }, statusForError(err))
  }
})

export default pendingActions
