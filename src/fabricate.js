// fabricate.js — Fabricate workflow (batches + jobs)
//
// A batch groups jobs going on the same machine/setup. A job promises to
// machine N units for exactly one assembly_part. See schema.sql for the
// full lifecycle (queued → committed → in_progress → complete → archived)
// and db.js for the CRUD/RPC layer this module calls into.
//
// Mirrors designer.js's structure/conventions (module-level state, a
// sidebar renderer + content renderer sharing the same DOM ids designer.js
// uses, toastFn injection from main.js).

import {
  fetchFabricationBatches, upsertFabricationBatch, deleteFabricationBatch,
  fetchAllFabricationJobs, fetchAssemblyPartsByIds, fetchAssemblyChildById,
  fetchRootAssemblyIdForChild,  moveJobToBatch, updateQueuedJobQuantity,
  claimFabricationJob, releaseFabricationJobClaim,
  archiveFabricationJob,
  fetchComponentsForFabricatePicker,
} from './db.js'
// Migration Plan Phase 2 cutover — create/recordProgress/deleteQueued
// now go through the migrated route (services/FabricationJobService.js
// via api/fabrication-jobs.js) instead of talking to Supabase directly.
// Everything else here (batches, claim/release, archive, quantity
// edits) is NOT part of that service's scope and still calls db.js —
// see MIGRATION_PLAN.md's own note that only create/recordProgress/
// deleteQueued were ever built out for Fabrication Jobs.
import { deleteQueuedFabricationJob, recordMachinedUnits } from './services/fabricationJobsApi.js'
import { getAssemblies } from './designer.js'
import { getCurrentMemberName } from './members.js'
import { renderSegmentPreview } from './segmentEditor.js'
import { renderSegmentPreview3D, disposeSegmentPreview3D } from './segmentPreview3D.js'

// ── State ─────────────────────────────────────────────────────
let batches         = []
let jobs            = []          // ALL jobs, every status — filtered per-view
let partsCache      = {}          // assembly_part id → part row
let componentsCache = {}
let childNameCache  = new Map()   // assembly_children id → name (lazy-resolved)
let selectedAssemblyId = null     // null = overview ("All jobs"), else an assembly id — primary nav now
let batchFilterId   = '__all__'   // secondary filter within an assembly's job list: '__all__' | '__unbatched__' | a batch id
let jobAssemblyIdCache = new Map()   // job id -> resolved root assembly id (or null), memoized across renders
let showHistory     = false       // "Show archived" topbar checkbox
let editingBatchId  = null
let selectedJobId   = null        // job shown in the job detail overlay, or null
let mergingJobIds   = null        // [jobIdA, jobIdB] when the batch modal was open by
                                  // dropping one job card onto another - on save, both
                                  // jobs are moved into the newly-created batch.
let dragJobId       = null        // job id currently being dragged, for card drag/drop
let activeShaftPreviewEl = null   // tracks the live 3D container so it can be disposed before the next re-render replaces it

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

let toastFn = msg => console.warn('[toast]', msg)
export function setFabricateToast(fn) { toastFn = fn }

// ── Boot ──────────────────────────────────────────────────────
export async function fabricateBoot() {
  ;[batches, jobs] = await Promise.all([fetchFabricationBatches(), fetchAllFabricationJobs()])
  partsCache = await fetchAssemblyPartsByIds([...new Set(jobs.map(j => j.assemblyPartId))])
  await refreshComponentsCache()
  jobAssemblyIdCache = new Map()
  await primeJobAssemblyIds(jobs)
}

async function refreshComponentsCache() {
  try {
    componentsCache = Object.fromEntries((await fetchComponentsForFabricatePicker()).map(c => [c.id, c]))
  } catch (e) {
    console.warn('[fabricate] Could not load component spec details', e)
  }
}

/** Called by designer.js right after "Send to Fabricate" creates a job,
 *  so switching to the Fabricate tab shows it without a full reload.
 *  Also best-effort refreshes the component cache, since a brand-new
 *  job usually means a brand-new (or newly resolved) component whose
 *  spec details wouldn't otherwise show up on its card until reboot. */
export function registerNewJob(job) {
  jobs.push(job)
  refreshComponentsCache().catch(() => {})
  primeJobAssemblyIds([job]).catch(() => {})
}

function replaceJob(updated) {
  const idx = jobs.findIndex(j => j.id === updated.id)
  if (idx > -1) jobs[idx] = updated
}

// ── Job → root assembly resolution ───────────────────────────
// A job only carries assemblyPartId. Its owning part is either a root
// part (assemblyId set directly) or a subassembly part
// (assemblyChildId set — needs walking up the child chain). Memoized
// per job id since many jobs in the same subassembly resolve to the
// same root, and fetchRootAssemblyIdForChild itself walks one level
// at a time — no reason to repeat that walk per job.
const childRootCache = new Map()   // assemblyChildId -> resolved root assemblyId (or null)

async function resolveJobAssemblyId(job) {
  if (jobAssemblyIdCache.has(job.id)) return jobAssemblyIdCache.get(job.id)

  const part = partsCache[job.assemblyPartId]
  let resolved = null
  if (part?.assemblyId) {
    resolved = part.assemblyId
  } else if (part?.assemblyChildId) {
    if (childRootCache.has(part.assemblyChildId)) {
      resolved = childRootCache.get(part.assemblyChildId)
    } else {
      resolved = await fetchRootAssemblyIdForChild(part.assemblyChildId).catch(() => null)
      childRootCache.set(part.assemblyChildId, resolved)
    }
  }
  jobAssemblyIdCache.set(job.id, resolved)
  return resolved
}

async function primeJobAssemblyIds(jobList) {
  // Parts referenced by these jobs might not be cached yet (e.g. a job
  // registered mid-session via registerNewJob) — top up first, same
  // pattern jobsTableHTML already uses.
  const missingPartIds = [...new Set(jobList.map(j => j.assemblyPartId).filter(id => !partsCache[id]))]
  if (missingPartIds.length) {
    const fetched = await fetchAssemblyPartsByIds(missingPartIds)
    partsCache = { ...partsCache, ...fetched }
  }
  await Promise.all(jobList.map(resolveJobAssemblyId))
}

/** Synchronous read of the memoized assembly id — used by render code,
 *  which must stay synchronous. Returns null (treated as "unassigned")
 *  until primeJobAssemblyIds has resolved it at least once. */
function jobAssemblyIdSync(job) {
  return jobAssemblyIdCache.has(job.id) ? jobAssemblyIdCache.get(job.id) : null
}


// ── Derived helpers ──────────────────────────────────────────
function jobsForBatch(batchId) { return jobs.filter(j => j.batchId === batchId) }
function unbatchedJobs()       { return jobs.filter(j => !j.batchId) }
function activeJobs(list)      { return list.filter(j => j.status !== 'archived') }

/** Every job (any batch status) whose resolved root assembly matches —
 *  the grouping unit the sidebar/content now navigate by. */
function jobsForAssembly(assemblyId) {
  return jobs.filter(j => jobAssemblyIdSync(j) === assemblyId)
}

/** Jobs whose part/assembly could not be resolved at all (deleted part,
 *  or a part that somehow has neither assemblyId nor assemblyChildId) —
 *  shown in a dedicated "Unassigned" bucket rather than silently
 *  dropped from every view. */
function unassignedJobs() {
  return jobs.filter(j => jobAssemblyIdSync(j) === null && !partsCache[j.assemblyPartId]?.assemblyId && !partsCache[j.assemblyPartId]?.assemblyChildId)
}

/** Applies the secondary batch filter on top of an assembly's job list. */
function applyBatchFilter(list) {
  if (batchFilterId === '__all__') return list
  if (batchFilterId === '__unbatched__') return list.filter(j => !j.batchId)
  return list.filter(j => j.batchId === batchFilterId)
}

function derivedBatchStatus(batchId) {
  const list   = jobsForBatch(batchId)
  const active = activeJobs(list)
  if (!list.length) return 'empty'
  if (!active.length) return 'archived'
  if (active.every(j => j.status === 'complete')) return 'complete'
  if (active.some(j => j.quantityMachined > 0 || j.status !== 'queued')) return 'in_progress'
  return 'queued'
}

// Reuses the asm-badge--{draft,active,complete} classes already defined
// in designer.css for assembly status, rather than inventing new ones.
function batchStatusBadgeHTML(status) {
  const map = {
    empty:       ['draft',    'ti-circle-dashed', 'No jobs'],
    queued:      ['draft',    'ti-clock',         'Queued'],
    in_progress: ['active',   'ti-loader-2',      'In progress'],
    complete:    ['complete', 'ti-check',         'Complete'],
    archived:    ['draft',    'ti-archive',       'Archived'],
  }
  const [cls, icon, label] = map[status] || map.queued
  return `<span class="asm-badge asm-badge--${cls}"><i class="ti ${icon}" aria-hidden="true"></i> ${label}</span>`
}

// Job status badge, standalone (was inline in jobCardHTML/jobRowHTML —
// factored out so the new assembly-view card can share it too).
function jobStatusBadgeHTML(job) {
  return {
    queued:      '<span class="part-badge part-badge--pending">Queued</span>',
    committed:   `<span class="part-badge part-badge--partial">Claimed${job.claimedBy ? ' — ' + job.claimedBy : ''}</span>`,
    in_progress: '<span class="part-badge part-badge--partial">In progress</span>',
    complete:    '<span class="part-badge part-badge--complete">Complete</span>',
    archived:    '<span class="part-badge part-badge--pending">Archived</span>',
  }[job.status] || job.status
}

function contextLabel(part) {
  if (!part) return '—'
  if (part.assemblyChildId) return `Sub: ${childNameCache.get(part.assemblyChildId) || '…'}`
  if (part.assemblyId) {
    const asm = getAssemblies().find(a => a.id === part.assemblyId)
    return asm ? asm.name : '—'
  }
  return '—'
}

/** Pulls the confirmed segment list off an Axial Shaft part's resolved
 *  component (the same `Profile` attribute FabricationDetectionService
 *  writes on confirm), or null if this part isn't a shaft / has no
 *  component cached yet. Shared by the 2D and 3D preview calls below. */
function fabShaftSegments(part) {
  if (!part || !part.componentId) return null
  const comp = componentsCache[part.componentId]
  if (!comp || comp.categoryName !== 'Axial Shaft') return null
  const attrs = Object.fromEntries((comp.attributes || []).map(a => [a.key, a.value]))
  const profile = attrs['Profile']
  if (!profile || !Array.isArray(profile.segments) || !profile.segments.length) return null
  return profile.segments
}

/** Renders a compact one-line spec summary (dimensions/material) for a
 *  part's resolved component, sourced from the Spacer/Axial Shaft/Plate
 *  category attributes — the same data the Designer confirm overlay
 *  writes. Lets a machinist read OD/ID/length or thickness/material
 *  straight off the Fabricate job card without opening Designer or
 *  Onshape. Returns '' when there's nothing to show (no component yet,
 *  component not cached, or a category this doesn't recognize). */
function fabDataHTML(part) {
  if (!part || !part.componentId) return ''
  const comp = componentsCache[part.componentId]
  if (!comp) return ''
  const attrs = Object.fromEntries((comp.attributes || []).map(a => [a.key, a.value]))
  const catName = comp.categoryName || ''

  if (catName === 'Spacer') {
    const type = attrs['Spacer Type'] || '?'
    const isHex = type.startsWith('HEX')
    return `<div class="fab-spec-line"><i class="ti ti-ruler-2" aria-hidden="true"></i> ${type} · OD ${attrs['OD'] ?? '?'}" · ${isHex ? 'AF' : 'ID'} ${attrs['ID or Across Flats'] ?? '?'}" · L ${attrs['Length'] ?? '?'}"</div>`
  }

  if (catName === 'Axial Shaft') {
    const profile = attrs['Profile']
    if (!profile || !Array.isArray(profile.segments) || !profile.segments.length) return ''
    const summary = profile.segments.map(s => {
      if (s.type === 'round')  return `⌀${s.diameter}"×${s.length}"`
      if (s.type === 'hex')    return `Hex ${s.acrossFlats}"×${s.length}"`
      if (s.type === 'square' || s.type === 'prism') return `${s.width}"×${s.length}"`
      return `${s.type}×${s.length}"`
    }).join(' → ')
    return `<div class="fab-spec-line"><i class="ti ti-ruler-2" aria-hidden="true"></i> ${summary}</div>`
  }

  if (catName === 'Plate') {
    return `<div class="fab-spec-line"><i class="ti ti-ruler-2" aria-hidden="true"></i> ${attrs['Material'] || '?'} · ${attrs['Thickness'] ?? '?'}" thick</div>`
  }

  return ''
}

// ── Sidebar ───────────────────────────────────────────────────
// Primary nav is now "which assembly" (mirrors Designer's sidebar) —
// batches are demoted to a secondary filter inside an assembly's view,
// since batching is orthogonal to which assembly a job's part belongs
// to (a single batch can, and often does, span multiple assemblies).
export function renderFabricateSidebar() {
  const navAll = document.getElementById('nav-all')
  const visibleJobCount = (showHistory ? jobs : jobs.filter(j => j.status !== 'archived')).length
  navAll.innerHTML = `<i class="ti ti-list-details" aria-hidden="true"></i> All jobs
   <span class="nav-count">${visibleJobCount}</span>`
  navAll.className = 'nav-item' + (selectedAssemblyId === null ? ' active' : '')

  const catNav = document.getElementById('cat-nav')
  const assemblies = getAssemblies()

  const assemblyItems = assemblies.map(a => {
    const list = showHistory ? jobsForAssembly(a.id) : jobsForAssembly(a.id).filter(j => j.status !== 'archived')
    if (!list.length) return ''   // hide assemblies with nothing to show, same as an empty Designer assembly wouldn't clutter nav
    const active = selectedAssemblyId === a.id
    return `<div class="nav-item asm-nav-item${active ? ' active' : ''}" data-asm-nav="${a.id}">
      <i class="ti ti-box" style="font-size:15px;flex-shrink:0" aria-hidden="true"></i>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px">${a.name}</span>
      <span class="nav-count">${list.length}</span>
    </div>`
  }).join('')

  const unassignedCount = (showHistory ? unassignedJobs() : unassignedJobs().filter(j => j.status !== 'archived')).length
  const unassignedItem = unassignedCount
    ? `<div class="nav-item asm-nav-item${selectedAssemblyId === '__unassigned__' ? ' active' : ''}" data-asm-nav="__unassigned__">
        <i class="ti ti-alert-triangle" style="font-size:15px;flex-shrink:0" aria-hidden="true"></i>
        <span style="flex:1;font-size:13px">Unassigned</span>
        <span class="nav-count">${unassignedCount}</span>
      </div>`
    : ''

  catNav.innerHTML = assemblyItems + unassignedItem
  // Hide the tags section — same convention Designer mode uses.
  document.getElementById('tags-divider').style.display  = 'none'
  document.getElementById('tags-label').style.display    = 'none'
  document.getElementById('tags-nav').innerHTML          = ''
  document.getElementById('sidebar-label-cats').textContent = 'Assemblies'

  catNav.querySelectorAll('[data-asm-nav]').forEach(el =>
    el.addEventListener('click', () => selectAssembly(el.dataset.batchNav))
  )
}

/** id is an assembly id, '__unassigned__', or null/falsy for "All jobs". */
export function selectAssembly(id) {
  selectedAssemblyId = id || null
  batchFilterId = '__all__'
  renderFabricateSidebar()
  renderFabricateContent()
}

// Kept as an alias — designer.js/fabricateFlow.js call selectBatch(null)
// today to mean "go to the Fabricate overview"; that meaning still holds.
export function selectBatch(id) { selectAssembly(id) }

// ── Content ───────────────────────────────────────────────────
export async function renderFabricateContent() {
  const title = document.getElementById('content-title')
  const meta  = document.getElementById('content-meta')
  const area  = document.getElementById('main-area')

  if (selectedAssemblyId === null) {
    title.textContent = 'Fabricate'
    meta.textContent  = `${jobs.length} job${jobs.length === 1 ? '' : 's'}`
    await renderOverview(area)
    return
  }

  if (selectedAssemblyId === '__unassigned__') {
    title.textContent = 'Unassigned jobs'
    meta.textContent  = 'Jobs whose part or assembly could not be resolved'
    await renderAssemblyJobsView(area, unassignedJobs(), null)
    return
  }

  const assembly = getAssemblies().find(a => a.id === selectedAssemblyId)
  if (!assembly) { selectAssembly(null); return }

  title.textContent = assembly.name
  meta.textContent  = `${jobsForAssembly(assembly.id).length} fabrication job${jobsForAssembly(assembly.id).length === 1 ? '' : 's'}`

  await renderAssemblyJobsView(area, jobsForAssembly(assembly.id), assembly)
}

/** Shared renderer for "one assembly's worth of jobs" and the
 *  "Unassigned" bucket (assembly === null in that case) — a job-card
 *  grid (mirrors Designer's parts-grid) plus a batch filter dropdown,
 *  since batching cuts across assemblies rather than nesting under one. */
async function renderAssemblyJobsView(area, jobList, assembly) {
  await primeJobCaches(jobList)

  const visible = applyBatchFilter(jobList.filter(j => showHistory || j.status !== 'archived'))
  const relevantBatchIds = [...new Set(jobList.map(j => j.batchId).filter(Boolean))]
  const relevantBatches = batches.filter(b => relevantBatchIds.includes(b.id))

  const batchFilterHTML = relevantBatches.length
    ? `<select id="fab-batch-filter-select" style="font-size:12px;padding:4px 8px;border-radius:var(--border-radius-md);border:0.5px solid var(--color-border-secondary);background:var(--color-background-primary);color:var(--color-text-primary)">
        <option value="__all__"${batchFilterId === '__all__' ? ' selected' : ''}>All batches</option>
        <option value="__unbatched__"${batchFilterId === '__unbatched__' ? ' selected' : ''}>Unbatched</option>
        ${relevantBatches.map(b => `<option value="${b.id}"${batchFilterId === b.id ? ' selected' : ''}>${b.name}</option>`).join('')}
      </select>`
    : ''

  area.innerHTML = `<div class="asm-detail">
    <div class="asm-detail-toolbar">
      <button class="btn btn-sm" id="btn-back-fab-overview"><i class="ti ti-arrow-left" aria-hidden="true"></i> All jobs</button>
      <div style="flex:1"></div>
      ${assembly?.onshapeUrl ? `<a class="btn btn-sm" href="${assembly.onshapeUrl}" target="_blank" rel="noreferrer"><i class="ti ti-external-link" aria-hidden="true"></i> Onshape</a>` : ''}
    </div>
    <div class="asm-parts-toolbar">
      <div class="asm-parts-title">Jobs <span class="section-count">${visible.length}</span></div>
      <div style="flex:1"></div>
      ${batchFilterHTML}
      <label class="fab-history-toggle"><input type="checkbox" id="chk-fab-history-inline" ${showHistory ? 'checked' : ''}> <span>Show archived</span></label>
    </div>
    ${visible.length
      ? `<div class="parts-grid" id="fab-jobs-grid">${visible.map(j => fabJobCardHTML(j)).join('')}</div>`
      : `<div class="empty" style="padding:40px 0">
          <i class="ti ti-list-check" aria-hidden="true"></i>
          <div class="empty-title">No jobs here</div>
          <div class="empty-sub">${batchFilterId !== '__all__' ? 'Try clearing the batch filter.' : ''}</div>
        </div>`}
  </div>`

  document.getElementById('btn-back-fab-overview').addEventListener('click', () => selectAssembly(null))
  document.getElementById('fab-batch-filter-select')?.addEventListener('change', e => {
    batchFilterId = e.target.value
    renderFabricateContent()
  })
  document.getElementById('chk-fab-history-inline')?.addEventListener('change', e => {
    showHistory = e.target.checked
    renderFabricateSidebar(); renderFabricateContent()
  })

  area.querySelectorAll('[data-open-job]').forEach(el =>
    el.addEventListener('click', () => openJobDetailModal(el.dataset.openJob))
  )
}


async function renderOverview(area) {
  // "All jobs" — every job across every assembly, grouped visually by
  // assembly (same idea as Designer's "All assemblies" grid, just one
  // level deeper since jobs are the leaf, not assemblies themselves).
  const visibleJobs = jobs.filter(j => showHistory || j.status !== 'archived')

  if (!visibleJobs.length) {
    area.innerHTML = `<div class="empty">
      <i class="ti ti-settings-automation" aria-hidden="true"></i>
      <div class="empty-title">No fabrication jobs yet</div>
      <div class="empty-sub">Jobs are created from an assembly's parts table via "Send to Fabricate." Batching them onto a machine run is optional.</div>
      <button class="btn btn-primary" id="empty-new-batch-btn"><i class="ti ti-plus"></i> New batch</button>
    </div>`
    document.getElementById('empty-new-batch-btn').addEventListener('click', () => openBatchModal())
    return
  }

  await primeJobCaches(visibleJobs)

  const assemblies = getAssemblies().filter(a => jobsForAssembly(a.id).some(j => showHistory || j.status !== 'archived'))
  const unassigned = unassignedJobs().filter(j => showHistory || j.status !== 'archived')

  const sectionsHTML = assemblies.map(a => {
    const list = jobsForAssembly(a.id).filter(j => showHistory || j.status !== 'archived')
    return `<div class="section-heading" data-asm-section="${a.id}" style="cursor:pointer">
        <i class="ti ti-box" aria-hidden="true"></i> ${a.name}
        <span class="section-count">${list.length}</span>
      </div>
      <div class="parts-grid">${list.slice(0, 6).map(j => fabJobCardHTML(j)).join('')}</div>
      ${list.length > 6 ? `<div style="margin:6px 0 4px"><button class="btn btn-sm" data-asm-section-more="${a.id}">View all ${list.length} in ${a.name} →</button></div>` : ''}`
  }).join('')

  const unassignedSectionHTML = unassigned.length ? `
    <div class="section-heading" data-asm-section="__unassigned__" style="cursor:pointer">
      <i class="ti ti-alert-triangle" aria-hidden="true"></i> Unassigned
      <span class="section-count">${unassigned.length}</span>
    </div>
    <div class="parts-grid">${unassigned.slice(0, 6).map(j => fabJobCardHTML(j)).join('')}</div>` : ''

  area.innerHTML = `<div style="display:flex;justify-content:flex-end;margin-bottom:10px">
      <button class="btn btn-sm" id="btn-new-batch-overview"><i class="ti ti-plus" aria-hidden="true"></i> New batch</button>
    </div>` + sectionsHTML + unassignedSectionHTML
  bindOverviewEvents(area)
  document.getElementById('btn-new-batch-overview')?.addEventListener('click', () => openBatchModal())
  area.querySelectorAll('[data-asm-section], [data-asm-section-more]').forEach(el => {
    const id = el.dataset.asmSection || el.dataset.asmSectionMore
    el.addEventListener('click', () => selectAssembly(id))
  })
}

// Resolves partsCache/childNameCache for a list of jobs — same top-up logic
// jobsTableHTML uses, factored out so the overview's job cards can call it
// without needing the full table markup.
async function primeJobCaches(jobList) {
  const missingPartIds = [...new Set(jobList.map(j => j.assemblyPartId).filter(id => !partsCache[id]))]
  if (missingPartIds.length) {
    const fetched = await fetchAssemblyPartsByIds(missingPartIds)
    partsCache = { ...partsCache, ...fetched }
  }

  const childIds = [...new Set(
    jobList.map(j => partsCache[j.assemblyPartId]?.assemblyChildId).filter(Boolean)
  )].filter(id => !childNameCache.has(id))
  if (childIds.length) {
    const resolved = await Promise.all(childIds.map(id => fetchAssemblyChildById(id).catch(() => null)))
    resolved.forEach((c, i) => { if (c) childNameCache.set(childIds[i], c.name) })
  }
  await primeJobAssemblyIds(jobList)
}
/** Job card in the new "part-card"-shaped layout — mirrors
 *  partsTable.js's partCardHTML visually (same .part-card/.card-*
 *  classes) so Fabricate's grid reads consistently with Designer's. */
function fabJobCardHTML(job) {
  const part      = partsCache[job.assemblyPartId]
  const partName  = part?.partName || '(deleted part)'
  const batch     = job.batchId ? batches.find(b => b.id === job.batchId) : null

  return `<div class="part-card fab-job-part-card" data-open-job="${job.id}" style="cursor:pointer">
    <div class="card-top">
      <div class="card-name-block">
        <div class="card-part-name">${partName}</div>
        <div class="card-part-number">${contextLabel(part)}</div>
      </div>
      <div class="card-qty">${job.quantityMachined} / ${job.quantityRequested}</div>
    </div>
    <div class="card-badges">
      ${jobStatusBadgeHTML(job)}
      ${batch ? `<span class="badge badge--muted"><i class="ti ti-tool" aria-hidden="true"></i> ${batch.name}</span>` : ''}
    </div>    
    ${fabDataHTML(part)}
  </div>`
}

// ── Overview interactions ────────────────────────────────────
// Drag-and-drop batch assignment (dragging a job card onto a batch
// card) doesn't apply now that the overview groups by assembly rather
// than surfacing batch cards directly — batch (re)assignment happens
// from the job detail modal's own <select>, unchanged below.
function bindOverviewEvents(area) {

  area.querySelectorAll('[data-open-job]').forEach(el =>
    el.addEventListener('click', () => openJobDetailModal(el.dataset.openJob))
  )

  // // Job card → drag source
  // area.querySelectorAll('[data-job-drag]').forEach(el => {
  //   el.addEventListener('dragstart', e => {
  //     dragJobId = el.dataset.jobDrag
  //     e.dataTransfer.effectAllowed = 'move'
  //     e.dataTransfer.setData('text/plain', dragJobId)
  //     el.classList.add('fab-card-dragging')
  //   })
  //   el.addEventListener('dragend', () => {
  //     dragJobId = null
  //     el.classList.remove('fab-card-dragging')
  //   })
  // })

  // // Batch card → drop target: assign the dragged job into this batch (confirm first)
  // area.querySelectorAll('[data-batch-drop]').forEach(el => {
  //   el.addEventListener('dragover', e => {
  //     if (!dragJobId) return
  //     e.preventDefault()
  //     e.dataTransfer.dropEffect = 'move'
  //     el.classList.add('fab-card-drop-target')
  //   })
  //   el.addEventListener('dragleave', () => el.classList.remove('fab-card-drop-target'))
  //   el.addEventListener('drop', e => {
  //     e.preventDefault()
  //     el.classList.remove('fab-card-drop-target')
  //     const jobId   = dragJobId || e.dataTransfer.getData('text/plain')
  //     const batchId = el.dataset.batchDrop
  //     if (jobId) handleDropJobOnBatch(jobId, batchId)
  //   })
  // })

  // // Job card → also a drop target: dropping one job onto another opens the
  // // "create batch" dialog pre-seeded to batch both jobs together.
  // area.querySelectorAll('[data-job-drag]').forEach(el => {
  //   el.addEventListener('dragover', e => {
  //     if (!dragJobId || dragJobId === el.dataset.jobDrag) return
  //     e.preventDefault()
  //     e.dataTransfer.dropEffect = 'move'
  //     el.classList.add('fab-card-drop-target')
  //   })
  //   el.addEventListener('dragleave', () => el.classList.remove('fab-card-drop-target'))
  //   el.addEventListener('drop', e => {
  //     e.preventDefault()
  //     el.classList.remove('fab-card-drop-target')
  //     const droppedJobId = dragJobId || e.dataTransfer.getData('text/plain')
  //     const targetJobId   = el.dataset.jobDrag
  //     if (droppedJobId && droppedJobId !== targetJobId) {
  //       openBatchModal(null, [droppedJobId, targetJobId])
  //     }
  //   })
  // })
}

// async function handleDropJobOnBatch(jobId, batchId) {
//   const job   = jobs.find(j => j.id === jobId)
//   const batch = batches.find(b => b.id === batchId)
//   const part  = job ? partsCache[job.assemblyPartId] : null
//   if (!job || !batch) return
//   if (job.batchId === batchId) return

//   const confirmed = confirm(`Place ${part ? `"${part.partName}"` : 'this job'} into batch "${batch.name}"?`)
//   if (!confirmed) return

//   await handleMoveBatch(jobId, batchId)
// }

// ── Job table (shared by overview's "unbatched" drill-in and batch detail) ──
// Retained as-is for now — no current call site after the rewrite above,
// but kept for reference until the batch modal's own list view (if any
// gets added later) needs it. Safe to delete in a follow-up cleanup pass.
async function jobsTableHTML(list, showBatchAssign) {
  if (!list.length) {
    return `<div class="empty" style="padding:40px 0">
      <i class="ti ti-list-check" aria-hidden="true"></i>
      <div class="empty-title">No jobs here</div>
    </div>`
  }

  // partsCache is seeded at boot, but a job created mid-session elsewhere
  // (e.g. Designer's "Send to Fabricate") only arrives via registerNewJob,
  // not with its part pre-fetched — so top up any that are missing.
  const missingPartIds = [...new Set(list.map(j => j.assemblyPartId).filter(id => !partsCache[id]))]
  if (missingPartIds.length) {
    const fetched = await fetchAssemblyPartsByIds(missingPartIds)
    partsCache = { ...partsCache, ...fetched }
  }

  const childIds = [...new Set(
    list.map(j => partsCache[j.assemblyPartId]?.assemblyChildId).filter(Boolean)
  )].filter(id => !childNameCache.has(id))
  if (childIds.length) {
    const resolved = await Promise.all(childIds.map(id => fetchAssemblyChildById(id).catch(() => null)))
    resolved.forEach((c, i) => { if (c) childNameCache.set(childIds[i], c.name) })
  }

  const visible = list.filter(j => showHistory || j.status !== 'archived')
  const rows = visible.map(j => jobRowHTML(j, showBatchAssign)).join('')

  return `<div class="parts-table-wrap">
    <table class="parts-table">
      <thead><tr>
        <th>Part</th><th>Context</th>
        <th style="text-align:center">Requested</th>
        <th style="text-align:center">Machined</th>
        <th>Status</th>
        ${showBatchAssign ? '<th>Batch</th>' : ''}
        <th></th>
      </tr></thead>
      <tbody id="fab-jobs-tbody">${rows}</tbody>
    </table>
  </div>`
}

function batchSelectHTML(job) {
  const opts = [`<option value=""${!job.batchId ? ' selected' : ''}>Unbatched</option>`]
    .concat(batches.map(b => `<option value="${b.id}"${job.batchId === b.id ? ' selected' : ''}>${b.name}</option>`))
  return `<select data-job-batch="${job.id}">${opts.join('')}</select>`
}

function jobRowHTML(job, showBatchAssign) {
  const part      = partsCache[job.assemblyPartId]
  const partName  = part?.partName || '(deleted part)'
  const remaining = Math.max(0, job.quantityRequested - job.quantityMachined)

  const statusBadge = {
    queued:      '<span class="part-badge part-badge--pending">Queued</span>',
    committed:   `<span class="part-badge part-badge--partial">Claimed${job.claimedBy ? ' — ' + job.claimedBy : ''}</span>`,
    in_progress: '<span class="part-badge part-badge--partial">In progress</span>',
    complete:    '<span class="part-badge part-badge--complete">Complete</span>',
    archived:    '<span class="part-badge part-badge--pending">Archived</span>',
  }[job.status] || job.status

  const actions = []
  if (job.status === 'queued') {
    actions.push(`<button class="btn-icon" data-job-claim="${job.id}" aria-label="Claim"><i class="ti ti-hand-stop" style="font-size:13px"></i></button>`)
    actions.push(`<button class="btn-icon" data-job-delete="${job.id}" aria-label="Delete"><i class="ti ti-trash" style="font-size:13px"></i></button>`)
  }
  if (job.status === 'committed' || job.status === 'in_progress') {
    actions.push(`<button class="btn-icon" data-job-release="${job.id}" aria-label="Release claim" title="Release claim back to the queue"><i class="ti ti-hand-off" style="font-size:13px"></i></button>`)
  }
  if (job.status === 'complete') {
    actions.push(`<button class="btn-icon" data-job-archive="${job.id}" aria-label="Archive"><i class="ti ti-archive" style="font-size:13px"></i></button>`)
  }

  // const requestedCell = job.status === 'queued'
  //   ? `<input type="number" min="1" value="${job.quantityRequested}" data-job-qty="${job.id}" style="width:52px;text-align:center">`
  //   : `${job.quantityRequested}`

  const progressCell = (job.status === 'committed' || job.status === 'in_progress')
    ? `<div class="job-progress-input">
        <input type="number" min="1" max="${remaining}" value="${Math.min(1, remaining)}" data-progress-input="${job.id}">
        <button class="btn btn-sm" data-job-progress="${job.id}" title="Log machined units"><i class="ti ti-plus" aria-hidden="true"></i></button>
      </div>`
    : ''

  return `<tr data-job-id="${job.id}">
     <td><div class="part-name">${partName}</div>${fabDataHTML(part)}</td>
    <td><span class="part-number">${contextLabel(part)}</span></td>
    <td style="text-align:center">${job.quantityRequested}</td>
    <td style="text-align:center">${job.quantityMachined} / ${job.quantityRequested}${progressCell}</td>
    <td>${statusBadge}</td>
    ${showBatchAssign ? `<td>${batchSelectHTML(job)}</td>` : ''}
    <td style="text-align:right">${actions.join('')}</td>
  </tr>`
}

// tbody is recreated fresh by innerHTML on every render (same as
// designer.js's parts-tbody), so binding here each time is safe — no
// duplicate listeners stack up on the persistent #main-area container.
function bindJobRowEvents() {
  const tbody = document.getElementById('fab-jobs-tbody')
  if (!tbody) return

  tbody.addEventListener('click', async e => {
    const claimBtn = e.target.closest('[data-job-claim]')
    if (claimBtn) { await handleClaimJob(claimBtn.dataset.jobClaim); return }

    const releaseBtn = e.target.closest('[data-job-release]')
    if (releaseBtn) { await handleReleaseClaim(releaseBtn.dataset.jobRelease); return }

    const deleteBtn = e.target.closest('[data-job-delete]')
    if (deleteBtn) { await handleDeleteJob(deleteBtn.dataset.jobDelete); return }

    const archiveBtn = e.target.closest('[data-job-archive]')
    if (archiveBtn) { await handleArchiveJob(archiveBtn.dataset.jobArchive); return }

    const progressBtn = e.target.closest('[data-job-progress]')
    if (progressBtn) {
      const jobId = progressBtn.dataset.jobProgress
      const input = tbody.querySelector(`[data-progress-input="${jobId}"]`)
      const n = Math.max(1, parseInt(input?.value, 10) || 1)
      await handleRecordProgress(jobId, n)
      return
    }
  })

  tbody.addEventListener('change', async e => {
    const batchSel = e.target.closest('[data-job-batch]')
    if (batchSel) { await handleMoveBatch(batchSel.dataset.jobBatch, batchSel.value || null); return }

    const qtyInput = e.target.closest('[data-job-qty]')
    if (qtyInput) { await handleUpdateQty(qtyInput.dataset.jobQty, parseInt(qtyInput.value, 10) || 1); return }
  })
}

// ── Job actions ──────────────────────────────────────────────
async function handleReleaseClaim(jobId) {
  try {
    replaceJob(await releaseFabricationJobClaim(jobId))
    renderFabricateSidebar(); renderFabricateContent()
    toastFn('Claim released')
  } catch (e) { console.error(e); toastFn('Error releasing claim') }
}

async function handleDeleteJob(jobId) {
  const job  = jobs.find(j => j.id === jobId)
  const part = job ? partsCache[job.assemblyPartId] : null
  if (!confirm(`Delete this unclaimed job${part ? ` for "${part.partName}"` : ''}? This cannot be undone.`)) return
  try {
    // FabricationJobService.deleteQueuedJob now owns the "reopen this
    // part for re-detection if its fabrication_metadata was left in a
    // TERMINAL 'queued' state" fix-up server-side (see that service's
    // own doc comment on why this used to be a bug magnet living only
    // in THIS click handler) — every future way to delete a queued job
    // gets it for free, not just this button. Just apply whatever the
    // server hands back.
    const { reopenedPart } = await deleteQueuedFabricationJob(jobId)
    if (reopenedPart) partsCache[job.assemblyPartId] = reopenedPart

    jobs = jobs.filter(j => j.id !== jobId)
    renderFabricateSidebar(); renderFabricateContent()
    toastFn('Job deleted')
  } catch (e) { console.error(e); toastFn(e.message || 'Error deleting job') }
}

async function handleArchiveJob(jobId) {
  try {
    replaceJob(await archiveFabricationJob(jobId))
    renderFabricateSidebar(); renderFabricateContent()
    toastFn('Job archived')
  } catch (e) { console.error(e); toastFn('Error archiving job') }
}

async function handleMoveBatch(jobId, batchId) {
  try {
    replaceJob(await moveJobToBatch(jobId, batchId))
    renderFabricateSidebar(); renderFabricateContent()
    toastFn('Job moved')
  } catch (e) { console.error(e); toastFn('Error moving job') }
}

async function handleUpdateQty(jobId, qty) {
  try {
    replaceJob(await updateQueuedJobQuantity(jobId, Math.max(1, qty)))
    renderFabricateContent()
  } catch (e) { console.error(e); toastFn('Error updating quantity') }
}

async function handleRecordProgress(jobId, n) {
  try {
    const updated = await recordMachinedUnits(jobId, n)
    replaceJob(updated)
    // The linked assembly_part's collected/promised numbers changed
    // server-side — drop the cached row so Designer mode refetches a
    // fresh one next time that part's row is rendered, instead of
    // showing stale collected/promised.
    delete partsCache[updated.assemblyPartId]
    renderFabricateSidebar(); renderFabricateContent()
    toastFn(`Logged ${n} unit(s) — added to Inventory`)
  } catch (e) {
    console.error(e)
    toastFn(e.message || 'Error recording progress')
  }
}



// ── Claim modal ──────────────────────────────────────────────
async function handleClaimJob(jobId) {
  const name = getCurrentMemberName()
  if (!name) { toastFn('Could not determine your name — please sign in again'); return }
  try {
    replaceJob(await claimFabricationJob(jobId, name))
    renderFabricateSidebar(); renderFabricateContent()
    toastFn('Job claimed')
  } catch (e) {
    console.error(e)
    toastFn(e.message || 'Error claiming job')
  }
}
// ── Job detail overlay ──────────────────────────────────────────
// Opened by clicking a job card on the overview grid. Surfaces the same
// actions the old table-row icons + inline <select> did (claim/release,
// log progress, delete/archive, reassign batch), for a single job.
function openJobDetailModal(jobId) {
  selectedJobId = jobId
  renderJobDetailModal()
  document.getElementById('job-detail-overlay').style.display = 'flex'
}

function closeJobDetailModal() {
  document.getElementById('job-detail-overlay').style.display = 'none'
  if (activeShaftPreviewEl) { disposeSegmentPreview3D(activeShaftPreviewEl); activeShaftPreviewEl = null }
  selectedJobId = null
}

function renderJobDetailModal() {
  if (activeShaftPreviewEl) { disposeSegmentPreview3D(activeShaftPreviewEl); activeShaftPreviewEl = null }

  const job = jobs.find(j => j.id === selectedJobId)
  const body = document.getElementById('job-detail-body')
  if (!job) { closeJobDetailModal(); return }

  const part = partsCache[job.assemblyPartId]
  const partName  = part?.partName || '(deleted part)'
  const remaining = Math.max(0, job.quantityRequested - job.quantityMachined)
  const shaftSegments = fabShaftSegments(part)
  const shaftPreviewHTML = shaftSegments ? `
    <div class="field">
      <label>Shaft preview</label>
      <div id="job-detail-shaft-2d" style="margin-bottom:8px"></div>
      <div id="job-detail-shaft-3d" style="width:100%;height:220px;border-radius:var(--border-radius-md);overflow:hidden;background:var(--color-background-secondary)"></div>
    </div>` : ''

  document.getElementById('job-detail-title').textContent = partName
  const statusBadge = {
    queued:      '<span class="part-badge part-badge--pending">Queued</span>',
    committed:   `<span class="part-badge part-badge--partial">Claimed${job.claimedBy ? ' — ' + job.claimedBy : ''}</span>`,
    in_progress: '<span class="part-badge part-badge--partial">In progress</span>',
    complete:    '<span class="part-badge part-badge--complete">Complete</span>',
    archived:    '<span class="part-badge part-badge--pending">Archived</span>',
  }[job.status] || job.status

  document.getElementById('job-detail-title').textContent = partName

  const progressHTML = (job.status === 'committed' || job.status === 'in_progress')
    ? `<div class="field">
        <label>Log machined units</label>
        <div class="job-progress-input">
          <input type="number" min="1" max="${remaining}" value="${Math.min(1, remaining)}" id="job-detail-progress-input">
          <button class="btn btn-sm" id="btn-job-detail-progress"><i class="ti ti-plus" aria-hidden="true"></i> Log</button>
        </div>
      </div>`
    : ''

  const claimActionsHTML = []
  if (job.status === 'queued') {
    claimActionsHTML.push(`<button class="btn btn-sm" id="btn-job-detail-claim"><i class="ti ti-hand-stop" aria-hidden="true"></i> Claim</button>`)
    claimActionsHTML.push(`<button class="btn btn-danger btn-sm" id="btn-job-detail-delete"><i class="ti ti-trash" aria-hidden="true"></i> Delete</button>`)
  }
  if (job.status === 'committed' || job.status === 'in_progress') {
    claimActionsHTML.push(`<button class="btn btn-sm" id="btn-job-detail-release"><i class="ti ti-hand-off" aria-hidden="true"></i> Release claim</button>`)
  }
  if (job.status === 'complete') {
    claimActionsHTML.push(`<button class="btn btn-sm" id="btn-job-detail-archive"><i class="ti ti-archive" aria-hidden="true"></i> Archive</button>`)
  }

  const batchOptsHTML = [`<option value=""${!job.batchId ? ' selected' : ''}>Unbatched</option>`]
    .concat(batches.map(b => `<option value="${b.id}"${job.batchId === b.id ? ' selected' : ''}>${b.name}</option>`))
    .join('')

  body.innerHTML = `
   <div class="asm-progress-row" style="justify-content:space-between">
      <span><i class="ti ti-stack-2" aria-hidden="true"></i> ${contextLabel(part)}</span>
      ${statusBadge}
    </div>
    ${fabDataHTML(part)}
    ${shaftPreviewHTML}
    <div class="field-row">
      <div class="field"><label>Requested</label><div style="font-size:15px;font-weight:600">${job.quantityRequested}</div></div>
      <div class="field"><label>Machined</label><div style="font-size:15px;font-weight:600">${job.quantityMachined}</div></div>
    </div>
    ${progressHTML}
    <div class="field">
      <label>Batch</label>
      <select id="job-detail-batch-select">${batchOptsHTML}</select>
      <p style="font-size:11px;color:var(--color-text-tertiary);margin-top:4px">
        Placing this job in a batch removes it from the main Jobs grid — you'll find it inside that batch instead.
      </p>
    </div>
    <div style="display:flex;gap:7px;flex-wrap:wrap">${claimActionsHTML.join('')}</div>`

  if (shaftSegments) {
    const preview2DEl = document.getElementById('job-detail-shaft-2d')
    if (preview2DEl) renderSegmentPreview(preview2DEl, shaftSegments, { editable: false, unit: 'in' })
    const preview3DEl = document.getElementById('job-detail-shaft-3d')
    if (preview3DEl) { renderSegmentPreview3D(preview3DEl, shaftSegments); activeShaftPreviewEl = preview3DEl }
  }
  document.getElementById('btn-job-detail-claim')?.addEventListener('click', async () => {
    await handleClaimJob(job.id)
    renderJobDetailModal()
  })
  document.getElementById('btn-job-detail-delete')?.addEventListener('click', async () => { await handleDeleteJob(job.id); closeJobDetailModal() })
  document.getElementById('btn-job-detail-release')?.addEventListener('click', async () => { await handleReleaseClaim(job.id); renderJobDetailModal() })
  document.getElementById('btn-job-detail-archive')?.addEventListener('click', async () => { await handleArchiveJob(job.id); closeJobDetailModal() })
  document.getElementById('btn-job-detail-progress')?.addEventListener('click', async () => {
    const input = document.getElementById('job-detail-progress-input')
    const n = Math.max(1, parseInt(input?.value, 10) || 1)
    await handleRecordProgress(job.id, n)
    renderJobDetailModal()
  })
  document.getElementById('job-detail-batch-select')?.addEventListener('change', async e => {
    await handleMoveBatch(job.id, e.target.value || null)
    // Job likely just left the main grid (or entered it) — the detail
    // overlay no longer reflects a job the grid still shows, so close it.
    closeJobDetailModal()
  })
}

// ── Batch modal ──────────────────────────────────────────────
// `mergeIds` is set when this modal was opened by dragging one job card
// onto another — on save, both jobs are moved into the newly-created batch.
export function openBatchModal(id, mergeIds) {
  editingBatchId = id || null
  mergingJobIds  = mergeIds || null
  const b = id ? batches.find(x => x.id === id) : null

  document.getElementById('batch-modal-merge-subtitle')?.remove()
  if (mergingJobIds) {
    const names = mergingJobIds.map(jid => {
      const job = jobs.find(j => j.id === jid)
      const part = job ? partsCache[job.assemblyPartId] : null
      return part?.partName || 'a job'
    })
    const p = document.createElement('p')
    p.id = 'batch-modal-merge-subtitle'
    p.style.cssText = 'font-size:12px;color:var(--color-text-tertiary)'
    p.textContent = `Creates a new batch and moves "${names[0]}" and "${names[1]}" into it.`
    document.getElementById('batch-modal-title').insertAdjacentElement('afterend', p)
  }

  document.getElementById('batch-modal-title').textContent = mergingJobIds ? 'New batch' : (b ? 'Edit batch' : 'New batch')
  document.getElementById('batch-field-name').value   = b?.name || ''
  document.getElementById('batch-field-method').value = b?.fabMethod || ''
  document.getElementById('batch-field-notes').value  = b?.notes || ''
  document.getElementById('btn-delete-batch').style.display = (b && !mergingJobIds) ? 'inline-flex' : 'none'
  document.getElementById('batch-modal-overlay').style.display = 'flex'
  setTimeout(() => document.getElementById('batch-field-name').focus(), 80)
}

function closeBatchModal() {
  document.getElementById('batch-modal-overlay').style.display = 'none'
  document.getElementById('batch-modal-merge-subtitle')?.remove()
  editingBatchId = null
  mergingJobIds = null
}

async function saveBatch() {
  const name   = document.getElementById('batch-field-name').value.trim()
  const method = document.getElementById('batch-field-method').value.trim()
  if (!name)   { document.getElementById('batch-field-name').focus();   toastFn('Batch name is required'); return }
  if (!method) { document.getElementById('batch-field-method').focus(); toastFn('Fab method is required'); return }

  const btn = document.getElementById('btn-save-batch')
  btn.disabled = true; btn.textContent = 'Saving…'

  const payload = {
    id:        editingBatchId || genId(),
    name,
    fabMethod: method,
    notes:     document.getElementById('batch-field-notes').value.trim(),
  }

  try {
    const saved = await upsertFabricationBatch(payload)
    if (editingBatchId) {
      const idx = batches.findIndex(b => b.id === editingBatchId)
      if (idx > -1) batches[idx] = saved
    } else {
      batches.unshift(saved)
    }

    if (mergingJobIds) {
      const moved = await Promise.all(mergingJobIds.map(jid => moveJobToBatch(jid, saved.id)))
      moved.forEach(replaceJob)
    }

    closeBatchModal()
    renderFabricateSidebar(); renderFabricateContent()
    toastFn(mergingJobIds ? 'Batch created — 2 jobs moved into it' : (editingBatchId ? 'Batch updated' : 'Batch created'))
  } catch (e) {
    console.error(e)
    toastFn('Error saving batch')
  } finally {
    btn.disabled = false
    btn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i> Save'
  }
}

async function deleteBatch() {
  if (!editingBatchId) return
  const b = batches.find(x => x.id === editingBatchId)
  if (!b || !confirm(`Delete batch "${b.name}"? Its jobs move back to the unbatched queue — they are not deleted.`)) return
  try {
    await deleteFabricationBatch(editingBatchId)
    batches = batches.filter(x => x.id !== editingBatchId)
    jobs = jobs.map(j => j.batchId === editingBatchId ? { ...j, batchId: null } : j)
    closeBatchModal()
    selectBatch(null)
    toastFn('Batch deleted')
  } catch (e) { console.error(e); toastFn('Error deleting batch') }
}

// ── Bind static events ───────────────────────────────────────
export function bindFabricateEvents() {
  document.getElementById('btn-new-batch').addEventListener('click', () => openBatchModal())
  document.getElementById('chk-fab-history').addEventListener('change', e => {
    showHistory = e.target.checked
    renderFabricateSidebar(); renderFabricateContent()
  })

  document.getElementById('btn-close-batch-modal').addEventListener('click', closeBatchModal)
  document.getElementById('btn-cancel-batch').addEventListener('click', closeBatchModal)
  document.getElementById('btn-save-batch').addEventListener('click', saveBatch)
  document.getElementById('btn-delete-batch').addEventListener('click', deleteBatch)
  document.getElementById('batch-modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeBatchModal()
  })

  document.getElementById('btn-close-job-detail').addEventListener('click', closeJobDetailModal)
  document.getElementById('job-detail-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeJobDetailModal()
  })
}