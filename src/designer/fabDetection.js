// src/designer/fabDetection.js
//
// Everything to do with reviewing an auto-detected fabrication candidate
// (see SPACER_AUTO_DETECTION_ROADMAP.md / AXIAL_SHAFT_DETECTION_ROADMAP.md /
// PLATE_DETECTION_ROADMAP.md) and confirming it into a real component +
// fabrication_jobs row. This was ~900 lines of designer.js and is the
// most self-contained subsystem in the file: it only reaches outside
// itself to read/replace the part it's confirming (via a small context
// object registered from partsTable.js) and to register the resulting
// job with fabricate.js.

import {
  upsertAssemblyPart, createFabricationJob,
  fetchCategories, upsertCategory,
} from '../db.js'
import { registerNewJob } from '../fabricate.js'
import { renderSegmentEditor, renderSegmentPreview } from '../segmentEditor.js'
import { genId, toast } from './state.js'

// ── Hard-coded category shapes for auto-created components ─────────
const SPACER_CATEGORY_NAME = 'Spacer'
const SPACER_REQUIRED_KEYS_CONFIG = [
  { key: 'Spacer Type', type: 'enum', options: ['ROUND', 'HEX', 'HEX375'] },
  { key: 'OD',           type: 'quantity', defaultUnit: 'in' },
  { key: 'ID or Across Flats', type: 'quantity', defaultUnit: 'in' },
  { key: 'Length',       type: 'quantity', defaultUnit: 'in' },
]

const AXIAL_SHAFT_CATEGORY_NAME = 'Axial Shaft'
const AXIAL_SHAFT_REQUIRED_KEYS_CONFIG = [
  { key: 'Profile', type: 'segments', segmentUnit: 'in' },
]

const PLATE_CATEGORY_NAME = 'Plate'
const PLATE_REQUIRED_KEYS_CONFIG = [
  { key: 'Material',  type: 'enum', options: ['Aluminum', 'Polycarbonate', 'Acrylic', 'Steel', 'Other'] },
  { key: 'Thickness', type: 'quantity', defaultUnit: 'in' },
]

async function ensureSpacerCategory() {
  const cats = await fetchCategories()
  let cat = cats.find(c => c.name === SPACER_CATEGORY_NAME)
  if (cat) return cat
  return upsertCategory({ id: genId(), name: SPACER_CATEGORY_NAME, requiredKeysConfig: SPACER_REQUIRED_KEYS_CONFIG })
}

async function ensureAxialShaftCategory() {
  const cats = await fetchCategories()
  let cat = cats.find(c => c.name === AXIAL_SHAFT_CATEGORY_NAME)
  if (cat) return cat
  return upsertCategory({ id: genId(), name: AXIAL_SHAFT_CATEGORY_NAME, requiredKeysConfig: AXIAL_SHAFT_REQUIRED_KEYS_CONFIG })
}

async function ensurePlateCategory() {
  const cats = await fetchCategories()
  let cat = cats.find(c => c.name === PLATE_CATEGORY_NAME)
  if (cat) return cat
  return upsertCategory({ id: genId(), name: PLATE_CATEGORY_NAME, requiredKeysConfig: PLATE_REQUIRED_KEYS_CONFIG })
}

// findOrCreateComponent is injected via initFabDetection() rather than
// imported directly, to keep this module's actual dependency surface
// explicit and to avoid a circular import back through db.js re-exports.
let findOrCreateComponentFn = null
export function initFabDetection(findOrCreateComponent) {
  findOrCreateComponentFn = findOrCreateComponent
}

// ── Modal state ──────────────────────────────────────────────────
let fabDetectPartId    = null
let fabDetectIsChild   = false
let fabDetectMatch     = null     // spacer only
let fabDetectCandidates = null    // spacer only
let fabDetectKind       = null    // 'spacer' | 'axial-shaft' | 'plate'
let fabDetectSegments   = null    // axial-shaft only — working (editable) array
let fabDetectOriginalSegments = null

/**
 * `ctx` is:
 *   getPart(partId, isChild)                  -> the part object
 *   onPartUpdated(savedPart, isChild)          -> persist + re-render after ignore
 *   onJobCreated(savedPart, job, isChild)       -> persist + re-render after confirm
 * Registered once by partsTable.js so this module never has to import
 * currentParts/currentChildParts state directly.
 */
let getPartsCtx = null
export function registerFabDetectionContext(ctx) { getPartsCtx = ctx }

function currentFabDetectPart() {
  return getPartsCtx.getPart(fabDetectPartId, fabDetectIsChild)
}

export function openFabDetectConfirmModal(partId, isChildPart = false) {
  fabDetectPartId  = partId
  fabDetectIsChild = isChildPart
  const part = currentFabDetectPart()
  if (!part) return
  const meta = part.fabricationMetadata || {}
  fabDetectKind = meta.kind || 'spacer'

  const subtitleEl = document.getElementById('fab-detect-subtitle')
  if (subtitleEl) {
    subtitleEl.textContent = `${part.partName} — ${part.quantityCollected || 0}/${part.quantityNeeded} collected`
  }

  const ignoreBtn = document.getElementById('btn-fab-detect-ignore')
  if (ignoreBtn) {
    ignoreBtn.innerHTML = fabDetectKind === 'axial-shaft'
      ? '<i class="ti ti-eye-off" aria-hidden="true"></i> Not a shaft'
      : fabDetectKind === 'plate'
        ? '<i class="ti ti-eye-off" aria-hidden="true"></i> Not a plate'
        : '<i class="ti ti-eye-off" aria-hidden="true"></i> Not a spacer'
  }

  const spacerFields   = document.getElementById('fab-detect-spacer-fields')
  const segmentsFields = document.getElementById('fab-detect-segments-fields')
  const plateFields    = document.getElementById('fab-detect-plate-fields')
  if (!spacerFields || !segmentsFields || !plateFields) {
    console.error('[fab-detect] Missing confirm-overlay field block — hard-refresh / rebuild likely needed.')
    return
  }

  spacerFields.style.display   = 'none'
  segmentsFields.style.display = 'none'
  plateFields.style.display    = 'none'

  if (fabDetectKind === 'axial-shaft') {
    segmentsFields.style.display = 'flex'
    openAxialShaftConfirmFields(part, meta)
  } else if (fabDetectKind === 'plate') {
    plateFields.style.display = 'flex'
    openPlateConfirmFields(part, meta)
  } else {
    spacerFields.style.display = 'flex'
    openSpacerConfirmFields(part, meta)
  }

  const warnings = meta.warnings || []
  document.getElementById('fab-detect-warning-banner').innerHTML = warnings.length
    ? `<div class="onshape-preview-warning"><i class="ti ti-alert-triangle" aria-hidden="true"></i><span>${warnings.join(' ')}</span></div>`
    : ''

  document.getElementById('fab-detect-confirm-overlay').style.display = 'flex'
}

function openAxialShaftConfirmFields(part, meta) {
  const detected = (meta.dimensions?.segments || []).map(s => ({ ...s }))
  fabDetectOriginalSegments = detected.map(s => ({ ...s }))

  fabDetectSegments = detected.map(seg => {
    const ov = meta.overrides?.[seg.id]
    if (!ov) return { ...seg }
    const patched = { ...seg }
    for (const [field, entry] of Object.entries(ov)) {
      if (field === 'userAdded' || field === 'reason') continue
      patched[field] = entry && typeof entry === 'object' && 'value' in entry ? entry.value : entry
    }
    return patched
  })

  if (meta.overrides) {
    Object.entries(meta.overrides).forEach(([id, ov]) => {
      if (ov.userAdded && !fabDetectSegments.some(s => s.id === id)) {
        const { userAdded, reason, ...rest } = ov
        fabDetectSegments.push({ id, ...rest })
      }
    })
  }

  const previewEl = document.getElementById('fab-detect-segments-preview')
  if (previewEl) renderSegmentPreview(previewEl, fabDetectSegments, { unit: 'in' })

  const segListEl = document.getElementById('fab-detect-segments-list')
  if (segListEl) {
    renderSegmentEditor(segListEl, fabDetectSegments, {
      editable: true,
      unit: 'in',
      onChange: () => {},
    })
  } else {
    console.error('[fab-detect] #fab-detect-segments-list not found in the DOM.')
  }

  const gap = Math.max(1, part.quantityNeeded - (part.quantityCollected || 0))
  const qtyEl = document.getElementById('fab-detect-field-qty')
  if (qtyEl) { qtyEl.value = gap; qtyEl.max = gap }
}

function openSpacerConfirmFields(part, meta) {
  const candidateField  = document.getElementById('fab-detect-candidate-field')
  const candidateSelect = document.getElementById('fab-detect-candidate-select')

  if (meta.candidateMatches && meta.candidateMatches.length > 1) {
    fabDetectCandidates = meta.candidateMatches
    candidateField.style.display = ''
    candidateSelect.innerHTML = fabDetectCandidates.map((m, i) => {
      const d = m.dimensions || {}
      const isHex = m.spacerType === 'HEX' || m.spacerType === 'HEX375'
      const idOrAf = isHex ? d.acrossFlats?.value : d.id?.value
      const summary = [
        m.spacerType || '?',
        d.od?.value != null ? `OD ${d.od.value}"` : 'OD ?',
        idOrAf != null ? `${isHex ? 'AF' : 'ID'} ${idOrAf}"` : `${isHex ? 'AF' : 'ID'} ?`,
        d.length?.value != null ? `L ${d.length.value}"` : 'L ?',
        m.endType || '',
      ].filter(Boolean).join(' · ')
      return `<option value="${i}">Match ${i + 1}: ${summary}</option>`
    }).join('')
    candidateSelect.value = '0'
    fabDetectMatch = fabDetectCandidates[0]
  } else {
    fabDetectCandidates = null
    candidateField.style.display = 'none'
    fabDetectMatch = meta
  }

  populateFabDetectFields(part)
}

function openPlateConfirmFields(part, meta) {
  const dims = meta.dimensions || {}
  document.getElementById('fab-detect-plate-field-thickness').value = dims.thickness?.value ?? ''
  document.getElementById('fab-detect-plate-field-material').value = ''
  document.getElementById('fab-detect-plate-confidence').innerHTML =
    `<span class="part-badge part-badge--${meta.confidence === 'high' ? 'complete' : 'partial'}">${meta.confidence || 'unknown'}</span>`

  const gap = Math.max(1, part.quantityNeeded - (part.quantityCollected || 0))
  const qtyEl = document.getElementById('fab-detect-field-qty')
  if (qtyEl) { qtyEl.value = gap; qtyEl.max = gap }
}

function populateFabDetectFields(part) {
  const dims = fabDetectMatch?.dimensions || {}
  const spacerType = fabDetectMatch?.spacerType || 'ROUND'
  const isHex = spacerType === 'HEX' || spacerType === 'HEX375'

  document.getElementById('fab-detect-spacer-type').textContent = spacerType
  document.getElementById('fab-detect-confidence').innerHTML =
    `<span class="part-badge part-badge--${fabDetectMatch?.confidence === 'high' ? 'complete' : 'partial'}">${fabDetectMatch?.confidence || 'unknown'}</span>`

  document.getElementById('fab-detect-id-label').textContent =
    isHex ? 'Across flats (in) *' : 'ID (inner diameter, in) *'

  document.getElementById('fab-detect-field-od').value     = dims.od?.value ?? ''
  document.getElementById('fab-detect-field-id').value     = isHex ? (dims.acrossFlats?.value ?? '') : (dims.id?.value ?? '')
  document.getElementById('fab-detect-field-length').value = dims.length?.value ?? ''

  const gap = Math.max(1, part.quantityNeeded - (part.quantityCollected || 0))
  document.getElementById('fab-detect-field-qty').value = gap
  document.getElementById('fab-detect-field-qty').max   = gap
}

export function handleFabDetectCandidateChange() {
  const idx = parseInt(document.getElementById('fab-detect-candidate-select').value, 10) || 0
  if (!fabDetectCandidates || !fabDetectCandidates[idx]) return
  fabDetectMatch = fabDetectCandidates[idx]
  const part = currentFabDetectPart()
  if (part) populateFabDetectFields(part)
}

export function closeFabDetectConfirmModal() {
  document.getElementById('fab-detect-confirm-overlay').style.display = 'none'
  fabDetectPartId = null
  fabDetectMatch  = null
  fabDetectCandidates = null
  fabDetectKind = null
  fabDetectSegments = null
  fabDetectOriginalSegments = null
}

export async function confirmFabDetection() {
  const part = currentFabDetectPart()
  if (!part) return

  if (fabDetectKind === 'axial-shaft') { await confirmAxialShaftDetection(part); return }
  if (fabDetectKind === 'plate')       { await confirmPlateDetection(part); return }

  const od     = parseFloat(document.getElementById('fab-detect-field-od').value)
  const idOrAf = parseFloat(document.getElementById('fab-detect-field-id').value)
  const length = parseFloat(document.getElementById('fab-detect-field-length').value)
  const qty    = Math.max(1, parseInt(document.getElementById('fab-detect-field-qty').value, 10) || 1)

  if (!Number.isFinite(od) || !Number.isFinite(idOrAf) || !Number.isFinite(length)) {
    toast('OD, ID/across-flats, and Length are all required')
    return
  }

  const meta = part.fabricationMetadata || {}
  const spacerType = fabDetectMatch?.spacerType || 'ROUND'

  const detectedDims = fabDetectMatch?.dimensions || {}
  const overrides = {}
  const detectedOd = detectedDims.od?.value
  const detectedLen = detectedDims.length?.value
  const detectedIdOrAf = spacerType === 'ROUND' ? detectedDims.id?.value : detectedDims.acrossFlats?.value
  if (detectedOd !== od) overrides.od = { value: od, unit: 'in', reason: 'User confirmation edit' }
  if (detectedLen !== length) overrides.length = { value: length, unit: 'in', reason: 'User confirmation edit' }
  if (detectedIdOrAf !== idOrAf) overrides[spacerType === 'ROUND' ? 'id' : 'acrossFlats'] = { value: idOrAf, unit: 'in', reason: 'User confirmation edit' }

  const btn = document.getElementById('btn-confirm-fab-detect')
  btn.disabled = true; btn.textContent = 'Confirming…'

  try {
    const spacerCat = await ensureSpacerCategory()
    const attrs = {
      'Spacer Type':        spacerType,
      'OD':                 String(od),
      'ID or Across Flats': String(idOrAf),
      'Length':             String(length),
    }
    const component = await findOrCreateComponentFn({
      categoryId: spacerCat.id,
      fields:     spacerCat.requiredKeysConfig,
      attrs,
      fallback:   { name: part.partName, description: `Auto-detected ${spacerType.toLowerCase()} spacer`, image: null },
      genId,
    })

    const updatedMeta = { ...meta, status: 'queued', overrides: Object.keys(overrides).length ? overrides : (meta.overrides || null) }
    const savedPart = await upsertAssemblyPart({ ...part, componentId: component.id, fabricationMetadata: updatedMeta })

    const job = await createFabricationJob({ assemblyPartId: part.id, quantityRequested: qty, batchId: null, genId })
    registerNewJob(job)

    getPartsCtx.onJobCreated(savedPart, job, fabDetectIsChild)
    closeFabDetectConfirmModal()
    toast(`Confirmed "${part.partName}" — sent ${qty} to Fabricate`)
  } catch (e) {
    console.error(e)
    toast(e.message?.includes('duplicate') ? 'This part already has an active fabrication job.' : 'Error confirming spacer')
  } finally {
    btn.disabled = false
    btn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i> Confirm &amp; send to Fabricate'
  }
}

async function confirmAxialShaftDetection(part) {
  if (!fabDetectSegments || !fabDetectSegments.length) { toast('At least one segment is required'); return }

  for (const seg of fabDetectSegments) {
    if (!Number.isFinite(seg.length) || seg.length <= 0) { toast('Every segment needs a positive length'); return }
    if (seg.type === 'round'  && (!Number.isFinite(seg.diameter)    || seg.diameter    <= 0)) { toast('Every round segment needs a diameter'); return }
    if (seg.type === 'hex'    && (!Number.isFinite(seg.acrossFlats) || seg.acrossFlats <= 0)) { toast('Every hex segment needs an across-flats value'); return }
    if ((seg.type === 'square' || seg.type === 'prism') && (!Number.isFinite(seg.width) || seg.width <= 0)) { toast('Every square/prism segment needs a width'); return }
  }

  const qty = Math.max(1, parseInt(document.getElementById('fab-detect-field-qty').value, 10) || 1)

  const overrides = {}
  const originalById = Object.fromEntries((fabDetectOriginalSegments || []).map(s => [s.id, s]))
  const survivingIds = new Set()

  for (const seg of fabDetectSegments) {
    survivingIds.add(seg.id)
    const original = originalById[seg.id]
    if (!original) { overrides[seg.id] = { ...seg, userAdded: true, reason: 'User-added segment' }; continue }
    const changedFields = {}
    for (const key of Object.keys(seg)) {
      if (key === 'id') continue
      if (seg[key] !== original[key]) changedFields[key] = { value: seg[key], reason: 'User confirmation edit' }
    }
    if (Object.keys(changedFields).length) overrides[seg.id] = changedFields
  }

  const removedIds = Object.keys(originalById).filter(id => !survivingIds.has(id))
  if (removedIds.length) overrides._removedSegmentIds = removedIds

  const meta = part.fabricationMetadata || {}
  const btn  = document.getElementById('btn-confirm-fab-detect')
  btn.disabled = true; btn.textContent = 'Confirming…'

  try {
    const shaftCat = await ensureAxialShaftCategory()
    const totalLength = fabDetectSegments.reduce((s, seg) => s + seg.length, 0)
    const profileValue = { totalLength, segments: fabDetectSegments.map(({ warnings, ...rest }) => rest) }

    const component = await findOrCreateComponentFn({
      categoryId: shaftCat.id,
      fields:     shaftCat.requiredKeysConfig,
      attrs:      { 'Profile': profileValue },
      fallback:   { name: part.partName, description: 'Auto-detected axial shaft', image: null },
      genId,
    })

    const updatedMeta = { ...meta, status: 'queued', overrides: Object.keys(overrides).length ? overrides : (meta.overrides || null) }
    const savedPart = await upsertAssemblyPart({ ...part, componentId: component.id, fabricationMetadata: updatedMeta })

    const job = await createFabricationJob({ assemblyPartId: part.id, quantityRequested: qty, batchId: null, genId })
    registerNewJob(job)

    getPartsCtx.onJobCreated(savedPart, job, fabDetectIsChild)
    closeFabDetectConfirmModal()
    toast(`Confirmed "${part.partName}" — sent ${qty} to Fabricate`)
  } catch (e) {
    console.error(e)
    toast(e.message?.includes('duplicate') ? 'This part already has an active fabrication job.' : 'Error confirming shaft')
  } finally {
    btn.disabled = false
    btn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i> Confirm &amp; send to Fabricate'
  }
}

async function confirmPlateDetection(part) {
  const thickness = parseFloat(document.getElementById('fab-detect-plate-field-thickness').value)
  const material  = document.getElementById('fab-detect-plate-field-material').value
  const qty       = Math.max(1, parseInt(document.getElementById('fab-detect-field-qty').value, 10) || 1)

  if (!Number.isFinite(thickness) || thickness <= 0) { toast('Thickness is required'); return }
  if (!material) { toast('Material is required'); return }

  const meta = part.fabricationMetadata || {}
  const detectedThickness = meta.dimensions?.thickness?.value
  const overrides = {}
  if (detectedThickness !== thickness) overrides.thickness = { value: thickness, unit: 'in', reason: 'User confirmation edit' }

  const btn = document.getElementById('btn-confirm-fab-detect')
  btn.disabled = true; btn.textContent = 'Confirming…'

  try {
    const plateCat = await ensurePlateCategory()
    const attrs = { 'Material': material, 'Thickness': String(thickness) }
    const component = await findOrCreateComponentFn({
      categoryId: plateCat.id,
      fields:     plateCat.requiredKeysConfig,
      attrs,
      fallback:   { name: part.partName, description: `Auto-detected ${material.toLowerCase()} plate`, image: null },
      genId,
    })

    const updatedMeta = { ...meta, status: 'queued', overrides: Object.keys(overrides).length ? overrides : (meta.overrides || null) }
    const savedPart = await upsertAssemblyPart({ ...part, componentId: component.id, fabricationMetadata: updatedMeta })

    const job = await createFabricationJob({ assemblyPartId: part.id, quantityRequested: qty, batchId: null, genId })
    registerNewJob(job)

    getPartsCtx.onJobCreated(savedPart, job, fabDetectIsChild)
    closeFabDetectConfirmModal()
    toast(`Confirmed "${part.partName}" — sent ${qty} to Fabricate`)
  } catch (e) {
    console.error(e)
    toast(e.message?.includes('duplicate') ? 'This part already has an active fabrication job.' : 'Error confirming plate')
  } finally {
    btn.disabled = false
    btn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i> Confirm &amp; send to Fabricate'
  }
}

export async function ignoreFabDetection() {
  const part = currentFabDetectPart()
  if (!part) return
  try {
    const updatedMeta = { ...(part.fabricationMetadata || {}), status: 'ignored' }
    const saved = await upsertAssemblyPart({ ...part, fabricationMetadata: updatedMeta })
    getPartsCtx.onPartUpdated(saved, fabDetectIsChild)
    closeFabDetectConfirmModal()
    toast('Marked as not a spacer')
  } catch (e) {
    console.error(e)
    toast('Error updating part')
  }
}

// ── Row-level display helpers (used by partsTable.js) ────────────
export function fabDetectionBadgeHTML(p) {
  const meta = p.fabricationMetadata
  if (!meta || !meta.autoDetected) return ''
  const noun = meta.kind === 'axial-shaft' ? 'shaft' : meta.kind === 'plate' ? 'plate' : 'spacer'
  const map = {
    detected:     ['fab-job-badge--complete',   'ti-cube-plus',    `${noun[0].toUpperCase()}${noun.slice(1)} detected`],
    needs_review: ['fab-job-badge--committed',  'ti-help-circle',  'Needs review'],
    confirmed:    ['fab-job-badge--in_progress','ti-clock',        'Confirmed'],
    queued:       ['fab-job-badge--queued',     'ti-tool',         'Queued for fab'],
    ignored:      ['fab-job-badge--queued',     'ti-eye-off',      `Not a ${noun}`],
    failed:       ['fab-job-badge--committed',  'ti-alert-triangle','Detection failed'],
  }
  const [cls, icon, label] = map[meta.status] || ['fab-job-badge--queued', 'ti-cube', meta.status]
  return `<span class="fab-job-badge ${cls}" title="${(meta.warnings || []).join(' ')}">
    <i class="ti ${icon}" aria-hidden="true"></i> ${label}
  </span>`
}

export function fabDetectActionable(p) {
  const meta = p.fabricationMetadata
  return !!meta?.autoDetected && ['detected', 'needs_review'].includes(meta.status)
}

// ── Static event bindings ────────────────────────────────────────
export function bindFabDetectionEvents() {
  document.getElementById('btn-close-fab-detect').addEventListener('click', closeFabDetectConfirmModal)
  document.getElementById('btn-cancel-fab-detect').addEventListener('click', closeFabDetectConfirmModal)
  document.getElementById('btn-confirm-fab-detect').addEventListener('click', confirmFabDetection)
  document.getElementById('btn-fab-detect-ignore').addEventListener('click', ignoreFabDetection)
  document.getElementById('fab-detect-candidate-select').addEventListener('change', handleFabDetectCandidateChange)
  document.getElementById('fab-detect-confirm-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeFabDetectConfirmModal()
  })
}