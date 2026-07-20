// partOrders.js — Part Orders workflow (carts + cart items)
//
// Mirrors fabricate.js's module structure/conventions. A cart groups
// order line items — either tied to one assembly (auto-created via
// "Add to cart" on a BOM part row in Designer) or general-purpose
// ("Tools", "Bolt restock", etc, created manually here).

import {
  fetchCarts, upsertCart, deleteCart,
  fetchAllCartItems, upsertCartItem, deleteCartItem,
  fetchAllPartNumbers, upsertPartNumber, deletePartNumber,
  fetchComponents, fetchAssemblies,
  resolveCartItemDisplay,
} from './db.js'

// ── State ─────────────────────────────────────────────────────
let carts          = []
let items          = []          // ALL cart_items, every cart
let partNumbers    = []          // ALL part_numbers
let components     = []          // for resolving names/links on items
let assemblies     = []          // for the cart "linked assembly" label + filter
let selectedCartId = null        // null = overview
let editingCartId  = null
let editingItemId  = null
let showReceived   = false

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

let toastFn = msg => console.warn('[toast]', msg)
export function setPartOrdersToast(fn) { toastFn = fn }

// ── Boot ──────────────────────────────────────────────────────
export async function partOrdersBoot() {
  ;[carts, items, partNumbers, components, assemblies] = await Promise.all([
    fetchCarts(), fetchAllCartItems(), fetchAllPartNumbers(), fetchComponents(), fetchAssemblies(),
  ])
}

/** Called by designer.js's "Add to cart" action so the tab reflects a
 *  newly-created item without a full reload. */
export function registerNewCartItem(item) { items.push(item) }
export function registerNewCart(cart) { 
    if (!carts.some(c => c.id === cart.id)) return
    carts.unshift(cart) 
}

function partNumberById(id) { return partNumbers.find(p => p.id === id) || null }
function componentById(id)  { return components.find(c => c.id === id) || null }
function assemblyById(id)   { return assemblies.find(a => a.id === id) || null }

function itemsForCart(cartId) { return items.filter(i => i.cartId === cartId) }

function cartTotal(cartId) {
  return itemsForCart(cartId).reduce((sum, item) => {
    const pn = partNumberById(item.partNumberId)
    const comp = pn ? componentById(pn.componentId) : null
    const display = resolveCartItemDisplay(item, pn, comp)
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
    return `<div class="nav-item asm-nav-item${active ? ' active' : ''}" data-cart-nav="${c.id}">
      <i class="ti ti-shopping-cart" style="font-size:15px;flex-shrink:0" aria-hidden="true"></i>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px">${c.name}</span>
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
export function renderPartOrdersContent() {
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

  const linkedAsm = cart.assemblyId ? assemblyById(cart.assemblyId) : null
  title.textContent = cart.name
  meta.innerHTML = `${linkedAsm ? `<span class="asm-linked-badge"><i class="ti ti-box" aria-hidden="true"></i> ${linkedAsm.name}</span>` : ''}
    <span style="margin-left:8px;color:var(--color-text-tertiary)">Total: $${cartTotal(cart.id).toFixed(2)}</span>`

  const cartItems = itemsForCart(cart.id).filter(i => showReceived || i.status !== 'received')

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

function renderCartsOverview(area) {
  if (!carts.length) {
    area.innerHTML = `<div class="empty">
      <i class="ti ti-shopping-cart-off" aria-hidden="true"></i>
      <div class="empty-title">No carts yet</div>
      <div class="empty-sub">Create a cart for an assembly's BOM, or a general-purpose cart like "Tools" or "Bolt restock."</div>
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
  const linkedAsm = c.assemblyId ? assemblyById(c.assemblyId) : null
  const count = itemsForCart(c.id).length
  const total = cartTotal(c.id)
  return `<div class="asm-card" data-open-cart="${c.id}">
    <div class="asm-card-header">
      <div class="asm-card-name">${c.name}</div>
      ${linkedAsm ? `<span class="asm-linked-badge"><i class="ti ti-box" aria-hidden="true"></i> Linked</span>` : ''}
    </div>
    <div class="asm-card-desc"><i class="ti ti-list-details" aria-hidden="true"></i> ${count} item${count === 1 ? '' : 's'} — $${total.toFixed(2)}</div>
  </div>`
}

// ── Item table ───────────────────────────────────────────────
function itemsTableHTML(list) {
  if (!list.length) {
    return `<div class="empty" style="padding:40px 0">
      <i class="ti ti-list-check" aria-hidden="true"></i>
      <div class="empty-title">No items in this cart</div>
    </div>`
  }

  const rows = list.map(itemRowHTML).join('')
  return `<div class="parts-table-wrap">
    <table class="parts-table">
      <thead><tr>
        <th>Name</th><th>Assembly</th><th>Vendor</th>
        <th style="text-align:center">Qty</th><th style="text-align:right">Price</th>
        <th style="text-align:center">Status</th><th></th>
      </tr></thead>
      <tbody id="cart-items-tbody">${rows}</tbody>
    </table>
  </div>`
}

function itemRowHTML(item) {
  const pn = partNumberById(item.partNumberId)
  const comp = pn ? componentById(pn.componentId) : null
  const display = resolveCartItemDisplay(item, pn, comp)
  const asm = item.assemblyPartId ? null : null // assembly resolved at cart level; per-item shown only if useful later

  const statusBadge = {
    pending:  '<span class="part-badge part-badge--pending">Pending</span>',
    ordered:  '<span class="part-badge part-badge--partial">Ordered</span>',
    received: '<span class="part-badge part-badge--complete">Received</span>',
  }[item.status] || item.status

  const lineTotal = display.price != null ? (display.price * item.quantity).toFixed(2) : '—'

  return `<tr data-item-id="${item.id}">
    <td>
      <div class="part-name">${display.link ? `<a href="${display.link}" target="_blank" rel="noreferrer">${display.name}</a>` : display.name}</div>
      ${pn ? `<div class="part-notes">${pn.value}</div>` : ''}
    </td>
    <td><span class="part-number">${display.vendor || '—'}</span></td>
    <td><span class="part-number">${display.vendor || '—'}</span></td>
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

// ── Cart modal ───────────────────────────────────────────────
export function openCartModal(id) {
  editingCartId = id || null
  const c = id ? carts.find(x => x.id === id) : null

  document.getElementById('cart-modal-title').textContent = c ? 'Edit cart' : 'New cart'
  document.getElementById('cart-field-name').value  = c?.name || ''
  document.getElementById('cart-field-notes').value = c?.notes || ''

  const asmSelect = document.getElementById('cart-field-assembly')
  asmSelect.innerHTML = '<option value="">— No linked assembly —</option>' +
    assemblies.map(a => `<option value="${a.id}"${c?.assemblyId === a.id ? ' selected' : ''}>${a.name}</option>`).join('')

  document.getElementById('btn-delete-cart-modal').style.display = c ? 'inline-flex' : 'none'
  document.getElementById('cart-modal-overlay').style.display = 'flex'
  setTimeout(() => document.getElementById('cart-field-name').focus(), 80)
}

function closeCartModal() {
  document.getElementById('cart-modal-overlay').style.display = 'none'
  editingCartId = null
}

async function saveCartModal() {
  const name = document.getElementById('cart-field-name').value.trim()
  if (!name) { document.getElementById('cart-field-name').focus(); toastFn('Cart name is required'); return }

  const payload = {
    id:         editingCartId || genId(),
    name,
    assemblyId: document.getElementById('cart-field-assembly').value || null,
    notes:      document.getElementById('cart-field-notes').value.trim(),
    status:     'open',
  }

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

// ── Item modal ───────────────────────────────────────────────
// Simple ad hoc item entry — name, link, price, quantity, optional
// vendor. Doesn't try to resolve an existing part_number/component;
// that linkage happens automatically via the Designer "Add to cart"
// path (openAddToCartFromPart in designer.js), which passes a
// part_number_id directly. This modal covers manual/ad hoc purchases.
let itemModalCartId = null

export function openItemModal(cartId, itemId) {
  itemModalCartId = cartId
  editingItemId = itemId || null
  const item = itemId ? items.find(i => i.id === itemId) : null
  const pn = item?.partNumberId ? partNumberById(item.partNumberId) : null

  document.getElementById('item-modal-title').textContent = item ? 'Edit item' : 'Add item'
  document.getElementById('item-field-name').value     = pn ? (componentById(pn.componentId)?.fallbackName || pn.value) : (item?.nameOverride || '')
  document.getElementById('item-field-link').value      = pn?.purchaseLink || item?.linkOverride || ''
  document.getElementById('item-field-price').value     = pn?.purchasePrice ?? item?.priceOverride ?? ''
  document.getElementById('item-field-qty').value       = item?.quantity ?? 1
  document.getElementById('item-field-name').disabled   = !!pn
  document.getElementById('item-modal-hint').textContent = pn
    ? `Linked to vendor SKU "${pn.value}" — edit price/link from the component's Part Numbers instead.`
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

  // If this item is linked to a part number, only quantity/status are
  // editable here — name/link/price live on the part_numbers row.
  if (existing?.partNumberId) {
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
    id:            editingItemId || genId(),
    cartId:        itemModalCartId,
    partNumberId:  null,
    assemblyPartId: existing?.assemblyPartId || null,
    nameOverride:  name,
    linkOverride:  document.getElementById('item-field-link').value.trim(),
    priceOverride: document.getElementById('item-field-price').value ? parseFloat(document.getElementById('item-field-price').value) : null,
    quantity:      Math.max(1, parseInt(document.getElementById('item-field-qty').value, 10) || 1),
    status:        existing?.status || 'pending',
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
    if (editingCartId) { closeCartModal(); await handleDeleteCart(editingCartId) }
  })
  document.getElementById('cart-modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeCartModal()
  })

  document.getElementById('btn-close-item-modal').addEventListener('click', closeItemModal)
  document.getElementById('btn-cancel-item').addEventListener('click', closeItemModal)
  document.getElementById('btn-save-item-modal').addEventListener('click', saveItemModal)
  document.getElementById('item-modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeItemModal()
  })
}

// ── Refresh hook (call after part_numbers change elsewhere, e.g. from
//    the component view's "manage vendors" editor) ──────────────────
export async function refreshPartNumbers() {
  partNumbers = await fetchAllPartNumbers()
}