// src/services/fabricationDetectionApi.js
//
// Migration Plan Phase 2 — seventh caller cutover, same shape as
// categoriesApi.js / cartItemsApi.js / inventoryReservationApi.js /
// assemblyPartsApi.js / componentsApi.js. Wraps api/fabrication-detection.js,
// which now owns the single "confirm a detected spacer/shaft/plate"
// action that used to be three near-identical, independently
// maintained functions in src/designer/fabDetection.js
// (confirmSpacerDetection / confirmAxialShaftDetection /
// confirmPlateDetection) — each doing ensure-category, find-or-create
// component, write componentId+fabrication_metadata, create job, in
// slightly different copy-pasted shapes.
//
// AUTH: api/fabrication-detection.js has no gate — same decision every
// other migrated route in this pass has made.

async function callFabricationDetectionApi(action, payload = {}) {
  const res = await fetch('/api/fabrication-detection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Fabrication detection request failed')
  return data
}

/**
 * Confirms a detected candidate for one of the three kinds
 * ('spacer' | 'axial-shaft' | 'plate'). `attrs` is the already-resolved
 * { key: value } map for that kind's fixed category (e.g.
 * { 'Spacer Type': 'ROUND', OD: '0.375', ... }) — the confirm overlay's
 * own field-reading logic is unchanged, only where the result gets sent
 * has moved. Returns { part, component, job }.
 */
export async function confirmFabricationDetection({ kind, partId, attrs, quantityRequested, overrides = null, actorId = null }) {
  const { part, component, job } = await callFabricationDetectionApi('confirm', {
    kind, partId, attrs, quantityRequested, overrides, actorId,
  })
  return { part, component, job }
}

/** "Not a spacer/shaft/plate" — marks the candidate ignored. Kind-
 *  agnostic, same as the service method it wraps. Returns the updated part. */
export async function ignoreFabricationDetection({ partId, actorId = null }) {
  const { part } = await callFabricationDetectionApi('ignore', { partId, actorId })
  return part
}