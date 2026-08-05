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
//   { action: 'invoke',  actionName, args, memberId, isAgent?, reason? }
// Member-facing inbox/resolve moved to /api/pending-actions (ungated —
// no more sensitive than any other member-facing write in this codebase).

import { Hono } from 'hono'
import { assertHarnessToken } from '../../api/_lib/harnessAuth.js'
import { resolveAction } from '../../api/_lib/harnessServiceRegistry.js'
import { HarnessGateway } from '../../src/services/HarnessGateway.js'
import { getSupabase } from '../../src/repositories/supabaseClient.js'
import { statusForError } from '../../src/repositories/errors.js'

const harnessInvoke = new Hono()

async function fetchMemberTrust(memberId) {
  const { data, error } = await getSupabase().from('members').select('trust_level').eq('id', memberId).maybeSingle()
  if (error) throw error
  return data?.trust_level ?? 0
}

harnessInvoke.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const gateway = new HarnessGateway()

  try {
    assertHarnessToken({ headers: Object.fromEntries(c.req.raw.headers) })

    switch (body.action) {
      case 'invoke': {
        const resolved = resolveAction(body.actionName)
        if (!resolved) return c.json({ error: `Unknown action "${body.actionName}"` }, 400)

        const memberTrustLevel = await fetchMemberTrust(body.memberId)
        const result = await gateway.invoke({
          actionName:       body.actionName,
          serviceInstance:  resolved.serviceInstance,
          methodName:       resolved.methodName,
          args:             body.args || {},
          memberId:         body.memberId,
          memberTrustLevel,
          isAgent:          body.isAgent ?? true,
          reason:           body.reason || null,
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