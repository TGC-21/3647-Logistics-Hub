// api/harness-invoke.js — Vercel serverless function
//
// The ONLY entry point the agent harness calls to act as a member.
// Process-level trust (per product decision: password auth for
// members, process-level trust for the harness itself) — gated by the
// existing assertHarnessToken shared secret, same as Phase 0's
// harnessAuth.js. Everything else routes through HarnessGateway, which
// enforces the per-member trust-level/confirmation gate.
//
// POST /api/harness-invoke
//   { action: 'invoke',  actionName, args, memberId, isAgent?, reason? }
//   { action: 'resolve', pendingActionId, decision, resolvedBy }
//   { action: 'inbox',   memberId }   -- list a member's pending actions

import { applyCors } from './_lib/onshape.js'
import { assertHarnessToken } from './_lib/harnessAuth.js'
import { resolveAction } from './_lib/harnessServiceRegistry.js'
import { HarnessGateway } from '../src/services/HarnessGateway.js'
import { PendingActionRepository } from '../src/repositories/PendingActionRepository.js'
import { getSupabase } from '../src/repositories/supabaseClient.js'
import { statusForError } from '../src/repositories/errors.js'

async function fetchMemberTrust(memberId) {
  const { data, error } = await getSupabase().from('members').select('trust_level').eq('id', memberId).maybeSingle()
  if (error) throw error
  return data?.trust_level ?? 0
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = req.body ?? {}
  const gateway = new HarnessGateway()

  try {
    assertHarnessToken(req)   // process-level: only the harness process holds this token

    switch (body.action) {
      case 'invoke': {
        const resolved = resolveAction(body.actionName)
        if (!resolved) return res.status(400).json({ error: `Unknown action "${body.actionName}"` })

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
        return res.status(200).json({ success: true, result })
      }

      case 'resolve': {
        const updated = await gateway.resolvePendingAction({
          pendingActionId: body.pendingActionId,
          decision:        body.decision,
          resolvedBy:      body.resolvedBy,
        })
        return res.status(200).json({ success: true, pendingAction: updated })
      }

      case 'inbox': {
        const repo = new PendingActionRepository()
        const items = await repo.findAwaitingForMember(body.memberId)
        return res.status(200).json({ success: true, items })
      }

      default:
        return res.status(400).json({ error: `Unknown action "${body.action}" — expected one of: invoke, resolve, inbox.` })
    }
  } catch (err) {
    // ConfirmationRequiredError included — statusForError reads its 202,
    // and the JSON body carries actionName/severity/pendingActionId (via
    // err.reason) so the harness executor has everything to suspend on.
    if (err.name === 'ConfirmationRequiredError') {
      return res.status(202).json({
        success: false,
        confirmationRequired: true,
        pendingActionId: err.reason,
        actionName: err.actionName,
        severity: err.severity,
        message: err.message,
      })
    }
    console.error('[harness-invoke]', err)
    return res.status(statusForError(err)).json({ error: err.message ?? 'Internal server error' })
  }
}