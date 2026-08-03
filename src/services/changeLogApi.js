// src/services/changeLogApi.js
//
// Client wrapper for api/change-log.js, same shape as categoriesApi.js /
// cartItemsApi.js. Function names/return shapes deliberately match
// src/changeLog.js's existing fetchEntityHistory/fetchCascadeChildren so
// historyPanel.js's (and partsTable.js's) call sites can swap import
// source only, no body rewrite — same "same names, different transport"
// discipline every prior caller-cutover module in this migration
// followed.
//
// NOTE ON AUTH: api/change-log.js has no gate — same reasoning as every
// other migrated route (see that file's own comment). Plain same-origin
// fetch, no special headers.
//
// Not yet wired into any call site — this is groundwork only (Step 1 of
// the change-log rewrite). historyPanel.js/partsTable.js still import
// fetchEntityHistory/fetchCascadeChildren from '../changeLog.js' for
// now; swapping those, and retiring versionedMutations.js's write path,
// is the next step.

async function callChangeLogApi(action, payload = {}) {
  const res = await fetch('/api/change-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Change log request failed')
  return data
}

export async function fetchEntityHistory(entityType, entityId) {
  const { rows } = await callChangeLogApi('entityHistory', { entityType, entityId })
  return rows
}

export async function fetchCommit(commitId) {
  const { rows } = await callChangeLogApi('commit', { commitId })
  return rows
}

export async function fetchCascadeChildren(causedByEntityType, causedByEntityId) {
  const { rows } = await callChangeLogApi('cascadeChildren', { causedByEntityType, causedByEntityId })
  return rows
}

export async function fetchRecentActivity(limit = 50) {
  const { rows } = await callChangeLogApi('recentActivity', { limit })
  return rows
}