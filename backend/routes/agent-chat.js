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

const agentChat = new Hono()

agentChat.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))

  if (!body.memberId) return c.json({ error: 'memberId is required' }, 400)
  if (!body.message || !String(body.message).trim()) return c.json({ error: 'message is required' }, 400)

  try {
    const result = await runTurn({
      memberId: body.memberId,
      message: body.message,
      conversationId: body.conversationId || null,
    })
    return c.json({ success: true, ...result })
  } catch (err) {
    console.error('[agent-chat]', err)
    return c.json({ error: err.message ?? 'Internal server error' }, statusForError(err))
  }
})

export default agentChat