// src/services/categoriesApi.js
//
// Migration Plan Phase 2 — first caller cutover. Categories was picked
// as the first domain to swap because it's small and self-contained
// (one modal, four actions, no cascading effects into Fabricate/Cart/
// Designer state) — a good round trip to prove the route + no-auth
// decision below before touching anything riskier (Cart, Inventory
// Reservation, Fabrication detection confirm).
//
// Same function names as the src/db.js functions this replaces
// (fetchCategories/createCategory reads like upsertCategory's "create"
// half/updateCategory/deleteCategory) so src/main.js's diff is just an
// import-source swap at each call site, not a rewrite of the call sites
// themselves.
//
// NOTE ON AUTH: api/categories.js does NOT require the harness token —
// see that file's own comment for why. This module calls it as a plain
// same-origin fetch, no special headers.
//
// Deliberately scoped to ONLY the Manage Categories modal's four
// actions (list/create/update/delete). The "find or create by name"
// helpers in src/designer/fabDetection.js (ensureSpacerCategory etc.)
// and src/designer/fabricateFlow.js (fabConfirmNewCategory) are NOT
// migrated to this module — those want idempotent find-or-create
// semantics, while CategoryService.create() is intentionally strict
// (throws on a duplicate name). Swapping those call sites onto this
// module would change their behavior, not just their transport — out
// of scope for a same-behavior cutover.

async function callCategoriesApi(action, payload = {}) {
  const res = await fetch('/api/categories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Category request failed')
  return data
}

export async function fetchCategories() {
  const { categories } = await callCategoriesApi('list')
  return categories
}

/** Strict create — rejects a duplicate name (ConflictError, surfaced as
 *  a regular Error with that message) rather than silently allowing
 *  two categories sharing a name, which src/db.js's plain upsertCategory
 *  never guarded against. This is the one intentional behavior change
 *  in this cutover, and it's a bug-fix, not a regression: the Manage
 *  Categories modal is exactly the place a duplicate-name guard belongs. */
export async function createCategory({ name, requiredKeysConfig = [], actorId = null }) {
  const { category } = await callCategoriesApi('create', { name, requiredKeysConfig, actorId })
  return category
}

export async function updateCategory({ categoryId, name, requiredKeysConfig = [], actorId = null }) {
  const { category } = await callCategoriesApi('update', { categoryId, name, requiredKeysConfig, actorId })
  return category
}

export async function deleteCategory({ categoryId, actorId = null }) {
  await callCategoriesApi('delete', { categoryId, actorId })
}
