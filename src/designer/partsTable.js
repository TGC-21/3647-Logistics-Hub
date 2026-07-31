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
//
// ── Multi-select + carousel (new) ───────────────────────────────
// Row checkboxes feed a Set<partId> (state.js's selectedPartIds, scoped
// to whichever table is on screen — see state.js's comment on
// clearPartSelection). Once >0 rows are selected, a small toolbar above
// the table offers Edit / Send to Fabricate / Review detected / Clear.
//
//   • Exactly one row selected  → the bulk action is IDENTICAL to
//     clicking that row's own icon button (calls the same single-part
//     opener directly, zero behavior change from before).
//   • More than one row selected → opens the SAME single-part modal
//     used above, but wrapped by a slim carousel nav bar (#carousel-
//     nav-bar, static markup in index.html) that steps through the
//     selected parts one at a time. Rows the action doesn't apply to
//     (e.g. "Send to Fabricate" on a part that's already fully
//     collected/promised) still show in the carousel, but dimmed with
//     a banner and their primary action button disabled — see
//     KIND_MODAL_CONFIG / setCarouselIneligibleState below.
//
// Advancing (Next/Prev) or closing the carousel auto-commits whatever
// the currently-visible step can commit:
//   • Edit          → calls the same savePart() the modal's own Save
//                      button calls.
//   • Review detect → calls the same confirmFabDetection() the modal's
//                      own Confirm button calls.
//   • Send to Fab   → deliberately NOT auto-submitted — that flow can
//                      have its own unresolved sub-steps (search/create
//                      a component). If no job exists for the part by
//                      the time the user moves on, whatever partial
//                      progress they made (e.g. a linked component)
//                      stays as-is, and a toast explains nothing was
//                      sent to Fabricate for that part.
// Either way, navigation itself is never blocked — per product
// direction, users can move freely through the carousel regardless of
// whether the current step is "complete."

import {
  toast, computePartStatus, totalPromisedQty, partCanPromiseMore,
  getSelectedPartIds, setSelectedPartIds, clearPartSelection,
  isPartSelected, togglePartSelected, setPartsSelected,
  getCurrentPartJobs, getCurrentChildPartJobs,
  getCurrentPartOrders, getCurrentChildPartOrders,
  partRowVisible,
} from './state.js'
import {
  fabDetectionBadgeHTML, fabDetectActionable, openFabDetectConfirmModal,
  confirmFabDetection,
} from './fabDetection.js'
import { createAssemblyPart, updateAssemblyPart, deleteAssemblyPart } from '../services/assemblyPartsApi.js'
import { getCurrentMemberId } from '../members.js'

import { fetchEntityHistory, fetchCascadeChildren } from '../changeLog.js'
import { openHistoryModal } from '../historyPanel.js'


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
  const checked = isPartSelected(p.id) ? ' checked' : ''

  return `<tr data-part-id="${p.id}">
    <td class="select-col"><input type="checkbox" data-part-select="${p.id}" aria-label="Select ${p.partName}"${checked}></td>
    <td>
      <div class="part-name-cell">
        <div>
          <div class="part-name">${p.partName}</div>
          ${p.notes ? `<div class="part-notes">${p.notes}</div>` : ''}
          ${fabJobBadgeHTML(job)}
          ${orderBadgesHTML(orders)}
          ${fabDetectionBadgeHTML(p)}
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
      <button class="btn-icon" data-part-history="${p.id}" aria-label="History" title="View change history"><i class="ti ti-history" style="font-size:13px"></i></button>
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
  const checked = isPartSelected(p.id) ? ' checked' : ''

  return `<tr data-part-id="${p.id}">
    <td class="select-col"><input type="checkbox" data-part-select="${p.id}" aria-label="Select ${p.partName}"${checked}></td>
    <td>
      <div class="part-name-cell">
        <div>
          <div class="part-name">${p.partName}</div>
          ${fabJobBadgeHTML(job)}
          ${orderBadgesHTML(orders)}
          ${fabDetectionBadgeHTML(p)}
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
      <button class="btn-icon" data-child-part-history="${p.id}" aria-label="History" title="View change history"><i class="ti ti-history" style="font-size:13px"></i></button>
      <button class="btn-icon" data-child-part-del="${p.id}" aria-label="Delete"><i class="ti ti-trash" style="font-size:13px"></i></button>
      ${fabDetectActionable(p) ? `<button class="btn-icon" data-child-part-fabdetect="${p.id}" aria-label="Review spacer detection" title="Review auto-detected fabrication candidate"><i class="ti ti-scan" style="font-size:13px"></i></button>` : ''}
      </td>
  </tr>`
}

// ── Selection toolbar ────────────────────────────────────────
// Rendered by assemblyDetail.js above the parts table whenever
// selection.size > 0; empty string (renders nothing) otherwise.
export function selectionToolbarHTML(isChild) {
  const ids = [...getSelectedPartIds()]
  if (!ids.length) return ''

  const parts = ids.map(id => ctx.getParts(isChild).find(p => p.id === id)).filter(Boolean)
  const anyFabricate = parts.some(p => eligibleForKind('fabricate', p, isChild))
  const anyReview    = parts.some(p => eligibleForKind('fabdetect', p, isChild))

  return `<div class="selection-toolbar" id="selection-toolbar">
    <span class="selection-toolbar-count"><i class="ti ti-checks" aria-hidden="true"></i> ${ids.length} selected</span>
    <div style="flex:1"></div>
    <button class="btn btn-sm" id="btn-bulk-edit"><i class="ti ti-edit" aria-hidden="true"></i> Edit</button>
    <button class="btn btn-sm" id="btn-bulk-fabricate" ${anyFabricate ? '' : 'disabled'}><i class="ti ti-tool" aria-hidden="true"></i> Send to Fabricate</button>
    <button class="btn btn-sm" id="btn-bulk-review" ${anyReview ? '' : 'disabled'}><i class="ti ti-scan" aria-hidden="true"></i> Review detected</button>
    <button class="btn btn-sm" id="btn-bulk-clear"><i class="ti ti-x" aria-hidden="true"></i> Clear</button>
  </div>`
}

/** Bind the selection toolbar's buttons — call after every render that
 *  inserts selectionToolbarHTML() into the DOM (it's rebuilt every time,
 *  so no duplicate-listener risk). No-ops harmlessly if the toolbar
 *  isn't present (selection empty). */
export function bindSelectionToolbarEvents(isChild) {
  document.getElementById('btn-bulk-edit')?.addEventListener('click', () => startBulkAction('edit', isChild))
  document.getElementById('btn-bulk-fabricate')?.addEventListener('click', () => startBulkAction('fabricate', isChild))
  document.getElementById('btn-bulk-review')?.addEventListener('click', () => startBulkAction('fabdetect', isChild))
  document.getElementById('btn-bulk-clear')?.addEventListener('click', () => {
    clearPartSelection()
    ctx.afterChange(isChild)
  })
}

/** Bind the table header's "select all visible" checkbox. Call once per
 *  FULL table render (thead is rebuilt then) — do NOT call this from a
 *  tbody-only refresh, or the still-alive header checkbox picks up a
 *  second stacked listener. */
export function bindPartsTableHeaderEvents(isChild) {
  const headerCheckbox = document.getElementById(isChild ? 'select-all-child-parts' : 'select-all-parts')
  if (!headerCheckbox) return
  headerCheckbox.addEventListener('change', () => {
    const visibleIds = ctx.getParts(isChild).filter(partRowVisible).map(p => p.id)
    setPartsSelected(visibleIds, headerCheckbox.checked)
    ctx.afterChange(isChild)
  })
}

// ── Row click dispatch ────────────────────────────────────────
// One binder handles both root ('parts-tbody') and child
// ('child-parts-tbody') tables — the only difference is which dataset
// keys are used (data-part-* vs data-child-part-*) and the isChild flag
// threaded through to ctx.
export function bindPartRowEvents() {
  const tbody = document.getElementById('parts-tbody')
  if (!tbody) return

  tbody.addEventListener('change', e => {
    const cb = e.target.closest('[data-part-select]')
    if (cb) { togglePartSelected(cb.dataset.partSelect); ctx.afterChange(false); return }
  })

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

    const historyBtn = e.target.closest('[data-part-history]')
    if (historyBtn) { openHistoryModal('assembly-part', historyBtn.dataset.partHistory, null); return }
  })
}

export function bindChildPartRowEvents() {
  const tbody = document.getElementById('child-parts-tbody')
  if (!tbody) return

  tbody.addEventListener('change', e => {
    const cb = e.target.closest('[data-part-select]')
    if (cb) { togglePartSelected(cb.dataset.partSelect); ctx.afterChange(true); return }
  })

  tbody.addEventListener('click', async e => {
    const linkBtn = e.target.closest('[data-part-link]')
    const viewLinkedBtn = e.target.closest('[data-view-linked]')
    const delBtn = e.target.closest('[data-child-part-del]')
    const editBtn = e.target.closest('[data-child-part-edit]')
    const fabBtn = e.target.closest('[data-child-part-fab]')
    const fabDetectBtn = e.target.closest('[data-child-part-fabdetect]')
    const orderBtn = e.target.closest('[data-child-part-order]')
    const historyBtn = e.target.closest('[data-child-part-history')

    if (fabDetectBtn) { openFabDetectConfirmModal(fabDetectBtn.dataset.childPartFabdetect, true); return }
    if (linkBtn) { ctx.onLinkInventory(linkBtn.dataset.partLink, true); return }
    if (viewLinkedBtn) { await ctx.onViewLinked(viewLinkedBtn.dataset.viewLinked, true); return }
    if (delBtn) { await deleteChildPart(delBtn.dataset.childPartDel); return }
    if (fabBtn) { ctx.onSendToFabricate(fabBtn.dataset.childPartFab, true); return }
    if (orderBtn) { await ctx.onAddToCart(orderBtn.dataset.childPartOrder, true); return }
    if (editBtn) { openPartModal(editBtn.dataset.childPartEdit, true); return }
    if (historyBtn) { openHistoryModal('assembly_part', historyBtn.dataset.childPartHistory, null); return }
  })
}

// ── Delete ────────────────────────────────────────────────────
async function deletePart(partId) {
  const part = ctx.getParts(false).find(p => p.id === partId)
  if (!part || !confirm(`Remove "${part.partName}" from this assembly?`)) return
  try {
    // deleteAssemblyPart now releases any reserved inventory AND
    // deletes the row server-side, in that order — no separate
    // releaseInstances call needed here anymore.
    await deleteAssemblyPart({ partId, actorId: getCurrentMemberId() })
    ctx.setParts?.(ctx.getParts(false).filter(p => p.id !== partId), false)
    if (isPartSelected(partId)) togglePartSelected(partId)
    await ctx.afterChange(false)
    toast('Part removed')
  } catch (e) { console.error(e); toast('Error removing part') }
}

async function deleteChildPart(partId) {
  const part = ctx.getParts(true).find(p => p.id === partId)
  if (!part || !confirm(`Remove "${part.partName}" from this subassembly?`)) return
  try {
    await deleteAssemblyPart({ partId, actorId: getCurrentMemberId() })
    ctx.setParts?.(ctx.getParts(true).filter(p => p.id !== partId), true)
    if (isPartSelected(partId)) togglePartSelected(partId)
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

  const partNumber     = document.getElementById('part-field-number').value.trim()
  const quantityNeeded = parseInt(document.getElementById('part-field-qty').value, 10) || 1
  const notes          = document.getElementById('part-field-notes').value.trim()
  const actorId         = getCurrentMemberId()

  try {
    // Editing only ever happens for an existing row (root or child) —
    // creation only ever happens for a root part (there's no "Add part"
    // entry point inside a subassembly's own table), so `existing` being
    // null always means "new root part" here.
    const saved = editingPartId
      ? await updateAssemblyPart({ partId: editingPartId, partName, partNumber, quantityNeeded, notes, actorId })
      : await createAssemblyPart({ assemblyId: ctx.getAssemblyIdForNewPart(), partName, partNumber, quantityNeeded, notes, actorId })

    const newParts = editingPartId
      ? parts.map(p => p.id === editingPartId ? saved : p)
      : [...parts, saved]
    ctx.setParts?.(newParts, isChildPart)
    await ctx.afterChange(isChildPart)
    closePartModal()
    toast(editingPartId ? 'Part updated' : 'Part added')
  } catch (e) {
    console.error(e)
    toast(e.message || 'Error saving part')
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

// ══════════════════════════════════════════════════════════════════
// ── Bulk actions / carousel driver ──────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Per-kind DOM wiring the carousel needs to know about: which overlay
// hosts that action's single-part modal, and which button(s) are its
// "commit" action — disabled (not hidden — still visible so the person
// can see what a normal step looks like) when the currently-shown part
// isn't eligible for this bulk action.
const KIND_MODAL_CONFIG = {
  edit:      { overlayId: 'part-modal-overlay',           primaryBtnIds: ['btn-save-part'] },
  fabricate: { overlayId: 'fab-job-modal-overlay',         primaryBtnIds: ['btn-fab-create-component-confirm', 'btn-confirm-fab-job'] },
  fabdetect: { overlayId: 'fab-detect-confirm-overlay',    primaryBtnIds: ['btn-confirm-fab-detect'] },
}

function eligibleForKind(kind, part, isChild) {
  if (!part) return false
  if (kind === 'edit') return true
  if (kind === 'fabricate') {
    const job    = (isChild ? getCurrentChildPartJobs()   : getCurrentPartJobs())[part.id]   || null
    const orders = (isChild ? getCurrentChildPartOrders() : getCurrentPartOrders())[part.id] || []
    return partCanPromiseMore(part, job, orders)
  }
  if (kind === 'fabdetect') return fabDetectActionable(part)
  return false
}

/** Opens the existing single-part modal for one id, exactly as if its
 *  own row icon had been clicked — no carousel-specific behavior here,
 *  that's layered on top by openCarouselStep(). */
function openSingleForKind(kind, id, isChild) {
  if (kind === 'edit')      openPartModal(id, isChild)
  if (kind === 'fabricate') ctx.onSendToFabricate(id, isChild)
  if (kind === 'fabdetect') openFabDetectConfirmModal(id, isChild)
}

// ── Carousel state ───────────────────────────────────────────
let carouselKind     = null    // 'edit' | 'fabricate' | 'fabdetect' | null when inactive
let carouselIds      = []
let carouselIndex    = 0
let carouselIsChild  = false

function startBulkAction(kind, isChild) {
  const ids = [...getSelectedPartIds()].filter(id => ctx.getParts(isChild).some(p => p.id === id))
  if (!ids.length) return

  if (ids.length === 1) {
    openSingleForKind(kind, ids[0], isChild)
    return
  }

  carouselKind    = kind
  carouselIds     = ids
  carouselIndex   = 0
  carouselIsChild = isChild
  showCarouselBar()
  bindCarouselBarEventsOnce()
  openCarouselStep()
}

function openCarouselStep() {
  if (!carouselIds.length) { endCarousel(); return }
  if (carouselIndex < 0) carouselIndex = 0
  if (carouselIndex >= carouselIds.length) carouselIndex = carouselIds.length - 1

  const id   = carouselIds[carouselIndex]
  const part = ctx.getParts(carouselIsChild).find(p => p.id === id)

  if (!part) {
    // Part vanished mid-session (e.g. deleted from another tab) — drop
    // it from the carousel and try the same index again.
    carouselIds.splice(carouselIndex, 1)
    openCarouselStep()
    return
  }

  openSingleForKind(carouselKind, id, carouselIsChild)
  const eligible = eligibleForKind(carouselKind, part, carouselIsChild)
  setCarouselIneligibleState(carouselKind, !eligible)
  updateCarouselBar(part)
}

/** Best-effort "auto-save on advance" for whatever step is currently
 *  showing. Never blocks navigation — see the module doc comment for
 *  why Send to Fabricate is deliberately excluded from auto-submit. */
async function commitCurrentCarouselStep() {
  const id   = carouselIds[carouselIndex]
  const part = ctx.getParts(carouselIsChild).find(p => p.id === id)
  if (!part) return

  const eligible = eligibleForKind(carouselKind, part, carouselIsChild)
  if (!eligible) return

  if (carouselKind === 'edit') {
    await savePart()
  } else if (carouselKind === 'fabdetect') {
    await confirmFabDetection()
  } else if (carouselKind === 'fabricate') {
    const jobsMap = carouselIsChild ? getCurrentChildPartJobs() : getCurrentPartJobs()
    if (!jobsMap[id]) {
      toast(`Not all fields populated — "${part.partName}" was not sent to fabrication.`)
    }
  }
}

async function advanceCarousel(direction) {
  await commitCurrentCarouselStep()

  const nextIndex = carouselIndex + direction
  if (nextIndex < 0) return                 // Prev before the first part — no-op
  if (nextIndex >= carouselIds.length) { endCarousel(); return }   // Next past the last — finish

  carouselIndex = nextIndex
  openCarouselStep()
}

async function closeCarousel() {
  await commitCurrentCarouselStep()
  endCarousel()
}

function endCarousel() {
  const cfg = KIND_MODAL_CONFIG[carouselKind]
  if (cfg) {
    const overlay = document.getElementById(cfg.overlayId)
    if (overlay) overlay.style.display = 'none'
    setCarouselIneligibleState(carouselKind, false)
  }
  hideCarouselBar()
  carouselKind    = null
  carouselIds     = []
  carouselIndex   = 0
}

// ── Carousel nav bar (static markup in index.html: #carousel-nav-bar) ──
function showCarouselBar() {
  const bar = document.getElementById('carousel-nav-bar')
  if (bar) bar.style.display = 'flex'
}
function hideCarouselBar() {
  const bar = document.getElementById('carousel-nav-bar')
  if (bar) bar.style.display = 'none'
}
function updateCarouselBar(part) {
  const label = document.getElementById('carousel-position-label')
  if (label) label.textContent = `Part ${carouselIndex + 1} of ${carouselIds.length} — ${part.partName}`

  const prevBtn = document.getElementById('btn-carousel-prev')
  if (prevBtn) prevBtn.disabled = carouselIndex === 0

  const nextBtn = document.getElementById('btn-carousel-next')
  if (nextBtn) {
    nextBtn.innerHTML = carouselIndex === carouselIds.length - 1
      ? '<i class="ti ti-check" aria-hidden="true"></i> Finish'
      : '<i class="ti ti-chevron-right" aria-hidden="true"></i> Next'
  }
}

/** Dims the current step's modal body and disables its primary
 *  commit button(s) when the part isn't eligible for this bulk action —
 *  the modal itself stays visible (per product decision B+C) so the
 *  carousel's shape stays consistent step to step; only the action is
 *  blocked. */
function setCarouselIneligibleState(kind, ineligible) {
  const cfg = KIND_MODAL_CONFIG[kind]
  if (!cfg) return
  const overlay = document.getElementById(cfg.overlayId)
  if (!overlay) return
  const body = overlay.querySelector('.modal-body')

  cfg.primaryBtnIds.forEach(id => {
    const btn = document.getElementById(id)
    if (btn) btn.disabled = ineligible ? true : btn.disabled && false
  })

  let banner = overlay.querySelector('.carousel-ineligible-banner')
  if (ineligible) {
    body?.classList.add('carousel-ineligible-body')
    if (!banner && body) {
      banner = document.createElement('div')
      banner.className = 'carousel-ineligible-banner'
      banner.innerHTML = `<i class="ti ti-info-circle" aria-hidden="true"></i> This action doesn't apply to this part — use the arrows above to continue.`
      body.prepend(banner)
    }
  } else {
    body?.classList.remove('carousel-ineligible-body')
    banner?.remove()
  }
}

let carouselBarEventsBound = false
function bindCarouselBarEventsOnce() {
  if (carouselBarEventsBound) return
  carouselBarEventsBound = true
  document.getElementById('btn-carousel-prev')?.addEventListener('click', () => advanceCarousel(-1))
  document.getElementById('btn-carousel-next')?.addEventListener('click', () => advanceCarousel(1))
  document.getElementById('btn-carousel-close')?.addEventListener('click', () => closeCarousel())
}

// ── Static event bindings ────────────────────────────────────────
export function bindPartsTableEvents() {
  document.getElementById('btn-close-part-modal').addEventListener('click', closePartModal)
  document.getElementById('btn-cancel-part').addEventListener('click', closePartModal)
  document.getElementById('btn-save-part').addEventListener('click', savePart)
  document.getElementById('part-modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closePartModal()
  })
  // The carousel nav bar is static markup present from boot, so its
  // listeners can be bound here too rather than lazily on first use.
  bindCarouselBarEventsOnce()
}
