// src/designer/fabricateFlow.js
//
// "Send to Fabricate" — creates a fabrication_jobs row promising to
// machine the remaining gap (needed - collected) for one assembly_part.
// If the part has no componentId yet, this inserts two steps first:
// search the catalog for an existing component to resolve to, or create
// a new one (category + typed required attributes — identical
// validation to Inventory mode's Add Component modal).

import {
  upsertAssemblyPart, createFabricationJob,
  fetchComponentsForFabricatePicker, findOrCreateComponent,
  fetchCategories, upsertCategory, validateAttribute,
} from '../db.js'
import { registerNewJob } from '../fabricate.js'
import { genId, toast } from './state.js'

/**
 * `ctx` is:
 *   getPart(partId, isChild)                -> part object
 *   onComponentLinked(savedPart, isChild)     -> persist part.componentId, no re-render needed yet
 *   onJobCreated(savedPart, job, isChild)      -> persist + register job + re-render
 */
let ctx = null
export function registerFabricateFlowContext(c) { ctx = c }

// ── Modal state ──────────────────────────────────────────────
let fabJobPartId      = null
let fabJobIsChildPart = false
let fabStep               = null   // null | 'search' | 'create'
let fabCatalog            = []
let fabCategories         = []
let fabComponentQuery     = ''
let fabSelectedCategoryId = ''
let fabNewCatMode         = false
let fabNewCatReqKeysConfig = []

function currentFabJobPart() {
  return ctx.getPart(fabJobPartId, fabJobIsChildPart)
}

export async function openSendToFabricateModal(partId, isChildPart = false) {
  fabJobPartId      = partId
  fabJobIsChildPart = isChildPart
  const part = currentFabJobPart()
  if (!part) return

  document.getElementById('fab-job-modal-overlay').style.display = 'flex'

  if (part.componentId) {
    fabStep = null
    renderFabModalStep()
    return
  }

  fabStep               = 'search'
  fabComponentQuery     = ''
  fabSelectedCategoryId = ''
  fabNewCatMode         = false
  fabNewCatReqKeysConfig = []
  renderFabModalStep()

  try {
    ;[fabCatalog, fabCategories] = await Promise.all([
      fetchComponentsForFabricatePicker(),
      fetchCategories(),
    ])
  } catch (e) {
    console.error(e)
    toast('Error loading component catalog')
    fabCatalog = []; fabCategories = []
  }
  renderFabModalStep()
}

function closeSendToFabricateModal() {
  document.getElementById('fab-job-modal-overlay').style.display = 'none'
  fabJobPartId = null
  fabStep      = null
}

// ── Step dispatcher ─────────────────────────────────────────────
function renderFabModalStep() {
  const part = currentFabJobPart()
  if (!part) return

  const searchStep = document.getElementById('fab-establish-search-step')
  const createStep = document.getElementById('fab-establish-create-step')
  const qtyStep     = document.getElementById('fab-qty-step')
  const trail       = document.getElementById('fab-step-trail')
  const backBtn     = document.getElementById('btn-fab-back')
  const createBtn   = document.getElementById('btn-fab-create-component-confirm')
  const jobBtn       = document.getElementById('btn-confirm-fab-job')

  searchStep.style.display = fabStep === 'search' ? 'flex' : 'none'
  createStep.style.display = fabStep === 'create' ? 'flex' : 'none'
  qtyStep.style.display    = fabStep === null     ? 'flex' : 'none'

  trail.style.display = fabStep ? 'block' : 'none'
  if (fabStep) {
    trail.innerHTML = fabStep === 'search'
      ? `<span class="step-current">Component</span> &nbsp;→&nbsp; <span>Quantity</span>`
      : `<span>Component</span> &nbsp;→&nbsp; <span class="step-current">New component</span> &nbsp;→&nbsp; <span>Quantity</span>`
  }

  backBtn.style.display   = fabStep === 'create' ? 'inline-flex' : 'none'
  createBtn.style.display = fabStep === 'create' ? 'inline-flex' : 'none'
  jobBtn.style.display    = fabStep === null     ? 'inline-flex' : 'none'

  document.getElementById('fab-job-modal-subtitle').textContent =
    `${part.partName} — ${part.quantityCollected || 0}/${part.quantityNeeded} collected`

  if (fabStep === 'search') renderFabSearchStep()
  if (fabStep === 'create') renderFabCreateStep()
  if (fabStep === null)     renderFabQtyStep(part)
}

function renderFabQtyStep(part) {
  const gap = Math.max(0, part.quantityNeeded - (part.quantityCollected || 0))
  document.getElementById('fab-job-field-qty').value = gap
  document.getElementById('fab-job-field-qty').max   = gap
  setTimeout(() => document.getElementById('fab-job-field-qty').focus(), 80)
}

// ── Search step ──────────────────────────────────────────────────
function fabComponentSummary(component) {
  return (component.attributes || []).map(a => `${a.key}: ${a.value}`).join(' · ') || '—'
}

function filteredFabCatalog() {
  const q = fabComponentQuery.trim().toLowerCase()
  if (!q) return fabCatalog
  return fabCatalog.filter(c =>
    c.categoryName.toLowerCase().includes(q) ||
    (c.attributes || []).some(a => String(a.value).toLowerCase().includes(q) || a.key.toLowerCase().includes(q))
  )
}

function renderFabSearchStep() {
  const resultsEl = document.getElementById('fab-comp-search-results')
  const searchInput = document.getElementById('fab-comp-search-input')
  searchInput.value = fabComponentQuery
  searchInput.oninput = e => { fabComponentQuery = e.target.value; renderFabSearchStep() }

  const results = filteredFabCatalog()

  if (!fabCatalog.length) {
    resultsEl.innerHTML = `<div class="onshape-state" style="padding:24px 0">
      <i class="ti ti-database-off" aria-hidden="true"></i>
      <div class="onshape-state-title">No components in your catalog yet</div>
      <div class="onshape-state-sub">Create one below to get started.</div>
    </div>`
    return
  }
  if (!results.length) {
    resultsEl.innerHTML = `<div class="onshape-state" style="padding:24px 0">
      <i class="ti ti-search-off" aria-hidden="true"></i>
      <div class="onshape-state-title">No matches</div>
      <div class="onshape-state-sub">Try a different search, or create a new component.</div>
    </div>`
    return
  }

  resultsEl.innerHTML = `<div class="onshape-list" style="max-height:220px">${results.map(c => `
    <div class="onshape-list-item" data-fab-select-component="${c.id}">
      <div class="onshape-list-item-icon"><i class="ti ti-box" aria-hidden="true"></i></div>
      <div class="onshape-list-item-text">
        <div class="onshape-list-item-name">${c.categoryName}</div>
        <div class="onshape-list-item-meta">${fabComponentSummary(c)}</div>
      </div>
      <i class="ti ti-chevron-right" aria-hidden="true"></i>
    </div>`).join('')}</div>`

  resultsEl.querySelectorAll('[data-fab-select-component]').forEach(el =>
    el.addEventListener('click', () => selectFabComponent(el.dataset.fabSelectComponent))
  )
}

async function selectFabComponent(componentId) {
  const part = currentFabJobPart()
  if (!part) return
  try {
    const saved = await upsertAssemblyPart({ ...part, componentId })
    ctx.onComponentLinked(saved, fabJobIsChildPart)
    fabStep = null
    renderFabModalStep()
  } catch (e) {
    console.error(e)
    toast('Error linking component to part')
  }
}

// ── Create-new-component step ───────────────────────────────────
function fabPopulateCatSelect(selectedId) {
  const sel = document.getElementById('fab-field-cat')
  sel.innerHTML = '<option value="">— Select —</option>' +
    fabCategories.map(c => `<option value="${c.id}"${c.id === selectedId ? ' selected' : ''}>${c.name}</option>`).join('')
}

function renderFabCreateStep() {
  fabPopulateCatSelect(fabSelectedCategoryId)
  fabHideNewCatRow()
  fabRefreshRequiredAttrs(fabSelectedCategoryId)
}

function fabShowNewCatRow() {
  document.getElementById('fab-new-cat-row').style.display = 'flex'
  document.getElementById('fab-new-cat-config-field').style.display = 'flex'
  document.getElementById('btn-fab-new-cat').style.display = 'none'
  document.getElementById('fab-field-cat').disabled = true
  fabNewCatMode = true
  fabNewCatReqKeysConfig = []
  fabRenderNewCatReqKeysConfig()
  document.getElementById('btn-fab-create-component-confirm').innerHTML =
    '<i class="ti ti-check" aria-hidden="true"></i> Save category'
  setTimeout(() => document.getElementById('fab-new-cat-input').focus(), 60)
}

function fabHideNewCatRow() {
  document.getElementById('fab-new-cat-row').style.display = 'none'
  document.getElementById('fab-new-cat-config-field').style.display = 'none'
  document.getElementById('btn-fab-new-cat').style.display = 'inline-flex'
  document.getElementById('fab-field-cat').disabled = false
  document.getElementById('fab-new-cat-input').value = ''
  document.getElementById('btn-fab-create-component-confirm').innerHTML =
    '<i class="ti ti-check" aria-hidden="true"></i> Create component'
  fabNewCatMode = false
}

// Mirrors main.js's renderReqKeysConfig()/addReqKeyConfig() — same CSS
// classes, scoped to this modal's own element ids + fabNewCatReqKeysConfig.
function fabRenderNewCatReqKeysConfig() {
  const list = document.getElementById('fab-req-keys-config-list')

  if (!fabNewCatReqKeysConfig.length) {
    list.innerHTML = `<div class="req-keys-empty">No required characteristics yet. Add one below.</div>`
  } else {
    list.innerHTML = fabNewCatReqKeysConfig.map((cfg, idx) => `
      <div class="req-key-config-row" data-config-idx="${idx}">
        <div class="req-key-config-main">
          <input type="text" class="fab-req-key-input" data-idx="${idx}"
                 value="${cfg.key}" placeholder="e.g. Inner Diameter">
          <select class="fab-req-type-select" data-idx="${idx}">
            <option value="string"   ${cfg.type === 'string'   ? 'selected' : ''}>Text</option>
            <option value="quantity" ${cfg.type === 'quantity' ? 'selected' : ''}>Quantity</option>
            <option value="enum"     ${cfg.type === 'enum'     ? 'selected' : ''}>Preset list</option>
            <option value="segments" ${cfg.type === 'segments' ? 'selected' : ''}>Shaft profile (segments)</option>
          </select>
          <button type="button" class="btn-icon" data-fab-remove-idx="${idx}" aria-label="Remove">
            <i class="ti ti-trash" style="font-size:13px" aria-hidden="true"></i>
          </button>
        </div>
        ${cfg.type === 'enum' ? `
          <div class="req-type-panel">
            <label>Preset options <span style="font-weight:400;color:var(--color-text-tertiary)">(one per line)</span></label>
            <textarea class="fab-enum-options-input" data-idx="${idx}"
                      placeholder="0.25&#10;0.5">${(cfg.options || []).join('\n')}</textarea>
          </div>` : ''}
        ${cfg.type === 'quantity' ? `
          <div class="req-type-panel">
            <label>Default unit <span style="font-weight:400;color:var(--color-text-tertiary)">(optional, e.g. mm, g, in)</span></label>
            <input type="text" class="fab-quantity-unit-input" data-idx="${idx}"
                   value="${cfg.defaultUnit || ''}" placeholder="e.g. mm">
          </div>` : ''}
        ${cfg.type === 'segments' ? `
          <div class="req-type-panel">
            <label>Segment length unit <span style="font-weight:400;color:var(--color-text-tertiary)">(e.g. in, mm)</span></label>
            <input type="text" class="fab-segment-unit-input" data-idx="${idx}"
                   value="${cfg.segmentUnit || 'in'}" placeholder="in">
          </div>` : ''}
      </div>
    `).join('')
  }

  list.querySelectorAll('.fab-req-key-input').forEach(input =>
    input.addEventListener('input', () => { fabNewCatReqKeysConfig[parseInt(input.dataset.idx, 10)].key = input.value })
  )
  list.querySelectorAll('.fab-req-type-select').forEach(select =>
    select.addEventListener('change', () => {
      const idx = parseInt(select.dataset.idx, 10)
      const cfg = fabNewCatReqKeysConfig[idx]
      cfg.type = select.value
      if (select.value === 'enum') { cfg.options = cfg.options || []; delete cfg.defaultUnit; delete cfg.segmentUnit }
      else if (select.value === 'quantity') { cfg.defaultUnit = cfg.defaultUnit || ''; delete cfg.options; delete cfg.segmentUnit }
      else if (select.value === 'segments') { cfg.segmentUnit = cfg.segmentUnit || 'in'; delete cfg.options; delete cfg.defaultUnit }
      else { delete cfg.options; delete cfg.defaultUnit; delete cfg.segmentUnit }
      fabRenderNewCatReqKeysConfig()
    })
  )
  list.querySelectorAll('.fab-segment-unit-input').forEach(input =>
    input.addEventListener('input', () => { fabNewCatReqKeysConfig[parseInt(input.dataset.idx, 10)].segmentUnit = input.value.trim() })
  )
  list.querySelectorAll('.fab-enum-options-input').forEach(ta =>
    ta.addEventListener('input', () => {
      fabNewCatReqKeysConfig[parseInt(ta.dataset.idx, 10)].options = ta.value.split('\n').map(s => s.trim()).filter(Boolean)
    })
  )
  list.querySelectorAll('.fab-quantity-unit-input').forEach(input =>
    input.addEventListener('input', () => { fabNewCatReqKeysConfig[parseInt(input.dataset.idx, 10)].defaultUnit = input.value.trim() })
  )
  list.querySelectorAll('[data-fab-remove-idx]').forEach(btn =>
    btn.addEventListener('click', () => {
      fabNewCatReqKeysConfig.splice(parseInt(btn.dataset.fabRemoveIdx, 10), 1)
      fabRenderNewCatReqKeysConfig()
    })
  )
}

function fabAddReqKeyConfig() {
  fabNewCatReqKeysConfig.push({ key: '', type: 'string' })
  fabRenderNewCatReqKeysConfig()
  const inputs = document.querySelectorAll('.fab-req-key-input')
  inputs[inputs.length - 1]?.focus()
}

function fabReadAttrRowValue(row) {
  if (row.dataset.type === 'quantity') {
    const numInput = row.querySelector('input[data-num-input]')
    return numInput ? numInput.value : ''
  }
  const input = row.querySelector('[data-val-input]')
  return input ? input.value : ''
}

// Mirrors main.js's buildRequiredAttrRow() so fabricate-flow components
// are validated identically to ones created from Inventory mode.
function fabBuildRequiredAttrRow(cfg, existingVal) {
  const row = document.createElement('div')
  row.className = 'attr-row'
  row.dataset.required = '1'
  row.dataset.type      = cfg.type || 'string'
  row.dataset.configKey = cfg.key

  const keyInput = document.createElement('input')
  keyInput.type = 'text'; keyInput.value = cfg.key; keyInput.readOnly = true
  keyInput.dataset.keyInput = '1'; keyInput.style.flex = '1'

  let valueEl
  if (cfg.type === 'enum') {
    const select = document.createElement('select')
    select.dataset.valInput = '1'; select.className = 'attr-typed-select'; select.style.flex = '1.5'
    const blank = document.createElement('option'); blank.value = ''; blank.textContent = '— Select —'
    select.appendChild(blank)
    ;(cfg.options || []).forEach(opt => {
      const o = document.createElement('option'); o.value = opt; o.textContent = opt
      if (opt === existingVal) o.selected = true
      select.appendChild(o)
    })
    valueEl = select
  } else if (cfg.type === 'quantity') {
    const wrap = document.createElement('div')
    wrap.className = 'attr-quantity-wrap'; wrap.style.flex = '1.5'; wrap.dataset.valInput = '1'
    const numInput = document.createElement('input')
    numInput.type = 'number'; numInput.step = 'any'; numInput.placeholder = 'Amount'
    numInput.dataset.numInput = '1'
    numInput.value = String(existingVal).trim().split(/\s+/)[0] || ''
    const unit = document.createElement('span')
    unit.className = 'attr-quantity-unit'; unit.textContent = cfg.defaultUnit || ''
    wrap.appendChild(numInput); wrap.appendChild(unit)
    valueEl = wrap
  } else {
    const input = document.createElement('input')
    input.type = 'text'; input.placeholder = 'Value'; input.dataset.valInput = '1'
    input.value = existingVal; input.style.flex = '1.5'
    valueEl = input
  }

  const badge = document.createElement('span')
  badge.className = 'attr-required-badge'; badge.textContent = 'required'
  row.append(keyInput, valueEl, badge)
  return row
}

function fabRefreshRequiredAttrs(catId) {
  const cat        = fabCategories.find(c => c.id === catId)
  const keysConfig = (cat && cat.requiredKeysConfig) || []
  const list       = document.getElementById('fab-attrs-list')
  list.innerHTML = ''
  keysConfig.forEach(cfg => list.appendChild(fabBuildRequiredAttrRow(cfg, '')))
}

async function fabConfirmNewCategory() {
  const name = document.getElementById('fab-new-cat-input').value.trim()
  if (!name) { document.getElementById('fab-new-cat-input').focus(); toast('Category name is required'); return }

  const cleanConfigs = fabNewCatReqKeysConfig.map(cfg => ({ ...cfg, key: cfg.key.trim() })).filter(cfg => cfg.key)

  try {
    const saved = await upsertCategory({ id: genId(), name, requiredKeysConfig: cleanConfigs })
    fabCategories.push(saved)
    fabSelectedCategoryId = saved.id
    fabHideNewCatRow()
    renderFabCreateStep()
    toast('Category created')
  } catch (e) {
    console.error(e)
    toast('Error creating category')
  }
}

async function confirmFabEstablishComponent() {
  const part = currentFabJobPart()
  if (!part) return

  const catId = document.getElementById('fab-field-cat').value || ''
  if (!catId) { toast('Select a category'); return }
  const cat = fabCategories.find(c => c.id === catId)
  const keysConfig = (cat && cat.requiredKeysConfig) || []

  const reqRows = [...document.querySelectorAll('#fab-attrs-list .attr-row[data-required]')]
  let valid = true
  const attrs = {}

  reqRows.forEach(row => {
    const configKey = row.dataset.configKey
    const config    = keysConfig.find(c => c.key === configKey)
    const rawValue  = fabReadAttrRowValue(row)
    const trimmed   = String(rawValue ?? '').trim()
    const errorTarget = row.dataset.type === 'quantity'
      ? row.querySelector('input[data-num-input]')
      : row.querySelector('[data-val-input]')

    if (!trimmed) { errorTarget?.classList.add('error'); valid = false; return }
    const result = validateAttribute(trimmed, config)
    if (!result.valid) { errorTarget?.classList.add('error'); valid = false; return }

    errorTarget?.classList.remove('error')
    attrs[configKey] = trimmed
  })

  if (!valid) { toast('Fill in all required characteristics correctly'); return }

  const btn = document.getElementById('btn-fab-create-component-confirm')
  btn.disabled = true; btn.textContent = 'Creating…'

  try {
    const component = await findOrCreateComponent({
      categoryId: catId,
      fields:     keysConfig,
      attrs,
      fallback:   { name: part.partName, description: '', image: null },
      genId,
    })
    fabCatalog.push({ ...component, categoryName: cat?.name || 'Uncategorized', category: cat })
    await selectFabComponent(component.id)
  } catch (e) {
    console.error(e)
    toast('Error creating component')
  } finally {
    btn.disabled = false
    btn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i> Create component'
  }
}

async function confirmSendToFabricate() {
  const part = currentFabJobPart()
  if (!part) return

  const gap = Math.max(0, part.quantityNeeded - (part.quantityCollected || 0))
  const qty = Math.max(1, Math.min(gap, parseInt(document.getElementById('fab-job-field-qty').value, 10) || 1))

  const btn = document.getElementById('btn-confirm-fab-job')
  btn.disabled = true; btn.textContent = 'Creating…'

  try {
    const job = await createFabricationJob({ assemblyPartId: part.id, quantityRequested: qty, batchId: null, genId })
    registerNewJob(job)
    ctx.onJobCreated(part, job, fabJobIsChildPart)
    closeSendToFabricateModal()
    toast(`Sent ${qty} × "${part.partName}" to Fabricate`)
  } catch (e) {
    console.error(e)
    toast(e.message?.includes('duplicate') ? 'This part already has an active fabrication job.' : 'Error creating fabrication job')
  } finally {
    btn.disabled = false
    btn.innerHTML = '<i class="ti ti-tool" aria-hidden="true"></i> Send to Fabricate'
  }
}

// ── Static event bindings ────────────────────────────────────────
export function bindFabricateFlowEvents() {
  document.getElementById('btn-close-fab-job-modal').addEventListener('click', closeSendToFabricateModal)
  document.getElementById('btn-cancel-fab-job').addEventListener('click', closeSendToFabricateModal)
  document.getElementById('btn-confirm-fab-job').addEventListener('click', confirmSendToFabricate)
  document.getElementById('fab-job-modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeSendToFabricateModal()
  })

  document.getElementById('btn-fab-create-new-component').addEventListener('click', () => {
    fabStep = 'create'
    fabSelectedCategoryId = ''
    renderFabModalStep()
  })
  document.getElementById('btn-fab-back').addEventListener('click', () => { fabStep = 'search'; renderFabModalStep() })
  document.getElementById('fab-field-cat').addEventListener('change', e => {
    fabSelectedCategoryId = e.target.value
    fabRefreshRequiredAttrs(fabSelectedCategoryId)
  })
  document.getElementById('btn-fab-new-cat').addEventListener('click', fabShowNewCatRow)
  document.getElementById('btn-fab-cancel-new-cat').addEventListener('click', fabHideNewCatRow)
  document.getElementById('fab-new-cat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); fabConfirmNewCategory() }
  })
  document.getElementById('btn-fab-add-req-key-config').addEventListener('click', fabAddReqKeyConfig)
  document.getElementById('btn-fab-create-component-confirm').addEventListener('click', () => {
    fabNewCatMode ? fabConfirmNewCategory() : confirmFabEstablishComponent()
  })
}