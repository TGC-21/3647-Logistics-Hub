// src/designer/assemblyGrid.js
//
// The "All assemblies" grid (root of Designer mode when nothing is
// selected) and the New/Edit assembly modal. Talks to assemblyDetail.js
// only via the exported openAssemblyModal/asmCardHTML — navigation itself
// (selectAssembly) is owned by assemblyDetail.js since it also has to
// manage the child-view stack.

import { upsertAssembly } from '../db.js'
import { genId, toast, statusLabel, getAssemblies, setAssemblies, assemblyById } from './state.js'
import { upsertAssemblyVersioned } from './versionedMutations.js'
import { getCurrentMemberId } from '../members.js'
import { openHistoryModal, openCascadeHistoryModal } from '../historyPanel.js'

let editingAssemblyId = null

/**
 * `ctx` is:
 *   onAssemblySaved(savedAssembly, wasNew) -> update list + navigate to it
 */
let ctx = null
export function registerAssemblyGridContext(c) { ctx = c }

export function renderAssemblyGrid() {
  const title = document.getElementById('content-title')
  const meta  = document.getElementById('content-meta')
  const area  = document.getElementById('main-area')
  const assemblies = getAssemblies()

  title.textContent = 'Assemblies'
  meta.textContent  = assemblies.length === 1 ? '1 assembly' : `${assemblies.length} assemblies`

  if (!assemblies.length) {
    area.innerHTML = `<div class="empty">
      <i class="ti ti-box-off" aria-hidden="true"></i>
      <div class="empty-title">No assemblies yet</div>
      <div class="empty-sub">Create one manually, or pull directly from Onshape to auto-populate the name and BOM.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">
        <button class="btn btn-primary" id="empty-new-asm-btn"><i class="ti ti-plus"></i> New assembly</button>
        <button class="btn" id="empty-new-from-onshape-btn"><i class="ti ti-cube"></i> New from Onshape</button>
      </div>
    </div>`
    document.getElementById('empty-new-asm-btn').addEventListener('click', () => openAssemblyModal())
    document.getElementById('empty-new-from-onshape-btn').addEventListener('click', () => ctx.openOnshapeLinkFlow())
    return
  }

  area.innerHTML = `<div class="asm-grid">${assemblies.map(asmCardHTML).join('')}</div>`
  area.querySelectorAll('[data-open-asm]').forEach(el =>
    el.addEventListener('click', () => ctx.selectAssembly(el.dataset.openAsm))
  )
 
  area.querySelectorAll('[data-history-asm]').forEach(el =>
    el.addEventListener('click', e => {
      e.stopPropagation()   // must run before the click bubbles to the
                             // ancestor .asm-card's data-open-asm listener
      const a = assemblies.find(x => x.id === el.dataset.historyAsm)
      openHistoryModal('assembly', el.dataset.historyAsm, a?.name)
    })
  )
}

export function asmCardHTML(a) {
  const isLinked = !!a.onshapeElementId
  const onshapeLink = a.onshapeUrl
    ? `<a class="asm-card-link" href="${a.onshapeUrl}" target="_blank" rel="noreferrer" onclick="event.stopPropagation()">
        <i class="ti ti-external-link" aria-hidden="true"></i> Open in Onshape
      </a>`
    : ''

  const thumbHTML = a.thumbnail
    ? `<div class="asm-card-thumb"><img src="${a.thumbnail}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
    : ''

  const linkedBadge = isLinked
    ? `<span class="asm-linked-badge"><i class="ti ti-link" aria-hidden="true"></i> Linked</span>`
    : ''

  return `<div class="asm-card" data-open-asm="${a.id}">
    ${thumbHTML}
    <div class="asm-card-header">
      <div class="asm-card-name">${a.name}</div>
      <div style="display:flex;gap:4px;align-items:center;flex-shrink:0">
        ${linkedBadge}
        ${statusLabel(a.status)}
        <button class="btn-icon" data-history-asm="${a.id}" aria-label="History" title="View change history" onclick="event.stopPropagation()">
          <i class="ti ti-history" style="font-size:13px"></i>
        </button>
      </div>
    </div>
    ${a.description ? `<div class="asm-card-desc">${a.description}</div>` : ''}
    ${onshapeLink}
  </div>`
}

// ── Assembly modal ────────────────────────────────────────────
export function openAssemblyModal(id) {
  editingAssemblyId = id || null
  const a = id ? assemblyById(id) : null

  document.getElementById('asm-modal-title').textContent = a ? 'Edit assembly' : 'New assembly'
  document.getElementById('asm-field-name').value        = a?.name || ''
  document.getElementById('asm-field-desc').value        = a?.description || ''
  document.getElementById('asm-field-url').value         = a?.onshapeUrl || ''
  document.getElementById('asm-field-status').value      = a?.status || 'draft'
  document.getElementById('asm-modal-overlay').style.display = 'flex'
  setTimeout(() => document.getElementById('asm-field-name').focus(), 80)
}

function closeAssemblyModal() {
  document.getElementById('asm-modal-overlay').style.display = 'none'
  editingAssemblyId = null
}

async function saveAssembly() {
  const name = document.getElementById('asm-field-name').value.trim()
  if (!name) { document.getElementById('asm-field-name').focus(); toast('Name is required'); return }

  const saveBtn = document.getElementById('btn-save-asm')
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…'

  const payload = {
    id:          editingAssemblyId || genId(),
    name,
    description: document.getElementById('asm-field-desc').value.trim(),
    onshapeUrl:  document.getElementById('asm-field-url').value.trim(),
    status:      document.getElementById('asm-field-status').value,
  }

  if (editingAssemblyId) {
    const existing = assemblyById(editingAssemblyId)
    payload.onshapeDocumentId  = existing?.onshapeDocumentId  || ''
    payload.onshapeWorkspaceId = existing?.onshapeWorkspaceId || ''
    payload.onshapeElementId   = existing?.onshapeElementId   || ''
    payload.thumbnail          = existing?.thumbnail          || null
  }

  try {
    const saved = await upsertAssemblyVersioned(payload, getCurrentMemberId())
    const wasNew = !editingAssemblyId
    const assemblies = getAssemblies()
    setAssemblies(wasNew ? [saved, ...assemblies] : assemblies.map(a => a.id === saved.id ? saved : a))

    closeAssemblyModal()
    ctx.onAssemblySaved(saved, wasNew)
    toast(wasNew ? 'Assembly created' : 'Assembly updated')
  } catch (e) {
    console.error(e)
    toast('Error saving assembly')
  } finally {
    saveBtn.disabled = false
    saveBtn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i> Save'
  }
}

// ── Static event bindings ────────────────────────────────────────
export function bindAssemblyGridEvents() {
  document.getElementById('btn-close-asm-modal').addEventListener('click', closeAssemblyModal)
  document.getElementById('btn-cancel-asm').addEventListener('click', closeAssemblyModal)
  document.getElementById('btn-save-asm').addEventListener('click', saveAssembly)
  document.getElementById('asm-modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeAssemblyModal()
  })
}