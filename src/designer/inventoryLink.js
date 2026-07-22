// src/designer/inventoryLink.js
//
// Lets a user search existing inventory components and link/unlink
// physical instances to a specific assembly part (root or subassembly).
// Also owns the inline "N linked" expansion panel under a part row,
// since it's the same reservation flow (unlink lives there too).

import {
  fetchComponents, fetchAvailableInstances, reserveInstance, unreserveInstance,
  fetchInstancesByIds, updateInstanceLocation, upsertAssemblyPart,
  fetchSuggestedInstancesForPartNumber, linkPartNumberToComponent,
} from '../db.js'
import { toast, computePartStatus } from './state.js'

// ── Part name → category dictionary (search suggestion chips) ────
const PART_NAME_DICTIONARY = {
  bolt:    ['Fasteners', 'Hardware'],
  screw:   ['Fasteners', 'Hardware'],
  nut:     ['Fasteners', 'Hardware'],
  washer:  ['Fasteners', 'Hardware'],
  rivet:   ['Fasteners', 'Hardware'],
  gear:    ['Gears'],
  sprocket:['Sprocket'],
  pulley:  ['Pulley'],
  belt:    ['Belt'],
  chain:   ['Chain'],
  bearing: ['Bearings', 'Hardware'],
  motor:   ['Motors', 'Electronics'],
  servo:   ['Motors', 'Electronics'],
  wire:    ['Electronics'],
  wheel:   ['Wheels', 'Drivetrain'],
  bracket: ['Structural', 'Hardware'],
  plate:   ['Structural'],
  tube:    ['Structural'],
  rod:     ['Structural'],
  spacer:  ['Spacer'],
  standoff:['Hardware'],
}

function suggestCategoriesForPartName(partName) {
  const words = partName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  for (const w of words) {
    if (PART_NAME_DICTIONARY[w]) return PART_NAME_DICTIONARY[w]
  }
  return null
}

/**
 * `ctx` is:
 *   getPart(partId, isChild)              -> part object
 *   afterChange(savedPart, isChild)         -> persist + sync assembly status (root only) + re-render
 *   getAssemblyNameForLocation(isChild)      -> string used as the fork's location label
 */
let ctx = null
export function registerInventoryLinkContext(c) { ctx = c }

// ── Modal state ──────────────────────────────────────────────
let invLinkPartId      = null
let invLinkIsChildPart = false
let invLinkQuery       = ''
let invLinkResults     = []
let invLinkAllComponents = []
let invLinkLoading     = false

export function openInventoryLinkModal(partId, isChildPart = false) {
  invLinkPartId      = partId
  invLinkIsChildPart = isChildPart
  invLinkQuery       = ''
  invLinkResults     = []
  invLinkLoading     = false

  const part = ctx.getPart(partId, isChildPart)
  if (!part) return

  document.getElementById('inv-link-subtitle').textContent = `For: ${part.partName}`
  document.getElementById('inv-link-search-input').value = ''
  document.getElementById('inv-link-overlay').style.display = 'flex'

  renderInventoryLinkSuggestion(part.partName)
  loadAndSearchInventory('')
  setTimeout(() => document.getElementById('inv-link-search-input').focus(), 80)
}

function closeInventoryLinkModal() {
  document.getElementById('inv-link-overlay').style.display = 'none'
  invLinkPartId = null
}

function currentInvLinkPart() {
  return ctx.getPart(invLinkPartId, invLinkIsChildPart)
}

function renderInventoryLinkSuggestion(partName) {
  const el = document.getElementById('inv-link-suggestion')
  const suggestions = suggestCategoriesForPartName(partName)
  if (!suggestions) { el.innerHTML = ''; return }

  el.innerHTML = suggestions.map(cat =>
    `<span class="inv-link-suggestion-chip" data-suggest-cat="${cat}">
      <i class="ti ti-sparkles" style="font-size:11px" aria-hidden="true"></i> ${cat}
    </span>`
  ).join(' ')

  el.querySelectorAll('[data-suggest-cat]').forEach(chip =>
    chip.addEventListener('click', () => {
      document.getElementById('inv-link-search-input').value = chip.dataset.suggestCat
      invLinkQuery = chip.dataset.suggestCat
      loadAndSearchInventory(invLinkQuery)
    })
  )
}

async function loadAndSearchInventory(query) {
  invLinkLoading = true
  renderInventoryLinkResults()

  try {
    const part = currentInvLinkPart()

    const rawPartNumber = part?.onshapeReference?.partNumber || part?.partNumber
    if (rawPartNumber && !query.trim()) {
      const suggested = await fetchSuggestedInstancesForPartNumber(rawPartNumber)
      if (suggested.length) {
        invLinkResults = [{ component: suggested[0].component ?? { id: suggested[0].componentId, fallbackName: suggested[0].name }, instances: suggested, suggested: true }]
        invLinkLoading = false
        renderInventoryLinkResults()
        return
      }
    }

    if (!invLinkAllComponents.length) invLinkAllComponents = await fetchComponents()

    const q = query.trim().toLowerCase()
    const matches = q
      ? invLinkAllComponents.filter(c => (c.fallbackName || '').toLowerCase().includes(q))
      : invLinkAllComponents

    const withInstances = await Promise.all(
      matches.slice(0, 30).map(async c => ({ component: c, instances: await fetchAvailableInstances(c.id) }))
    )

    invLinkResults = withInstances.filter(r => r.instances.length > 0)
  } catch (e) {
    console.error(e)
    toast('Error searching inventory')
    invLinkResults = []
  } finally {
    invLinkLoading = false
    renderInventoryLinkResults()
  }
}

function renderInventoryLinkResults() {
  const el = document.getElementById('inv-link-results')

  if (invLinkLoading) {
    el.innerHTML = `<div class="onshape-state"><i class="ti ti-loader-2 spin" aria-hidden="true"></i><div class="onshape-state-title">Searching…</div></div>`
    return
  }

  const part = currentInvLinkPart()
  const remainingNeeded = part ? Math.max(0, part.quantityNeeded - (part.quantityCollected || 0)) : 0
  const atCap = part ? remainingNeeded <= 0 : false
  if (atCap) {
    el.innerHTML = `<div class="onshape-state" style="padding:24px 0">
      <i class="ti ti-circle-check" aria-hidden="true"></i>
      <div class="onshape-state-title">Quantity needed is met</div>
      <div class="onshape-state-sub">${part.quantityNeeded} of ${part.quantityNeeded} linked. Unlink an item first if you need to swap it.</div>
    </div>`
    return
  }

  if (!invLinkResults.length) {
    el.innerHTML = `<div class="onshape-state">
      <i class="ti ti-package-off" aria-hidden="true"></i>
      <div class="onshape-state-title">No available inventory found</div>
      <div class="onshape-state-sub">Try a different search term, or add this component to Inventory first.</div>
    </div>`
    return
  }

  el.innerHTML = invLinkResults.map(({ component, instances }) => {
    const totalAvailable = instances.reduce((s, i) => s + (i.quantity || 0), 0)
    return `
    <div class="inv-link-comp-card">
      <div class="inv-link-comp-header">
        <span class="inv-link-comp-name">${component.fallbackName || 'Unnamed component'}</span>
        <span class="inv-link-comp-count">${totalAvailable} available</span>
      </div>
      ${instances.map(inst => `
        <div class="inv-link-instance-row">
          <span class="inv-link-instance-loc">
            <i class="ti ti-map-pin" aria-hidden="true"></i>
            ${inst.name || component.fallbackName || 'Unnamed'} — ${inst.location || 'No location set'}
            <span class="inv-link-instance-pile-qty">(${inst.quantity} here)</span>
          </span>
          <input type="number" class="inv-link-qty-input" data-qty-for="${inst.id}" min="1"
                 max="${Math.min(inst.quantity, remainingNeeded)}" value="1" style="width:52px">
          <button class="btn btn-sm btn-primary" data-add-instance="${inst.id}" data-comp-name="${component.fallbackName || 'component'}">
            <i class="ti ti-plus" aria-hidden="true"></i> Add to assembly
          </button>
        </div>
      `).join('')}
    </div>
  `
  }).join('')

  el.querySelectorAll('[data-add-instance]').forEach(btn =>
    btn.addEventListener('click', () => {
      const qtyInput = el.querySelector(`[data-qty-for="${btn.dataset.addInstance}"]`)
      const requestedQty = Math.max(1, parseInt(qtyInput?.value, 10) || 1)
      linkInstanceToPart(btn.dataset.addInstance, btn.dataset.compName, btn.dataset.componentId, requestedQty)
    })
  )

  el.querySelectorAll('.inv-link-comp-card').forEach((card, i) => {
    const componentId = invLinkResults[i].component.id
    card.querySelectorAll('[data-add-instance]').forEach(btn => { btn.dataset.componentId = componentId })
  })
}

async function linkInstanceToPart(instanceId, componentName, componentId, requestedQty = 1) {
  const part = currentInvLinkPart()
  if (!part) return

  const currentLinked   = part.linkedInstanceIds || []
  const alreadyLinked   = part.quantityCollected || 0
  const remainingNeeded = part.quantityNeeded - alreadyLinked
  if (remainingNeeded <= 0) { toast(`Already have ${part.quantityNeeded} linked — quantity needed is met.`); return }
  const qty = Math.min(requestedQty, remainingNeeded)
  if (qty <= 0) return

  const assemblyName = ctx.getAssemblyNameForLocation(invLinkIsChildPart)

  try {
    const fork = await reserveInstance(instanceId, qty, assemblyName)

    const updatedPart = {
      ...part,
      componentId:       part.componentId || componentId,
      linkedInstanceIds: [...currentLinked, fork.id],
      quantityCollected: alreadyLinked + qty,
    }
    updatedPart.status = computePartStatus(updatedPart)

    const saved = await upsertAssemblyPart(updatedPart)

    const rawPartNumber = part.onshapeReference?.partNumber || part.partNumber
    if (rawPartNumber) {
      try { await linkPartNumberToComponent(rawPartNumber, updatedPart.componentId || componentId) }
      catch (e) { console.warn('[partNumbers] backfill failed', e) }
    }

    await ctx.afterChange(saved, invLinkIsChildPart)

    toast(`Linked ${qty} x ${componentName} to "${part.partName}"`)
    document.getElementById('inv-link-subtitle').textContent =
      `For: ${saved.partName} (${saved.quantityCollected}/${saved.quantityNeeded} linked)`
    loadAndSearchInventory(invLinkQuery)
  } catch (e) {
    console.error(e)
    toast(e.message?.includes('available') ? e.message : 'Error linking inventory item')
    loadAndSearchInventory(invLinkQuery)
  }
}

async function unlinkInstanceFromPart(partId, instanceId, isChildPart) {
  const part = ctx.getPart(partId, isChildPart)
  if (!part) return
  if (!confirm('Unlink this inventory item? It will be marked available again.')) return

  try {
    await unreserveInstance(instanceId, '')
    const unlinkedRow = await fetchInstancesByIds([instanceId]).then(rows => rows[0])
    const unlinkedQty  = unlinkedRow?.quantity || 1

    const remaining = (part.linkedInstanceIds || []).filter(id => id !== instanceId)
    const updatedPart = {
      ...part,
      linkedInstanceIds: remaining,
      componentId:       remaining.length ? part.componentId : null,
      quantityCollected: Math.max(0, (part.quantityCollected || 0) - unlinkedQty),
    }
    updatedPart.status = computePartStatus(updatedPart)

    const saved = await upsertAssemblyPart(updatedPart)
    await ctx.afterChange(saved, isChildPart)

    if (openLinkedDetailIds.has(partId)) { openLinkedDetailIds.delete(partId); toggleLinkedDetail(partId, isChildPart) }
    toast('Unlinked from inventory')
  } catch (e) {
    console.error(e)
    toast('Error unlinking item')
  }
}

// ── Inline "linked instances" detail panel under a part row ─────
let openLinkedDetailIds = new Set()

export async function toggleLinkedDetail(partId, isChildPart) {
  const el = document.getElementById(`linked-detail-${partId}`)
  if (!el) return

  const isOpen = el.style.display !== 'none'
  if (isOpen) { el.style.display = 'none'; openLinkedDetailIds.delete(partId); return }

  openLinkedDetailIds.add(partId)
  el.style.display = 'block'
  el.innerHTML = `<div class="inv-linked-loading"><i class="ti ti-loader-2 spin" aria-hidden="true"></i> Loading…</div>`

  const part = ctx.getPart(partId, isChildPart)
  if (!part) return

  try {
    const instances = await fetchInstancesByIds(part.linkedInstanceIds || [])
    renderLinkedDetail(partId, instances, isChildPart)
  } catch (e) {
    console.error(e)
    el.innerHTML = `<div class="inv-linked-loading">Error loading linked items</div>`
  }
}

function renderLinkedDetail(partId, instances, isChildPart) {
  const el = document.getElementById(`linked-detail-${partId}`)
  if (!el) return

  if (!instances.length) { el.innerHTML = ''; el.style.display = 'none'; return }

  el.innerHTML = instances.map(inst => `
    <div class="inv-linked-row" data-instance-id="${inst.id}">
      <i class="ti ti-map-pin" style="font-size:11px;color:var(--color-text-tertiary)" aria-hidden="true"></i>
      <input type="text" class="inv-linked-loc-input" value="${inst.location || ''}"
             placeholder="Set location…" data-loc-input="${inst.id}">
      <button class="btn-icon" data-unlink-instance="${inst.id}" aria-label="Unlink" title="Unlink">
        <i class="ti ti-unlink" style="font-size:12px"></i>
      </button>
    </div>
  `).join('')

  el.querySelectorAll('[data-loc-input]').forEach(input => {
    const save = async () => {
      try { await updateInstanceLocation(input.dataset.locInput, input.value.trim()) }
      catch (e) { console.error(e); toast('Error updating location') }
    }
    input.addEventListener('blur', save)
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur() })
  })

  el.querySelectorAll('[data-unlink-instance]').forEach(btn =>
    btn.addEventListener('click', () => unlinkInstanceFromPart(partId, btn.dataset.unlinkInstance, isChildPart))
  )
}

// ── Static event bindings ────────────────────────────────────────
export function bindInventoryLinkEvents() {
  document.getElementById('btn-close-inv-link').addEventListener('click', closeInventoryLinkModal)
  document.getElementById('btn-close-inv-link-2').addEventListener('click', closeInventoryLinkModal)
  document.getElementById('inv-link-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeInventoryLinkModal()
  })

  let invLinkSearchTimer
  document.getElementById('inv-link-search-input').addEventListener('input', e => {
    invLinkQuery = e.target.value
    clearTimeout(invLinkSearchTimer)
    invLinkSearchTimer = setTimeout(() => loadAndSearchInventory(invLinkQuery), 250)
  })
}