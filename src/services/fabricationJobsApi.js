// src/services/fabricationJobsApi.js
//
// Migration Plan Phase 2 — second caller cutover, following the shape
// src/services/categoriesApi.js already established for the first
// (Categories). Fabrication Jobs was picked next per
// MIGRATION_EXAMPLE.md's own framing as "the reference implementation"
// — its route (api/fabrication-jobs.js) and service
// (services/FabricationJobService.js) have existed since Phase 1 item 4
// specifically to be copied, and nothing about them needed to change to
// go live; only the auth gate and the callers did.
//
// Same function names/signatures as the src/db.js functions this
// replaces (createFabricationJob, recordMachinedUnits,
// deleteQueuedFabricationJob) so each call site's diff is an
// import-source swap, not a rewrite — same discipline categoriesApi.js
// followed.
//
// NOTE ON AUTH: api/fabrication-jobs.js no longer requires the harness
// token — see that file's own comment for why (same reasoning
// api/categories.js already documented: no real per-member auth
// boundary exists yet, so gating one route tighter than the rest of the
// app is theater, not security). Plain same-origin fetch, no special
// headers.
//
// ONE BEHAVIOR IMPROVEMENT, not just a transport swap: deleteQueuedJob
// now returns `reopenedPart` — the part row FabricationJobService
// already re-opens for re-detection server-side when its queued job is
// deleted (see that service's own doc comment on why this used to be a
// bug magnet: it lived in src/fabricate.js's handleDeleteJob click
// handler, so only THAT specific delete path remembered to do it).
// deleteQueuedFabricationJob's caller no longer needs to replicate that
// fix-up itself — see the updated handleDeleteJob in src/fabricate.js.

async function callFabricationJobsApi(action, payload = {}) {
  const res = await fetch('/api/fabrication-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Fabrication job request failed')
  return data
}

/** Same call shape every existing call site already uses
 *  (`{ assemblyPartId, quantityRequested, batchId, genId }`) — `genId`
 *  is accepted and ignored (the server assigns the new job's id now),
 *  so no call site needs to change how it invokes this. */
export async function createFabricationJob({ assemblyPartId, quantityRequested, batchId = null, actorId = null }) {
  const { job } = await callFabricationJobsApi('create', { assemblyPartId, quantityRequested, batchId, actorId })
  return job
}

export async function recordMachinedUnits(jobId, quantity, actorId = null) {
  const { job } = await callFabricationJobsApi('recordProgress', { jobId, quantity, actorId })
  return job
}

/** Returns `{ deletedJobId, reopenedPart }` — `reopenedPart` is the
 *  freshly-saved assembly_part row if this job's deletion also reopened
 *  it for re-detection, or `null` if there was nothing to reopen (a
 *  manually-created part, or one whose fabrication_metadata wasn't in
 *  the 'queued' state). Callers that only care about the delete itself
 *  can ignore the second field, same as before. */
export async function deleteQueuedFabricationJob(jobId, actorId = null) {
  const { deletedJobId, reopenedPart } = await callFabricationJobsApi('deleteQueued', { jobId, actorId })
  return { deletedJobId, reopenedPart }
}