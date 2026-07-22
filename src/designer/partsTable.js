// src/designer/partsTable.js
//
// Everything about rendering a parts table (root assembly or subassembly
// node) and reacting to clicks on it: the row templates, the badge
// helpers, the add/edit part modal, delete, and the click-dispatch that
// routes a row's icon buttons to whichever other module owns that flow
// (inventory linking, Send to Fabricate, fab-detection review, cart).
//
// This module owns NO assembly/part state itself — it reads it and
// reports changes back through a context object registered by
// assemblyDetail.js, the same pattern fabDetection.js and
// onshapePicker.js already use. That keeps "how root vs. child parts are
// stored and re-rendered" entirely assemblyDetail.js's problem.

import { upsertAssemblyPart, deleteAssemblyPart, releaseInstances } from '../db.js'
import { genId, toast, computePartStatus, totalPromisedQty } from './state.js'
import { fabDetectionBadgeHTML, fabDetectActionable, openFabDetectConfirmModal } from './fabDetection.js'

/**
 * `ctx` is:
 *   getParts(isChild)                    -> current array (currentParts or currentChildParts)
 *   afterChange(isChild)                  -> persist array mutation + re-render (assemblyDetail.js
 *                                             decides whether that also means syncAssemblyStatus)
 *   getAssemblyIdForNewPart()             -> currentAssemblyId, for a brand-new root part's assembly_id
 *   onLinkInventory(partId, isChild)       -> open the inventory-link modal
 *   onViewLinked(partId, isChild)          -> toggle the inline linked-instances panel
 *   onSendToFabricate(partId, isChild)     -> open the Send to Fabricate modal
 *   onAddToCart(partId, isChild)           -> add remaining qty to a Part Orders cart
 */
let ctx = null
export function registerPartsTableContext(c) { ctx = c }

// ── Badges ────────────────────────────────────────────────────
export function fabJobBadgeHTML(job) {
  if (!job) return ''
  const label = {
    queued:      'Queued for fab',
    commited:    `Claimed${job.claimedBy ? ' by ' + job.claimedBy : ''}`,
    in_progress: `Machining ${job.quantityMachined}/${job.quantityRequested}`,
    complete:    'Fab complete',
  }[job.status] || job.status
  return `<span class="fab-job-badge fab-job-badge--${job.status}"title="Fabrication job: ${job.quantityRequested} requested">
    <i class="ti ti-tool" aria-hidden="true"></i> ${label}
    </span>`
}

export function orderBadgesHTML(orders) {
  if (!orders || !orders.length) return ''
  return orders.map(o => {
    const label = o.status === 'pending' ? `In cart (${o.quantity})` : `Ordered (${o.quantity})`
    return `<span class="fab-job-badge fab-job-badge--${o.status === 'pending' ? 'queued' : 'committed'}" title="Part order: ${o.quantity} pending arrival">
      <i class="ti ti-truck-delivery" aria-hidden="true"></i> ${label}
    </span>`
  }).join('')
}

// ── Row templates ────────────────────────────────────────────
export function partRowHTML(p, job = null, orders = []) {
  const status = computePartStatus(p)
  const statusBadge = {
    complete: '<span class="part-badge part-badge--complete">Complete</span>',
    partial:  '<span class="part-badge part-badge--partial">Partial</span>',
    pending:  '<span class="part-badge part-badge--pending">Pending</span>',
  }[status]

  const collectedQty = p.quantityCollected || 0
  const linkedPiles   = (p.linkedInstanceIds || []).length
  const linkedBadge = linkedPiles
    ? `<button class="inv-link-linked-badge" data-view-linked="${p.id}" type="button">
        <i class="ti ti-link" aria-hidden="true"></i> ${linkedPiles} linked
       </button>`
    : ''

  const promisedQty = totalPromisedQty(job, orders)
  const gapRemaining = p.quantityNeeded - collectedQty - promisedQty
  const canPromiseMore = gapRemaining > 0

  return `<tr data-part-id="${p.id}">
    <td>
      <div class="part-name-cell">
        <div>
          <div class="part-name">${p.partName}</div>
          ${p.notes ? `<div class="part-notes">${p.notes}</div>` : ''}
          ${fabJobBadgeHTML(job)}
          ${orderBadgesHTML(orders)}
        </div>
        <button class="btn-icon btn-link-inventory" data-part-link="${p.id}" aria-label="Link to inventory" title="Link to inventory component">
          <i class="ti ti-link" style="font-size:14px"></i>
        </button>
      </div>
    </td>
    <td>
      ${linkedBadge}
      <div class="inv-linked-detail" id="linked-detail-${p.id}" style="display:none"></div>
    </td>
    <td><span class="part-number">${p.partNumber || '—'}</span></td>
    <td style="text-align:center">${p.quantityNeeded}</td>
    <td style="text-align:center">
      <span class="qty-collected-readout">${collectedQty}${promisedQty ? ` <span class="qty-promised">+${promisedQty} promised</span>` : ''} / ${p.quantityNeeded}</span>
    </td>
    <td style="text-align:center">${statusBadge}</td>
    <td style="text-align:right">
      <button class="btn-icon" data-part-order="${p.id}" aria-label="Add to Part Orders cart" title="Add remaining quantity to a Part Orders cart"
        ${canPromiseMore ? '':'disabled'}>
        <i class="ti ti-shopping-cart-plus" style="font-size:13px"></i>
      </button>
      <button class="btn-icon" data-part-fab="${p.id}" aria-label="Send to Fabricate" title="${p.componentId ? 'Send remaining quantity to Fabricate' : 'Send to Fabricate — you\'ll be asked to identify the component first'}" ${canPromiseMore ? '' : 'disabled'}><i class="ti ti-tool" style="font-size:13px"></i></button>
      <button class="btn-icon" data-part-edit="${p.id}" aria-label="Edit"><i class="ti ti-edit" style="font-size:13px"></i></button>
      <button class="btn-icon" data-part-del="${p.id}" aria-label="Delete"><i class="ti ti-trash" style="font-size:13px"></i></button>
      ${fabDetectActionable(p) ? `<button class="btn-icon" data-part-fabdetect="${p.id}" aria-label="Review spacer detection" title="Review auto-detected fabrication candidate">     <i class="ti ti-scan" style="font-size:13px"></i></button>` : ''}
      </td>
  </tr>`
}

export function childPartRowHTML(p, job = null, orders = []) {
  const status = computePartStatus(p)
  const statusBadge = {
    complete: '<span class="part-badge part-badge--complete">Complete</span>',
    partial:  '<span class="part-badge part-badge--partial">Partial</span>',
    pending:  '<span class="part-badge part-badge--pending">Pending</span>',
  }[status]

  const collectedQty = p.quantityCollected || 0
  const linkedPiles   = (p.linkedInstanceIds || []).length
  const linkedBadge = linkedPiles
    ? `<button class="inv-link-linked-badge" data-view-linked="${p.id}" type="button">
        <i class="ti ti-link" aria-hidden="true"></i> ${linkedPiles} linked
       </button>`
    : ''

  const promisedQty = totalPromisedQty(job, orders)
  const gapRemaining = p.quantityNeeded - collectedQty - promisedQty
  const canPromiseMore = gapRemaining > 0

  return `<tr data-part-id="${p.id}">
    <td>
      <div class="part-name-cell">
        <div>
          <div class="part-name">${p.partName}</div>
          ${fabJobBadgeHTML(job)}
          ${orderBadgesHTML(orders)}
        </div>
        <button class="btn-icon btn-link-inventory" data-part-link="${p.id}" aria-label="Link to inventory" title="Link to inventory component">
          <i class="ti ti-link" style="font-size:14px"></i>
        </button>
      </div>
    </td>
    <td>
      ${linkedBadge}
      <div class="inv-linked-detail" id="linked-detail-${p.id}" style="display:none"></div>
    </td>
    <td><span class="part-number">${p.partNumber || '—'}</span></td>
    <td style="text-align:center">${p.quantityNeeded}</td>
    <td style="text-align:center">
      <span class="qty-collected-readout">${collectedQty}${promisedQty ? ` <span class="qty-promised">+${promisedQty} promised</span>` : ''} / ${p.quantityNeeded}</span>
    </td>
    <td style="text-align:center">${statusBadge}</td>
    <td style="text-align:right">
      <button class="btn-icon" data-child-part-order="${p.id}" aria-label="Add to Part Orders cart" title="Add remaining quantity to a Part Orders cart"
        ${canPromiseMore ? '' : 'disabled'}>
          <i class="ti ti-shopping-cart-plus" style="font-size:13px"></i>
      </button>
      <button class="btn-icon" data-child-part-fab="${p.id}" aria-label="Send to Fabricate" title="${p.componentId ? 'Send remaining quantity to Fabricate' : 'Send to Fabricate — you\'ll be asked to identify the component first'}" ${canPromiseMore ? '' : 'disabled'}><i class="ti ti-tool" style="font-size:13px"></i></button>
      <button class="btn-icon" data-child-part-edit="${p.id}" aria-label="Edit"><i class="ti ti-edit" style="font-size:13px"></i></button>
      <button class="btn-icon" data-child-part-del="${p.id}" aria-label="Delete"><i class="ti ti-trash" style="font-size:13px"></i></button>
      ${fabDetectActionable(p) ? `<button class="btn-icon" data-child-part-fabdetect="${p.id}" aria-label="Review spacer detection" title="Review auto-detected fabrication candidate"><i class="ti ti-scan" style="font-size:13px"></i></button>` : ''}
      </td>
  </tr>`
}

// ── Row click dispatch ────────────────────────────────────────
// One binder handles both root ('parts-tbody') and child
// ('child-parts-tbody') tables — the only difference is which dataset
// keys are used (data-part-* vs data-child-part-*) and the isChild flag
// threaded through to ctx.
export function bindPartRowEvents() {
  const tbody = document.getElementById('parts-tbody')
  if (!tbody) return

  tbody.addEventListener('click', async e => {
    const linkBtn = e.target.closest('[data-part-link]')
    if (linkBtn) { ctx.onLinkInventory(linkBtn.dataset.partLink, false); return }

    const viewLinkedBtn = e.target.closest('[data-view-linked]')
    if (viewLinkedBtn) { await ctx.onViewLinked(viewLinkedBtn.dataset.viewLinked, false); return }

    const editBtn = e.target.closest('[data-part-edit]')
    if (editBtn) { openPartModal(editBtn.dataset.partEdit, false); return }

    const delBtn = e.target.closest('[data-part-del]')
    if (delBtn) { await deletePart(delBtn.dataset.partDel); return }

    const fabBtn = e.target.closest('[data-part-fab]')
    if (fabBtn) { ctx.onSendToFabricate(fabBtn.dataset.partFab, false); return }

    const fabDetectBtn = e.target.closest('[data-part-fabdetect]')
    if (fabDetectBtn) { openFabDetectConfirmModal(fabDetectBtn.dataset.partFabdetect, false); return }

    const orderBtn = e.target.closest('[data-part-order]')
    if (orderBtn) { await ctx.onAddToCart(orderBtn.dataset.partOrder, false); return }
  })
}

export function bindChildPartRowEvents() {
  const tbody = document.getElementById('child-parts-tbody')
  if (!tbody) return

  tbody.addEventListener('click', async e => {
    const linkBtn = e.target.closest('[data-part-link]')
    const viewLinkedBtn = e.target.closest('[data-view-linked]')
    const delBtn = e.target.closest('[data-child-part-del]')
    const editBtn = e.target.closest('[data-child-part-edit]')
    const fabBtn = e.target.closest('[data-child-part-fab]')
    const fabDetectBtn = e.target.closest('[data-child-part-fabdetect]')
    const orderBtn = e.target.closest('[data-child-part-order]')

    if (fabDetectBtn) { openFabDetectConfirmModal(fabDetectBtn.dataset.childPartFabdetect, true); return }
    if (linkBtn) { ctx.onLinkInventory(linkBtn.dataset.partLink, true); return }
    if (viewLinkedBtn) { await ctx.onViewLinked(viewLinkedBtn.dataset.viewLinked, true); return }
    if (delBtn) { await deleteChildPart(delBtn.dataset.childPartDel); return }
    if (fabBtn) { ctx.onSendToFabricate(fabBtn.dataset.childPartFab, true); return }
    if (orderBtn) { await ctx.onAddToCart(orderBtn.dataset.childPartOrder, true); return }
    if (editBtn) { openPartModal(editBtn.dataset.childPartEdit, true); return }
  })
}

// ── Delete ────────────────────────────────────────────────────
async function deletePart(partId) {
  const part = ctx.getParts(false).find(p => p.id === partId)
  if (!part || !confirm(`Remove "${part.partName}" from this assembly?`)) return
  try {
    if (part.linkedInstanceIds?.length) await releaseInstances(part.linkedInstanceIds)
    await deleteAssemblyPart(partId)
    ctx.setParts?.(ctx.getParts(false).filter(p => p.id !== partId), false)
    await ctx.afterChange(false)
    toast('Part removed')
  } catch (e) { console.error(e); toast('Error removing part') }
}

async function deleteChildPart(partId) {
  const part = ctx.getParts(true).find(p => p.id === partId)
  if (!part || !confirm(`Remove "${part.partName}" from this subassembly?`)) return
  try {
    if (part.linkedInstanceIds?.length) await releaseInstances(part.linkedInstanceIds)
    await deleteAssemblyPart(partId)
    ctx.setParts?.(ctx.getParts(true).filter(p => p.id !== partId), true)
    await ctx.afterChange(true)
    toast('Part removed')
  } catch (e) { console.error(e); toast('Error removing part') }
}

// ── Add / edit part modal ────────────────────────────────────
let editingPartId = null
let editingIsChildPart = false

export function openPartModal(id, isChildPart = false) {
  editingPartId = id || null
  editingIsChildPart = isChildPart
  const p = ctx.getParts(isChildPart).find(p => p.id === editingPartId)
  if (id && !p) return

  document.getElementById('part-modal-title').textContent = p ? 'Edit part' : 'Add part'
  document.getElementById('part-field-name').value        = p?.partName || ''
  document.getElementById('part-field-number').value      = p?.partNumber || ''
  document.getElementById('part-field-qty').value         = p?.quantityNeeded ?? 1
  document.getElementById('part-field-notes').value       = p?.notes || ''
  document.getElementById('part-modal-overlay').style.display = 'flex'
  setTimeout(() => document.getElementById('part-field-name').focus(), 80)
}

function closePartModal() {
  document.getElementById('part-modal-overlay').style.display = 'none'
  editingPartId = null
}

async function savePart() {
  const partName = document.getElementById('part-field-name').value.trim()
  if (!partName) { document.getElementById('part-field-name').focus(); toast('Part name is required'); return }

  const saveBtn = document.getElementById('btn-save-part')
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…'

  const isChildPart = editingIsChildPart
  const parts = ctx.getParts(isChildPart)
  const existing = editingPartId ? parts.find(p => p.id === editingPartId) : null

  const payload = {
    id:                editingPartId || genId(),
    assemblyId:        isChildPart ? null : ctx.getAssemblyIdForNewPart(),
    assemblyChildId:   isChildPart ? existing?.assemblyChildId : undefined,
    partName,
    partNumber:        document.getElementById('part-field-number').value.trim(),
    quantityNeeded:    parseInt(document.getElementById('part-field-qty').value, 10) || 1,
    quantityCollected: existing?.quantityCollected ?? 0,
    notes:             document.getElementById('part-field-notes').value.trim(),
    source:            existing?.source || 'manual',
    onshapeReference:  existing?.onshapeReference || null,
    linkedInstanceIds: existing?.linkedInstanceIds || [],
    componentId:       existing?.componentId || null,
  }
  payload.status = computePartStatus(payload)

  try {
    const saved = await upsertAssemblyPart(payload)
    const idx = parts.findIndex(p => p.id === (editingPartId || saved.id))
    const newParts = editingPartId
      ? parts.map(p => p.id === editingPartId ? saved : p)
      : [...parts, saved]
    ctx.setParts?.(newParts, isChildPart)
    await ctx.afterChange(isChildPart)
    closePartModal()
    toast(editingPartId ? 'Part updated' : 'Part added')
  } catch (e) {
    console.error(e)
    toast('Error saving part')
  } finally {
    saveBtn.disabled = false
    saveBtn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i> Save'
  }
}

// ── Toolbar fragments (rendered inline by assemblyDetail.js) ────
export function fabFilterSelectHTML(currentFilter) {
  const opts = [
    ['all', 'All parts'],
    ['detected', 'Detected'],
    ['needs_review', 'Needs review'],
    ['queued', 'Queued for fab'],
    ['ignored', 'Ignored'],
  ]
  return `<select id="fab-filter-select" style="font-size:12px;padding:4px 8px;border-radius:var(--border-radius-md);border:0.5px solid var(--color-border-secondary);background:var(--color-background-primary);color:var(--color-text-primary)">
    ${opts.map(([v, l]) => `<option value="${v}"${currentFilter === v ? ' selected' : ''}>${l}</option>`).join('')}
  </select>`
}

export function partSearchToolbarHTML(query, partNumberOnly) {
  return `
    <div class="onshape-search-row" style="margin:0;max-width:220px">
      <i class="ti ti-search" aria-hidden="true"></i>
      <input type="text" id="part-search-input" placeholder="Search parts…" value="${query}">
    </div>
    <label class="fab-history-toggle">
      <input type="checkbox" id="chk-part-number-only" ${partNumberOnly ? 'checked' : ''}>
      <span>Has part #</span>
    </label>`
}

// ── Static event bindings ────────────────────────────────────────
export function bindPartsTableEvents() {
  document.getElementById('btn-close-part-modal').addEventListener('click', closePartModal)
  document.getElementById('btn-cancel-part').addEventListener('click', closePartModal)
  document.getElementById('btn-save-part').addEventListener('click', savePart)
  document.getElementById('part-modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closePartModal()
  })
}