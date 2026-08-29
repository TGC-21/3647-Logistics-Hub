// src/services/agentProposalsApi.js
// Thin wrapper for /api/agent-proposals — resolving (confirm/discard)
// a queued image-sourced inventory proposal. See agent-proposals.js
// for why the actual instance write never happens through this route.

async function callAgentProposalsApi(action, payload = {}) {
  const res = await fetch('/api/agent-proposals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Proposal request failed')
  return data
}

/** decision: 'confirmed' | 'discarded'. `instanceId` should be set on
 *  confirm once the client has actually created the inventory instance
 *  (createInventoryInstance) — omit for discard. Returns
 *  { pendingProposals, nextProposal } — nextProposal is the next
 *  queued item from the same photo, or null if none remain. */
export async function resolveProposal({ conversationId, proposalId, decision, instanceId = null }) {
  return callAgentProposalsApi('resolve', { conversationId, proposalId, decision, instanceId })
}
