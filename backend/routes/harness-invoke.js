// backend/routes/harness-invoke.js — converted from api/harness-invoke.js
//
// The ONLY entry point the agent harness calls to act as a member.
// Gated by assertHarnessToken (process-level trust — only the harness
// process, running on this same VM or reachable over the private
// network, holds HARNESS_API_TOKEN). Everything else routes through
// HarnessGateway, which enforces the per-member trust-level/
// confirmation gate.
//
// POST /api/harness-invoke
//   { action: 'list' }
//   { action: 'invoke', toolName, args, memberId, isAgent?, reason? }// Member-facing inbox/resolve moved to /api/pending-actions (ungated —
// no more sensitive than any other member-facing write in this codebase).

import { Hono } from 'hono'
import { assertHarnessToken } from '../../backend/_lib/harnessAuth.js'
import { listTools, executeTool } from '../../backend/_lib/harnessToolRegistry.js'
import { statusForError } from '../../src/repositories/errors.js'

const harnessInvoke = new Hono()



harnessInvoke.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))

  try {
    assertHarnessToken({ headers: Object.fromEntries(c.req.raw.headers) })

    switch (body.action) {
      case 'list': {
        return c.json({ success: true, tools: listTools() })
      }

      case 'invoke': {
        const result = await executeTool(body.toolName, body.args || {}, {
          memberId: body.memberId, isAgent: body.isAgent ?? true, reason: body.reason || null,
        })
        return c.json({ success: true, result })
      }

      case 'resolve': {
        const updated = await gateway.resolvePendingAction({
          pendingActionId: body.pendingActionId,
          decision:        body.decision,
          resolvedBy:      body.resolvedBy,
        })
        return c.json({ success: true, pendingAction: updated })
      }

      case 'inbox': {
        const repo = new PendingActionRepository()
        const items = await repo.findAwaitingForMember(body.memberId)
        return c.json({ success: true, items })
      }

      default:
       return c.json({ error: `Unknown action "${body.action}" — expected: invoke.` }, 400)    
    }
  } catch (err) {
    if (err.name === 'ConfirmationRequiredError') {
      return c.json({
        success: false,
        confirmationRequired: true,
        pendingActionId: err.reason,
        actionName: err.actionName,
        severity: err.severity,
        message: err.message,
      }, 202)
    }
    console.error('[harness-invoke]', err)
    return c.json({ error: err.message ?? 'Internal server error' }, statusForError(err))
  }
})

export default harnessInvoke