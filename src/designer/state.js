// src/designer/state.js
//
// Single source of truth for state shared across the designer/* modules.
// Everything here used to be a bare module-level `let` in designer.js.
// Rather than pass a dozen values through every function signature, each
// piece of state gets a get/set pair (matching the existing getAssemblies()
// convention designer.js already used) — modules import only the
// getters/setters they actually touch.
//
// Nothing in this file renders, fetches, or touches the DOM — it's pure
// state + the couple of tiny pure helpers (genId, assemblyById,
// computePartStatus, etc.) that many modules need and that don't belong
// to any one feature area.

// ── Toast ─────────────────────────────────────────────────────
let toastFn = msg => console.warn('[toast]', msg)
export function setToast(fn) { toastFn = fn }
export function toast(msg, onClick) { toastFn(msg, onClick) }

// ── Shared id helper ─────────────────────────────────────────
export function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

// ── Assemblies (root list + current selection) ─────────────────
let assemblies        = []
let currentAssemblyId = null
let currentParts      = []
let currentPartJobs   = {}   // assembly_part id -> active fabrication job
let currentPartOrders = {}   // assembly_part id -> active (non-received) cart_items
let currentChildren   = []   // assembly_children rows for the current root assembly
let navigationStack   = []   // [{id, name}] trail from root -> current (root assemblies only)
let isolatedMode      = false

export function getAssemblies()          { return assemblies }
export function setAssemblies(v)         { assemblies = v }
export function getCurrentAssemblyId()   { return currentAssemblyId }
export function setCurrentAssemblyId(v)  { currentAssemblyId = v }
export function getCurrentParts()        { return currentParts }
export function setCurrentParts(v)       { currentParts = v }
export function getCurrentPartJobs()     { return currentPartJobs }
export function setCurrentPartJobs(v)    { currentPartJobs = v }
export function getCurrentPartOrders()   { return currentPartOrders }
export function setCurrentPartOrders(v)  { currentPartOrders = v }
export function getCurrentChildren()     { return currentChildren }
export function setCurrentChildren(v)    { currentChildren = v }
export function getNavigationStack()     { return navigationStack }
export function setNavigationStack(v)    { navigationStack = v }
export function getIsolatedMode()        { return isolatedMode }
export function setIsolatedMode(v)       { isolatedMode = v }

export function assemblyById(id) { return assemblies.find(a => a.id === id) }

// ── Subassembly (child) viewing state ───────────────────────────
let viewingChildId       = null
let childNavStack        = []
let childDetailTab       = 'parts'
let currentChildName     = null
let currentChildParts    = []
let currentChildChildren = []
let currentChildPartJobs = {}
let currentChildPartOrders = {}

export function getViewingChildId()        { return viewingChildId }
export function setViewingChildId(v)       { viewingChildId = v }
export function getChildNavStack()         { return childNavStack }
export function setChildNavStack(v)        { childNavStack = v }
export function getChildDetailTab()        { return childDetailTab }
export function setChildDetailTab(v)       { childDetailTab = v }
export function getCurrentChildName()      { return currentChildName }
export function setCurrentChildName(v)     { currentChildName = v }
export function getCurrentChildParts()     { return currentChildParts }
export function setCurrentChildParts(v)    { currentChildParts = v }
export function getCurrentChildChildren()  { return currentChildChildren }
export function setCurrentChildChildren(v) { currentChildChildren = v }
export function getCurrentChildPartJobs()  { return currentChildPartJobs }
export function setCurrentChildPartJobs(v) { currentChildPartJobs = v }
export function getCurrentChildPartOrders()  { return currentChildPartOrders }
export function setCurrentChildPartOrders(v) { currentChildPartOrders = v }

// ── Detail tab (root assembly view) ─────────────────────────────
let detailTab = 'parts'
export function getDetailTab()  { return detailTab }
export function setDetailTab(v) { detailTab = v }

// ── Parts-table filters (shared by root + child views) ──────────
let fabFilter       = 'all'
let partSearchQuery = ''
let partNumberOnly  = false

export function getFabFilter()        { return fabFilter }
export function setFabFilter(v)       { fabFilter = v }
export function getPartSearchQuery()  { return partSearchQuery }
export function setPartSearchQuery(v) { partSearchQuery = v }
export function getPartNumberOnly()   { return partNumberOnly }
export function setPartNumberOnly(v)  { partNumberOnly = v }

export function resetPartFilters() {
  fabFilter = 'all'
  partSearchQuery = ''
  partNumberOnly = false
}

// ── Small pure helpers used across many modules ──────────────────
export function partsProgress(parts) {
  if (!parts.length) return { collected: 0, total: 0, pct: 0 }
  const total     = parts.reduce((s, p) => s + p.quantityNeeded, 0)
  const collected = parts.reduce((s, p) => s + p.quantityCollected, 0)
  return { collected, total, pct: total ? Math.round(100 * collected / total) : 0 }
}

export function computePartStatus(p) {
  const collected = p.quantityCollected || 0
  if (collected >= p.quantityNeeded) return 'complete'
  if (collected > 0) return 'partial'
  return 'pending'
}

export function statusLabel(s) {
  if (s === 'complete') return '<span class="asm-badge asm-badge--complete"><i class="ti ti-check"></i> Complete</span>'
  if (s === 'active')   return '<span class="asm-badge asm-badge--active"><i class="ti ti-loader-2"></i> Active</span>'
  return '<span class="asm-badge asm-badge--draft"><i class="ti ti-pencil"></i> Draft</span>'
}

export function derivedAssemblyStatus(parts) {
  if (!parts.length) return 'draft'
  if (parts.every(p => computePartStatus(p) === 'complete')) return 'complete'
  if (parts.some(p => computePartStatus(p) !== 'pending')) return 'active'
  return 'draft'
}

// `orders` is a list of active (non-received) cart_items for one part —
// see fetchActiveCartItemsForParts in db.js.
export function totalPromisedQty(job, orders) {
  const fromJob    = job ? Math.max(0, job.quantityRequested - job.quantityMachined) : 0
  const fromOrders = (orders || []).reduce((sum, o) => sum + (o.quantity || 0), 0)
  return fromJob + fromOrders
}

// ── Part-row filter predicates (used by partsTable.js's render) ───
export function fabFilterMatches(p) {
  if (fabFilter === 'all') return true
  return p.fabricationMetadata?.status === fabFilter
}

export function partSearchMatches(p) {
  const q = partSearchQuery.trim().toLowerCase()
  if (!q) return true
  return (p.partName || '').toLowerCase().includes(q)
    || (p.partNumber || '').toLowerCase().includes(q)
    || (p.onshapeReference?.partNumber || '').toLowerCase().includes(q)
    || (p.notes || '').toLowerCase().includes(q)
}

export function partHasPartNumber(p) {
  return !!(p.partNumber || p.onshapeReference?.partNumber)
}

export function partNumberFilterMatches(p) {
  return !partNumberOnly || partHasPartNumber(p)
}

export function partRowVisible(p) {
  return fabFilterMatches(p) && partSearchMatches(p) && partNumberFilterMatches(p)
}