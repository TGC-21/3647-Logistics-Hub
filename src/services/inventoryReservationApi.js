// src/services/inventoryReservationApi.js
//
// Migration Plan Phase 2 — fourth caller cutover, same shape as
// categoriesApi.js / fabricationJobsApi.js / cartItemsApi.js. Wraps
// api/inventory-reservation.js's two actions ('reserve' / 'unreserve'),
// which now own the rules that used to live inline in
// src/designer/inventoryLink.js's linkInstanceToPart/unlinkInstanceFromPart
// (qty-capped-at-remaining-needed, fork/status recompute, part-number
// backfill) — see InventoryReservationService's own doc comment for the
// full rule list.
//
// AUTH: api/inventory-reservation.js has no gate — same decision every
// other migrated route in this pass has made. Plain same-origin fetch,
// no special headers.

async function callInventoryReservationApi(action, payload = {}) {
  const res = await fetch('/api/inventory-reservation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Inventory reservation request failed')
  return data
}

/**
 * Reserves `quantity` units of `instanceId` for `assemblyPartId`,
 * forking them off the source pile. Server caps the quantity at the
 * part's remaining gap (needed - collected) rather than trusting the
 * caller's number, recomputes the part's status, and (if
 * `sourcePartNumber` is given) best-effort backfills that vendor SKU's
 * component_id. Returns { part, fork }.
 */
export async function reserveInventoryUnits({
  assemblyPartId, instanceId, componentId = null, quantity, location = '',
  sourcePartNumber = null, actorId = null,
}) {
  return callInventoryReservationApi('reserve', {
    assemblyPartId, instanceId, componentId, quantity, location, sourcePartNumber, actorId,
  })
}

/**
 * Releases one specific forked instance back to 'available' and removes
 * it from the part's linked_instance_ids, recomputing status. Clears
 * componentId too if that was the part's last linked instance. Returns
 * the updated part directly (matches unreserveInstance's old shape at
 * the call site — no `{ part }` wrapper needed there).
 */
export async function unreserveInventoryUnits({
  assemblyPartId, instanceId, unlinkedQuantity = 1, resetLocation = '', actorId = null,
}) {
  const { part } = await callInventoryReservationApi('unreserve', {
    assemblyPartId, instanceId, unlinkedQuantity, resetLocation, actorId,
  })
  return part
}
