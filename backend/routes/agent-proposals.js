// backend/routes/agent-proposals.js
//
// Member-facing half of the image→inventory proposal flow. No auth
// gate — same posture as agent-chat.js/pending-actions.js (no real
// per-request session verification exists yet to gate behind).
//
// The actual DB write (InventoryInstanceService.createInstance) still
// happens client-side, via the exact same call the manual "Add
// component" modal uses (src/services/componentsApi.js) — this route
// never writes an inventory instance itself. Its only job is to keep
// harness_conversations.pending_proposals in sync with what the
// member decided, so:
//   (a) a proposal the member already confirmed/discarded doesn't
//       reappear if they reopen the conversation from a different
//       session/device, and
//   (b) if the same photo produced multiple queued proposals, the
//       next one is handed back immediately so the client can chain
//       straight into it without the member re-prompting.
//
// POST /api/agent-proposals
//   { action: 'resolve', conversationId, proposalId, decision: 'confirmed'|'discarded', instanceId? }

import { Hono } from 'hono'
import { HarnessConversationService } from '../../src/services/HarnessConversationService.js'
import { statusForError } from '../../src/repositories/errors.js'

const agentProposals = new Hono()

agentProposals.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const service = new HarnessConversationService()

  try {
    switch (body.action) {
      case 'resolve': {
        if (!body.conversationId || !body.proposalId || !body.decision) {
          return c.json({ error: 'conversationId, proposalId, and decision are required' }, 400)
        }
        const { conversation, nextProposal } = await service.resolveProposal({
          conversationId: body.conversationId,
          proposalId: body.proposalId,
          decision: body.decision,
          instanceId: body.instanceId || null,
        })
        return c.json({ success: true, pendingProposals: conversation.pendingProposals, nextProposal })
      }
      default:
        return c.json({ error: `Unknown action "${body.action}" — expected: resolve.` }, 400)
    }
  } catch (err) {
    console.error('[agent-proposals]', err)
    return c.json({ error: err.message ?? 'Internal server error' }, statusForError(err))
  }
})

export default agentProposals
