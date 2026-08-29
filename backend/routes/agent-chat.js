// backend/routes/agent-chat.js
//
// Member-facing entry point for a chat turn with the agent. Thin HTTP
// wrapper over conversationLoop.runTurn() — no business logic here,
// same discipline every other route in this codebase follows.
//
// No auth gate — same posture as pending-actions.js and every other
// member-facing route in this migration pass (no real per-request
// session verification exists yet to gate behind; see api/categories.js's
// own comment for the fuller reasoning). memberId is trusted from the
// request body for now, same as every other route's actorId today.
//
// POST /api/agent-chat
//   { memberId, message, conversationId? }
//
// Response shapes mirror conversationLoop.runTurn()'s return value:
//   { success: true, conversationId, status: 'completed', reply }
//   { success: true, conversationId, status: 'awaiting_confirmation', pendingActionId, message }

import { Hono } from 'hono'
import { runTurn } from '../harness/conversationLoop.js'
import { statusForError } from '../../src/repositories/errors.js'
import { HarnessConversationService } from '../../src/services/HarnessConversationService.js'
import { withTurnLock, isLocked } from '../harness/turnLock.js'
import { beginTurnProgress, getTurnProgress, endTurnProgress } from '../harness/turnProgress.js'


const agentChat = new Hono()

agentChat.get('/progress/:progressId', (c) => c.json({ success: true, progress: getTurnProgress(c.req.param('progressId')) }))

// Conversation history is only used for the panel's "Previous topics"
// list. A client must explicitly choose an item; page reload never resumes
// a prior conversation automatically.
agentChat.get('/', async (c) => {
  const memberId = c.req.query('memberId')
  if (!memberId) return c.json({ error: 'memberId is required' }, 400)
  try {
    const service = new HarnessConversationService()
    // Fix #3: 12 was too aggressive a cap — older-but-still-relevant
    // conversations were falling off the list entirely with no
    // indication there was more. 50 is a cheap, generous bump; a real
    // "load more" is a follow-up if this ever isn't enough.
    const conversations = await service.listRecentForMember(memberId, 50)
    return c.json({ success: true, conversations })
  } catch (err) {
    console.error('[agent-chat] recent conversations', err)
    return c.json({ error: err.message ?? 'Internal server error' }, statusForError(err))
  }
})

agentChat.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))

  if (!body.memberId) return c.json({ error: 'memberId is required' }, 400)
  const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 3) : []
  const message = String(body.message || '').trim() || (attachments.length ? 'The user sent a file without a question.' : '')
  if (!message) return c.json({ error: 'message is required' }, 400)

  const lockKey = `${body.memberId}:${body.conversationId || 'new'}`
  const progressId = String(body.progressId || '')
  try {
    if (progressId) beginTurnProgress(progressId)
    if (isLocked(lockKey)) {
      if (progressId) endTurnProgress(progressId)
      return c.json({
        success: false,
        result: {
          success: false,
          data: null,
          error: { code: 'CONFLICT', message: 'Another Clinker turn is already running for this conversation.', retryable: true },
          meta: { lockKey: body.conversationId || 'new' },
        },
      }, 409)
    }
    const result = await withTurnLock(lockKey, () =>
      runTurn({
        memberId: body.memberId,
        message,
        conversationId: body.conversationId || null,
        attachments,
        progressId,
      })
    )
    if (progressId) endTurnProgress(progressId)
    return c.json({ success: true, ...result })
  } catch (err) {
    if (progressId) endTurnProgress(progressId)
    if (err.code === 'TURN_LOCKED') {
      return c.json({
        success: false,
        result: {
          success: false, data: null,
          error: { code: 'CONFLICT', message: err.message, retryable: true },
          meta: { lockKey },
        },
      }, 409)
    }
    console.error('[agent-chat]', err)
    return c.json({ error: err.message ?? 'Internal server error' }, statusForError(err))
  }
})

export default agentChat
