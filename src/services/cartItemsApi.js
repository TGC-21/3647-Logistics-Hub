// src/services/cartItemsApi.js
//
// Migration Plan Phase 2 — third caller cutover, same shape as
// categoriesApi.js / fabricationJobsApi.js. Only wraps the actions
// CartService actually implements (create, advanceStatus, delete,
// findOrCreateCart, ensurePartNumber) — see src/partOrders.js and
// src/designer/partOrdersCart.js's own comments for exactly which
// call sites moved here and which stayed on db.js's generic
// upsertCartItem, and why.
//
// findOrCreateCartForVendor and ensurePartNumberStub keep their
// original db.js positional signatures — including a trailing,
// ignored `genId` parameter — specifically so their call sites need
// only an import-source swap, zero body changes. createCartItem and
// deleteCartItem/advanceCartItemStatus don't have that luxury: there
// is no existing db.js function named "createCartItem" (the client
// used generic upsertCartItem with a locally-generated id for
// creation too), and advanceCartItemStatus's new name reflects that
// it's now a specific transition, not a generic field update.
//
// AUTH: api/cart-items.js has no gate — same decision every other
// migrated route in this pass has made (see that file's own comment).
// Plain same-origin fetch, no special headers.

async function callCartItemsApi(action, payload = {}) {
  const res = await fetch('/api/cart-items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Cart item request failed')
  return data
}

export async function createCartItem({ cartId, vendorListingId = null, assemblyPartId = null, nameOverride = '', linkOverride = '', priceOverride = null, quantity, actorId = null }) {
  const { item } = await callCartItemsApi('create', { cartId, vendorListingId, assemblyPartId, nameOverride, linkOverride, priceOverride, quantity, actorId })
  return item
}

export async function advanceCartItemStatus(itemId, actorId = null) {
  const { item } = await callCartItemsApi('advanceStatus', { itemId, actorId })
  return item
}

/** Same name/positional signature as the db.js function it replaces —
 *  drop-in for every existing call site. NOTE the one real behavior
 *  change: CartService.deleteItem refuses to delete a 'received' item
 *  (a completed purchase) — see that service's own doc comment. Callers
 *  that hit this now get a friendly ConflictError message instead of
 *  the delete silently succeeding. */
export async function deleteCartItem(itemId, actorId = null) {
  return callCartItemsApi('delete', { itemId, actorId })
}

export async function findOrCreateCartForVendor(vendorId, vendorName, _genId, actorId = null) {
  const { cart } = await callCartItemsApi('findOrCreateCart', { vendorId, vendorName, actorId })
  return cart
}

export async function ensurePartNumberStub(value, _genId) {
  const { partNumber } = await callCartItemsApi('ensurePartNumber', { value })
  return partNumber
}