// designer.js — Designer workflow (assemblies + BOM management)
import {
  fetchAssemblies, upsertAssembly, deleteAssembly,
  fetchAssemblyParts, upsertAssemblyPart, bulkInsertAssemblyParts, deleteAssemblyPart,
  fetchAssemblyChildren, fetchChildrenOfChild, fetchAssemblyChildById, fetchChildParts,
  fetchComponents, fetchAvailableInstances, reserveInstance, unreserveInstance,
  fetchInstancesByIds, updateInstanceLocation,
  releaseInstances, fetchAllLinkedInstanceIdsForAssembly,
} from './db.js'

// ── State ─────────────────────────────────────────────────────
let assemblies        = []
let currentAssemblyId = null
let currentParts      = []
let currentChildren   = []   // assembly_children rows for the current assembly
let navigationStack   = []   // [{id, name}] trail from root → current (root assemblies only)
let editingAssemblyId = null
let editingPartId     = null
let detailTab         = 'parts'   // 'parts' | 'subassemblies' — active tab in assembly detail view
let isolatedMode      = false     // true when opened via "?asm=<id>" / "?child=<id>" in its own window/tab

// Isolated subassembly-node view state (separate from root assembly state —
// a subassembly is never a row in `assemblies`, so it can't share currentAssemblyId)
let viewingChildId       = null   // assembly_children.id currently shown, or null
let childNavStack        = []     // [{id, name}] trail when drilling into nested subassemblies
let childDetailTab       = 'parts'

// Onshape import picker state
let onshapeStep        = 'search'   // 'search' | 'assemblies' | 'preview'
let onshapeQuery        = ''
let onshapeDocs          = []
let onshapeSelectedDoc   = null     // { id, name, workspaceId, ... }
let onshapeAssemblies    = []
let onshapeSelectedAsm   = null     // { id, name, documentId, workspaceId }
let onshapePreviewParts       = []    // direct parts at the top level
let onshapePreviewSubassemblies = []  // subassembly nodes from the hierarchy
let onshapePreviewWarning       = null
let onshapeLoading       = false
let onshapeSearchTimer   = null

// Inventory link modal state
let invLinkPartId      = null   // the assembly_parts.id (or child part) being linked
let invLinkIsChildPart = false  // true if linking a subassembly's part, not a root assembly's
let invLinkQuery       = ''
let invLinkResults     = []     // [{ component, instances }] — components w/ available instances
let invLinkAllComponents = []   // cached full component list for client-side search
let invLinkLoading     = false

// ── Part name → category dictionary ─────────────────────────
// Keys are lowercase keywords checked against words in a part's name.
// Values are candidate category names to prioritize in search results.
// Extend freely — this is just a starting set.
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
  spacer:  ['Hardware'],
  standoff:['Hardware'],
}

/** Returns the first matching category name(s) for a part name, or null. */
function suggestCategoriesForPartName(partName) {
  const words = partName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  for (const w of words) {
    if (PART_NAME_DICTIONARY[w]) return PART_NAME_DICTIONARY[w]
  }
  return null
}

// ── Shared utilities ──────────────────────────────────────────
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }
function assemblyById(id) { return assemblies.find(a => a.id === id) }

function partsProgress(parts) {
  if (!parts.length) return { collected: 0, total: 0, pct: 0 }
  const total     = parts.reduce((s, p) => s + p.quantityNeeded, 0)
  const collected = parts.reduce((s, p) => s + p.quantityCollected, 0)
  return { collected, total, pct: total ? Math.round(100 * collected / total) : 0 }
}

function computePartStatus(p) {
  const linked = (p.linkedInstanceIds || []).length
  if (linked >= p.quantityNeeded) return 'complete'
  if (linked > 0) return 'partial'
  return 'pending'
}

function statusLabel(s) {
  if (s === 'complete') return '<span class="asm-badge asm-badge--complete"><i class="ti ti-check"></i> Complete</span>'
  if (s === 'active')   return '<span class="asm-badge asm-badge--active"><i class="ti ti-loader-2"></i> Active</span>'
  return '<span class="asm-badge asm-badge--draft"><i class="ti ti-pencil"></i> Draft</span>'
}

function derivedAssemblyStatus(parts) {
  if (!parts.length) return 'draft'
  if (parts.every(p => computePartStatus(p) === 'complete')) return 'complete'
  if (parts.some(p => computePartStatus(p) !== 'pending')) return 'active'
  return 'draft'
}

let toastFn = msg => console.warn('[toast]', msg)
export function setToast(fn) { toastFn = fn }

// ── Boot ──────────────────────────────────────────────────────
export async function designerBoot() {
  assemblies = await fetchAssemblies()
}

export function getAssemblies() { return assemblies }

// ── Isolated single-node window (opened via "?asm=<id>" or "?child=<id>") ──
export function setIsolatedMode(v) { isolatedMode = v }

/** Boots the app straight into a root assembly's detail view, with no
 *  sidebar/other assemblies in reach. */
export async function bootIsolatedAssembly(assemblyId) {
  isolatedMode    = true
  navigationStack = []
  await designerBoot()
  selectAssembly(assemblyId)
}

/** Boots the app straight into a SUBASSEMBLY node's detail view — used by
 *  the "open in new window" action on a subassembly card. Subassemblies
 *  aren't real assemblies, so this bypasses selectAssembly()/assemblies[]
 *  entirely and renders directly from assembly_children + assembly_parts. */
export async function bootIsolatedChild(childId) {
  isolatedMode  = true
  viewingChildId = childId
  await renderChildDetail()
}

/** Opens a subassembly node in a fresh, isolated browser window/tab. */
/** Navigate INTO a subassembly node in place (no new window/tab).
 *  Remembers what to return to (the root assembly, or a parent
 *  subassembly if we're already nested) so the back button works. */
let currentChildName = null   // name of the subassembly node currently shown (embedded mode)

function enterChildAssembly(childId) {
  const fromLabel = viewingChildId
    ? (currentChildName || 'Subassembly')
    : (assemblyById(currentAssemblyId)?.name || 'Assembly')
  childNavStack.push({ id: viewingChildId, name: fromLabel })
  viewingChildId  = childId
  childDetailTab  = 'parts'
  renderDesignerContent()
}

function exitChildAssembly() {
  const parent = childNavStack.pop()
  viewingChildId = parent ? parent.id : null
  childDetailTab = 'parts'
  renderDesignerContent()
}

// ── Sidebar ───────────────────────────────────────────────────
export function renderDesignerSidebar() {
  // "All assemblies" nav item header
  const navAll = document.getElementById('nav-all')
  navAll.innerHTML = `<i class="ti ti-stack-2" aria-hidden="true"></i> All assemblies
    <span class="nav-count" id="all-count">${assemblies.length}</span>`
  navAll.className = 'nav-item' + (!currentAssemblyId ? ' active' : '')

  // Assembly list
  const catNav = document.getElementById('cat-nav')
  catNav.innerHTML = assemblies.map(a => {
    const active = currentAssemblyId === a.id
    const badge  = statusLabel(a.status)
    return `<div class="nav-item asm-nav-item${active ? ' active' : ''}" data-asm-nav="${a.id}">
      <i class="ti ti-box" style="font-size:15px;flex-shrink:0" aria-hidden="true"></i>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px">${a.name}</span>
      ${badge}
    </div>`
  }).join('')

  // Hide tags section
  document.getElementById('tags-divider').style.display  = 'none'
  document.getElementById('tags-label').style.display    = 'none'
  document.getElementById('tags-nav').innerHTML          = ''
  document.getElementById('sidebar-label-cats').textContent = 'Assemblies'

  // Bind clicks
  catNav.querySelectorAll('[data-asm-nav]').forEach(el =>
    el.addEventListener('click', () => selectAssembly(el.dataset.asmNav))
  )
}

// ── Content ───────────────────────────────────────────────────
export async function renderDesignerContent() {
  if (viewingChildId) {
    await renderChildDetail()
  } else if (currentAssemblyId) {
    await renderAssemblyDetail()
  } else {
    await renderAssemblyGrid()
  }
}

function renderAssemblyGrid() {
  const title = document.getElementById('content-title')
  const meta  = document.getElementById('content-meta')
  const area  = document.getElementById('main-area')

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
    document.getElementById('empty-new-from-onshape-btn').addEventListener('click', () => openOnshapeModal('link'))
    return
  }

  area.innerHTML = `<div class="asm-grid">${assemblies.map(asmCardHTML).join('')}</div>`
  area.querySelectorAll('[data-open-asm]').forEach(el =>
    el.addEventListener('click', () => selectAssembly(el.dataset.openAsm))
  )
}

function asmCardHTML(a) {
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
      </div>
    </div>
    ${a.description ? `<div class="asm-card-desc">${a.description}</div>` : ''}
    ${onshapeLink}
  </div>`
}

async function renderAssemblyDetail() {
  const assembly = assemblyById(currentAssemblyId)
  if (!assembly) { selectAssembly(null); return }

  const title = document.getElementById('content-title')
  const meta  = document.getElementById('content-meta')
  const area  = document.getElementById('main-area')

  title.textContent = assembly.name
  meta.innerHTML    = statusLabel(assembly.status)

  area.innerHTML = `<div class="empty"><i class="ti ti-loader-2 spin"></i><div class="empty-title">Loading…</div></div>`

  try {
    ;[currentParts, currentChildren] = await Promise.all([
      fetchAssemblyParts(currentAssemblyId),
      fetchAssemblyChildren(currentAssemblyId),
    ])
  } catch (e) {
    area.innerHTML = `<div class="empty"><i class="ti ti-alert-circle"></i><div class="empty-title">Error loading assembly</div></div>`
    return
  }

  const prog     = partsProgress(currentParts)
  const isLinked = !!assembly.onshapeElementId
  const isChild  = navigationStack.length > 0
  const parent   = isChild ? navigationStack[navigationStack.length - 1] : null

  // Breadcrumb trail when deep in the hierarchy
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

  const childrenHTML = currentChildren.length
    ? `<div class="asm-grid">
        ${currentChildren.map(c => {
          const thumbHTML = c.thumbnail
            ? `<div class="asm-card-thumb"><img src="${c.thumbnail}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
            : ''
          return `<div class="asm-card asm-subasm-card" data-open-child="${c.id}" title="Opens in a new window">
            <i class="ti ti-arrow-up-right asm-card-open-icon" aria-hidden="true"></i>
            ${thumbHTML}
            <div class="asm-card-header">
              <div class="asm-card-name">${c.name}</div>
            </div>
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
        <div style="flex:1"></div>
        <button class="btn btn-sm" id="btn-import-csv"><i class="ti ti-upload" aria-hidden="true"></i><span> Import CSV</span></button>
        <button class="btn btn-sm" id="btn-import-onshape"><i class="ti ti-cube" aria-hidden="true"></i><span> Import from Onshape</span></button>
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
                ${currentParts.map(partRowHTML).join('')}
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
        <button class="btn btn-sm" id="btn-edit-asm"><i class="ti ti-edit" aria-hidden="true"></i><span> Edit</span></button>
        <button class="btn btn-danger btn-sm" id="btn-delete-asm"><i class="ti ti-trash" aria-hidden="true"></i></button>
      </div>

      ${assembly.description ? `<p class="asm-detail-desc">${assembly.description}</p>` : ''}

      <div class="asm-progress-row">
        <div class="asm-progress-bar">
          <div class="asm-progress-fill" style="width:${prog.pct}%"></div>
        </div>
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
  document.getElementById('tab-btn-parts')?.addEventListener('click', () => { detailTab = 'parts'; renderAssemblyDetail() })
  document.getElementById('tab-btn-subassemblies')?.addEventListener('click', () => { detailTab = 'subassemblies'; renderAssemblyDetail() })
  document.getElementById('btn-edit-asm').addEventListener('click', () => openAssemblyModal(currentAssemblyId))
  document.getElementById('btn-delete-asm').addEventListener('click', deleteCurrentAssembly)
  document.getElementById('btn-add-part')?.addEventListener('click', () => openPartModal())
  document.getElementById('btn-import-csv')?.addEventListener('click', openBomImportModal)
  document.getElementById('btn-import-onshape')?.addEventListener('click', () => openOnshapeModal('import'))
  if (isLinked) {
    document.getElementById('btn-reimport-asm').addEventListener('click', () => confirmReimport(assembly))
  }

  // Breadcrumb clicks jump to an ancestor
  document.getElementById('btn-breadcrumb-root')?.addEventListener('click', () => selectAssembly(null))
  area.querySelectorAll('[data-breadcrumb-idx]').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.breadcrumbIdx, 10)
      navigationStack.splice(idx + 1)
      const target = navigationStack.pop()
      currentAssemblyId = target.id
      currentParts      = []
      currentChildren   = []
      renderDesignerSidebar()
      renderDesignerContent()
    })
  })

  /// Subassembly cards navigate in place, not a new window
  area.querySelectorAll('[data-open-child]').forEach(el =>
    el.addEventListener('click', () => enterChildAssembly(el.dataset.openChild))
  )

  bindPartRowEvents()

}

// ── Subassembly node detail (isolated window only) ─────────────
// A subassembly is never a row in `assemblies` — this renders directly
// from assembly_children + assembly_parts (assembly_child_id). It's
// intentionally lighter than renderAssemblyDetail: no edit/delete/re-import,
// since a subassembly's contents are owned by re-importing the ROOT
// assembly, which rebuilds the whole tree underneath it. Quantity
// collection tracking still works, since that's independent per-part state.
let currentChildParts    = []
let currentChildChildren = []

async function renderChildDetail() {
  const title = document.getElementById('content-title')
  const meta  = document.getElementById('content-meta')
  const area  = document.getElementById('main-area')

  area.innerHTML = `<div class="empty"><i class="ti ti-loader-2 spin"></i><div class="empty-title">Loading…</div></div>`

  let child
  try {
    ;[child, currentChildParts, currentChildChildren] = await Promise.all([
      fetchAssemblyChildById(viewingChildId),
      fetchChildParts(viewingChildId),
      fetchChildrenOfChild(viewingChildId),
    ])
  } catch (e) {
    area.innerHTML = `<div class="empty"><i class="ti ti-alert-circle"></i><div class="empty-title">Error loading subassembly</div></div>`
    return
  }

  currentChildName = child.name
  const parentLabel = childNavStack.length ? childNavStack[childNavStack.length - 1].name : ''

  title.textContent = child.name
  meta.innerHTML    = `<span class="asm-badge asm-badge--draft"><i class="ti ti-git-branch" aria-hidden="true"></i> Subassembly${parentLabel ? ' of ' + parentLabel : ''}</span>`
  const prog = partsProgress(currentChildParts)

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
    : `<div class="empty" style="padding:40px 0">
        <i class="ti ti-cube-off" aria-hidden="true"></i>
        <div class="empty-title">No subassemblies</div>
      </div>`

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
      ${tabsHTML ? '' : `<div class="asm-parts-toolbar"><div class="asm-parts-title">Parts <span class="section-count">${currentChildParts.length}</span></div></div>`}
      ${currentChildParts.length
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
              <tbody id="child-parts-tbody">
                ${currentChildParts.map(childPartRowHTML).join('')}
              </tbody>
            </table>
          </div>`
        : `<div class="empty" style="padding:40px 0">
            <i class="ti ti-list-check" aria-hidden="true"></i>
            <div class="empty-title">No direct parts</div>
          </div>`}`

  const backLabel = isolatedMode
    ? `<i class="ti ti-x" aria-hidden="true"></i> Close`
    : `<i class="ti ti-arrow-left" aria-hidden="true"></i> Return to ${parentLabel || 'parent assembly'}`

  area.innerHTML = `
    <div class="asm-detail">
      <div class="asm-detail-toolbar">
        <button class="btn btn-sm" id="btn-back-asm">${backLabel}</button>
        <span class="asm-linked-badge asm-linked-badge--detail"><i class="ti ti-link" aria-hidden="true"></i> From Onshape</span>
        <div style="flex:1"></div>
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

  document.getElementById('tab-btn-parts')?.addEventListener('click', () => { childDetailTab = 'parts'; renderChildDetail() })
  document.getElementById('tab-btn-subassemblies')?.addEventListener('click', () => { childDetailTab = 'subassemblies'; renderChildDetail() })

  area.querySelectorAll('[data-open-child]').forEach(el =>
    el.addEventListener('click', () => enterChildAssembly(el.dataset.openChild))
  )

  const tbody = document.getElementById('child-parts-tbody')
  if (tbody) {
    tbody.addEventListener('click', async e => {
      const linkBtn = e.target.closest('[data-part-link]')
      const viewLinkedBtn = e.target.closest('[data-view-linked]')
      const delBtn = e.target.closest('[data-child-part-del]')

      if (linkBtn) { openInventoryLinkModal(linkBtn.dataset.partLink, true); return }
      if (viewLinkedBtn) { await toggleLinkedDetail(viewLinkedBtn.dataset.viewLinked, true); return }
      if (delBtn) { await deleteChildPart(delBtn.dataset.childPartDel); return }
    })
  }
}

function childPartRowHTML(p) {
  const status = computePartStatus(p)
  const statusBadge = {
    complete: '<span class="part-badge part-badge--complete">Complete</span>',
    partial:  '<span class="part-badge part-badge--partial">Partial</span>',
    pending:  '<span class="part-badge part-badge--pending">Pending</span>',
  }[status]

  const linkedCount = (p.linkedInstanceIds || []).length
  const linkedBadge = linkedCount
    ? `<button class="inv-link-linked-badge" data-view-linked="${p.id}" type="button">
        <i class="ti ti-link" aria-hidden="true"></i> ${linkedCount} linked
       </button>`
    : ''

  return `<tr data-part-id="${p.id}">
    <td>
      <div class="part-name">${p.partName}</div>
      ${linkedBadge}
      <div class="inv-linked-detail" id="linked-detail-${p.id}" style="display:none"></div>
    </td>
    <td><span class="part-number">${p.partNumber || '—'}</span></td>
    <td style="text-align:center">${p.quantityNeeded}</td>
    <td style="text-align:center">
      <span class = "qty-collected-readout">${linkedCount} / ${p.quantityNeeded}</span>
    </td>
    <td style="text-align:center">${statusBadge}</td>
    <td style="text-align:right">
      <button class="btn-icon" data-part-link="${p.id}" aria-label="Link inventory" ${linkedCount >= p.quantityNeeded ? 'disabled' : ''}><i class="ti ti-search" style="font-size:13px"></i></button>
      <button class="btn-icon" data-child-part-del="${p.id}" aria-label="Delete"><i class="ti ti-trash" style="font-size:13px"></i></button>
    </td>
  </tr>`
}

function partRowHTML(p) {
  const status = computePartStatus(p)
  const statusBadge = {
    complete: '<span class="part-badge part-badge--complete">Complete</span>',
    partial:  '<span class="part-badge part-badge--partial">Partial</span>',
    pending:  '<span class="part-badge part-badge--pending">Pending</span>',
  }[status]

  const linkedCount = (p.linkedInstanceIds || []).length
  const linkedBadge = linkedCount
    ? `<button class="inv-link-linked-badge" data-view-linked="${p.id}" type="button">
        <i class="ti ti-link" aria-hidden="true"></i> ${linkedCount} linked
       </button>`
    : ''

  return `<tr data-part-id="${p.id}">
    <td>
      <div class="part-name">${p.partName}</div>
      ${p.notes ? `<div class="part-notes">${p.notes}</div>` : ''}
      ${linkedBadge}
      <div class="inv-linked-detail" id="linked-detail-${p.id}" style="display:none"></div>
    </td>
    <td><span class="part-number">${p.partNumber || '—'}</span></td>
    <td style="text-align:center">${p.quantityNeeded}</td>
    <td style="text-align:center">
      <span class="qty-collected-readout">${linkedCount} / ${p.quantityNeeded}</span>
    </td>
    <td style="text-align:center">${statusBadge}</td>
    <td style="text-align:right">
      <button class="btn-icon" data-part-link="${p.id}" aria-label="Link inventory" ${linkedCount >= p.quantityNeeded ? 'disabled' : ''}><i class="ti ti-search" style="font-size:13px"></i></button>
      <button class="btn-icon" data-part-edit="${p.id}" aria-label="Edit"><i class="ti ti-edit" style="font-size:13px"></i></button>
      <button class="btn-icon" data-part-del="${p.id}" aria-label="Delete"><i class="ti ti-trash" style="font-size:13px"></i></button>
    </td>
  </tr>`
}

function bindPartRowEvents() {
  const tbody = document.getElementById('parts-tbody')
  if (!tbody) return

  tbody.addEventListener('click', async e => {

    const linkBtn = e.target.closest('[data-part-link]')
    if (linkBtn) { openInventoryLinkModal(linkBtn.dataset.partLink, false); return }

    const viewLinkedBtn = e.target.closest('[data-view-linked]')
    if (viewLinkedBtn) { await toggleLinkedDetail(viewLinkedBtn.dataset.viewLinked, false); return }

    const editBtn = e.target.closest('[data-part-edit]')
    if (editBtn) { openPartModal(editBtn.dataset.partEdit); return }

    const delBtn = e.target.closest('[data-part-del]')
    if (delBtn) { await deletePart(delBtn.dataset.partDel); return }
  })
}

async function syncAssemblyStatus() {
  const assembly = assemblyById(currentAssemblyId)
  if (!assembly) return
  const newStatus = derivedAssemblyStatus(currentParts)
  if (newStatus !== assembly.status) {
    const updated = await upsertAssembly({ ...assembly, status: newStatus })
    const idx = assemblies.findIndex(a => a.id === currentAssemblyId)
    if (idx > -1) assemblies[idx] = updated
  }
}

async function deletePart(partId) {
  const part = currentParts.find(p => p.id === partId)
  if (!part || !confirm(`Remove "${part.partName}" from this assembly?`)) return
  try {
    // Release any linked inventory before the part row disappears —
    // otherwise those instances stay stuck at status: 'in_assembly'
    // with nothing left pointing back to them.
    if (part.linkedInstanceIds?.length) {
      await releaseInstances(part.linkedInstanceIds)
    }
    await deleteAssemblyPart(partId)
    currentParts = currentParts.filter(p => p.id !== partId)
    await syncAssemblyStatus()
    renderAssemblyDetail()
    toastFn('Part removed')
  } catch (e) { console.error(e); toastFn('Error removing part') }
}

/** Deletes a part belonging to a subassembly NODE (not a root assembly).
 *  Mirrors deletePart() but operates on currentChildParts / renderChildDetail. */
async function deleteChildPart(partId) {
  const part = currentChildParts.find(p => p.id === partId)
  if (!part || !confirm(`Remove "${part.partName}" from this subassembly?`)) return
  try {
    if (part.linkedInstanceIds?.length) {
      await releaseInstances(part.linkedInstanceIds)
    }
    await deleteAssemblyPart(partId)
    currentChildParts = currentChildParts.filter(p => p.id !== partId)
    renderChildDetail()
    toastFn('Part removed')
  } catch (e) { console.error(e); toastFn('Error removing part') }
}


async function deleteCurrentAssembly() {
  const a = assemblyById(currentAssemblyId)
  if (!a || !confirm(`Delete assembly "${a.name}" and all its parts? This cannot be undone.`)) return
  try {
    // Release every linked instance in the whole tree (root parts + all
    // nested subassembly parts) BEFORE the cascade delete removes the
    // rows that reference them.
    const linkedIds = await fetchAllLinkedInstanceIdsForAssembly(currentAssemblyId)
    if (linkedIds.length) await releaseInstances(linkedIds)
    
    await deleteAssembly(currentAssemblyId)
    assemblies = assemblies.filter(x => x.id !== currentAssemblyId)
    selectAssembly(null)
    toastFn('Assembly deleted')
  } catch (e) { console.error(e); toastFn('Error deleting assembly') }
}

// ── Navigation ────────────────────────────────────────────────

/** Navigate to an assembly from the grid or sidebar — clears the stack. */
export function selectAssembly(id) {
  currentAssemblyId = id
  currentParts      = []
  currentChildren   = []
  navigationStack   = []
  viewingChildId    = null
  childNavStack     = []
  detailTab         = 'parts'
  renderDesignerSidebar()
  renderDesignerContent()
}

/** Navigate back one level in the stack. */
function navigateUp() {
  const parent = navigationStack.pop()
  if (!parent) { selectAssembly(null); return }
  currentAssemblyId = parent.id
  currentParts      = []
  currentChildren   = []
  detailTab         = 'parts'
  renderDesignerSidebar()
  renderDesignerContent()
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

export function closeAssemblyModal() {
  document.getElementById('asm-modal-overlay').style.display = 'none'
  editingAssemblyId = null
}

export async function saveAssembly() {
  const name = document.getElementById('asm-field-name').value.trim()
  if (!name) { document.getElementById('asm-field-name').focus(); toastFn('Name is required'); return }

  const saveBtn = document.getElementById('btn-save-asm')
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…'

  const payload = {
    id:          editingAssemblyId || genId(),
    name,
    description: document.getElementById('asm-field-desc').value.trim(),
    onshapeUrl:  document.getElementById('asm-field-url').value.trim(),
    status:      document.getElementById('asm-field-status').value,
  }

  // Preserve Onshape link fields if editing — the manual edit form only
  // exposes the URL field; element ID, workspace/doc IDs, and thumbnail
  // are set by the Onshape link flow and shouldn't be wiped by a plain edit.
  if (editingAssemblyId) {
    const existing = assemblyById(editingAssemblyId)
    payload.onshapeDocumentId  = existing?.onshapeDocumentId  || ''
    payload.onshapeWorkspaceId = existing?.onshapeWorkspaceId || ''
    payload.onshapeElementId   = existing?.onshapeElementId   || ''
    payload.thumbnail          = existing?.thumbnail          || null
  }

  try {
    const saved = await upsertAssembly(payload)
    if (editingAssemblyId) {
      const idx = assemblies.findIndex(a => a.id === editingAssemblyId)
      if (idx > -1) assemblies[idx] = saved
    } else {
      assemblies.unshift(saved)
    }
    closeAssemblyModal()
    selectAssembly(saved.id)
    toastFn(editingAssemblyId ? 'Assembly updated' : 'Assembly created')
  } catch (e) {
    console.error(e)
    toastFn('Error saving assembly')
  } finally {
    saveBtn.disabled = false
    saveBtn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i> Save'
  }
}

// ── Part modal ────────────────────────────────────────────────
function openPartModal(id) {
  editingPartId = id || null
  const p = id ? currentParts.find(x => x.id === id) : null

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
  if (!partName) { document.getElementById('part-field-name').focus(); toastFn('Part name is required'); return }

  const saveBtn = document.getElementById('btn-save-part')
  saveBtn.disabled = true; saveBtn.textContent = 'Saving…'

  const existing = editingPartId ? currentParts.find(p => p.id === editingPartId) : null
  const payload = {
    id:                editingPartId || genId(),
    assemblyId:        currentAssemblyId,
    partName,
    partNumber:        document.getElementById('part-field-number').value.trim(),
    quantityNeeded:    parseInt(document.getElementById('part-field-qty').value, 10) || 1,
    quantityCollected: existing?.linkedInstanceIds?.length ?? 0,
    notes:             document.getElementById('part-field-notes').value.trim(),
    source:            existing?.source || 'manual',
    onshapeReference:  existing?.onshapeReference || null,
    linkedInstanceIds: existing?.linkedInstanceIds || [],
    componentId:       existing?.componentId || null,
  }
  payload.status = computePartStatus(payload)

  try {
    const saved = await upsertAssemblyPart(payload)
    if (editingPartId) {
      const idx = currentParts.findIndex(p => p.id === editingPartId)
      if (idx > -1) currentParts[idx] = saved
    } else {
      currentParts.push(saved)
    }
    await syncAssemblyStatus()
    closePartModal()
    renderAssemblyDetail()
    toastFn(editingPartId ? 'Part updated' : 'Part added')
  } catch (e) {
    console.error(e)
    toastFn('Error saving part')
  } finally {
    saveBtn.disabled = false
    saveBtn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i> Save'
  }
}

// ── BOM CSV import ────────────────────────────────────────────
function openBomImportModal() {
  document.getElementById('bom-file-input').value = ''
  document.getElementById('bom-preview').innerHTML = ''
  document.getElementById('bom-preview').style.display = 'none'
  document.getElementById('btn-confirm-bom').style.display = 'none'
  document.getElementById('bom-import-overlay').style.display = 'flex'
}

function closeBomImportModal() {
  document.getElementById('bom-import-overlay').style.display = 'none'
}

let parsedBomRows = []

function handleBomFile(e) {
  const file = e.target.files[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = ev => {
    parsedBomRows = parseBomCsv(ev.target.result)
    renderBomPreview(parsedBomRows)
  }
  reader.readAsText(file)
}

function parseBomCsv(text) {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return []

  // Parse header row — handle quoted fields
  const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase().trim())

  // Column detection (Onshape and common BOM formats)
  const col = key => {
    const ALIASES = {
      name:   ['name', 'part name', 'description', 'item', 'component'],
      number: ['part number', 'part #', 'pn', 'part_number', 'number'],
      qty:    ['qty', 'quantity', 'count', 'amount'],
      notes:  ['notes', 'comment', 'remarks', 'note'],
    }
    const alts = ALIASES[key] || [key]
    const idx  = headers.findIndex(h => alts.some(a => h.includes(a)))
    return idx
  }

  const nameIdx   = col('name')
  const numberIdx = col('number')
  const qtyIdx    = col('qty')
  const notesIdx  = col('notes')

  if (nameIdx < 0) return []  // can't parse without a name column

  return lines.slice(1)
    .map(line => {
      const cells = parseCsvLine(line)
      const partName = cells[nameIdx]?.trim()
      if (!partName) return null
      return {
        partName,
        partNumber: numberIdx >= 0 ? (cells[numberIdx]?.trim() || '') : '',
        quantityNeeded: qtyIdx >= 0 ? (parseInt(cells[qtyIdx], 10) || 1) : 1,
        notes: notesIdx >= 0 ? (cells[notesIdx]?.trim() || '') : '',
      }
    })
    .filter(Boolean)
}

function parseCsvLine(line) {
  const result = []
  let current  = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
      else inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      result.push(current); current = ''
    } else {
      current += ch
    }
  }
  result.push(current)
  return result
}

function renderBomPreview(rows) {
  const preview = document.getElementById('bom-preview')
  const confirmBtn = document.getElementById('btn-confirm-bom')

  if (!rows.length) {
    preview.innerHTML = `<p class="bom-parse-error">Could not detect columns. Make sure your CSV has a "Name" or "Part name" column.</p>`
    preview.style.display = 'block'
    confirmBtn.style.display = 'none'
    return
  }

  preview.innerHTML = `
    <div class="bom-preview-info">Detected ${rows.length} parts — review before importing:</div>
    <table class="parts-table" style="margin-top:8px">
      <thead><tr><th>Part name</th><th>Part #</th><th style="text-align:center">Qty</th><th>Notes</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${r.partName}</td>
        <td><span class="part-number">${r.partNumber || '—'}</span></td>
        <td style="text-align:center">${r.quantityNeeded}</td>
        <td style="color:var(--color-text-tertiary);font-size:12px">${r.notes || ''}</td>
      </tr>`).join('')}</tbody>
    </table>`
  preview.style.display = 'block'
  confirmBtn.style.display = 'inline-flex'
}

async function confirmBomImport() {
  if (!parsedBomRows.length) return
  const confirmBtn = document.getElementById('btn-confirm-bom')
  confirmBtn.disabled = true; confirmBtn.textContent = 'Importing…'

  const parts = parsedBomRows.map(r => ({
    id:                genId(),
    assemblyId:        currentAssemblyId,
    partName:          r.partName,
    partNumber:        r.partNumber,
    quantityNeeded:    r.quantityNeeded,
    quantityCollected: 0,
    status:            'pending',
    source:            'csv',
    notes:             r.notes,
    onshapeReference:  null,
  }))

  try {
    const saved = await bulkInsertAssemblyParts(parts)
    currentParts.push(...saved)
    await syncAssemblyStatus()
    closeBomImportModal()
    renderAssemblyDetail()
    toastFn(`Imported ${saved.length} parts`)
  } catch (e) {
    console.error(e)
    toastFn('Error importing BOM')
  } finally {
    confirmBtn.disabled = false
    confirmBtn.innerHTML = '<i class="ti ti-check"></i> Import'
  }
}

// ── Onshape picker ───────────────────────────────────────────
// Three-step flow: search documents → pick assembly → preview & confirm.
// Uses the three read-only endpoints from api/onshape-documents.js,
// api/onshape-elements.js, api/onshape-bom-preview.js.
//
// Two modes, set by the caller via openOnshapeModal(mode):
//   'import' — adds the previewed parts to the CURRENTLY OPEN assembly
//              (reached from the "Import from Onshape" button inside an
//              assembly's detail view)
//   'link'   — creates a BRAND NEW assembly, named after and linked to
//              the chosen Onshape assembly, seeded with its BOM
//              (reached from the "New from Onshape" button in the
//              assembly grid / topbar)

let onshapeMode       = 'import'   // 'import' | 'link'
let onshapeCreateName = ''         // editable name shown in 'link' mode's preview step

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
    i === idx
      ? `<span class="step-current">${s.label}</span>`
      : `<span>${s.label}</span>`
  ).join(' &nbsp;→&nbsp; ')
}

function renderOnshapeModal() {
  document.getElementById('onshape-modal-title').textContent =
    onshapeMode === 'link' ? 'New assembly from Onshape' : 'Import from Onshape'
  document.getElementById('onshape-step-trail').innerHTML = onshapeStepTrail()
  document.getElementById('btn-onshape-back').style.display = onshapeStep === 'search' ? 'none' : 'inline-flex'

  // In 'link' mode, an empty BOM is still a valid outcome — the user may
  // be linking an assembly they haven't built out yet. In 'import' mode,
  // there's nothing useful to do with zero parts.
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

// ── Inventory link modal ─────────────────────────────────────
// Lets a user search existing inventory components and link one or more
// physical instances to a specific assembly part. Works for both root
// assembly parts (currentParts) and subassembly-node parts (currentChildParts).

export function openInventoryLinkModal(partId, isChildPart = false) {
  invLinkPartId      = partId
  invLinkIsChildPart = isChildPart
  invLinkQuery       = ''
  invLinkResults     = []
  invLinkLoading     = false

  const part = isChildPart
    ? currentChildParts.find(p => p.id === partId)
    : currentParts.find(p => p.id === partId)
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
  return invLinkIsChildPart
    ? currentChildParts.find(p => p.id === invLinkPartId)
    : currentParts.find(p => p.id === invLinkPartId)
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
    if (!invLinkAllComponents.length) {
      invLinkAllComponents = await fetchComponents()
    }

    const q = query.trim().toLowerCase()
    const matches = q
      ? invLinkAllComponents.filter(c =>
          c.name.toLowerCase().includes(q) ||
          (c.tags || []).some(t => t.toLowerCase().includes(q)))
      : invLinkAllComponents

    // Fetch available instances per matching component in parallel
    const withInstances = await Promise.all(
      matches.slice(0, 30).map(async c => ({
        component: c,
        instances: await fetchAvailableInstances(c.id),
      }))
    )

    invLinkResults = withInstances.filter(r => r.instances.length > 0)
  } catch (e) {
    console.error(e)
    toastFn('Error searching inventory')
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
  const linkedIds = new Set(part?.linkedInstanceIds || [])

  const atCap = part ? (part.linkedInstanceIds || []).length >= part.quantityNeeded : false

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

  el.innerHTML = invLinkResults.map(({ component, instances }) => `
    <div class="inv-link-comp-card">
      <div class="inv-link-comp-header">
        <span class="inv-link-comp-name">${component.name}</span>
        <span class="inv-link-comp-count">${instances.length} available</span>
      </div>
      ${instances.map(inst => `
        <div class="inv-link-instance-row">
          <span class="inv-link-instance-loc">
            <i class="ti ti-map-pin" aria-hidden="true"></i> ${inst.location || 'No location set'}
          </span>
          <button class="btn btn-sm btn-primary" data-add-instance="${inst.id}" data-comp-name="${component.name}">
            <i class="ti ti-plus" aria-hidden="true"></i> Add to assembly
          </button>
        </div>
      `).join('')}
    </div>
  `).join('')

  el.querySelectorAll('[data-add-instance]').forEach(btn =>
    btn.addEventListener('click', () => linkInstanceToPart(btn.dataset.addInstance, btn.dataset.compName, btn.dataset.componentId))
  )

  // Attach component id via closure lookup since dataset can't hold it cleanly per-row
  el.querySelectorAll('.inv-link-comp-card').forEach((card, i) => {
    const componentId = invLinkResults[i].component.id
    card.querySelectorAll('[data-add-instance]').forEach(btn => {
      btn.dataset.componentId = componentId
    })
  })
}

async function linkInstanceToPart(instanceId, componentName, componentId) {
  const part = currentInvLinkPart()
  if (!part) return

    // Enforce the cap: never let linked count exceed quantityNeeded.
  const currentLinked = part.linkedInstanceIds || []
  if (currentLinked.length >= part.quantityNeeded) {
    toastFn(`Already have ${part.quantityNeeded} linked — quantity needed is met.`)
    return
  }


  const assemblyName = invLinkIsChildPart
    ? (document.getElementById('content-title')?.textContent || 'Assembly')
    : (assemblyById(currentAssemblyId)?.name || 'Assembly')

  try {
    await reserveInstance(instanceId, assemblyName)

    const newLinkedIds = [...currentLinked, instanceId]
    const updatedPart = {
      ...part,
      componentId:       part.componentId || componentId,
      linkedInstanceIds: newLinkedIds,
      quantityCollected: newLinkedIds.length,
    }
    updatedPart.status = computePartStatus(updatedPart)

    const saved = await upsertAssemblyPart(updatedPart)

    if (invLinkIsChildPart) {
      const idx = currentChildParts.findIndex(p => p.id === part.id)
      if (idx > -1) currentChildParts[idx] = saved
      renderChildDetail()
    } else {
      const idx = currentParts.findIndex(p => p.id === part.id)
      if (idx > -1) currentParts[idx] = saved
      await syncAssemblyStatus()
      renderAssemblyDetail()
    }

    toastFn(`Linked ${componentName} to "${part.partName}"`)
    document.getElementById('inv-link-subtitle').textContent =
      `For: ${saved.partName} (${newLinkedIds.length}/${saved.quantityNeeded} linked)`
    loadAndSearchInventory(invLinkQuery)  // refresh available counts + button states
  } catch (e) {
    console.error(e)
    toastFn('Error linking inventory item')
  }
}

/** Unlinks a single instance from a part, restoring it to available. */
async function unlinkInstanceFromPart(partId, instanceId, isChildPart) {
  const part = isChildPart
    ? currentChildParts.find(p => p.id === partId)
    : currentParts.find(p => p.id === partId)
  if (!part) return

  if (!confirm('Unlink this inventory item? It will be marked available again.')) return

  try {
    await unreserveInstance(instanceId, '')

    const remaining = (part.linkedInstanceIds || []).filter(id => id !== instanceId)
    const updatedPart = {
      ...part,
      linkedInstanceIds: remaining,
      componentId:       remaining.length ? part.componentId : null,
      quantityCollected: remaining.length,
    }
    updatedPart.status = computePartStatus(updatedPart)

    const saved = await upsertAssemblyPart(updatedPart)

    if (isChildPart) {
      const idx = currentChildParts.findIndex(p => p.id === partId)
      if (idx > -1) currentChildParts[idx] = saved
      renderChildDetail()
      // Re-open detail panel post-render if it was open
      if (openLinkedDetailIds.has(partId)) { openLinkedDetailIds.delete(partId); toggleLinkedDetail(partId, false) }
    } else {
      const idx = currentParts.findIndex(p => p.id === partId)
      if (idx > -1) currentParts[idx] = saved
      await syncAssemblyStatus()
      renderAssemblyDetail()
      if (openLinkedDetailIds.has(partId)) { openLinkedDetailIds.delete(partId); toggleLinkedDetail(partId, false) }
    }

    toastFn('Unlinked from inventory')
  } catch (e) {
    console.error(e)
    toastFn('Error unlinking item')
  }
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
  // Kick off an initial search (empty query = most recently modified docs)
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
    toastFn('Error searching Onshape documents')
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
    toastFn(e.message || 'Error loading assemblies')
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
        <div class="onshape-list-item-text">
          <div class="onshape-list-item-name">${a.name}</div>
        </div>
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
  onshapeCreateName   = asm.name   // pre-fill; user can edit in 'link' mode
  onshapeStep         = 'preview'
  onshapePreviewParts = []
  onshapeLoading      = true
  renderOnshapeModal()

  try {
    const params = new URLSearchParams({
      documentId:  asm.documentId,
      workspaceId: asm.workspaceId,
      elementId:   asm.id,
    })
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
    toastFn(e.message || 'Error loading BOM preview')
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

  // ── Subassembly preview rows ──────────────────────────────
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

  // ── Direct parts table ────────────────────────────────────
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
  if (onshapeStep === 'preview') {
    onshapeStep = 'assemblies'
  } else if (onshapeStep === 'assemblies') {
    onshapeStep = 'search'
  }
  renderOnshapeModal()
}

async function confirmOnshapeImport() {
  const confirmBtn = document.getElementById('btn-confirm-onshape')
  confirmBtn.disabled = true
  confirmBtn.textContent = 'Saving…'

  try {
    if (onshapeMode === 'link') {
      await confirmLinkAssembly()
    } else {
      await confirmImportParts()
    }
  } catch (e) {
    console.error(e)
    toastFn('Something went wrong — check console')
  } finally {
    confirmBtn.disabled = false
    renderOnshapeModal()   // restore correct button label
  }
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

    assemblies = await fetchAssemblies()
    toastFn(data.message || 'Re-imported successfully')
    selectAssembly(assembly.id)
  } catch (e) {
    console.error(e)
    toastFn(`Re-import failed: ${e.message}`)
    renderAssemblyDetail()
  }
}

// 'link' mode — delegates to the server for hierarchical BOM build
async function confirmLinkAssembly() {
  const name = (document.getElementById('onshape-create-name')?.value || onshapeCreateName).trim()
  if (!name) {
    document.getElementById('onshape-create-name')?.focus()
    toastFn('Assembly name is required')
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
  if (!res.ok) throw new Error(data.error + " and did:" + asm.documentId + " and wid:"+ asm.workspaceId+" and element id:" + asm.id || 'Import failed')

  assemblies = await fetchAssemblies()
  closeOnshapeModal()
  selectAssembly(data.assemblyId)
  toastFn(`"${name}" created — ${data.partCount} part(s), ${data.childCount} subassembly(ies)`)
}

// 'import' mode — add flat parts to the currently open assembly
async function confirmImportParts() {
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
  currentParts.push(...saved)

  const assembly = assemblyById(currentAssemblyId)
  if (assembly && !assembly.onshapeElementId && onshapeSelectedAsm) {
    const asm = onshapeSelectedAsm
    const onshapeUrl = `https://cad.onshape.com/documents/${asm.documentId}/w/${asm.workspaceId}/e/${asm.id}`
    const updated = await upsertAssembly({
      ...assembly,
      onshapeUrl,
      onshapeDocumentId:  asm.documentId,
      onshapeWorkspaceId: asm.workspaceId,
      onshapeElementId:   asm.id,
      thumbnail:          onshapeSelectedDoc?.thumbnailUrl || assembly.thumbnail || null,
    })
    const idx = assemblies.findIndex(a => a.id === currentAssemblyId)
    if (idx > -1) assemblies[idx] = updated
  }

  await syncAssemblyStatus()
  closeOnshapeModal()
  renderAssemblyDetail()
  toastFn(`Imported ${saved.length} part${saved.length === 1 ? '' : 's'} from Onshape`)
}

// ── Bind all designer events ──────────────────────────────────
export function bindDesignerEvents() {
  // (nav-all click is owned by main.js — it checks designerMode and delegates here)

  // Assembly modal
  document.getElementById('btn-close-asm-modal').addEventListener('click', closeAssemblyModal)
  document.getElementById('btn-cancel-asm').addEventListener('click', closeAssemblyModal)
  document.getElementById('btn-save-asm').addEventListener('click', saveAssembly)
  document.getElementById('asm-modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeAssemblyModal()
  })

  // Part modal
  document.getElementById('btn-close-part-modal').addEventListener('click', closePartModal)
  document.getElementById('btn-cancel-part').addEventListener('click', closePartModal)
  document.getElementById('btn-save-part').addEventListener('click', savePart)
  document.getElementById('part-modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closePartModal()
  })

  // BOM import modal
  document.getElementById('btn-close-bom-modal').addEventListener('click', closeBomImportModal)
  document.getElementById('btn-cancel-bom').addEventListener('click', closeBomImportModal)
  document.getElementById('bom-file-input').addEventListener('change', handleBomFile)
  document.getElementById('btn-confirm-bom').addEventListener('click', confirmBomImport)
  document.getElementById('bom-import-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeBomImportModal()
  })

  // Onshape import modal
  document.getElementById('btn-close-onshape-modal').addEventListener('click', closeOnshapeModal)
  document.getElementById('btn-cancel-onshape').addEventListener('click', closeOnshapeModal)
  document.getElementById('btn-onshape-back').addEventListener('click', goBackOnshapeStep)
  document.getElementById('btn-confirm-onshape').addEventListener('click', confirmOnshapeImport)
  document.getElementById('onshape-import-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeOnshapeModal()
  })

  // Inventory link modal
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

// ── Onshape webhook result handler (called by onshape-bom API) ──
// When an assembly is imported via the Onshape API route, it creates
// an assembly in Supabase. This function refreshes and opens it.
export async function refreshAndOpenAssembly(assemblyId) {
  assemblies = await fetchAssemblies()
  selectAssembly(assemblyId)
}
// ── Linked instance detail (inline expansion under a part row) ─
// Tracks which part rows currently have their linked-instance detail open,
// so re-renders (e.g. after qty change) can restore the open state.
let openLinkedDetailIds = new Set()

async function toggleLinkedDetail(partId, isChildPart) {
  const el = document.getElementById(`linked-detail-${partId}`)
  if (!el) return

  const isOpen = el.style.display !== 'none'
  if (isOpen) {
    el.style.display = 'none'
    openLinkedDetailIds.delete(partId)
    return
  }

  openLinkedDetailIds.add(partId)
  el.style.display = 'block'
  el.innerHTML = `<div class="inv-linked-loading"><i class="ti ti-loader-2 spin" aria-hidden="true"></i> Loading…</div>`

  const part = isChildPart
    ? currentChildParts.find(p => p.id === partId)
    : currentParts.find(p => p.id === partId)
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

  if (!instances.length) {
    el.innerHTML = ''
    el.style.display = 'none'
    return
  }

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

  // Location edit — save on blur/Enter
  el.querySelectorAll('[data-loc-input]').forEach(input => {
    const save = async () => {
      const instId = input.dataset.locInput
      try {
        await updateInstanceLocation(instId, input.value.trim())
      } catch (e) {
        console.error(e)
        toastFn('Error updating location')
      }
    }
    input.addEventListener('blur', save)
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur() })
  })

  // Unlink button
  el.querySelectorAll('[data-unlink-instance]').forEach(btn =>
    btn.addEventListener('click', () => unlinkInstanceFromPart(partId, btn.dataset.unlinkInstance, isChildPart))
  )
}
