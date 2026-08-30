// src/services/componentsApi.js
//
// Migration Plan Phase 2 — sixth caller cutover, same shape as
// categoriesApi.js / cartItemsApi.js / inventoryReservationApi.js /
// assemblyPartsApi.js. Wraps api/components.js, which now owns "what
// makes two components the same" (src/componentMatch.js's signature
// rules, applied server-side) instead of that logic — and the
// find-or-insert race it implies — running independently in three
// client call sites (src/main.js, src/designer/fabDetection.js,
// src/designer/fabricateFlow.js).
//
// `fields`/`genId` that old callers used to pass into db.js's
// findOrCreateComponent are gone: the server derives the category's
// requiredKeysConfig itself and generates the new component's id, so
// callers only ever need to say WHAT they want, not how to build it.
//
// AUTH: api/components.js has no gate — same decision every other
// migrated route in this pass has made.
//
// createInstance/updateInstance/deleteInstance added for the Inventory
// Instance CRUD migration — folded into this same client module for the
// same reason they're folded into the same route: no new file, same
// domain pairing (component identity + instances of it), and Vercel's
// 12-function ceiling has no room for a dedicated route to wrap
// separately.

async function callComponentsApi(action, payload = {}) {
  const res = await fetch('/api/components', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Component request failed')
  return data
}

/** Finds an existing component matching (categoryId, attrs) per the
 *  category's own requiredKeysConfig typing rules, or creates a new
 *  one. `attrs` is a plain { key: value } map. `fallback` seeds
 *  fallback_name/description/image ONLY on create. */
export async function findOrCreateComponent({ categoryId, attrs, fallback = null, actorId = null }) {
  const { component } = await callComponentsApi('findOrCreate', { categoryId, attrs, fallback, actorId })
  return component
}

export async function updateComponentFallback({ componentId, name, description, image, actorId = null }) {
  const { component } = await callComponentsApi('updateFallback', { componentId, name, description, image, actorId })
  return component
}

/** Deletes a component IF nothing references it anymore. `instanceCount`
 *  must be computed by the caller first (e.g. via
 *  fetchInstanceCountsForComponents in db.js) — this stays a read the
 *  reservation/inventory domain owns, not something ComponentService
 *  reaches for itself. Returns whether a delete actually happened. */
export async function deleteComponentIfOrphaned({ componentId, instanceCount, actorId = null }) {
  const { deleted } = await callComponentsApi('deleteIfOrphaned', { componentId, instanceCount, actorId })
  return deleted
}


/**
 * Creates a brand-new inventory instance, resolving (or creating) its
 * component first. `categoryId` may be omitted/blank — the server
 * resolves it to a fixed "Uncategorized" category rather than
 * requiring one, so this never fails the way a bare
 * ComponentService.findOrCreate call would.
 */
export async function createInventoryInstance({ categoryId, attrs, fallback = null, name, description = '', image = null, location = '', quantity = 0, notes = '', actorId = null }) {
  const { instance } = await callComponentsApi('createInstance', {
    categoryId, attrs, fallback, name, description, image, location, quantity, notes, actorId,
  })
  return instance
}

/** Edits an existing instance's own fields AND re-resolves its
 *  component from the (possibly changed) category/attrs — may re-parent
 *  the instance onto a different component, orphan-checking the old one
 *  server-side if so. */
export async function updateInventoryInstance({ instanceId, categoryId, attrs, fallback = null, name, description = '', image = null, location = '', quantity = 0, notes = '', actorId = null }) {
  const { instance } = await callComponentsApi('updateInstance', {
    instanceId, categoryId, attrs, fallback, name, description, image, location, quantity, notes, actorId,
  })
  return instance
}

/** Deletes an instance outright — the server unreserves it from every
 *  assembly part that currently links it, deletes the row, then
 *  orphan-checks its component, all before returning. Returns
 *  { deletedInstanceId, unreservedPartCount, componentDeleted }. */
export async function deleteInventoryInstance({ instanceId, actorId = null }) {
  return callComponentsApi('deleteInstance', { instanceId, actorId })
}