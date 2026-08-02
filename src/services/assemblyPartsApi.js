// src/services/assemblyPartsApi.js
//
// Migration Plan Phase 2 — fifth caller cutover, same shape as
// categoriesApi.js / cartItemsApi.js / inventoryReservationApi.js.
// Wraps api/assembly-parts.js's create/update/delete actions, which now
// own the manual Add/Edit/Delete Part rules that used to live inline in
// src/designer/partsTable.js's savePart/deletePart/deleteChildPart
// (owner-XOR validation, status recompute on quantity edits, release
// reserved inventory before deleting).
//
// AUTH: api/assembly-parts.js has no gate — same decision every other
// migrated route in this pass has made.

async function callAssemblyPartsApi(action, payload = {}) {
  const res = await fetch('/api/assembly-parts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Assembly part request failed')
  return data
}

/** Manual "Add part" — exactly one of assemblyId/assemblyChildId. */
export async function createAssemblyPart({ assemblyId = null, assemblyChildId = null, partName, partNumber = '', quantityNeeded = 1, notes = '', actorId = null }) {
  const { part } = await callAssemblyPartsApi('create', {
    assemblyId, assemblyChildId, partName, partNumber, quantityNeeded, notes, actorId,
  })
  return part
}

/** Manual "Edit part" — name/number/quantity/notes only; reservation
 *  bookkeeping and fabrication metadata are untouched (other services'
 *  domains). Status is recomputed server-side and comes back updated. */
export async function updateAssemblyPart({ partId, partName, partNumber = '', quantityNeeded, notes = '', actorId = null }) {
  const { part } = await callAssemblyPartsApi('update', {
    partId, partName, partNumber, quantityNeeded, notes, actorId,
  })
  return part
}

/** Manual "Delete part" — releases any reserved inventory back to
 *  available, then removes the row. Returns
 *  { deletedPartId, releasedInstanceCount }. */
export async function deleteAssemblyPart({ partId, actorId = null }) {
  return callAssemblyPartsApi('delete', { partId, actorId })
}

/** "Send to Fabricate" step 1's "use an existing catalog component"
 *  path — links a part to an already-resolved component, nothing else. */
export async function linkAssemblyPartComponent({ partId, componentId, actorId = null }) {
  const { part } = await callAssemblyPartsApi('linkComponent', { partId, componentId, actorId })
  return part
}