// src/designer/assemblyDetail.js
//
// The orchestrator. Owns currentAssemblyId/currentParts/navigationStack
// (via state.js) and the two detail renderers (root assembly, subassembly
// node). Every other split-out module (partsTable, fabDetection,
// onshapePicker, bomImport, inventoryLink, fabricateFlow, partOrdersCart)
// is state-agnostic and talks to this file through a small registered
// context object — this is the one place that knows how root vs. child
// parts are stored and when a re-render / status-sync needs to happen.

import {
  fetchAssemblies, upsertAssembly, deleteAssembly,
  fetchAssemblyParts, fetchAssemblyChildren, fetchChildrenOfChild,
  fetchAssemblyChildById, fetchChildParts,
  releaseInstances, fetchAllLinkedInstanceIdsForAssembly,
  fetchActiveJobsForParts, fetchActiveCartItemsForParts,
  fetchRootAssemblyIdForChild, findOrCreateComponent, fetchAllAssemblyPartIdsForAssembly,
  deletePendingCartItemsForAssemblyPartIds, 
} from '../db.js'

import {
  toast, genId, assemblyById, statusLabel, partsProgress, derivedAssemblyStatus,
  getAssemblies, setAssemblies,
  getCurrentAssemblyId, setCurrentAssemblyId,
  getCurrentParts, setCurrentParts,
  getCurrentPartJobs, setCurrentPartJobs,
  getCurrentPartOrders, setCurrentPartOrders,
  getCurrentChildren, setCurrentChildren,
  getNavigationStack, setNavigationStack,
  getIsolatedMode, setIsolatedMode,
  getViewingChildId, setViewingChildId,
  getChildNavStack, setChildNavStack,
  getChildDetailTab, setChildDetailTab,
  getCurrentChildName, setCurrentChildName,
  getCurrentChildParts, setCurrentChildParts,
  getCurrentChildChildren, setCurrentChildChildren,
  getCurrentChildPartJobs, setCurrentChildPartJobs,
  getCurrentChildPartOrders, setCurrentChildPartOrders,
  getDetailTab, setDetailTab,
  getFabFilter, setFabFilter,
  getPartSearchQuery, setPartSearchQuery,
  getPartNumberOnly, setPartNumberOnly,
  resetPartFilters, partRowVisible,
} from './state.js'
export {getAssemblies}
import {
  partRowHTML, childPartRowHTML, bindPartRowEvents, bindChildPartRowEvents,
  fabFilterSelectHTML, partSearchToolbarHTML,
  registerPartsTableContext, openPartModal,
} from './partsTable.js'

import {
  initFabDetection, registerFabDetectionContext, openFabDetectConfirmModal,
} from './fabDetection.js'

import {
  registerOnshapePickerContext, openOnshapeModal,
} from './onshapePicker.js'

import { registerBomImportContext, openBomImportModal } from './bomImport.js'
import { registerInventoryLinkContext, openInventoryLinkModal, toggleLinkedDetail } from './inventoryLink.js'
import { registerFabricateFlowContext, openSendToFabricateModal } from './fabricateFlow.js'
import { registerPartOrdersCartContext, addPartToCart } from './partOrdersCart.js'
import { renderAssemblyGrid, openAssemblyModal, registerAssemblyGridContext } from './assemblyGrid.js'
import { deleteAssemblyWithHistory } from './versionedMutations.js'
import { getCurrentMemberId } from '../members.js'

let fabDetectRunning = false

// ── Boot ──────────────────────────────────────────────────────
export async function designerBoot() {
  setAssemblies(await fetchAssemblies())
}

// ── Isolated single-node window ("?asm=<id>" / "?child=<id>") ──
export async function bootIsolatedAssembly(assemblyId) {
  setIsolatedMode(true)
  setNavigationStack([])
  await designerBoot()
  selectAssembly(assemblyId)
}

export async function bootIsolatedChild(childId) {
  setIsolatedMode(true)
  setViewingChildId(childId)
  await renderChildDetail()
}

function enterChildAssembly(childId) {
  const fromLabel = getViewingChildId()
    ? (getCurrentChildName() || 'Subassembly')
    : (assemblyById(getCurrentAssemblyId())?.name || 'Assembly')
  setChildNavStack([...getChildNavStack(), { id: getViewingChildId(), name: fromLabel }])
  setViewingChildId(childId)
  setChildDetailTab('parts')
  renderDesignerContent()
}

function exitChildAssembly() {
  const stack = [...getChildNavStack()]
  const parent = stack.pop()
  setChildNavStack(stack)
  setViewingChildId(parent ? parent.id : null)
  setChildDetailTab('parts')
  renderDesignerContent()
}

// ── Sidebar ───────────────────────────────────────────────────
export function renderDesignerSidebar() {
  const assemblies = getAssemblies()
  const currentAssemblyId = getCurrentAssemblyId()

  const navAll = document.getElementById('nav-all')
  navAll.innerHTML = `<i class="ti ti-stack-2" aria-hidden="true"></i> All assemblies
    <span class="nav-count" id="all-count">${assemblies.length}</span>`
  navAll.className = 'nav-item' + (!currentAssemblyId ? ' active' : '')

  const catNav = document.getElementById('cat-nav')
  catNav.innerHTML = assemblies.map(a => {
    const active = currentAssemblyId === a.id
    return `<div class="nav-item asm-nav-item${active ? ' active' : ''}" data-asm-nav="${a.id}">
      <i class="ti ti-box" style="font-size:15px;flex-shrink:0" aria-hidden="true"></i>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px">${a.name}</span>
      ${statusLabel(a.status)}
    </div>`
  }).join('')

  document.getElementById('tags-divider').style.display  = 'none'
  document.getElementById('tags-label').style.display    = 'none'
  document.getElementById('tags-nav').innerHTML          = ''
  document.getElementById('sidebar-label-cats').textContent = 'Assemblies'

  catNav.querySelectorAll('[data-asm-nav]').forEach(el =>
    el.addEventListener('click', () => selectAssembly(el.dataset.asmNav))
  )
}

// ── Content dispatcher ──────────────────────────────────────────
export async function renderDesignerContent() {
  if (getViewingChildId()) await renderChildDetail()
  else if (getCurrentAssemblyId()) await renderAssemblyDetail()
  else renderAssemblyGrid()
}

// ── Root assembly detail ─────────────────────────────────────
async function renderAssemblyDetail() {
  const currentAssemblyId = getCurrentAssemblyId()
  const assembly = assemblyById(currentAssemblyId)
  if (!assembly) { selectAssembly(null); return }

  const title = document.getElementById('content-title')
  const meta  = document.getElementById('content-meta')
  const area  = document.getElementById('main-area')

  title.textContent = assembly.name
  meta.innerHTML    = statusLabel(assembly.status)
  area.innerHTML = `<div class="empty"><i class="ti ti-loader-2 spin"></i><div class="empty-title">Loading…</div></div>`

  let currentParts, currentChildren
  try {
    ;[currentParts, currentChildren] = await Promise.all([
      fetchAssemblyParts(currentAssemblyId),
      fetchAssemblyChildren(currentAssemblyId),
    ])
    setCurrentParts(currentParts)
    setCurrentChildren(currentChildren)
    setCurrentPartJobs(await fetchActiveJobsForParts(currentParts.map(p => p.id)))
    setCurrentPartOrders(await fetchActiveCartItemsForParts(currentParts.map(p => p.id)))
  } catch (e) {
    area.innerHTML = `<div class="empty"><i class="ti ti-alert-circle"></i><div class="empty-title">Error loading assembly</div></div>`
    return
  }

  const currentPartJobs = getCurrentPartJobs()
  const currentPartOrders = getCurrentPartOrders()
  const navigationStack = getNavigationStack()
  const isolatedMode = getIsolatedMode()
  const detailTab = getDetailTab()
  const fabFilter = getFabFilter()

  const prog     = partsProgress(currentParts)
  const isLinked = !!assembly.onshapeElementId
  const isChild  = navigationStack.length > 0
  const parent   = isChild ? navigationStack[navigationStack.length - 1] : null

  const breadcrumbHTML = navigationStack.length
    ? `<div class="asm-breadcrumb">
        <span class="asm-breadcrumb-root" id="btn-breadcrumb-root">
          <i class="ti ti-layout-grid" style="font-size:11px"></i> All assemblies
        </span>
        ${navigationStack.map((step, i) =>
          `<span class="asm-breadcrumb-sep">›</span>
           <span class="asm-breadcrumb-step" data-breadcrumb-idx="${i}">${step.name}</span>`
        ).join('')}
        <span class="asm-breadcrumb-sep">›</span>
        <span class="asm-breadcrumb-current">${assembly.name}</span>
      </div>`
    : ''

  const backLabel = isolatedMode
    ? `<i class="ti ti-x" aria-hidden="true"></i> Close`
    : isChild
      ? `<i class="ti ti-arrow-left" aria-hidden="true"></i> ${parent.name}`
      : `<i class="ti ti-arrow-left" aria-hidden="true"></i> All assemblies`

  const onshapeBtn = assembly.onshapeUrl
    ? `<a class="btn btn-sm" href="${assembly.onshapeUrl}" target="_blank" rel="noreferrer">
        <i class="ti ti-external-link" aria-hidden="true"></i> Onshape
      </a>`
    : ''

  const linkedBadge = isLinked
    ? `<span class="asm-linked-badge asm-linked-badge--detail"><i class="ti ti-link" aria-hidden="true"></i> Linked to Onshape</span>`
    : ''

  const reimportBtn = isLinked
    ? `<button class="btn btn-sm" id="btn-reimport-asm"><i class="ti ti-refresh" aria-hidden="true"></i><span> Re-import</span></button>`
    : ''

  const detectFabBtn = isLinked
    ? `<button class="btn btn-sm" id="btn-detect-fabrication">
         <i class="ti ti-scan" aria-hidden="true"></i><span> Detect fabrication candidates</span>
       </button>`
    : ''

  const childrenHTML = currentChildren.length
    ? `<div class="asm-grid">
        ${currentChildren.map(c => {
          const thumbHTML = c.thumbnail
            ? `<div class="asm-card-thumb"><img src="${c.thumbnail}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
            : ''
          return `<div class="asm-card asm-subasm-card" data-open-child="${c.id}" title="Opens in a new window">
            <i class="ti ti-arrow-up-right asm-card-open-icon" aria-hidden="true"></i>
            ${thumbHTML}
            <div class="asm-card-header"><div class="asm-card-name">${c.name}</div></div>
            <div class="asm-child-qty">× ${c.quantity}</div>
          </div>`
        }).join('')}
      </div>`
    : `<div class="empty" style="padding:40px 0">
        <i class="ti ti-cube-off" aria-hidden="true"></i>
        <div class="empty-title">No subassemblies</div>
        <div class="empty-sub">This assembly has no child assemblies linked from Onshape.</div>
      </div>`

  const tabsHTML = currentChildren.length
    ? `<div class="asm-detail-tabs">
        <button class="asm-detail-tab${detailTab === 'parts' ? ' active' : ''}" id="tab-btn-parts">
          Parts <span class="section-count">${currentParts.length}</span>
        </button>
        <button class="asm-detail-tab${detailTab === 'subassemblies' ? ' active' : ''}" id="tab-btn-subassemblies">
          Subassemblies <span class="section-count">${currentChildren.length}</span>
        </button>
      </div>`
    : ''

  const showSubTab = detailTab === 'subassemblies' && currentChildren.length

  const partsSectionHTML = showSubTab ? '' : `
      <div class="asm-parts-toolbar">
        ${tabsHTML ? '' : `<div class="asm-parts-title">Parts <span class="section-count">${currentParts.length}</span></div>`}
        ${partSearchToolbarHTML(getPartSearchQuery(), getPartNumberOnly())}
        <div style="flex:1"></div>
        <button class="btn btn-sm" id="btn-import-csv"><i class="ti ti-upload" aria-hidden="true"></i><span> Import CSV</span></button>
        <button class="btn btn-sm" id="btn-import-onshape"><i class="ti ti-cube" aria-hidden="true"></i><span> Import from Onshape</span></button>
        ${assembly.onshapeElementId ? fabFilterSelectHTML(fabFilter) : ''}
        <button class="btn btn-primary btn-sm" id="btn-add-part"><i class="ti ti-plus" aria-hidden="true"></i><span> Add part</span></button>
      </div>

      ${currentParts.length
        ? `<div class="parts-table-wrap">
            <table class="parts-table">
              <thead>
                <tr>
                  <th>Part name</th>
                  <th>Part #</th>
                  <th style="text-align:center">Needed</th>
                  <th style="text-align:center">Collected</th>
                  <th style="text-align:center">Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody id="parts-tbody">
                ${currentParts.filter(partRowVisible).map(p => partRowHTML(p, currentPartJobs[p.id] || null, currentPartOrders[p.id] || [])).join('')}
              </tbody>
            </table>
          </div>`
        : `<div class="empty" style="padding:40px 0">
            <i class="ti ti-list-check" aria-hidden="true"></i>
            <div class="empty-title">No direct parts</div>
            <div class="empty-sub">${currentChildren.length
              ? 'Parts for this assembly live within its subassemblies above.'
              : 'Add parts manually, import a CSV, or pull from Onshape.'}</div>
          </div>`}`

  area.innerHTML = `
    <div class="asm-detail">
      ${breadcrumbHTML}
      <div class="asm-detail-toolbar">
        <button class="btn btn-sm" id="btn-back-asm">${backLabel}</button>
        ${linkedBadge}
        <div style="flex:1"></div>
        ${reimportBtn}
        ${onshapeBtn}
        ${detectFabBtn}
        <button class="btn btn-sm" id="btn-edit-asm"><i class="ti ti-edit" aria-hidden="true"></i><span> Edit</span></button>
        <button class="btn btn-danger btn-sm" id="btn-delete-asm"><i class="ti ti-trash" aria-hidden="true"></i></button>
      </div>

      ${assembly.description ? `<p class="asm-detail-desc">${assembly.description}</p>` : ''}

      <div class="asm-progress-row">
        <div class="asm-progress-bar"><div class="asm-progress-fill" style="width:${prog.pct}%"></div></div>
        <div class="asm-progress-label">${prog.collected} / ${prog.total} collected (${prog.pct}%)</div>
      </div>

      ${tabsHTML}
      ${showSubTab ? `<div style="margin-top:12px">${childrenHTML}</div>` : ''}
      ${partsSectionHTML}
    </div>`

  document.getElementById('btn-back-asm').addEventListener('click', () => {
    if (isolatedMode) { window.close(); return }
    isChild ? navigateUp() : selectAssembly(null)
  })
  document.getElementById('tab-btn-parts')?.addEventListener('click', () => { setDetailTab('parts'); renderAssemblyDetail() })
  document.getElementById('tab-btn-subassemblies')?.addEventListener('click', () => { setDetailTab('subassemblies'); renderAssemblyDetail() })
  document.getElementById('btn-edit-asm').addEventListener('click', () => openAssemblyModal(currentAssemblyId))
  document.getElementById('btn-delete-asm').addEventListener('click', deleteCurrentAssembly)
  document.getElementById('btn-add-part')?.addEventListener('click', () => openPartModal())
  document.getElementById('btn-import-csv')?.addEventListener('click', openBomImportModal)
  document.getElementById('btn-import-onshape')?.addEventListener('click', () => openOnshapeModal('import'))
  document.getElementById('btn-detect-fabrication')?.addEventListener('click', runFabricationDetection)
  document.getElementById('fab-filter-select')?.addEventListener('change', e => { setFabFilter(e.target.value); renderAssemblyDetail() })
  document.getElementById('chk-part-number-only')?.addEventListener('change', e => { setPartNumberOnly(e.target.checked); renderAssemblyDetail() })

  let partSearchTimer
  document.getElementById('part-search-input')?.addEventListener('input', e => {
    setPartSearchQuery(e.target.value)
    clearTimeout(partSearchTimer)
    partSearchTimer = setTimeout(() => {
      renderAssemblyDetail()
      const input = document.getElementById('part-search-input')
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length) }
    }, 200)
  })

  if (isLinked) {
    document.getElementById('btn-reimport-asm').addEventListener('click', () => confirmReimport(assembly))
  }

  document.getElementById('btn-breadcrumb-root')?.addEventListener('click', () => selectAssembly(null))
  area.querySelectorAll('[data-breadcrumb-idx]').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.breadcrumbIdx, 10)
      const stack = [...getNavigationStack()]
      stack.splice(idx + 1)
      const target = stack.pop()
      setNavigationStack(stack)
      setCurrentAssemblyId(target.id)
      setCurrentParts([])
      setCurrentChildren([])
      renderDesignerSidebar()
      renderDesignerContent()
    })
  })

  area.querySelectorAll('[data-open-child]').forEach(el =>
    el.addEventListener('click', () => enterChildAssembly(el.dataset.openChild))
  )

  bindPartRowEvents()
}

// ── Fabrication detection trigger ────────────────────────────
async function runFabricationDetection() {
  const currentAssemblyId = getCurrentAssemblyId()
  if (!currentAssemblyId || fabDetectRunning) return
  fabDetectRunning = true
  const btn = document.getElementById('btn-detect-fabrication')
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2 spin" aria-hidden="true"></i><span> Scanning…</span>' }

  try {
    const res  = await fetch('/api/onshape-detect-fabrication', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ assemblyId: currentAssemblyId }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Detection failed')

    setCurrentParts(await fetchAssemblyParts(currentAssemblyId))
    renderAssemblyDetail()
    toast(data.message || 'Detection complete')
  } catch (e) {
    console.error(e)
    toast(e.message || 'Error running fabrication detection')
  } finally {
    fabDetectRunning = false
  }
}

async function runFabricationDetectionForChild() {
  if (fabDetectRunning) return
  fabDetectRunning = true
  const btn = document.getElementById('btn-detect-fabrication')
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ti ti-loader-2 spin" aria-hidden="true"></i><span> Scanning…</span>' }
  try {
    const rootAssemblyId = await fetchRootAssemblyIdForChild(getViewingChildId())
    const res = await fetch('/api/onshape-detect-fabrication', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assemblyId: rootAssemblyId }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Detection failed')
    setCurrentChildParts(await fetchChildParts(getViewingChildId()))
    renderChildDetail()
    toast(data.message || 'Detection complete')
  } catch (e) {
    console.error(e)
    toast(e.message || 'Error running fabrication detection')
  } finally {
    fabDetectRunning = false
  }
}

// ── Subassembly node detail ─────────────────────────────────
async function renderChildDetail() {
  const title = document.getElementById('content-title')
  const meta  = document.getElementById('content-meta')
  const area  = document.getElementById('main-area')
  const viewingChildId = getViewingChildId()

  area.innerHTML = `<div class="empty"><i class="ti ti-loader-2 spin"></i><div class="empty-title">Loading…</div></div>`

  let child, currentChildParts, currentChildChildren
  try {
    ;[child, currentChildParts, currentChildChildren] = await Promise.all([
      fetchAssemblyChildById(viewingChildId),
      fetchChildParts(viewingChildId),
      fetchChildrenOfChild(viewingChildId),
    ])
    setCurrentChildParts(currentChildParts)
    setCurrentChildChildren(currentChildChildren)
    setCurrentChildPartJobs(await fetchActiveJobsForParts(currentChildParts.map(p => p.id)))
    setCurrentChildPartOrders(await fetchActiveCartItemsForParts(currentChildParts.map(p => p.id)))
  } catch (e) {
    area.innerHTML = `<div class="empty"><i class="ti ti-alert-circle"></i><div class="empty-title">Error loading subassembly</div></div>`
    return
  }

  const isLinked = !!child.onshapeElementId
  setCurrentChildName(child.name)
  const childNavStack = getChildNavStack()
  const parentLabel = childNavStack.length ? childNavStack[childNavStack.length - 1].name : ''
  const isolatedMode = getIsolatedMode()
  const childDetailTab = getChildDetailTab()
  const currentChildPartJobs = getCurrentChildPartJobs()
  const currentChildPartOrders = getCurrentChildPartOrders()

  title.textContent = child.name
  meta.innerHTML    = `<span class="asm-badge asm-badge--draft"><i class="ti ti-git-branch" aria-hidden="true"></i> Subassembly${parentLabel ? ' of ' + parentLabel : ''}</span>`
  const prog = partsProgress(currentChildParts)

  const detectFabBtn = isLinked
    ? `<button class="btn btn-sm" id="btn-detect-fabrication">
         <i class="ti ti-scan" aria-hidden="true"></i><span> Detect fabrication candidates</span>
       </button>`
    : ''
  const onshapeBtn = child.onshapeUrl
    ? `<a class="btn btn-sm" href="${child.onshapeUrl}" target="_blank" rel="noreferrer">
        <i class="ti ti-external-link" aria-hidden="true"></i> Onshape
      </a>`
    : ''

  const childrenHTML = currentChildChildren.length
    ? `<div class="asm-grid">
        ${currentChildChildren.map(c => {
          const thumbHTML = c.thumbnail
            ? `<div class="asm-card-thumb"><img src="${c.thumbnail}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
            : ''
          return `<div class="asm-card asm-subasm-card" data-open-child="${c.id}" title="Opens in a new window">
            <i class="ti ti-arrow-up-right asm-card-open-icon" aria-hidden="true"></i>
            ${thumbHTML}
            <div class="asm-card-header"><div class="asm-card-name">${c.name}</div></div>
            <div class="asm-child-qty">× ${c.quantity}</div>
          </div>`
        }).join('')}
      </div>`
    : `<div class="empty" style="padding:40px 0"><i class="ti ti-cube-off" aria-hidden="true"></i><div class="empty-title">No subassemblies</div></div>`

  const tabsHTML = currentChildChildren.length
    ? `<div class="asm-detail-tabs">
        <button class="asm-detail-tab${childDetailTab === 'parts' ? ' active' : ''}" id="tab-btn-parts">
          Parts <span class="section-count">${currentChildParts.length}</span>
        </button>
        <button class="asm-detail-tab${childDetailTab === 'subassemblies' ? ' active' : ''}" id="tab-btn-subassemblies">
          Subassemblies <span class="section-count">${currentChildChildren.length}</span>
        </button>
      </div>`
    : ''

  const showSubTab = childDetailTab === 'subassemblies' && currentChildChildren.length

  const partsSectionHTML = showSubTab ? '' : `
      ${tabsHTML ? '' : `<div class="asm-parts-toolbar"><div class="asm-parts-title">Parts <span class="section-count">${currentChildParts.length}</span></div>${partSearchToolbarHTML(getPartSearchQuery(), getPartNumberOnly())}</div>`}
      ${currentChildParts.length
        ? `<div class="parts-table-wrap">
            <table class="parts-table">
              <thead>
                <tr>
                  <th>Part name</th>
                  <th>Linked Part(s)</th>
                  <th>Part #</th>
                  <th style="text-align:center">Needed</th>
                  <th style="text-align:center">Collected</th>
                  <th style="text-align:center">Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody id="child-parts-tbody">
                ${currentChildParts.filter(partRowVisible).map(p => childPartRowHTML(p, currentChildPartJobs[p.id] || null, currentChildPartOrders[p.id] || [])).join('')}
              </tbody>
            </table>
          </div>`
        : `<div class="empty" style="padding:40px 0"><i class="ti ti-list-check" aria-hidden="true"></i><div class="empty-title">No direct parts</div></div>`}`

  const backLabel = isolatedMode
    ? `<i class="ti ti-x" aria-hidden="true"></i> Close`
    : `<i class="ti ti-arrow-left" aria-hidden="true"></i> Return to ${parentLabel || 'parent assembly'}`

  area.innerHTML = `
    <div class="asm-detail">
      <div class="asm-detail-toolbar">
        <button class="btn btn-sm" id="btn-back-asm">${backLabel}</button>
        <span class="asm-linked-badge asm-linked-badge--detail"><i class="ti ti-link" aria-hidden="true"></i> From Onshape</span>
        <div style="flex:1"></div>
        ${detectFabBtn}
        ${onshapeBtn}
      </div>

      <div class="asm-progress-row">
        <div class="asm-progress-bar"><div class="asm-progress-fill" style="width:${prog.pct}%"></div></div>
        <div class="asm-progress-label">${prog.collected} / ${prog.total} collected (${prog.pct}%)</div>
      </div>

      ${tabsHTML}
      ${showSubTab ? `<div style="margin-top:12px">${childrenHTML}</div>` : ''}
      ${partsSectionHTML}
    </div>`

  document.getElementById('btn-back-asm').addEventListener('click', () => {
    if (isolatedMode) { window.close(); return }
    exitChildAssembly()
  })
  document.getElementById('btn-detect-fabrication')?.addEventListener('click', runFabricationDetectionForChild)
  document.getElementById('tab-btn-parts')?.addEventListener('click', () => { setChildDetailTab('parts'); renderChildDetail() })
  document.getElementById('tab-btn-subassemblies')?.addEventListener('click', () => { setChildDetailTab('subassemblies'); renderChildDetail() })
  document.getElementById('chk-part-number-only')?.addEventListener('change', e => { setPartNumberOnly(e.target.checked); renderChildDetail() })

  let childPartSearchTimer
  document.getElementById('part-search-input')?.addEventListener('input', e => {
    setPartSearchQuery(e.target.value)
    clearTimeout(childPartSearchTimer)
    childPartSearchTimer = setTimeout(() => {
      renderChildDetail()
      const input = document.getElementById('part-search-input')
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length) }
    }, 200)
  })

  area.querySelectorAll('[data-open-child]').forEach(el =>
    el.addEventListener('click', () => enterChildAssembly(el.dataset.openChild))
  )

  bindChildPartRowEvents()
}

// ── Navigation ────────────────────────────────────────────────
export function selectAssembly(id) {
  setCurrentAssemblyId(id)
  setCurrentParts([])
  setCurrentChildren([])
  setNavigationStack([])
  setViewingChildId(null)
  setChildNavStack([])
  setDetailTab('parts')
  resetPartFilters()
  renderDesignerSidebar()
  renderDesignerContent()
}

function navigateUp() {
  const stack = [...getNavigationStack()]
  const parent = stack.pop()
  setNavigationStack(stack)
  if (!parent) { selectAssembly(null); return }
  setCurrentAssemblyId(parent.id)
  setCurrentParts([])
  setCurrentChildren([])
  setDetailTab('parts')
  renderDesignerSidebar()
  renderDesignerContent()
}

async function syncAssemblyStatus() {
  const currentAssemblyId = getCurrentAssemblyId()
  const assembly = assemblyById(currentAssemblyId)
  if (!assembly) return
  const newStatus = derivedAssemblyStatus(getCurrentParts())
  if (newStatus !== assembly.status) {
    const updated = await upsertAssembly({ ...assembly, status: newStatus })
    setAssemblies(getAssemblies().map(a => a.id === currentAssemblyId ? updated : a))
  }
}

async function deleteCurrentAssembly() {
  const currentAssemblyId = getCurrentAssemblyId()
  const a = assemblyById(currentAssemblyId)
  if (!a || !confirm(`Delete assembly "${a.name}" and all its parts? This cannot be undone.`)) return
  try {
    const result = await deleteAssemblyWithHistory(currentAssemblyId, getCurrentMemberId())
    setAssemblies(getAssemblies().filter(x => x.id !== currentAssemblyId))
    selectAssembly(null)
    toast(`Assembly deleted (${result.deletedPartCount} part(s) logged, ${result.deletedChildCount} subassembly(ies) logged)`)
  } catch (e) { console.error(e); toast('Error deleting assembly') }
}

// ── Re-import ─────────────────────────────────────────────────
async function confirmReimport(assembly) {
  const warningMsg =
    `Re-import "${assembly.name}" from Onshape?\n\n` +
    `• All BOM parts and subassembly links will be rebuilt from scratch.\n` +
    `• Collected quantities will be restored by part number where possible.\n` +
    `• Manually-added parts are kept; Onshape-sourced parts are replaced.\n\n` +
    `This cannot be undone.`
  if (!confirm(warningMsg)) return

  const area = document.getElementById('main-area')
  area.innerHTML = `<div class="empty"><i class="ti ti-loader-2 spin"></i><div class="empty-title">Re-importing from Onshape…</div></div>`

  try {
    const res  = await fetch('/api/onshape-bom', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ assemblyId: assembly.id, reimport: true }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Re-import failed')

    setAssemblies(await fetchAssemblies())
    toast(data.message || 'Re-imported successfully')
    selectAssembly(assembly.id)
  } catch (e) {
    console.error(e)
    toast(`Re-import failed: ${e.message}`)
    renderAssemblyDetail()
  }
}

export async function refreshAndOpenAssembly(assemblyId) {
  setAssemblies(await fetchAssemblies())
  selectAssembly(assemblyId)
}

// ── Context wiring ────────────────────────────────────────────
// Called once at boot (see index.js) to connect every state-agnostic
// module to this file's notion of "current root part" vs.
// "current child part" and how to persist + re-render after each.

function getPartsFor(isChild) { return isChild ? getCurrentChildParts() : getCurrentParts() }
function setPartsFor(arr, isChild) { isChild ? setCurrentChildParts(arr) : setCurrentParts(arr) }
function replacePartIn(list, saved) { return list.map(p => p.id === saved.id ? saved : p) }

async function afterPartsChange(isChild) {
  if (isChild) { renderChildDetail(); return }
  await syncAssemblyStatus()
  renderAssemblyDetail()
}

export function initDesignerWiring() {
  initFabDetection(findOrCreateComponent)

  registerAssemblyGridContext({
    selectAssembly,
    openOnshapeLinkFlow: () => openOnshapeModal('link'),
    onAssemblySaved: (saved) => selectAssembly(saved.id),
  })

  registerPartsTableContext({
    getParts: getPartsFor,
    setParts: setPartsFor,
    afterChange: afterPartsChange,
    getAssemblyIdForNewPart: () => getCurrentAssemblyId(),
    onLinkInventory: (partId, isChild) => openInventoryLinkModal(partId, isChild),
    onViewLinked: (partId, isChild) => toggleLinkedDetail(partId, isChild),
    onSendToFabricate: (partId, isChild) => openSendToFabricateModal(partId, isChild),
    onAddToCart: (partId, isChild) => addPartToCart(partId, isChild),
  })

  registerFabDetectionContext({
    getPart: (partId, isChild) => getPartsFor(isChild).find(p => p.id === partId),
    onPartUpdated: (saved, isChild) => {
      setPartsFor(replacePartIn(getPartsFor(isChild), saved), isChild)
      isChild ? renderChildDetail() : renderAssemblyDetail()
    },
    onJobCreated: (saved, job, isChild) => {
      setPartsFor(replacePartIn(getPartsFor(isChild), saved), isChild)
      if (isChild) { getCurrentChildPartJobs()[saved.id] = job; renderChildDetail() }
      else { getCurrentPartJobs()[saved.id] = job; renderAssemblyDetail() }
    },
  })

  registerOnshapePickerContext({
    getCurrentAssemblyId: () => getCurrentAssemblyId(),
    onPartsImported: async (saved, onshapeSelectedAsm, onshapeSelectedDoc) => {
      setCurrentParts([...getCurrentParts(), ...saved])
      const assembly = assemblyById(getCurrentAssemblyId())
      if (assembly && !assembly.onshapeElementId && onshapeSelectedAsm) {
        const onshapeUrl = `https://cad.onshape.com/documents/${onshapeSelectedAsm.documentId}/w/${onshapeSelectedAsm.workspaceId}/e/${onshapeSelectedAsm.id}`
        const updated = await upsertAssembly({
          ...assembly,
          onshapeUrl,
          onshapeDocumentId:  onshapeSelectedAsm.documentId,
          onshapeWorkspaceId: onshapeSelectedAsm.workspaceId,
          onshapeElementId:   onshapeSelectedAsm.id,
          thumbnail:          onshapeSelectedDoc?.thumbnailUrl || assembly.thumbnail || null,
        })
        setAssemblies(getAssemblies().map(a => a.id === updated.id ? updated : a))
      }
      await syncAssemblyStatus()
      renderAssemblyDetail()
    },
    onAssemblyCreated: async (assemblyId) => {
      setAssemblies(await fetchAssemblies())
      selectAssembly(assemblyId)
    },
  })

  registerBomImportContext({
    getCurrentAssemblyId: () => getCurrentAssemblyId(),
    onPartsImported: async (saved) => {
      setCurrentParts([...getCurrentParts(), ...saved])
      await syncAssemblyStatus()
      renderAssemblyDetail()
    },
  })

  registerInventoryLinkContext({
    getPart: (partId, isChild) => getPartsFor(isChild).find(p => p.id === partId),
    afterChange: async (saved, isChild) => {
      setPartsFor(replacePartIn(getPartsFor(isChild), saved), isChild)
      await afterPartsChange(isChild)
    },
    getAssemblyNameForLocation: (isChild) =>
      isChild ? (document.getElementById('content-title')?.textContent || 'Assembly')
              : (assemblyById(getCurrentAssemblyId())?.name || 'Assembly'),
  })

  registerFabricateFlowContext({
    getPart: (partId, isChild) => getPartsFor(isChild).find(p => p.id === partId),
    onComponentLinked: (saved, isChild) => {
      setPartsFor(replacePartIn(getPartsFor(isChild), saved), isChild)
    },
    onJobCreated: (part, job, isChild) => {
      if (isChild) { getCurrentChildPartJobs()[part.id] = job; renderChildDetail() }
      else { getCurrentPartJobs()[part.id] = job; renderAssemblyDetail() }
    },
  })

  registerPartOrdersCartContext({
    getPart: (partId, isChild) => getPartsFor(isChild).find(p => p.id === partId),
  })
}

// ── Static event bindings owned directly by this module ─────────
export function bindAssemblyDetailEvents() {
  document.getElementById('btn-new-assembly').addEventListener('click', () => openAssemblyModal())
  document.getElementById('btn-new-from-onshape').addEventListener('click', () => openOnshapeModal('link'))
}