// partOrders.js — Part Orders workflow (vendor-scoped carts + cart items)

import {
  fetchCarts, upsertCart, deleteCart,
  fetchAllCartItems, upsertCartItem, deleteCartItem,
  fetchAllPartNumbers, fetchVendors, findOrCreateVendor,
  fetchComponents, fetchListingsForPartNumber,
  resolveCartItemDisplay,
} from './db.js'

// ── State ─────────────────────────────────────────────────────
let carts          = []
let items          = []
let partNumbers    = []
let vendors        = []
let components     = []
let listingsCache  = new Map()   // partNumberId -> vendor_listings[] (lazy)
let selectedCartId = null
let editingCartId  = null
let showReceived   = false

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

let toastFn = msg => console.warn('[toast]', msg)
export function setPartOrdersToast(fn) { toastFn = fn }

export async function partOrdersBoot() {
  ;[carts, items, partNumbers, vendors, components] = await Promise.all([
    fetchCarts(), fetchAllCartItems(), fetchAllPartNumbers(), fetchVendors(), fetchComponents(),
  ])
}

export function registerNewCartItem(item) { items.push(item) }
export function registerNewCart(cart) { if (!carts.some(c => c.id === cart.id)) carts.unshift(cart) }
export function registerNewVendor(vendor) { if (!vendors.some(v => v.id === vendor.id)) vendors.push(vendor) }
export function registerNewPartNumber(pn) { if (!partNumbers.some(p => p.id === pn.id)) partNumbers.push(pn) }
export function getVendors() { return vendors }
export function getPartNumbers() { return partNumbers }

function vendorById(id)     { return vendors.find(v => v.id === id) || null }
function componentById(id)  { return components.find(c => c.id === id) || null }
function partNumberById(id) { return partNumbers.find(p => p.id === id) || null }
function itemsForCart(cartId) { return items.filter(i => i.cartId === cartId) }

// ── Listing lookups (needed synchronously for row render — cache-first) ──
// Cart items store a vendor_listing_id directly (no async needed to
// render once cached), but the cache itself is populated lazily per part
// number the first time it's touched (e.g. from the linking modal). For
// items whose listing isn't cached yet, render falls back to overrides.
function cachedListing(listingId) {
  for (const list of listingsCache.values()) {
    const found = list.find(l => l.id === listingId)
    if (found) return found
  }
  return null
}

function cartTotal(cartId) {
  return itemsForCart(cartId).reduce((sum, item) => {
    const listing = item.vendorListingId ? cachedListing(item.vendorListingId) : null
    const pn = listing ? partNumberById(listing.partNumberId) : null
    const comp = pn ? componentById(pn.componentId) : null
    const display = resolveCartItemDisplay(item, listing, comp, item.nameOverride)
    return sum + (display.price != null ? display.price * item.quantity : 0)
  }, 0)
}

// ── Sidebar ───────────────────────────────────────────────────
export function renderPartOrdersSidebar() {
  const navAll = document.getElementById('nav-all')
  navAll.innerHTML = `<i class="ti ti-shopping-cart" aria-hidden="true"></i> All carts
    <span class="nav-count">${carts.length}</span>`
  navAll.className = 'nav-item' + (selectedCartId === null ? ' active' : '')

  const catNav = document.getElementById('cat-nav')
  catNav.innerHTML = carts.map(c => {
    const active = selectedCartId === c.id
    const count = itemsForCart(c.id).length
    const vendor = c.vendorId ? vendorById(c.vendorId) : null
    return `<div class="nav-item asm-nav-item${active ? ' active' : ''}" data-cart-nav="${c.id}">
      <i class="ti ti-shopping-cart" style="font-size:15px;flex-shrink:0" aria-hidden="true"></i>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px">${c.name}${vendor ? ` <span style="color:var(--color-text-tertiary);font-weight:400">· ${vendor.name}</span>` : ''}</span>
      <span class="nav-count">${count}</span>
    </div>`
  }).join('')

  document.getElementById('tags-divider').style.display = 'none'
  document.getElementById('tags-label').style.display   = 'none'
  document.getElementById('tags-nav').innerHTML         = ''
  document.getElementById('sidebar-label-cats').textContent = 'Carts'

  catNav.querySelectorAll('[data-cart-nav]').forEach(el =>
    el.addEventListener('click', () => selectCart(el.dataset.cartNav))
  )
}

export function selectCart(id) {
  selectedCartId = id || null
  renderPartOrdersSidebar()
  renderPartOrdersContent()
}

// ── Content ───────────────────────────────────────────────────
export async function renderPartOrdersContent() {
  const title = document.getElementById('content-title')
  const meta  = document.getElementById('content-meta')
  const area  = document.getElementById('main-area')

  if (selectedCartId === null) {
    title.textContent = 'Part Orders'
    meta.textContent  = `${carts.length} cart${carts.length === 1 ? '' : 's'}`
    renderCartsOverview(area)
    return
  }

  const cart = carts.find(c => c.id === selectedCartId)
  if (!cart) { selectCart(null); return }

  const vendor = cart.vendorId ? vendorById(cart.vendorId) : null
  title.textContent = cart.name
  meta.innerHTML = `${vendor ? `<span class="asm-linked-badge"><i class="ti ti-building-store" aria-hidden="true"></i> ${vendor.name}</span>` : ''}
    <span style="margin-left:8px;color:var(--color-text-tertiary)">Total: $${cartTotal(cart.id).toFixed(2)}</span>`

  // Prime the listing cache for every part number referenced by this
  // cart's items so cartTotal()/rows render with real prices, not blanks.
  const cartItems = itemsForCart(cart.id).filter(i => showReceived || i.status !== 'received')
  await primeListingsForItems(cartItems)

  area.innerHTML = `<div class="asm-detail">
    <div class="asm-detail-toolbar">
      <button class="btn btn-sm" id="btn-back-cart"><i class="ti ti-arrow-left" aria-hidden="true"></i> All carts</button>
      <div style="flex:1"></div>
      <button class="btn btn-sm" id="btn-edit-cart"><i class="ti ti-edit" aria-hidden="true"></i><span> Edit cart</span></button>
      <button class="btn btn-danger btn-sm" id="btn-delete-cart"><i class="ti ti-trash" aria-hidden="true"></i></button>
    </div>
    ${cart.notes ? `<p class="asm-detail-desc">${cart.notes}</p>` : ''}
    <div class="asm-parts-toolbar">
      <div class="asm-parts-title">Items <span class="section-count">${cartItems.length}</span></div>
      <div style="flex:1"></div>
      <label class="fab-history-toggle"><input type="checkbox" id="chk-show-received" ${showReceived ? 'checked' : ''}> <span>Show received</span></label>
      <button class="btn btn-primary btn-sm" id="btn-add-item"><i class="ti ti-plus" aria-hidden="true"></i><span> Add item</span></button>
    </div>
    ${itemsTableHTML(cartItems)}
  </div>`

  document.getElementById('btn-back-cart').addEventListener('click', () => selectCart(null))
  document.getElementById('btn-edit-cart').addEventListener('click', () => openCartModal(cart.id))
  document.getElementById('btn-delete-cart').addEventListener('click', () => handleDeleteCart(cart.id))
  document.getElementById('btn-add-item').addEventListener('click', () => openItemModal(cart.id))
  document.getElementById('chk-show-received').addEventListener('change', e => {
    showReceived = e.target.checked
    renderPartOrdersContent()
  })
  bindItemRowEvents()
}

async function primeListingsForItems(cartItems) {
  const pnIds = new Set()
  for (const item of cartItems) {
    const listing = item.vendorListingId ? cachedListing(item.vendorListingId) : null
    if (item.vendorListingId && !listing) {
      // We only have the id — fetch by walking part_numbers is wasteful;
      // instead fetch listings keyed by the part number once we know it.
      // Simplify: fetch every part number's listings lazily as items ask
      // for them, keyed by part_number_id — but items only carry
      // vendor_listing_id, so resolve via a direct listing fetch instead.
    }
  }
  // Simpler and correct: fetch listings for every part number in
  // `partNumbers` that appears on a cart item indirectly isn't knowable
  // without the listing row itself, so just fetch-by-id for any
  // uncached vendor_listing_id.
  const uncachedIds = [...new Set(cartItems.map(i => i.vendorListingId).filter(Boolean))]
    .filter(id => !cachedListing(id))
  await Promise.all(uncachedIds.map(fetchAndCacheListingById))
}

async function fetchAndCacheListingById(listingId) {
  // vendor_listings has no single-row fetch-by-id helper exposed yet —
  // reuse fetchListingsForPartNumber once we know the part number. Since
  // we only have the listing id at this point, do a light direct query.
  const { supabase } = await import('./db.js')
  const { data, error } = await supabase.from('vendor_listings').select('*').eq('id', listingId).maybeSingle()
  if (error || !data) return
  const listing = {
    id: data.id, partNumberId: data.part_number_id, vendorId: data.vendor_id,
    purchaseLink: data.purchase_link ?? '', purchasePrice: data.purchase_price ?? null,
    isPreferred: data.is_preferred ?? false, createdAt: data.created_at,
  }
  const list = listingsCache.get(listing.partNumberId) || []
  if (!list.some(l => l.id === listing.id)) list.push(listing)
  listingsCache.set(listing.partNumberId, list)
}

function renderCartsOverview(area) {
  if (!carts.length) {
    area.innerHTML = `<div class="empty">
      <i class="ti ti-shopping-cart-off" aria-hidden="true"></i>
      <div class="empty-title">No carts yet</div>
      <div class="empty-sub">Carts are organized by vendor — one cart per store you're ordering from.</div>
      <button class="btn btn-primary" id="empty-new-cart-btn"><i class="ti ti-plus"></i> New cart</button>
    </div>`
    document.getElementById('empty-new-cart-btn').addEventListener('click', () => openCartModal())
    return
  }

  area.innerHTML = `<div class="asm-grid">${carts.map(cartCardHTML).join('')}</div>`
  area.querySelectorAll('[data-open-cart]').forEach(el =>
    el.addEventListener('click', () => selectCart(el.dataset.openCart))
  )
}

function cartCardHTML(c) {
  const vendor = c.vendorId ? vendorById(c.vendorId) : null
  const count = itemsForCart(c.id).length
  return `<div class="asm-card" data-open-cart="${c.id}">
    <div class="asm-card-header">
      <div class="asm-card-name">${c.name}</div>
      ${vendor ? `<span class="asm-linked-badge"><i class="ti ti-building-store" aria-hidden="true"></i> ${vendor.name}</span>` : ''}
    </div>
    <div class="asm-card-desc"><i class="ti ti-list-details" aria-hidden="true"></i> ${count} item${count === 1 ? '' : 's'} — $${cartTotal(c.id).toFixed(2)}</div>
  </div>`
}

// ── Item table ───────────────────────────────────────────────
function itemsTableHTML(list) {
  if (!list.length) {
    return `<div class="empty" style="padding:40px 0"><i class="ti ti-list-check" aria-hidden="true"></i><div class="empty-title">No items in this cart</div></div>`
  }
  return `<div class="parts-table-wrap">
    <table class="parts-table">
      <thead><tr>
        <th>Name</th><th>Part #</th>
        <th style="text-align:center">Qty</th><th style="text-align:right">Price</th>
        <th style="text-align:center">Status</th><th></th>
      </tr></thead>
      <tbody id="cart-items-tbody">${list.map(itemRowHTML).join('')}</tbody>
    </table>
  </div>`
}

function itemRowHTML(item) {
  const listing = item.vendorListingId ? cachedListing(item.vendorListingId) : null
  const pn = listing ? partNumberById(listing.partNumberId) : null
  const comp = pn ? componentById(pn.componentId) : null
  const display = resolveCartItemDisplay(item, listing, comp, item.nameOverride)

  const statusBadge = {
    pending:  '<span class="part-badge part-badge--pending">Pending</span>',
    ordered:  '<span class="part-badge part-badge--partial">Ordered</span>',
    received: '<span class="part-badge part-badge--complete">Received</span>',
  }[item.status] || item.status

  const lineTotal = display.price != null ? (display.price * item.quantity).toFixed(2) : '—'

  return `<tr data-item-id="${item.id}">
    <td>
      <div class="part-name">${display.link ? `<a href="${display.link}" target="_blank" rel="noreferrer">${display.name}</a>` : display.name}</div>
    </td>
    <td><span class="part-number">${pn?.value || '—'}</span></td>
    <td style="text-align:center">${item.quantity}</td>
    <td style="text-align:right">${display.price != null ? '$' + display.price.toFixed(2) : '—'} <span style="color:var(--color-text-tertiary);font-size:11px">(${lineTotal})</span></td>
    <td style="text-align:center">${statusBadge}</td>
    <td style="text-align:right">
      ${item.status !== 'received' ? `<button class="btn-icon" data-item-advance="${item.id}" aria-label="Advance status" title="${item.status === 'pending' ? 'Mark ordered' : 'Mark received'}"><i class="ti ti-arrow-right" style="font-size:13px"></i></button>` : ''}
      <button class="btn-icon" data-item-edit="${item.id}" aria-label="Edit"><i class="ti ti-edit" style="font-size:13px"></i></button>
      <button class="btn-icon" data-item-delete="${item.id}" aria-label="Delete"><i class="ti ti-trash" style="font-size:13px"></i></button>
    </td>
  </tr>`
}

function bindItemRowEvents() {
  const tbody = document.getElementById('cart-items-tbody')
  if (!tbody) return
  tbody.addEventListener('click', async e => {
    const advBtn = e.target.closest('[data-item-advance]')
    if (advBtn) { await handleAdvanceStatus(advBtn.dataset.itemAdvance); return }
    const editBtn = e.target.closest('[data-item-edit]')
    if (editBtn) { openItemModal(selectedCartId, editBtn.dataset.itemEdit); return }
    const delBtn = e.target.closest('[data-item-delete]')
    if (delBtn) { await handleDeleteItem(delBtn.dataset.itemDelete); return }
  })
}

async function handleAdvanceStatus(itemId) {
  const item = items.find(i => i.id === itemId)
  if (!item) return
  const next = item.status === 'pending' ? 'ordered' : 'received'
  try {
    const saved = await upsertCartItem({ ...item, status: next })
    const idx = items.findIndex(i => i.id === itemId)
    if (idx > -1) items[idx] = saved
    renderPartOrdersContent()
  } catch (e) { console.error(e); toastFn('Error updating item') }
}

async function handleDeleteItem(itemId) {
  if (!confirm('Remove this item from the cart?')) return
  try {
    await deleteCartItem(itemId)
    items = items.filter(i => i.id !== itemId)
    renderPartOrdersContent()
    toastFn('Item removed')
  } catch (e) { console.error(e); toastFn('Error removing item') }
}

async function handleDeleteCart(cartId) {
  const cart = carts.find(c => c.id === cartId)
  if (!cart || !confirm(`Delete cart "${cart.name}" and all its items? This cannot be undone.`)) return
  try {
    await deleteCart(cartId)
    carts = carts.filter(c => c.id !== cartId)
    items = items.filter(i => i.cartId !== cartId)
    selectCart(null)
    toastFn('Cart deleted')
  } catch (e) { console.error(e); toastFn('Error deleting cart') }
}

// ── Cart modal (vendor-scoped) ──────────────────────────────
let cartModalNewVendorMode = false

export function openCartModal(id) {
  editingCartId = id || null
  cartModalNewVendorMode = false
  const c = id ? carts.find(x => x.id === id) : null

  document.getElementById('cart-modal-title').textContent = c ? 'Edit cart' : 'New cart'
  document.getElementById('cart-field-name').value  = c?.name || ''
  document.getElementById('cart-field-notes').value = c?.notes || ''

  populateVendorSelect(c?.vendorId || '')
  hideCartNewVendorRow()

  document.getElementById('btn-delete-cart-modal').style.display = c ? 'inline-flex' : 'none'
  document.getElementById('cart-modal-overlay').style.display = 'flex'
  setTimeout(() => document.getElementById('cart-field-name').focus(), 80)
}

function populateVendorSelect(selectedId) {
  const sel = document.getElementById('cart-field-vendor')
  sel.innerHTML = '<option value="">— Select vendor —</option>' +
    vendors.map(v => `<option value="${v.id}"${v.id === selectedId ? ' selected' : ''}>${v.name}</option>`).join('')
}

function showCartNewVendorRow() {
  document.getElementById('cart-new-vendor-row').style.display = 'flex'
  document.getElementById('btn-cart-new-vendor').style.display = 'none'
  document.getElementById('cart-field-vendor').disabled = true
  cartModalNewVendorMode = true
  setTimeout(() => document.getElementById('cart-new-vendor-input').focus(), 60)
}
function hideCartNewVendorRow() {
  document.getElementById('cart-new-vendor-row').style.display = 'none'
  document.getElementById('btn-cart-new-vendor').style.display = 'inline-flex'
  document.getElementById('cart-field-vendor').disabled = false
  document.getElementById('cart-new-vendor-input').value = ''
  cartModalNewVendorMode = false
}

async function confirmCartNewVendor() {
  const name = document.getElementById('cart-new-vendor-input').value.trim()
  if (!name) { document.getElementById('cart-new-vendor-input').focus(); return }
  try {
    const vendor = await findOrCreateVendor(name, genId)
    registerNewVendor(vendor)
    populateVendorSelect(vendor.id)
    hideCartNewVendorRow()
    toastFn('Vendor added')
  } catch (e) { console.error(e); toastFn('Error adding vendor') }
}

function closeCartModal() {
  document.getElementById('cart-modal-overlay').style.display = 'none'
  editingCartId = null
}

async function saveCartModal() {
  const name = document.getElementById('cart-field-name').value.trim()
  const vendorId = document.getElementById('cart-field-vendor').value || null
  if (!name) { document.getElementById('cart-field-name').focus(); toastFn('Cart name is required'); return }
  if (!vendorId) { toastFn('A vendor is required — every cart belongs to exactly one vendor'); return }

  const payload = { id: editingCartId || genId(), name, vendorId, notes: document.getElementById('cart-field-notes').value.trim(), status: 'open' }

  try {
    const saved = await upsertCart(payload)
    if (editingCartId) {
      const idx = carts.findIndex(c => c.id === editingCartId)
      if (idx > -1) carts[idx] = saved
    } else {
      carts.unshift(saved)
    }
    closeCartModal()
    renderPartOrdersSidebar()
    selectCart(saved.id)
    toastFn(editingCartId ? 'Cart updated' : 'Cart created')
  } catch (e) { console.error(e); toastFn('Error saving cart') }
}

// ── Item modal (ad hoc items only — listing-linked items are edited via
//    the assembly-part linking flow in designer.js) ─────────────────
let itemModalCartId = null
let editingItemId = null

export function openItemModal(cartId, itemId) {
  itemModalCartId = cartId
  editingItemId = itemId || null
  const item = itemId ? items.find(i => i.id === itemId) : null
  const isLinked = !!item?.vendorListingId

  document.getElementById('item-modal-title').textContent = item ? 'Edit item' : 'Add item'
  document.getElementById('item-field-name').value = item?.nameOverride || ''
  document.getElementById('item-field-link').value = item?.linkOverride || ''
  document.getElementById('item-field-price').value = item?.priceOverride ?? ''
  document.getElementById('item-field-qty').value = item?.quantity ?? 1
  document.getElementById('item-field-name').disabled = isLinked
  document.getElementById('item-field-link').disabled = isLinked
  document.getElementById('item-field-price').disabled = isLinked
  document.getElementById('item-modal-hint').textContent = isLinked
    ? 'This item is linked to a vendor listing — edit price/link from the part\'s vendor listings instead.'
    : ''
  document.getElementById('item-modal-overlay').style.display = 'flex'
  setTimeout(() => document.getElementById('item-field-name').focus(), 80)
}

function closeItemModal() {
  document.getElementById('item-modal-overlay').style.display = 'none'
  itemModalCartId = null
  editingItemId = null
}

async function saveItemModal() {
  const existing = editingItemId ? items.find(i => i.id === editingItemId) : null

  if (existing?.vendorListingId) {
    const payload = { ...existing, quantity: Math.max(1, parseInt(document.getElementById('item-field-qty').value, 10) || 1) }
    try {
      const saved = await upsertCartItem(payload)
      const idx = items.findIndex(i => i.id === existing.id)
      if (idx > -1) items[idx] = saved
      closeItemModal(); renderPartOrdersContent()
    } catch (e) { console.error(e); toastFn('Error saving item') }
    return
  }

  const name = document.getElementById('item-field-name').value.trim()
  if (!name) { document.getElementById('item-field-name').focus(); toastFn('Name is required'); return }

  const payload = {
    id: editingItemId || genId(),
    cartId: itemModalCartId,
    vendorListingId: null,
    assemblyPartId: existing?.assemblyPartId || null,
    nameOverride: name,
    linkOverride: document.getElementById('item-field-link').value.trim(),
    priceOverride: document.getElementById('item-field-price').value ? parseFloat(document.getElementById('item-field-price').value) : null,
    quantity: Math.max(1, parseInt(document.getElementById('item-field-qty').value, 10) || 1),
    status: existing?.status || 'pending',
  }

  try {
    const saved = await upsertCartItem(payload)
    if (editingItemId) {
      const idx = items.findIndex(i => i.id === editingItemId)
      if (idx > -1) items[idx] = saved
    } else {
      items.push(saved)
    }
    closeItemModal()
    renderPartOrdersContent()
    toastFn(editingItemId ? 'Item updated' : 'Item added')
  } catch (e) { console.error(e); toastFn('Error saving item') }
}

// ── Bind static events ───────────────────────────────────────
export function bindPartOrdersEvents() {
  document.getElementById('btn-new-cart-topbar').addEventListener('click', () => openCartModal())

  document.getElementById('btn-close-cart-detail-modal').addEventListener('click', closeCartModal)
  document.getElementById('btn-cancel-cart-detail').addEventListener('click', closeCartModal)
  document.getElementById('btn-save-cart-detail').addEventListener('click', saveCartModal)
  document.getElementById('btn-delete-cart-modal').addEventListener('click', async () => {
    if (editingCartId) { const id = editingCartId; closeCartModal(); await handleDeleteCart(id) }
  })
  document.getElementById('cart-modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeCartModal()
  })
  document.getElementById('btn-cart-new-vendor').addEventListener('click', showCartNewVendorRow)
  document.getElementById('btn-cart-cancel-new-vendor').addEventListener('click', hideCartNewVendorRow)
  document.getElementById('btn-cart-confirm-new-vendor').addEventListener('click', confirmCartNewVendor)

  document.getElementById('btn-close-item-modal').addEventListener('click', closeItemModal)
  document.getElementById('btn-cancel-item').addEventListener('click', closeItemModal)
  document.getElementById('btn-save-item-modal').addEventListener('click', saveItemModal)
  document.getElementById('item-modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeItemModal()
  })
}

export async function refreshPartNumbers() {
  partNumbers = await fetchAllPartNumbers()
}