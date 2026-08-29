// src/services/harnessApi.js
// Thin wrapper for the member-facing half of /api/harness-invoke —
// listing and resolving pending actions. The 'invoke' action is
// harness-only (token-gated) and never called from the browser.

async function callPendingActionsApi(action, payload = {}) {
  const res = await fetch('/api/pending-actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Harness request failed')
  return data
}

export async function fetchPendingActions(memberId) {
  const { items } = await callPendingActionsApi('inbox', { memberId })
  return items
}

export async function resolvePendingAction({ pendingActionId, decision, resolvedBy, progressId }) {
  return callPendingActionsApi('resolve', { pendingActionId, decision, resolvedBy, progressId })
}
