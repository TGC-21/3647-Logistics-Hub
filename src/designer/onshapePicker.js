// src/designer/onshapePicker.js
//
// The three-step "Import from Onshape" / "New from Onshape" modal:
// search documents -> pick an assembly -> preview its BOM -> confirm.
// Fully self-contained: its own state, its own step renderers, and it
// only reaches out at the very end to either POST /api/onshape-bom (link
// mode) or bulkInsertAssemblyParts (import mode) via a small context
// object registered from assemblyDetail.js.

import { bulkInsertAssemblyParts, upsertAssembly, fetchAssemblies } from '../db.js'
import { genId, toast } from './state.js'

// ── State ─────────────────────────────────────────────────────
let onshapeMode       = 'import'   // 'import' | 'link'
let onshapeStep        = 'search'   // 'search' | 'assemblies' | 'preview'
let onshapeQuery        = ''
let onshapeDocs          = []
let onshapeSelectedDoc   = null
let onshapeAssemblies    = []
let onshapeSelectedAsm   = null
let onshapePreviewParts       = []
let onshapePreviewSubassemblies = []
let onshapePreviewWarning       = null
let onshapeCreateName           = ''
let onshapeLoading       = false
let onshapeSearchTimer   = null

/**
 * `ctx` is:
 *   getCurrentAssemblyId()                     -> string | null (import mode target)
 *   onPartsImported(savedParts)                 -> append to current parts + re-render
 *   onAssemblyLinked(assemblyId, docThumbnail)   -> patch onshape fields onto current assembly
 *   onAssemblyCreated(assemblyId)                -> refetch assemblies + navigate to the new one
 * Registered once by assemblyDetail.js.
 */
let ctx = null
export function registerOnshapePickerContext(c) { ctx = c }

export function openOnshapeModal(mode = 'import') {
  onshapeMode         = mode
  onshapeStep         = 'search'
  onshapeQuery        = ''
  onshapeDocs         = []
  onshapeSelectedDoc  = null
  onshapeAssemblies   = []
  onshapeSelectedAsm  = null
  onshapePreviewParts         = []
  onshapePreviewSubassemblies = []
  onshapeCreateName           = ''
  onshapeLoading              = false
  document.getElementById('onshape-import-overlay').style.display = 'flex'
  renderOnshapeModal()
  setTimeout(() => document.getElementById('onshape-search-input')?.focus(), 80)
}

function closeOnshapeModal() {
  document.getElementById('onshape-import-overlay').style.display = 'none'
  clearTimeout(onshapeSearchTimer)
}

function onshapeStepTrail() {
  const steps = [
    { key: 'search',     label: 'Document' },
    { key: 'assemblies', label: 'Assembly' },
    { key: 'preview',    label: onshapeMode === 'link' ? 'Review & link' : 'Preview' },
  ]
  const idx = steps.findIndex(s => s.key === onshapeStep)
  return steps.map((s, i) =>
    i === idx ? `<span class="step-current">${s.label}</span>` : `<span>${s.label}</span>`
  ).join(' &nbsp;→&nbsp; ')
}

function renderOnshapeModal() {
  document.getElementById('onshape-modal-title').textContent =
    onshapeMode === 'link' ? 'New assembly from Onshape' : 'Import from Onshape'
  document.getElementById('onshape-step-trail').innerHTML = onshapeStepTrail()
  document.getElementById('btn-onshape-back').style.display = onshapeStep === 'search' ? 'none' : 'inline-flex'

  const hasContent = onshapePreviewParts.length > 0 || onshapePreviewSubassemblies.length > 0
  const canConfirm = onshapeStep === 'preview' && !onshapeLoading &&
    (onshapeMode === 'link' || hasContent)
  const confirmBtn = document.getElementById('btn-confirm-onshape')
  confirmBtn.style.display = canConfirm ? 'inline-flex' : 'none'
  confirmBtn.innerHTML = onshapeMode === 'link'
    ? '<i class="ti ti-link" aria-hidden="true"></i> Create & link assembly'
    : '<i class="ti ti-check" aria-hidden="true"></i> Import parts'

  if (onshapeStep === 'search')     return renderOnshapeSearchStep()
  if (onshapeStep === 'assemblies') return renderOnshapeAssembliesStep()
  if (onshapeStep === 'preview')    return renderOnshapePreviewStep()
}

// ── Step 1: search documents ───────────────────────────────────
function renderOnshapeSearchStep() {
  const body = document.getElementById('onshape-modal-body')
  body.innerHTML = `
    <div class="onshape-search-row">
      <i class="ti ti-search" aria-hidden="true"></i>
      <input type="text" id="onshape-search-input" placeholder="Search your Onshape documents…" value="${onshapeQuery}">
    </div>
    <div id="onshape-doc-results"></div>`

  document.getElementById('onshape-search-input').addEventListener('input', e => {
    onshapeQuery = e.target.value
    clearTimeout(onshapeSearchTimer)
    onshapeSearchTimer = setTimeout(() => searchOnshapeDocuments(), 300)
  })

  renderOnshapeDocResults()
  searchOnshapeDocuments()
}

async function searchOnshapeDocuments() {
  onshapeLoading = true
  renderOnshapeDocResults()
  try {
    const params = new URLSearchParams({ limit: '20' })
    if (onshapeQuery.trim()) params.set('q', onshapeQuery.trim())
    const res = await fetch(`/api/onshape-documents?${params.toString()}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Search failed')
    onshapeDocs = data.documents || []
  } catch (e) {
    console.error(e)
    onshapeDocs = []
    toast('Error searching Onshape documents')
  } finally {
    onshapeLoading = false
    renderOnshapeDocResults()
  }
}

function renderOnshapeDocResults() {
  const el = document.getElementById('onshape-doc-results')
  if (!el) return

  if (onshapeLoading) {
    el.innerHTML = `<div class="onshape-state"><i class="ti ti-loader-2 spin" aria-hidden="true"></i><div class="onshape-state-title">Searching…</div></div>`
    return
  }
  if (!onshapeDocs.length) {
    el.innerHTML = `<div class="onshape-state">
      <i class="ti ti-file-off" aria-hidden="true"></i>
      <div class="onshape-state-title">No documents found</div>
      <div class="onshape-state-sub">Try a different search term, or check that this document is shared with the Onshape account Partshelf is connected to.</div>
    </div>`
    return
  }

  el.innerHTML = `<div class="onshape-list">${onshapeDocs.map(d => `
    <div class="onshape-list-item" data-doc-id="${d.id}">
      <div class="onshape-list-item-icon">
        ${d.thumbnailUrl ? `<img src="${d.thumbnailUrl}" alt="">` : `<i class="ti ti-file" aria-hidden="true"></i>`}
      </div>
      <div class="onshape-list-item-text">
        <div class="onshape-list-item-name">${d.name}</div>
        <div class="onshape-list-item-meta">${d.owner ? d.owner + ' · ' : ''}${d.modifiedAt ? new Date(d.modifiedAt).toLocaleDateString() : ''}</div>
      </div>
      <i class="ti ti-chevron-right" aria-hidden="true"></i>
    </div>`).join('')}</div>`

  el.querySelectorAll('[data-doc-id]').forEach(item =>
    item.addEventListener('click', () => {
      const doc = onshapeDocs.find(d => d.id === item.dataset.docId)
      if (doc) selectOnshapeDocument(doc)
    })
  )
}

// ── Step 2: pick assembly ──────────────────────────────────────
async function selectOnshapeDocument(doc) {
  onshapeSelectedDoc = doc
  onshapeStep        = 'assemblies'
  onshapeAssemblies   = []
  onshapeLoading      = true
  renderOnshapeModal()

  try {
    const params = new URLSearchParams({ documentId: doc.id, workspaceId: doc.workspaceId })
    const res  = await fetch(`/api/onshape-elements?${params.toString()}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Could not load assemblies')
    onshapeAssemblies = data.assemblies || []
  } catch (e) {
    console.error(e)
    toast(e.message || 'Error loading assemblies')
  } finally {
    onshapeLoading = false
    renderOnshapeModal()
  }
}

function renderOnshapeAssembliesStep() {
  const body = document.getElementById('onshape-modal-body')

  if (onshapeLoading) {
    body.innerHTML = `<div class="onshape-state"><i class="ti ti-loader-2 spin" aria-hidden="true"></i><div class="onshape-state-title">Loading assemblies…</div></div>`
    return
  }
  if (!onshapeAssemblies.length) {
    body.innerHTML = `<div class="onshape-state">
      <i class="ti ti-box-off" aria-hidden="true"></i>
      <div class="onshape-state-title">No assemblies in this document</div>
      <div class="onshape-state-sub">"${onshapeSelectedDoc?.name}" doesn't contain any Assembly elements — only Assemblies have a BOM.</div>
    </div>`
    return
  }

  body.innerHTML = `
    <p style="font-size:12px;color:var(--color-text-tertiary);margin-bottom:10px">From <strong>${onshapeSelectedDoc?.name}</strong> — pick an assembly:</p>
    <div class="onshape-list">${onshapeAssemblies.map(a => `
      <div class="onshape-list-item" data-asm-id="${a.id}">
        <div class="onshape-list-item-icon"><i class="ti ti-cube" aria-hidden="true"></i></div>
        <div class="onshape-list-item-text"><div class="onshape-list-item-name">${a.name}</div></div>
        <i class="ti ti-chevron-right" aria-hidden="true"></i>
      </div>`).join('')}</div>`

  body.querySelectorAll('[data-asm-id]').forEach(item =>
    item.addEventListener('click', () => {
      const asm = onshapeAssemblies.find(a => a.id === item.dataset.asmId)
      if (asm) selectOnshapeAssembly(asm)
    })
  )
}

// ── Step 3: preview & confirm ──────────────────────────────────
async function selectOnshapeAssembly(asm) {
  onshapeSelectedAsm  = asm
  onshapeCreateName   = asm.name
  onshapeStep         = 'preview'
  onshapePreviewParts = []
  onshapeLoading      = true
  renderOnshapeModal()

  try {
    const params = new URLSearchParams({ documentId: asm.documentId, workspaceId: asm.workspaceId, elementId: asm.id })
    const res  = await fetch(`/api/onshape-bom-preview?${params.toString()}`)
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Could not load BOM')
    onshapePreviewParts         = data.parts         || []
    onshapePreviewSubassemblies = data.subassemblies  || []
    onshapePreviewWarning       = data.warning        || null
  } catch (e) {
    console.error(e)
    onshapePreviewSubassemblies = []
    onshapePreviewWarning = null
    toast(e.message || 'Error loading BOM preview')
  } finally {
    onshapeLoading = false
    renderOnshapeModal()
  }
}

function renderOnshapePreviewStep() {
  const body = document.getElementById('onshape-modal-body')

  if (onshapeLoading) {
    body.innerHTML = `<div class="onshape-state"><i class="ti ti-loader-2 spin" aria-hidden="true"></i><div class="onshape-state-title">Fetching BOM…</div></div>`
    return
  }

  const warningHTML = onshapePreviewWarning
    ? `<div class="onshape-preview-warning"><i class="ti ti-alert-triangle" aria-hidden="true"></i><span>${onshapePreviewWarning}</span></div>`
    : ''

  const directCount = onshapePreviewParts.length
  const subCount    = onshapePreviewSubassemblies.length
  const totalParts  = directCount + onshapePreviewSubassemblies.reduce((n, s) => n + (s.children?.parts?.length ?? 0), 0)

  function subassemblyPreviewHTML(subs) {
    if (!subs.length) return ''
    return `<div class="onshape-preview-subassemblies">
      ${subs.map(s => {
        const childCount = s.children?.parts?.length ?? 0
        const grandCount = s.children?.subassemblies?.length ?? 0
        return `<div class="onshape-preview-sub-row">
          <i class="ti ti-cube" style="font-size:13px;color:var(--color-accent);flex-shrink:0" aria-hidden="true"></i>
          <div style="flex:1;min-width:0">
            <span class="onshape-preview-sub-name">${s.partName}</span>
            <span class="onshape-preview-sub-meta">
              × ${s.quantity} &nbsp;·&nbsp; ${childCount} part${childCount === 1 ? '' : 's'}${grandCount ? ` + ${grandCount} sub` : ''}
            </span>
          </div>
          <span class="asm-badge asm-badge--draft" style="flex-shrink:0">child assembly</span>
        </div>`
      }).join('')}
    </div>`
  }

  function directPartsHTML(parts) {
    if (!parts.length) return ''
    return `<div class="parts-table-wrap" style="max-height:200px;overflow-y:auto">
      <table class="parts-table">
        <thead><tr><th>Part name</th><th>Part #</th><th style="text-align:center">Qty</th></tr></thead>
        <tbody>${parts.map(p => `<tr>
          <td>${p.partName}</td>
          <td><span class="part-number">${p.partNumber || '—'}</span></td>
          <td style="text-align:center">${p.quantity}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`
  }

  const emptyHTML = (totalParts === 0 && subCount === 0)
    ? `<div class="onshape-state" style="padding:20px 0">
        <i class="ti ti-list-check" aria-hidden="true"></i>
        <div class="onshape-state-title">BOM is empty</div>
        <div class="onshape-state-sub">No parts found. You can still link the assembly and add parts later.</div>
      </div>`
    : ''

  const summaryLine = (totalParts > 0 || subCount > 0)
    ? `<p style="font-size:12px;color:var(--color-text-tertiary);margin-bottom:10px">
        From <strong>${onshapeSelectedAsm?.name}</strong>:
        ${directCount ? `<strong>${directCount}</strong> direct part${directCount === 1 ? '' : 's'}` : ''}
        ${directCount && subCount ? ' + ' : ''}
        ${subCount ? `<strong>${subCount}</strong> subassembl${subCount === 1 ? 'y' : 'ies'} (will become child assemblies)` : ''}
      </p>`
    : ''

  if (onshapeMode === 'link') {
    body.innerHTML = `
      ${warningHTML}
      <div class="field" style="margin-bottom:14px">
        <label>Assembly name <span class="required-star">*</span></label>
        <input type="text" id="onshape-create-name" value="${onshapeCreateName}" placeholder="e.g. Drivetrain">
      </div>
      ${summaryLine}
      ${subassemblyPreviewHTML(onshapePreviewSubassemblies)}
      ${subCount && directCount ? '<div style="margin:8px 0;font-size:11px;color:var(--color-text-tertiary);font-weight:500;text-transform:uppercase;letter-spacing:.05em">Direct parts</div>' : ''}
      ${directPartsHTML(onshapePreviewParts)}
      ${emptyHTML}`

    requestAnimationFrame(() => {
      const input = document.getElementById('onshape-create-name')
      if (input) input.addEventListener('input', e => { onshapeCreateName = e.target.value })
    })
  } else {
    body.innerHTML = `
      ${warningHTML}
      ${summaryLine}
      ${subassemblyPreviewHTML(onshapePreviewSubassemblies)}
      ${subCount && directCount ? '<div style="margin:8px 0;font-size:11px;color:var(--color-text-tertiary);font-weight:500;text-transform:uppercase;letter-spacing:.05em">Direct parts</div>' : ''}
      ${directPartsHTML(onshapePreviewParts)}
      ${emptyHTML}`
  }
}

function goBackOnshapeStep() {
  if (onshapeStep === 'preview') onshapeStep = 'assemblies'
  else if (onshapeStep === 'assemblies') onshapeStep = 'search'
  renderOnshapeModal()
}

async function confirmOnshapeImport() {
  const confirmBtn = document.getElementById('btn-confirm-onshape')
  confirmBtn.disabled = true
  confirmBtn.textContent = 'Saving…'
  try {
    if (onshapeMode === 'link') await confirmLinkAssembly()
    else await confirmImportParts()
  } catch (e) {
    console.error(e)
    toast('Something went wrong — check console')
  } finally {
    confirmBtn.disabled = false
    renderOnshapeModal()
  }
}

// 'link' mode — delegates to the server for hierarchical BOM build
async function confirmLinkAssembly() {
  const name = (document.getElementById('onshape-create-name')?.value || onshapeCreateName).trim()
  if (!name) {
    document.getElementById('onshape-create-name')?.focus()
    toast('Assembly name is required')
    return
  }

  const asm = onshapeSelectedAsm
  const doc = onshapeSelectedDoc

  const res  = await fetch('/api/onshape-bom', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      documentId:   asm.documentId,
      workspaceId:  asm.workspaceId,
      elementId:    asm.id,
      assemblyName: name,
      thumbnailUrl: doc?.thumbnailUrl || null,
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'Import failed')

  closeOnshapeModal()
  await ctx.onAssemblyCreated(data.assemblyId)
  toast(`"${name}" created — ${data.partCount} part(s), ${data.childCount} subassembly(ies)`)
}

// 'import' mode — add flat parts to the currently open assembly
async function confirmImportParts() {
  const currentAssemblyId = ctx.getCurrentAssemblyId()
  if (!onshapePreviewParts.length || !currentAssemblyId) return

  const parts = onshapePreviewParts.map(p => ({
    id:                genId(),
    assemblyId:        currentAssemblyId,
    partName:          p.partName,
    partNumber:        p.partNumber,
    quantityNeeded:    p.quantity,
    quantityCollected: 0,
    status:            'pending',
    source:            'onshape',
    notes:             '',
    onshapeReference:  p.raw || null,
  }))

  const saved = await bulkInsertAssemblyParts(parts)

  await ctx.onPartsImported(saved, onshapeSelectedAsm, onshapeSelectedDoc)

  closeOnshapeModal()
  toast(`Imported ${saved.length} part${saved.length === 1 ? '' : 's'} from Onshape`)
}

// ── Static event bindings ────────────────────────────────────────
export function bindOnshapePickerEvents() {
  document.getElementById('btn-close-onshape-modal').addEventListener('click', closeOnshapeModal)
  document.getElementById('btn-cancel-onshape').addEventListener('click', closeOnshapeModal)
  document.getElementById('btn-onshape-back').addEventListener('click', goBackOnshapeStep)
  document.getElementById('btn-confirm-onshape').addEventListener('click', confirmOnshapeImport)
  document.getElementById('onshape-import-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeOnshapeModal()
  })
}