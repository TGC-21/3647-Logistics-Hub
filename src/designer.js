
import {
  fetchAssemblies, upsertAssembly, deleteAssembly,
  fetchAssemblyParts, upsertAssemblyPart, bulkInsertAssemblyParts, deleteAssemblyPart,
  fetchAssemblyChildren, fetchChildrenOfChild, fetchAssemblyChildById, fetchChildParts,
  fetchComponents, fetchAvailableInstances, reserveInstance, unreserveInstance,
  fetchInstancesByIds, updateInstanceLocation,
  releaseInstances, fetchAllLinkedInstanceIdsForAssembly,
  fetchActiveJobsForParts, createFabricationJob,
  fetchComponentsForFabricatePicker, findOrCreateComponent,
  fetchCategories, upsertCategory, validateAttribute, 
  fetchSuggestedInstancesForPartNumber, upsertCartItem, fetchPartNumberByValue,
  ensurePartNumberStub, linkPartNumberToComponent,
  findOrCreateCartForVendor, findOrCreateVendor,
  fetchListingsForPartNumber, upsertVendorListing,
  fetchAllPartNumbersWithListings, fetchActiveCartItemsForParts,
} from './db.js'

import { registerNewJob } from './fabricate.js'
import { renderSegmentEditor, renderSegmentPreview } from './segmentEditor.js'
import {
  registerNewCartItem, registerNewCart, registerNewVendor,
  getVendors, getPartNumbers,
} from './partOrders.js'

// ── State ─────────────────────────────────────────────────────
let assemblies        = []
let currentAssemblyId = null
let currentParts      = []
let currentPartJobs = {} //assembly_part id -> active fabrication job, for the currently open root assembly
let currentChildren   = []   // assembly_children rows for the current assembly
let navigationStack   = []   // [{id, name}] trail from root → current (root assemblies only)
let editingAssemblyId = null
let editingPartId     = null
let editingChild      = false
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

let fabDetectRunning   = false   // true while POST /api/onshape-detect-fabrication is in flight
let fabDetectPartId    = null    // assembly_parts.id currently shown in the confirm modal
let fabDetectIsChild   = false
let fabDetectMatch     = null    // the single resolved match object (only set when unambiguous) — spacer only
let fabDetectCandidates = null 
let fabDetectKind       = null   // 'spacer' | 'axial-shaft' — which confirm-overlay branch is showing
let fabDetectSegments   = null   // working (editable) segment array — axial-shaft only
let fabDetectOriginalSegments = null   // as-detected segment array, for override diffing at confirm time
let fabFilter = 'all'

let cartLinkPartId = null
let cartLinkIsChild = false
let cartLinkPartNumber = null   // the resolved part_numbers row
let cartLinkListings = []

let currentPartOrders      = {}   // assembly_part id -> array of active (non-received) cart_items, for the currently open root assembly
let currentChildPartOrders = {}   // same, for a subassembly node

let partSearchQuery = ''
let partNumberOnly  = false   // "has part number" filter
// Hard-coded category shape for auto-created Spacer components — no UI
// to configure this in v1, matches the confirmation overlay's fields.
const SPACER_CATEGORY_NAME = 'Spacer'
const SPACER_REQUIRED_KEYS_CONFIG = [
  { key: 'Spacer Type', type: 'enum', options: ['ROUND', 'HEX', 'HEX375'] },
  { key: 'OD',           type: 'quantity', defaultUnit: 'in' },
  { key: 'ID or Across Flats', type: 'quantity', defaultUnit: 'in' },
  { key: 'Length',       type: 'quantity', defaultUnit: 'in' },
]

// Hard-coded category shape for auto-created Axial Shaft components —
// mirrors the Spacer precedent above. A single 'segments'-typed
// characteristic holds the whole reconstructed profile (see
// AXIAL_SHAFT_DETECTION_ROADMAP.md's component-typing decision) rather
// than a fixed set of scalar fields, since a shaft's dimensions are an
// ordered list, not a handful of independent values.
const AXIAL_SHAFT_CATEGORY_NAME = 'Axial Shaft'
const AXIAL_SHAFT_REQUIRED_KEYS_CONFIG = [
  { key: 'Profile', type: 'segments', segmentUnit: 'in' },
]

const PLATE_CATEGORY_NAME = 'Plate'
const PLATE_REQUIRED_KEYS_CONFIG = [
  { key: 'Material',  type: 'enum', options: ['Aluminum', 'Polycarbonate', 'Acrylic', 'Steel', 'Other'] },
  { key: 'Thickness', type: 'quantity', defaultUnit: 'in' },
]

async function ensurePlateCategory() {
  const cats = await fetchCategories()
  let cat = cats.find(c => c.name === PLATE_CATEGORY_NAME)
  if (cat) return cat
  cat = await upsertCategory({ id: genId(), name: PLATE_CATEGORY_NAME, requiredKeysConfig: PLATE_REQUIRED_KEYS_CONFIG })
  return cat
}

/** Finds (or creates, once) the hard-coded "Axial Shaft" category —
 *  mirrors ensureSpacerCategory() below. */

function fabFilterMatches(p) {
  if (fabFilter === 'all') return true
  return p.fabricationMetadata?.status === fabFilter
}

function partSearchMatches(p) {
  const q = partSearchQuery.trim().toLowerCase()
  if (!q) return true
  return (p.partName || '').toLowerCase().includes(q)
    || (p.partNumber || '').toLowerCase().includes(q)
    || (p.onshapeReference?.partNumber || '').toLowerCase().includes(q)
    || (p.notes || '').toLowerCase().includes(q)
}

function partHasPartNumber(p) {
  return !!(p.partNumber || p.onshapeReference?.partNumber)
}

function partNumberFilterMatches(p) {
  return !partNumberOnly || partHasPartNumber(p)
}

function partRowVisible(p) {
  return fabFilterMatches(p) && partSearchMatches(p) && partNumberFilterMatches(p)
}

function fabFilterSelectHTML() {
  const opts = [
    ['all', 'All parts'],
    ['detected', 'Detected'],
    ['needs_review', 'Needs review'],
    ['queued', 'Queued for fab'],
    ['ignored', 'Ignored'],
  ]
  return `<select id="fab-filter-select" style="font-size:12px;padding:4px 8px;border-radius:var(--border-radius-md);border:0.5px solid var(--color-border-secondary);background:var(--color-background-primary);color:var(--color-text-primary)">
    ${opts.map(([v, l]) => `<option value="${v}"${fabFilter === v ? ' selected' : ''}>${l}</option>`).join('')}
  </select>`
}

async function ensureAxialShaftCategory() {
  const cats = await fetchCategories()
  let cat = cats.find(c => c.name === AXIAL_SHAFT_CATEGORY_NAME)
  if (cat) return cat
  cat = await upsertCategory({ id: genId(), name: AXIAL_SHAFT_CATEGORY_NAME, requiredKeysConfig: AXIAL_SHAFT_REQUIRED_KEYS_CONFIG })
  return cat
}

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
  spacer:  ['Spacer'],
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
  // quantityCollected is the SUM of linked instance quantities, not a row
  // count — one forked instance can represent more than 1 unit.
  const collected = p.quantityCollected || 0
  if (collected >= p.quantityNeeded) return 'complete'
  if (collected > 0) return 'partial'
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
    currentPartJobs = await fetchActiveJobsForParts(currentParts.map(p => p.id))
    currentPartOrders = await fetchActiveCartItemsForParts(currentParts.map(p => p.id))
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

   const detectFabBtn = isLinked
     ? `<button class="btn btn-sm" id="btn-detect-fabrication">
          <i class="ti ti-scan" aria-hidden="true"></i><span> Detect fabrication candidates</span>
        </button>`
     : ''

// ...include ${detectFabBtn} next to ${reimportBtn} in the toolbar template...
//
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
        ${partSearchToolbarHTML()}
        <div style="flex:1"></div>
        <button class="btn btn-sm" id="btn-import-csv"><i class="ti ti-upload" aria-hidden="true"></i><span> Import CSV</span></button>
        <button class="btn btn-sm" id="btn-import-onshape"><i class="ti ti-cube" aria-hidden="true"></i><span> Import from Onshape</span></button>
        ${assembly.onshapeElementId ? fabFilterSelectHTML() : ''}
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
  document.getElementById('btn-detect-fabrication')?.addEventListener('click', runFabricationDetection)
  document.getElementById('fab-filter-select')?.addEventListener('change', e => {
    fabFilter = e.target.value
    renderAssemblyDetail()
  })

  document.getElementById('chk-part-number-only')?.addEventListener('change', e => {
    partNumberOnly = e.target.checked
    renderAssemblyDetail()
  })
  let partSearchTimer
  document.getElementById('part-search-input')?.addEventListener('input', e => {
    partSearchQuery = e.target.value
    clearTimeout(partSearchTimer)
    // Re-render on a short debounce so search feels responsive without
    // re-rendering the whole table on every keystroke; caret position is
    // preserved because the input keeps focus across renders below.
    partSearchTimer = setTimeout(() => {
      renderAssemblyDetail()
      const input = document.getElementById('part-search-input')
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length) }
    }, 200)
  })

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


/** POSTs to /api/onshape-detect-fabrication for the current assembly, then
 *  refetches parts so the new fabrication_metadata shows up on rows.
 *  Button-triggered only — never called automatically during import. */
async function runFabricationDetection() {
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
 
    currentParts = await fetchAssemblyParts(currentAssemblyId)
    renderAssemblyDetail()
    toastFn(data.message || 'Detection complete')
  } catch (e) {
    console.error(e)
    toastFn(e.message || 'Error running fabrication detection')
  } finally {
    fabDetectRunning = false
  }
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
let currentChildPartJobs = {}

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
    currentChildPartJobs = await fetchActiveJobsForParts(currentChildParts.map(p => p.id))
    currentChildPartOrders = await fetchActiveCartItemsForParts(currentChildParts.map(p => p.id))
  } catch (e) {
    area.innerHTML = `<div class="empty"><i class="ti ti-alert-circle"></i><div class="empty-title">Error loading subassembly</div></div>`
    return
  }
  const isLinked = !!child.onshapeElementId
  currentChildName = child.name
  const parentLabel = childNavStack.length ? childNavStack[childNavStack.length - 1].name : ''

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
      ${tabsHTML ? '' : `<div class="asm-parts-toolbar"><div class="asm-parts-title">Parts <span class="section-count">${currentChildParts.length}</span></div>${partSearchToolbarHTML()}</div>`}
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
  document.getElementById('btn-detect-fabrication')?.addEventListener('click', runFabricationDetection)

  document.getElementById('tab-btn-parts')?.addEventListener('click', () => { childDetailTab = 'parts'; renderChildDetail() })
  document.getElementById('tab-btn-subassemblies')?.addEventListener('click', () => { childDetailTab = 'subassemblies'; renderChildDetail() })
  document.getElementById('fab-filter-select')?.addEventListener('change', e => {
    fabFilter = e.target.value
    renderAssemblyDetail()
  })
    document.getElementById('chk-part-number-only')?.addEventListener('change', e => {
    partNumberOnly = e.target.checked
    renderChildDetail()
  })
  let childPartSearchTimer
  document.getElementById('part-search-input')?.addEventListener('input', e => {
    partSearchQuery = e.target.value
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

  const tbody = document.getElementById('child-parts-tbody')
  if (tbody) {
    tbody.addEventListener('click', async e => {
      const linkBtn = e.target.closest('[data-part-link]')
      const viewLinkedBtn = e.target.closest('[data-view-linked]')
      const delBtn = e.target.closest('[data-child-part-del]')
      const editBtn = e.target.closest('[data-child-part-edit]')
      const fabBtn = e.target.closest('[data-child-part-fab]')
      const fabDetectBtn = e.target.closest('[data-child-part-fabdetect]')
      const orderBtn = e.target.closest('[data-child-part-order]')

      if (fabDetectBtn) { openFabDetectConfirmModal(fabDetectBtn.dataset.childPartFabdetect, true); return }
      if (linkBtn) { openInventoryLinkModal(linkBtn.dataset.partLink, true); return }
      if (viewLinkedBtn) { await toggleLinkedDetail(viewLinkedBtn.dataset.viewLinked, true); return }
      if (delBtn) { await deleteChildPart(delBtn.dataset.childPartDel); return }
      if (fabBtn) { openSendToFabricateModal(fabBtn.dataset.childPartFab, true); return }
      if (orderBtn) { await addPartToCart(orderBtn.dataset.childPartOrder, true); return }
      if (editBtn) { openPartModal(editBtn.dataset.childPartEdit, true); return }
      
    })
  }
}

/** Small status pill for a part row's linked fabricatino job, if any. */
function fabJobBadgeHTML(job) {
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

// `orders` here is really a list of active (non-received) cart_items —
// see fetchActiveCartItemsForParts in db.js. Unlike fabrication_jobs'
// quantity_requested/quantity_machined split, a cart_item has no partial-
// receipt tracking: it's either outstanding (status 'pending'/'ordered')
// or fully 'received', so the whole item's quantity counts as promised
// until it flips to received (at which point fetchActiveCartItemsForParts
// excludes it from this list entirely).
function totalPromisedQty(job, orders) {
  const fromJob    = job ? Math.max(0, job.quantityRequested - job.quantityMachined) : 0
  const fromOrders = (orders || []).reduce((sum, o) => sum + (o.quantity || 0), 0)
  return fromJob + fromOrders
}

function orderBadgesHTML(orders) {
  if (!orders || !orders.length) return ''
  return orders.map(o => {
    const label = o.status === 'pending' ? `In cart (${o.quantity})` : `Ordered (${o.quantity})`
    return `<span class="fab-job-badge fab-job-badge--${o.status === 'pending' ? 'queued' : 'committed'}" title="Part order: ${o.quantity} pending arrival">
      <i class="ti ti-truck-delivery" aria-hidden="true"></i> ${label}
    </span>`
  }).join('')
}

function childPartRowHTML(p, job = null, orders = []) {
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

  // promised = whatever this part's active job still owes beyond what
  // it's already machined - those units aren't "collected" yet, but
  // they're not un-accounted-for either.
  const promisedQty = totalPromisedQty(job, orders)
  const gapRemaining = p.quantityNeeded - collectedQty - promisedQty
  const canPromiseMore = gapRemaining > 0;
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
      ${fabDetectActionable(p) ? `<button class="btn-icon" data-part-fabdetect="${p.id}" aria-label="Review spacer detection" title="Review auto-detected fabrication candidate"><i class="ti ti-scan" style="font-size:13px"></i></button>` : ''}
      </td>
  </tr>`
}

function partRowHTML(p, job = null, orders = []) {
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

function bindPartRowEvents() {
  const tbody = document.getElementById('parts-tbody')
  if (!tbody) return

  tbody.addEventListener('click', async e => {

    const linkBtn = e.target.closest('[data-part-link]')
    if (linkBtn) { openInventoryLinkModal(linkBtn.dataset.partLink, false); return }

    const viewLinkedBtn = e.target.closest('[data-view-linked]')
    if (viewLinkedBtn) { await toggleLinkedDetail(viewLinkedBtn.dataset.viewLinked, false); return }

    const editBtn = e.target.closest('[data-part-edit]')
    if (editBtn) { openPartModal(editBtn.dataset.partEdit, false); return }

    const delBtn = e.target.closest('[data-part-del]')
    if (delBtn) { await deletePart(delBtn.dataset.partDel); return }

    const fabBtn = e.target.closest('[data-part-fab]')
    if (fabBtn) { openSendToFabricateModal(fabBtn.dataset.partFab, false); return }

    const fabDetectBtn = e.target.closest('[data-part-fabdetect]')
    if (fabDetectBtn) { openFabDetectConfirmModal(fabDetectBtn.dataset.partFabdetect, false); return }

    const orderBtn = e.target.closest('[data-part-order]')
    if (orderBtn) { await addPartToCart(orderBtn.dataset.partOrder, false); return }
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
  fabFilter         = 'all'
  partSearchQuery   = ''
  partNumberOnly    = false
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
function openPartModal(id, isChildPart = false) {
  
  editingPartId = id || null
  const p = isChildPart
    ? currentChildParts.find(p => p.id === editingPartId)
    : currentParts.find(p => p.id === editingPartId)
  if (!p) return

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
    // Preserve the real collected amount — it's a sum of linked instance
    // quantities, not something to recompute from row count on every edit.
    quantityCollected: existing?.quantityCollected ?? 0,    notes:             document.getElementById('part-field-notes').value.trim(),
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

// ── Send to Fabricate ────────────────────────────────────────
 // Creates a fabrication_jobs row promising to machine the remaining gap
// (needed − collected) for one assembly_part.
//
// A part doesn't need any inventory linked to be sent to fabricate — but
// record_machined_units() (schema.sql) still needs SOME components row to
// attach the eventually-machined inventory_instance to. So if the part has
// no componentId yet, this flow inserts two steps before the quantity
// step: search the catalog for an existing component to resolve to, or
// create a new one (category + typed required attributes — identical
// validation to Inventory mode's Add Component modal). Either way, once a
// component is resolved it's persisted onto the part immediately (same as
// linkInstanceToPart does), with no inventory_instance created — that only
// happens later when machined units are actually logged.
let fabJobPartId      = null
let fabJobIsChildPart = false

// Establish-component sub-flow state — only touched when the part has no
// componentId yet. fabStep is null once a component is already resolved
// (existing behavior: straight to the quantity step).
let fabStep               = null   // null | 'search' | 'create'
let fabCatalog            = []     // fetchComponentsForFabricatePicker() result, fetched once per modal open
let fabCategories         = []     // fetchCategories() result, fetched once per modal open
let fabComponentQuery     = ''
let fabSelectedCategoryId = ''
let fabNewCatMode         = false
let fabNewCatReqKeysConfig = []    // working copy while creating a category inline — same shape as main.js's editingReqKeysConfig


function currentFabJobPart() {
  return fabJobIsChildPart
    ? currentChildParts.find(p => p.id === fabJobPartId)
    : currentParts.find(p => p.id === fabJobPartId)
}

async function openSendToFabricateModal(partId, isChildPart = false) {
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

  // No component resolved yet — load the catalog + categories once and
  // start on the search step.
  fabStep               = 'search'
  fabComponentQuery     = ''
  fabSelectedCategoryId = ''
  fabNewCatMode         = false
  fabNewCatReqKeysConfig = []
  renderFabModalStep()   // show a loading state immediately

  try {
    ;[fabCatalog, fabCategories] = await Promise.all([
      fetchComponentsForFabricatePicker(),
      fetchCategories(),
    ])
  } catch (e) {
    console.error(e)
    toastFn('Error loading component catalog')
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
  const attrs = (component.attributes || [])
    .map(a => `${a.key}: ${a.value}`)
    .join(' · ')
  return attrs || '—'
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

/** Persists a resolved component onto the current fab part (no inventory
 *  instance created), then advances to the quantity step. Shared by both
 *  "picked an existing component" and "just created a new one". */
async function selectFabComponent(componentId) {
  const part = currentFabJobPart()
  if (!part) return

  try {
    const saved = await upsertAssemblyPart({ ...part, componentId })
    if (fabJobIsChildPart) {
      const idx = currentChildParts.findIndex(p => p.id === part.id)
      if (idx > -1) currentChildParts[idx] = saved
    } else {
      const idx = currentParts.findIndex(p => p.id === part.id)
      if (idx > -1) currentParts[idx] = saved
    }
    fabStep = null
    renderFabModalStep()
  } catch (e) {
    console.error(e)
    toastFn('Error linking component to part')
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


// Typed required-characteristics editor for a brand-new category — mirrors
// main.js's renderReqKeysConfig()/addReqKeyConfig() exactly (same CSS
// classes), scoped to this modal's own element ids + fabNewCatReqKeysConfig.
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
    input.addEventListener('input', () => {
      fabNewCatReqKeysConfig[parseInt(input.dataset.idx, 10)].key = input.value
    })
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
    input.addEventListener('input', () => {
      fabNewCatReqKeysConfig[parseInt(input.dataset.idx, 10)].segmentUnit = input.value.trim()
    })
  )
  list.querySelectorAll('.fab-enum-options-input').forEach(ta =>
    ta.addEventListener('input', () => {
      fabNewCatReqKeysConfig[parseInt(ta.dataset.idx, 10)].options =
        ta.value.split('\n').map(s => s.trim()).filter(Boolean)
    })
  )
  list.querySelectorAll('.fab-quantity-unit-input').forEach(input =>
    input.addEventListener('input', () => {
      fabNewCatReqKeysConfig[parseInt(input.dataset.idx, 10)].defaultUnit = input.value.trim()
    })
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

/** Reads the current value out of a required attr row, regardless of type —
 *  mirrors main.js's readAttrRowValue(). */
function fabReadAttrRowValue(row) {
  if (row.dataset.type === 'quantity') {
    const numInput = row.querySelector('input[data-num-input]')
    return numInput ? numInput.value : ''
  }
  const input = row.querySelector('[data-val-input]')
  return input ? input.value : ''
}

/** Builds one required-characteristic row for the given type config —
 *  mirrors main.js's buildRequiredAttrRow() so fabricate-flow components
 *  are validated identically to ones created from Inventory mode. */
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
  if (!name) { document.getElementById('fab-new-cat-input').focus(); toastFn('Category name is required'); return }

  const cleanConfigs = fabNewCatReqKeysConfig
    .map(cfg => ({ ...cfg, key: cfg.key.trim() }))
    .filter(cfg => cfg.key)

  try {
    const saved = await upsertCategory({ id: genId(), name, requiredKeysConfig: cleanConfigs })
    fabCategories.push(saved)
    fabSelectedCategoryId = saved.id
    fabHideNewCatRow()
    renderFabCreateStep()
    toastFn('Category created')
  } catch (e) {
    console.error(e)
    toastFn('Error creating category')
  }
}

async function confirmFabEstablishComponent() {
  const part = currentFabJobPart()
  if (!part) return

  const catId = document.getElementById('fab-field-cat').value || ''
  if (!catId) { toastFn('Select a category'); return }
  const cat = fabCategories.find(c => c.id === catId)
  const keysConfig = (cat && cat.requiredKeysConfig) || []

  // ── Validate required rows, type-aware — mirrors main.js's saveItem() ──
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

  if (!valid) { toastFn('Fill in all required characteristics correctly'); return }

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
    toastFn('Error creating component')
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
    const job = await createFabricationJob({
      assemblyPartId:    part.id,
      quantityRequested: qty,
      batchId:           null,
      genId,
    })
    registerNewJob(job)
    if (fabJobIsChildPart) {
      currentChildPartJobs[part.id] = job
      renderChildDetail()
    } else {
      currentPartJobs[part.id] = job
      renderAssemblyDetail()
    }
    closeSendToFabricateModal()
    toastFn(`Sent ${qty} × "${part.partName}" to Fabricate`)
  } catch (e) {
    console.error(e)
    toastFn(e.message?.includes('duplicate') ? 'This part already has an active fabrication job.' : 'Error creating fabrication job')
  } finally {
    btn.disabled = false
    btn.innerHTML = '<i class="ti ti-tool" aria-hidden="true"></i> Send to Fabricate'
  }
}

function currentFabDetectPart() {
  return fabDetectIsChild
    ? currentChildParts.find(p => p.id === fabDetectPartId)
    : currentParts.find(p => p.id === fabDetectPartId)
}
 
function openFabDetectConfirmModal(partId, isChildPart = false) {
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
  if (!spacerFields || !segmentsFields) {
    // Static markup missing — almost always a stale bundle/HTML mismatch
    // (e.g. dev server serving an old index.html against new JS) rather
    // than a real runtime condition. Fail loudly in the console instead
    // of throwing out of this click handler.
    console.error('[fab-detect] Missing #fab-detect-spacer-fields or #fab-detect-segments-fields in the DOM — hard-refresh / rebuild likely needed.')
    return
  }

  const plateFields = document.getElementById('fab-detect-plate-fields')
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

/** Seeds fabDetectSegments from a detected (or previously-edited, if the
 *  modal is being reopened before confirming) axial-shaft's metadata, and
 *  renders the shared segment editor. Overrides are re-applied so
 *  reopening the modal doesn't discard in-progress edits made earlier in
 *  the same session. */
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

  // Restore any segments the user added in a prior (unconfirmed) edit —
  // these exist only in overrides, not in the detected list.
  if (meta.overrides) {
    Object.entries(meta.overrides).forEach(([id, ov]) => {
      if (ov.userAdded && !fabDetectSegments.some(s => s.id === id)) {
        const { userAdded, reason, ...rest } = ov
        fabDetectSegments.push({ id, ...rest })
      }
    })
  }

  const previewEl = document.getElementById('fab-detect-segments-preview')
  if (previewEl) renderSegmentPreview(previewEl, fabDetectSegments, {unit: 'in'})
    
  const segListEl = document.getElementById('fab-detect-segments-list')
  if (segListEl) {
    renderSegmentEditor(segListEl, fabDetectSegments, {
      editable: true,
      unit: 'in',
      onChange: () => {},   // array is mutated in place — nothing extra to sync
    })
  } else {
    console.error('[fab-detect] #fab-detect-segments-list not found in the DOM.')
  }

  const gap = Math.max(1, part.quantityNeeded - (part.quantityCollected || 0))
  const qtyEl = document.getElementById('fab-detect-field-qty')
  if (qtyEl) { qtyEl.value = gap; qtyEl.max = gap }

  
}

/** The original spacer-specific field population, unchanged in behavior —
 *  just extracted into its own function so openFabDetectConfirmModal can
 *  dispatch by kind. */
function openSpacerConfirmFields(part, meta) {
  const candidateField  = document.getElementById('fab-detect-candidate-field')
  const candidateSelect = document.getElementById('fab-detect-candidate-select')

  if (meta.candidateMatches && meta.candidateMatches.length > 1) {
    // Ambiguous — detection found multiple spacer features in this part's
    // source Part Studio and can't tell which one this BOM row is.
    // Previously this silently defaulted to candidateMatches[0] for every
    // row in the group, which meant two genuinely different spacers could
    // show identical dimensions. Now we show all candidates and require
    // an explicit pick.
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
    // Unambiguous — either a clean single match, or no candidateMatches
    // at all (meta itself carries the dimensions directly).
    fabDetectCandidates = null
    candidateField.style.display = 'none'
    fabDetectMatch = meta.dimensions ? meta : meta
  }

  populateFabDetectFields(part)
}

/** Seeds the plate confirm fields from detected metadata — thickness
 *  and confidence only, per resolved scope. Material has no detected
 *  value (not derivable from geometry alone in v1), so it's always left
 *  for the user to pick. */
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
 
/** Fills the OD/ID/length/spacer-type/qty fields from whatever
 *  fabDetectMatch currently points at. Called on modal open and again
 *  whenever the candidate picker's selection changes. */
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
 
/** Bound to the candidate <select>'s change event — swaps fabDetectMatch
 *  to the newly picked candidate and refreshes the form fields. */
function handleFabDetectCandidateChange() {
  const idx = parseInt(document.getElementById('fab-detect-candidate-select').value, 10) || 0
  if (!fabDetectCandidates || !fabDetectCandidates[idx]) return
  fabDetectMatch = fabDetectCandidates[idx]
  const part = currentFabDetectPart()
  if (part) populateFabDetectFields(part)
}
 
function closeFabDetectConfirmModal() {
  document.getElementById('fab-detect-confirm-overlay').style.display = 'none'
  fabDetectPartId = null
  fabDetectMatch  = null
  fabDetectCandidates = null
  fabDetectKind = null
  fabDetectSegments = null
  fabDetectOriginalSegments = null
}
 
/** Finds (or creates, once) the hard-coded "Spacer" category. */
async function ensureSpacerCategory() {
  let cats = await fetchCategories()
  let cat = cats.find(c => c.name === SPACER_CATEGORY_NAME)
  if (cat) return cat
  cat = await upsertCategory({ id: genId(), name: SPACER_CATEGORY_NAME, requiredKeysConfig: SPACER_REQUIRED_KEYS_CONFIG })
  return cat
}
 
async function confirmFabDetection() {
  const part = currentFabDetectPart()
  if (!part) return

  if (fabDetectKind === 'axial-shaft') {
    await confirmAxialShaftDetection(part)
    return
  }

  if (fabDetectKind === 'plate') {
    await confirmPlateDetection(part)
    return
  }

  const od     = parseFloat(document.getElementById('fab-detect-field-od').value)
  const idOrAf = parseFloat(document.getElementById('fab-detect-field-id').value)
  const length = parseFloat(document.getElementById('fab-detect-field-length').value)
  const qty    = Math.max(1, parseInt(document.getElementById('fab-detect-field-qty').value, 10) || 1)
 
  if (!Number.isFinite(od) || !Number.isFinite(idOrAf) || !Number.isFinite(length)) {
    toastFn('OD, ID/across-flats, and Length are all required')
    return
  }
 
  const meta = part.fabricationMetadata || {}
  const spacerType = fabDetectMatch?.spacerType || 'ROUND'
 
  // Original detected values (if any) are preserved; anything the user
  // typed that differs from what detection found is recorded as an
  // override — matches the roadmap's overrides shape.
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
      'Spacer Type':          spacerType,
      'OD':                   String(od),
      'ID or Across Flats':   String(idOrAf),
      'Length':               String(length),
    }
    const component = await findOrCreateComponent({
      categoryId: spacerCat.id,
      fields:     spacerCat.requiredKeysConfig,
      attrs,
      fallback:   { name: part.partName, description: `Auto-detected ${spacerType.toLowerCase()} spacer`, image: null },
      genId,
    })
 
    const updatedMeta = {
      ...meta,
      status: 'queued',
      overrides: Object.keys(overrides).length ? overrides : (meta.overrides || null),
    }
 
    const savedPart = await upsertAssemblyPart({ ...part, componentId: component.id, fabricationMetadata: updatedMeta })
 
    const job = await createFabricationJob({
      assemblyPartId:    part.id,
      quantityRequested: qty,
      batchId:           null,
      genId,
    })
    registerNewJob(job)
 
    if (fabDetectIsChild) {
      const idx = currentChildParts.findIndex(p => p.id === part.id)
      if (idx > -1) currentChildParts[idx] = savedPart
      currentChildPartJobs[part.id] = job
      renderChildDetail()
    } else {
      const idx = currentParts.findIndex(p => p.id === part.id)
      if (idx > -1) currentParts[idx] = savedPart
      currentPartJobs[part.id] = job
      renderAssemblyDetail()
    }
 
    closeFabDetectConfirmModal()
    toastFn(`Confirmed "${part.partName}" — sent ${qty} to Fabricate`)
  } catch (e) {
    console.error(e)
    toastFn(e.message?.includes('duplicate') ? 'This part already has an active fabrication job.' : 'Error confirming spacer')
  } finally {
    btn.disabled = false
    btn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i> Confirm &amp; send to Fabricate'
  }
}
 

/**
 * Confirms an auto-detected (or user-edited) axial shaft: validates every
 * segment, diffs the final segment list against what was originally
 * detected to build `overrides` (keyed by stable segment id — see
 * AXIAL_SHAFT_DETECTION_ROADMAP.md's resolved override scheme), finds or
 * creates the matching "Axial Shaft" component, and creates a
 * fabrication job — same downstream mechanics as confirmFabDetection's
 * spacer path.
 */
async function confirmAxialShaftDetection(part) {
  if (!fabDetectSegments || !fabDetectSegments.length) {
    toastFn('At least one segment is required')
    return
  }

  for (const seg of fabDetectSegments) {
    if (!Number.isFinite(seg.length) || seg.length <= 0) { toastFn('Every segment needs a positive length'); return }
    if (seg.type === 'round'  && (!Number.isFinite(seg.diameter)    || seg.diameter    <= 0)) { toastFn('Every round segment needs a diameter'); return }
    if (seg.type === 'hex'    && (!Number.isFinite(seg.acrossFlats) || seg.acrossFlats <= 0)) { toastFn('Every hex segment needs an across-flats value'); return }
    if ((seg.type === 'square' || seg.type === 'prism') && (!Number.isFinite(seg.width) || seg.width <= 0)) { toastFn('Every square/prism segment needs a width'); return }
  }

  const qty = Math.max(1, parseInt(document.getElementById('fab-detect-field-qty').value, 10) || 1)

  // Diff the final (possibly edited) segment list against the original
  // detection, by stable id — never by array index (see roadmap).
  const overrides = {}
  const originalById = Object.fromEntries((fabDetectOriginalSegments || []).map(s => [s.id, s]))
  const survivingIds = new Set()

  for (const seg of fabDetectSegments) {
    survivingIds.add(seg.id)
    const original = originalById[seg.id]

    if (!original) {
      overrides[seg.id] = { ...seg, userAdded: true, reason: 'User-added segment' }
      continue
    }
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
    // Strip UI-only fields (warnings) before persisting — the stored
    // attribute value should be pure dimensional data.
    const profileValue = {
      totalLength,
      segments: fabDetectSegments.map(({ warnings, ...rest }) => rest),
    }

    const component = await findOrCreateComponent({
      categoryId: shaftCat.id,
      fields:     shaftCat.requiredKeysConfig,
      attrs:      { 'Profile': profileValue },
      fallback:   { name: part.partName, description: 'Auto-detected axial shaft', image: null },
      genId,
    })

    const updatedMeta = {
      ...meta,
      status: 'queued',
      overrides: Object.keys(overrides).length ? overrides : (meta.overrides || null),
    }

    const savedPart = await upsertAssemblyPart({ ...part, componentId: component.id, fabricationMetadata: updatedMeta })

    const job = await createFabricationJob({
      assemblyPartId:    part.id,
      quantityRequested: qty,
      batchId:           null,
      genId,
    })
    registerNewJob(job)

    if (fabDetectIsChild) {
      const idx = currentChildParts.findIndex(p => p.id === part.id)
      if (idx > -1) currentChildParts[idx] = savedPart
      currentChildPartJobs[part.id] = job
      renderChildDetail()
    } else {
      const idx = currentParts.findIndex(p => p.id === part.id)
      if (idx > -1) currentParts[idx] = savedPart
      currentPartJobs[part.id] = job
      renderAssemblyDetail()
    }

    closeFabDetectConfirmModal()
    toastFn(`Confirmed "${part.partName}" — sent ${qty} to Fabricate`)
  } catch (e) {
    console.error(e)
    toastFn(e.message?.includes('duplicate') ? 'This part already has an active fabrication job.' : 'Error confirming shaft')
  } finally {
    btn.disabled = false
    btn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i> Confirm &amp; send to Fabricate'
  }
}

async function confirmPlateDetection(part) {
  const thickness = parseFloat(document.getElementById('fab-detect-plate-field-thickness').value)
  const material  = document.getElementById('fab-detect-plate-field-material').value
  const qty       = Math.max(1, parseInt(document.getElementById('fab-detect-field-qty').value, 10) || 1)

  if (!Number.isFinite(thickness) || thickness <= 0) { toastFn('Thickness is required'); return }
  if (!material) { toastFn('Material is required'); return }

  const meta = part.fabricationMetadata || {}
  const detectedThickness = meta.dimensions?.thickness?.value
  const overrides = {}
  if (detectedThickness !== thickness) {
    overrides.thickness = { value: thickness, unit: 'in', reason: 'User confirmation edit' }
  }

  const btn = document.getElementById('btn-confirm-fab-detect')
  btn.disabled = true; btn.textContent = 'Confirming…'

  try {
    const plateCat = await ensurePlateCategory()
    const attrs = {
      'Material':  material,
      'Thickness': String(thickness),
    }
    const component = await findOrCreateComponent({
      categoryId: plateCat.id,
      fields:     plateCat.requiredKeysConfig,
      attrs,
      fallback:   { name: part.partName, description: `Auto-detected ${material.toLowerCase()} plate`, image: null },
      genId,
    })

    const updatedMeta = {
      ...meta,
      status: 'queued',
      overrides: Object.keys(overrides).length ? overrides : (meta.overrides || null),
    }

    const savedPart = await upsertAssemblyPart({ ...part, componentId: component.id, fabricationMetadata: updatedMeta })

    const job = await createFabricationJob({
      assemblyPartId:    part.id,
      quantityRequested: qty,
      batchId:           null,
      genId,
    })
    registerNewJob(job)

    if (fabDetectIsChild) {
      const idx = currentChildParts.findIndex(p => p.id === part.id)
      if (idx > -1) currentChildParts[idx] = savedPart
      currentChildPartJobs[part.id] = job
      renderChildDetail()
    } else {
      const idx = currentParts.findIndex(p => p.id === part.id)
      if (idx > -1) currentParts[idx] = savedPart
      currentPartJobs[part.id] = job
      renderAssemblyDetail()
    }

    closeFabDetectConfirmModal()
    toastFn(`Confirmed "${part.partName}" — sent ${qty} to Fabricate`)
  } catch (e) {
    console.error(e)
    toastFn(e.message?.includes('duplicate') ? 'This part already has an active fabrication job.' : 'Error confirming plate')
  } finally {
    btn.disabled = false
    btn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i> Confirm &amp; send to Fabricate'
  }
}

/** "Not a spacer" — marks the row ignored so it stops showing the review
 *  action, without creating any component or job. */
async function ignoreFabDetection() {
  const part = currentFabDetectPart()
  if (!part) return
  try {
    const updatedMeta = { ...(part.fabricationMetadata || {}), status: 'ignored' }
    const saved = await upsertAssemblyPart({ ...part, fabricationMetadata: updatedMeta })
    if (fabDetectIsChild) {
      const idx = currentChildParts.findIndex(p => p.id === part.id)
      if (idx > -1) currentChildParts[idx] = saved
      renderChildDetail()
    } else {
      const idx = currentParts.findIndex(p => p.id === part.id)
      if (idx > -1) currentParts[idx] = saved
      renderAssemblyDetail()
    }
    closeFabDetectConfirmModal()
    toastFn('Marked as not a spacer')
  } catch (e) {
    console.error(e)
    toastFn('Error updating part')
  }
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

    // Strong signal first: if this part's Onshape-derived part number is
    // already tied to a component, show ONLY that component's available
    // instances — this is the "heavily filtered" auto-suggestion.
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

    if (!invLinkAllComponents.length) {
      invLinkAllComponents = await fetchComponents()
    }

    const q = query.trim().toLowerCase()
    // Components no longer carry `name`/`tags` directly — those live on
    // inventory_instances now. Match against the component's fallback
    // name, which is the closest thing a component has to a display name.
    const matches = q
      ? invLinkAllComponents.filter(c =>
        (c.fallbackName || '').toLowerCase().includes(q))
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

  // quantityCollected already reflects the SUM of linked instance
  // quantities (see linkInstanceToPart), not a row count — so comparing
  // it directly against quantityNeeded gives the correct remaining cap.
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
          <input
            type="number"
            class="inv-link-qty-input"
            data-qty-for="${inst.id}"
            min="1"
            max="${Math.min(inst.quantity, remainingNeeded)}"
            value="1"
            style="width:52px"
          >
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

  // Attach component id via closure lookup since dataset can't hold it cleanly per-row
  el.querySelectorAll('.inv-link-comp-card').forEach((card, i) => {
    const componentId = invLinkResults[i].component.id
    card.querySelectorAll('[data-add-instance]').forEach(btn => {
      btn.dataset.componentId = componentId
    })
  })
}

async function linkInstanceToPart(instanceId, componentName, componentId, requestedQty = 1) {
  const part = currentInvLinkPart()
  if (!part) return

  // Enforce the cap: never let linked quantity exceed quantityNeeded.
  const currentLinked   = part.linkedInstanceIds || []
  const alreadyLinked   = part.quantityCollected || 0
  const remainingNeeded = part.quantityNeeded - alreadyLinked
  if (remainingNeeded <= 0) {
    toastFn(`Already have ${part.quantityNeeded} linked — quantity needed is met.`)
    return
  }
  const qty = Math.min(requestedQty, remainingNeeded)
  if (qty <= 0) {
    return
  }


  const assemblyName = invLinkIsChildPart
    ? (document.getElementById('content-title')?.textContent || 'Assembly')
    : (assemblyById(currentAssemblyId)?.name || 'Assembly')

  try {
    // reserveInstance forks `qty` units off the source pile into a new,
    // dedicated row and returns THAT row — link the fork's id, not the
    // source instanceId, since the source may no longer exist if this
    // reservation emptied it entirely.
    const fork = await reserveInstance(instanceId, qty, assemblyName)

    const newLinkedIds = [...currentLinked, fork.id]
    const updatedPart = {
      ...part,
      componentId:       part.componentId || componentId,
      linkedInstanceIds: newLinkedIds,
      quantityCollected: alreadyLinked + qty,
    }
    updatedPart.status = computePartStatus(updatedPart)

    const saved = await upsertAssemblyPart(updatedPart)
        // Backfill: this confirms which component the part's vendor SKU
    // actually is, so future imports/links auto-suggest correctly.
    const rawPartNumber = part.onshapeReference?.partNumber || part.partNumber
    if (rawPartNumber) {
      try { await linkPartNumberToComponent(rawPartNumber, updatedPart.componentId || componentId) }
      catch (e) { console.warn('[partNumbers] backfill failed', e) }
    }

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

    toastFn(`Linked ${qty} x ${componentName} to "${part.partName}"`)
    document.getElementById('inv-link-subtitle').textContent =
      `For: ${saved.partName} (${saved.quantityCollected}/${saved.quantityNeeded} linked)`
    loadAndSearchInventory(invLinkQuery)  // refresh available counts + button states
  } catch (e) {
    console.error(e)
    // The RPC throws if the pile has fewer than `qty` available (e.g. a
    // concurrent reservation beat this one to it) — surface that clearly
    // rather than a generic error, and refresh so stale quantities clear.
    toastFn(e.message?.includes('available') ? e.message : 'Error linking inventory item')
    loadAndSearchInventory(invLinkQuery)
  } finally {

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
     // Need the forked row's own quantity to subtract the right amount
    // from quantityCollected — a single linked instance can represent
    // more than 1 unit now.
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

  // Send to Fabricate modal
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

  document.getElementById('btn-fab-back').addEventListener('click', () => {
    fabStep = 'search'
    renderFabModalStep()
  })

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

  document.getElementById('btn-close-fab-detect').addEventListener('click', closeFabDetectConfirmModal)
  document.getElementById('btn-cancel-fab-detect').addEventListener('click', closeFabDetectConfirmModal)
  document.getElementById('btn-confirm-fab-detect').addEventListener('click', confirmFabDetection)
  document.getElementById('btn-fab-detect-ignore').addEventListener('click', ignoreFabDetection)
  document.getElementById('fab-detect-candidate-select').addEventListener('change', handleFabDetectCandidateChange())
  document.getElementById('fab-detect-confirm-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeFabDetectConfirmModal()
  })

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

function fabDetectionBadgeHTML(p) {
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

// A row gets the "Review spacer" action button whenever detection found
// something that isn't already queued/ignored.
function fabDetectActionable(p) {
  const meta = p.fabricationMetadata
  return !!meta?.autoDetected && ['detected', 'needs_review'].includes(meta.status)
}

async function addPartToCart(partId, isChildPart = false) {
  const part = isChildPart ? currentChildParts.find(p => p.id === partId) : currentParts.find(p => p.id === partId)
  if (!part) return

  const rawPartNumber = part.onshapeReference?.partNumber || part.partNumber

  if (!rawPartNumber) {
    // No identity to auto-resolve — let the user search every existing
    // vendor listing and pick the right one manually, instead of a dead-end toast.
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
  } catch (e) { console.error(e); toastFn('Error resolving part number'); return }

  if (cartLinkListings.length === 1) { await addToCartWithListing(cartLinkListings[0]); return }
  if (cartLinkListings.length === 0) { openNewListingModal(rawPartNumber); return }
  openListingPickerModal()
}

let listingSearchAll = null

async function openListingSearchModal(partName) {
  document.getElementById('listing-search-subtitle').textContent = `For: ${partName}`
  document.getElementById('listing-search-input').value = ''
  document.getElementById('listing-search-overlay').style.display = 'flex'
  document.getElementById('btn-listing-search-new').onclick = () => {
    document.getElementById('listing-search-overlay').style.display = 'none'
    // No known part number string — prompt for one alongside the vendor listing.
    openAdhocListingModal()
  }

  if (!listingSearchAll) {
    try { listingSearchAll = await fetchAllPartNumbersWithListings() }
    catch (e) { console.error(e); toastFn('Error loading listings'); listingSearchAll = [] }
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
// vendor listing together, same shape as openNewListingModal but without
// a pre-resolved cartLinkPartNumber.
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
  const part = cartLinkIsChild ? currentChildParts.find(p => p.id === cartLinkPartId) : currentParts.find(p => p.id === cartLinkPartId)
  if (!part) return

  try {
    const vendor = getVendors().find(v => v.id === listing.vendorId)
    const cart = await findOrCreateCartForVendor(listing.vendorId, vendor?.name || 'Vendor', genId)
    const item = await upsertCartItem({
      id: genId(), cartId: cart.id,
      vendorListingId: listing.id,
      assemblyPartId: part.id,
      nameOverride: part.partName,   // fallback if no component linked yet
      quantity: Math.max(1, part.quantityNeeded - (part.quantityCollected || 0)) || 1,
      status: 'pending',
    })
    registerNewCart(cart)
    registerNewCartItem(item)
    toastFn(`Added "${part.partName}" to cart "${cart.name}"`)
  } catch (e) { console.error(e); toastFn('Error adding to cart') }
}

// ── "No listings yet" — one-click-collapsing add-vendor-listing modal ──
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

  if (!vendorSel && !newVendorName) { toastFn('Select or enter a vendor'); return }

  try {
    const vendor = vendorSel ? getVendors().find(v => v.id === vendorSel) : await findOrCreateVendor(newVendorName, genId)
    if (!vendorSel) registerNewVendor(vendor)

    let partNumber = cartLinkPartNumber
    if (!partNumber) {
      const sku = skuField?.value.trim()
      if (!sku) { toastFn('Enter a part number'); return }
      partNumber = await ensurePartNumberStub(sku, genId)
    }

    const listing = await upsertVendorListing({
      id: genId(), partNumberId: partNumber.id, vendorId: vendor.id,
      purchaseLink: link, purchasePrice: price ? parseFloat(price) : null, isPreferred: true,
    })
    document.getElementById('new-listing-modal-overlay').style.display = 'none'
    if (skuField) skuField.style.display = 'none'
    await addToCartWithListing(listing)
  } catch (e) { console.error(e); toastFn('Error creating vendor listing') }
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

function partSearchToolbarHTML() {
  return `
    <div class="onshape-search-row" style="margin:0;max-width:220px">
      <i class="ti ti-search" aria-hidden="true"></i>
      <input type="text" id="part-search-input" placeholder="Search parts…" value="${partSearchQuery}">
    </div>
    <label class="fab-history-toggle">
      <input type="checkbox" id="chk-part-number-only" ${partNumberOnly ? 'checked' : ''}>
      <span>Has part #</span>
    </label>`
}
// (The old "Send to Part Order" modal — currentOrderPart/openSendToOrderModal/
// closeSendToOrderModal/confirmSendToOrder, backed by the deprecated
// part_orders table — was removed here. The row buttons now call
// addPartToCart() directly, which resolves the part's vendor listing
// (or prompts to create one) and adds it straight to the real
// carts/cart_items system. See addPartToCart above for the actual flow.)