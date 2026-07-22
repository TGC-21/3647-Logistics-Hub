// src/designer/partOrdersCart.js
//
// Row-level "add to Part Orders cart" action plus the three small modals
// it can trigger: search all existing listings, add a brand-new listing
// (with or without a known part number), and pick between 2+ listings
// for the same part number. Barely touches assembly state — this is
// really an extension of partOrders.js's domain entered from a part row.

import {
  ensurePartNumberStub, fetchListingsForPartNumber, upsertVendorListing,
  findOrCreateCartForVendor, upsertCartItem, fetchAllPartNumbersWithListings,
} from '../db.js'
import { genId, toast } from './state.js'
import {
  registerNewCartItem, registerNewCart, registerNewVendor, getVendors,
} from '../partOrders.js'

/**
 * `ctx` is:
 *   getPart(partId, isChild) -> part object
 */
let ctx = null
export function registerPartOrdersCartContext(c) { ctx = c }

let cartLinkPartId = null
let cartLinkIsChild = false
let cartLinkPartNumber = null
let cartLinkListings = []
let listingSearchAll = null

export async function addPartToCart(partId, isChildPart = false) {
  const part = ctx.getPart(partId, isChildPart)
  if (!part) return

  const rawPartNumber = part.onshapeReference?.partNumber || part.partNumber

  if (!rawPartNumber) {
    cartLinkPartId = partId
    cartLinkIsChild = isChildPart
    await openListingSearchModal(part.partName)
    return
  }

  cartLinkPartId = partId
  cartLinkIsChild = isChildPart
  try {
    cartLinkPartNumber = await ensurePartNumberStub(rawPartNumber, genId)
    cartLinkListings = await fetchListingsForPartNumber(cartLinkPartNumber.id)
  } catch (e) { console.error(e); toast('Error resolving part number'); return }

  if (cartLinkListings.length === 1) { await addToCartWithListing(cartLinkListings[0]); return }
  if (cartLinkListings.length === 0) { openNewListingModal(rawPartNumber); return }
  openListingPickerModal()
}

// ── "Search all existing listings" (no known part number) ─────────
async function openListingSearchModal(partName) {
  document.getElementById('listing-search-subtitle').textContent = `For: ${partName}`
  document.getElementById('listing-search-input').value = ''
  document.getElementById('listing-search-overlay').style.display = 'flex'
  document.getElementById('btn-listing-search-new').onclick = () => {
    document.getElementById('listing-search-overlay').style.display = 'none'
    openAdhocListingModal()
  }

  if (!listingSearchAll) {
    try { listingSearchAll = await fetchAllPartNumbersWithListings() }
    catch (e) { console.error(e); toast('Error loading listings'); listingSearchAll = [] }
  }
  renderListingSearchResults('')
  setTimeout(() => document.getElementById('listing-search-input').focus(), 60)
}

function renderListingSearchResults(query) {
  const q = query.trim().toLowerCase()
  const results = (listingSearchAll || []).filter(r =>
    !q || r.partNumber.value.toLowerCase().includes(q)
       || (r.vendor?.name || '').toLowerCase().includes(q)
       || (r.component?.fallbackName || '').toLowerCase().includes(q)
  ).slice(0, 40)

  const el = document.getElementById('listing-search-results')
  el.innerHTML = results.length
    ? results.map(r => `<div class="onshape-list-item" data-pick-search-listing="${r.listing.id}">
        <div class="onshape-list-item-icon"><i class="ti ti-building-store" aria-hidden="true"></i></div>
        <div class="onshape-list-item-text">
          <div class="onshape-list-item-name">${r.component?.fallbackName || r.partNumber.value}</div>
          <div class="onshape-list-item-meta">${r.partNumber.value} · ${r.vendor?.name || '?'}${r.listing.purchasePrice != null ? ' · $' + r.listing.purchasePrice.toFixed(2) : ''}</div>
        </div>
        <i class="ti ti-chevron-right" aria-hidden="true"></i>
      </div>`).join('')
    : `<div class="onshape-state" style="padding:24px 0"><i class="ti ti-search-off" aria-hidden="true"></i><div class="onshape-state-title">No matches</div></div>`

  el.querySelectorAll('[data-pick-search-listing]').forEach(item =>
    item.addEventListener('click', async () => {
      const found = listingSearchAll.find(r => r.listing.id === item.dataset.pickSearchListing)
      document.getElementById('listing-search-overlay').style.display = 'none'
      if (found) await addToCartWithListing(found.listing)
    })
  )
}

// Ad hoc: user picked "no match" — collect a new part number string +
// vendor listing together.
function openAdhocListingModal() {
  document.getElementById('listing-modal-hint').textContent = 'Enter the part number and vendor details for this item.'
  document.getElementById('listing-field-link').value = ''
  document.getElementById('listing-field-price').value = ''
  populateListingVendorSelect('')
  const skuField = ensureAdhocSkuField()
  skuField.value = ''
  document.getElementById('new-listing-modal-overlay').style.display = 'flex'
}
function ensureAdhocSkuField() {
  let el = document.getElementById('listing-field-sku')
  if (!el) {
    el = document.createElement('input')
    el.type = 'text'; el.id = 'listing-field-sku'; el.placeholder = 'Part number / SKU'
    document.querySelector('#new-listing-modal-overlay .modal-body').prepend(el)
  }
  el.style.display = ''
  return el
}

async function addToCartWithListing(listing) {
  const part = ctx.getPart(cartLinkPartId, cartLinkIsChild)
  if (!part) return

  try {
    const vendor = getVendors().find(v => v.id === listing.vendorId)
    const cart = await findOrCreateCartForVendor(listing.vendorId, vendor?.name || 'Vendor', genId)
    const item = await upsertCartItem({
      id: genId(), cartId: cart.id,
      vendorListingId: listing.id,
      assemblyPartId: part.id,
      nameOverride: part.partName,
      quantity: Math.max(1, part.quantityNeeded - (part.quantityCollected || 0)) || 1,
      status: 'pending',
    })
    registerNewCart(cart)
    registerNewCartItem(item)
    toast(`Added "${part.partName}" to cart "${cart.name}"`)
  } catch (e) { console.error(e); toast('Error adding to cart') }
}

// ── "No listings yet" — one-click add-vendor-listing modal ────────
function openNewListingModal(prefillSku) {
  populateListingVendorSelect('')
  document.getElementById('listing-field-link').value = ''
  document.getElementById('listing-field-price').value = ''
  document.getElementById('listing-modal-hint').textContent =
    `No vendor listing exists yet for "${cartLinkPartNumber.value}" — add the vendor, link, and price.`
  document.getElementById('new-listing-modal-overlay').style.display = 'flex'
}

function populateListingVendorSelect(selectedId) {
  const sel = document.getElementById('listing-field-vendor')
  sel.innerHTML = '<option value="">— Select or create vendor —</option>' +
    getVendors().map(v => `<option value="${v.id}"${v.id === selectedId ? ' selected' : ''}>${v.name}</option>`).join('')
}

async function confirmNewListing() {
  const vendorSel = document.getElementById('listing-field-vendor').value
  const newVendorName = document.getElementById('listing-new-vendor-input').value.trim()
  const link = document.getElementById('listing-field-link').value.trim()
  const price = document.getElementById('listing-field-price').value
  const skuField = document.getElementById('listing-field-sku')

  if (!vendorSel && !newVendorName) { toast('Select or enter a vendor'); return }

  try {
    // findOrCreateVendor imported lazily to avoid a hard dependency on
    // db.js's vendor helpers for the (common) path where the vendor
    // already exists and is picked from the select.
    const { findOrCreateVendor } = await import('../db.js')
    const vendor = vendorSel ? getVendors().find(v => v.id === vendorSel) : await findOrCreateVendor(newVendorName, genId)
    if (!vendorSel) registerNewVendor(vendor)

    let partNumber = cartLinkPartNumber
    if (!partNumber) {
      const sku = skuField?.value.trim()
      if (!sku) { toast('Enter a part number'); return }
      partNumber = await ensurePartNumberStub(sku, genId)
    }

    const listing = await upsertVendorListing({
      id: genId(), partNumberId: partNumber.id, vendorId: vendor.id,
      purchaseLink: link, purchasePrice: price ? parseFloat(price) : null, isPreferred: true,
    })
    document.getElementById('new-listing-modal-overlay').style.display = 'none'
    if (skuField) skuField.style.display = 'none'
    await addToCartWithListing(listing)
  } catch (e) { console.error(e); toast('Error creating vendor listing') }
}

// ── 2+ listings — picker ────────────────────────────────────
function openListingPickerModal() {
  const list = document.getElementById('listing-picker-list')
  list.innerHTML = cartLinkListings.map(l => {
    const vendor = getVendors().find(v => v.id === l.vendorId)
    return `<div class="onshape-list-item" data-pick-listing="${l.id}">
      <div class="onshape-list-item-icon"><i class="ti ti-building-store" aria-hidden="true"></i></div>
      <div class="onshape-list-item-text">
        <div class="onshape-list-item-name">${vendor?.name || 'Unknown vendor'}</div>
        <div class="onshape-list-item-meta">${l.purchaseLink ? l.purchaseLink : 'No link set'}${l.purchasePrice != null ? ' · $' + l.purchasePrice.toFixed(2) : ''}</div>
      </div>
      <i class="ti ti-chevron-right" aria-hidden="true"></i>
    </div>`
  }).join('') + `<div class="onshape-list-item" data-pick-listing="__new__">
      <div class="onshape-list-item-icon"><i class="ti ti-plus" aria-hidden="true"></i></div>
      <div class="onshape-list-item-text"><div class="onshape-list-item-name">Add another vendor</div></div>
    </div>`

  list.querySelectorAll('[data-pick-listing]').forEach(el =>
    el.addEventListener('click', () => {
      document.getElementById('listing-picker-overlay').style.display = 'none'
      if (el.dataset.pickListing === '__new__') { openNewListingModal(cartLinkPartNumber.value); return }
      const listing = cartLinkListings.find(l => l.id === el.dataset.pickListing)
      if (listing) addToCartWithListing(listing)
    })
  )
  document.getElementById('listing-picker-overlay').style.display = 'flex'
}

// ── Static event bindings ────────────────────────────────────────
export function bindPartOrdersCartEvents() {
  document.getElementById('btn-close-new-listing').addEventListener('click', () => document.getElementById('new-listing-modal-overlay').style.display = 'none')
  document.getElementById('btn-cancel-new-listing').addEventListener('click', () => document.getElementById('new-listing-modal-overlay').style.display = 'none')
  document.getElementById('btn-confirm-new-listing').addEventListener('click', confirmNewListing)
  document.getElementById('btn-close-listing-picker').addEventListener('click', () => document.getElementById('listing-picker-overlay').style.display = 'none')
  document.getElementById('btn-cancel-listing-picker').addEventListener('click', () => document.getElementById('listing-picker-overlay').style.display = 'none')
  document.getElementById('btn-close-listing-search').addEventListener('click', () => document.getElementById('listing-search-overlay').style.display = 'none')
  document.getElementById('btn-cancel-listing-search').addEventListener('click', () => document.getElementById('listing-search-overlay').style.display = 'none')

  let listingSearchTimer
  document.getElementById('listing-search-input').addEventListener('input', e => {
    clearTimeout(listingSearchTimer)
    listingSearchTimer = setTimeout(() => renderListingSearchResults(e.target.value), 150)
  })
}