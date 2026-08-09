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
  fetchRootAssemblyIdForChild,
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
let jobs            = []          // ALL jobs, every status — filtered per-view
let partsCache      = {}          // assembly_part id → part row
let componentsCache = {}
let childNameCache  = new Map()   // assembly_children id → name (lazy-resolved)
let selectedAssemblyId = null     // null = overview ("All jobs"), else an assembly id — primary nav now
let jobAssemblyIdCache = new Map()   // job id -> resolved root assembly id (or null), memoized across renders
let showHistory     = false       // "Show archived" topbar checkbox
let selectedJobId   = null        // job shown in the job detail overlay, or null
let activeShaftPreviewEl = null   // tracks the live 3D container so it can be disposed before the next re-render replaces it

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

// Rounds a number to 4 decimal places and strips trailing zeros —
// every dimension shown on a job card/detail comes from floating-point
// geometry reconstruction (see axial-shaft.js's classifyGeometry) and
// is never meant to be read past thousandths, so this is purely a
// DISPLAY concern — never applied to a value before it's saved/compared.
function round4(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return n
  return Math.round(n * 10000) / 10000
}


let toastFn = msg => console.warn('[toast]', msg)
export function setFabricateToast(fn) { toastFn = fn }

// ── Boot ──────────────────────────────────────────────────────
export async function fabricateBoot() {
  jobs = await fetchAllFabricationJobs()
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

// ── Display ordering ─────────────────────────────────────────
// "Active/unclaimed first, completed/archived last" — queued (needs a
// claim) and committed/in_progress (someone's actively on it) both
// read as "live work," so they rank ahead of anything done. Ties
// within a rank fall back to part name so the same list doesn't
// visibly reshuffle between renders.
const JOB_STATUS_RANK = { queued: 0, committed: 1, in_progress: 1, complete: 2, archived: 3 }

function sortJobsForDisplay(list) {
  return [...list].sort((a, b) => {
    const rankDiff = (JOB_STATUS_RANK[a.status] ?? 1) - (JOB_STATUS_RANK[b.status] ?? 1)
    if (rankDiff !== 0) return rankDiff
    const nameA = partsCache[a.assemblyPartId]?.partName || ''
    const nameB = partsCache[b.assemblyPartId]?.partName || ''
    return nameA.localeCompare(nameB)
  })
}

/** Jobs the signed-in member currently has claimed (committed or
 *  in_progress, claimedBy matching their name) — surfaced in its own
 *  section at the top of every job list so "my work" never requires
 *  hunting through an assembly tree. */
function claimedByMeJobs(list) {
  const me = getCurrentMemberName()
  if (!me) return []
  return list.filter(j => (j.status === 'committed' || j.status === 'in_progress') && j.claimedBy === me)
}

/** Groups a job list by the subassembly its part belongs to — mirrors
 *  Designer's root-parts-vs-subassembly split. Returns an ordered
 *  array of { key, label, jobs } — direct (root-owned) parts first
 *  under a null key, then one group per subassembly, alphabetical by
 *  name. Uses childNameCache, so callers must have already awaited
 *  primeJobCaches/primeJobAssemblyIds for this job list. */
function groupJobsBySubassembly(list) {
  const direct = []
  const byChildId = new Map()   // assemblyChildId -> jobs[]

  for (const job of list) {
    const part = partsCache[job.assemblyPartId]
    if (part?.assemblyChildId) {
      if (!byChildId.has(part.assemblyChildId)) byChildId.set(part.assemblyChildId, [])
      byChildId.get(part.assemblyChildId).push(job)
    } else {
      direct.push(job)
    }
  }

  const groups = []
  if (direct.length) groups.push({ key: null, label: 'Direct parts', jobs: direct })

  const childGroups = [...byChildId.entries()]
    .map(([childId, groupJobs]) => ({ key: childId, label: childNameCache.get(childId) || 'Subassembly', jobs: groupJobs }))
    .sort((a, b) => a.label.localeCompare(b.label))
  groups.push(...childGroups)

  return groups
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

  const r = round4   // local alias, keeps the lines below from wrapping awkwardly


  if (catName === 'Spacer') {
    const type = attrs['Spacer Type'] || '?'
    const isHex = type.startsWith('HEX')
    return `<div class="fab-spec-line"><i class="ti ti-ruler-2" aria-hidden="true"></i> ${type} · OD ${r(parseFloat(attrs['OD'])) ?? '?'}" · ${isHex ? 'AF' : 'ID'} ${r(parseFloat(attrs['ID or Across Flats'])) ?? '?'}" · L ${r(parseFloat(attrs['Length'])) ?? '?'}"</div>`
  }

  if (catName === 'Axial Shaft') {
    const profile = attrs['Profile']
    if (!profile || !Array.isArray(profile.segments) || !profile.segments.length) return ''
    const summary = profile.segments.map(s => {
      if (s.type === 'round')  return `⌀${r(s.diameter)}"×${r(s.length)}"`
      if (s.type === 'hex')    return `Hex ${r(s.acrossFlats)}"×${r(s.length)}"`
      if (s.type === 'square' || s.type === 'prism') return `${r(s.width)}"×${r(s.length)}"`
      return `${s.type}×${r(s.length)}"`
    }).join(' → ')
    return `<div class="fab-spec-line"><i class="ti ti-ruler-2" aria-hidden="true"></i> ${summary}</div>`
  }

  if (catName === 'Plate') {
    return `<div class="fab-spec-line"><i class="ti ti-ruler-2" aria-hidden="true"></i> ${attrs['Material'] || '?'} · ${r(parseFloat(attrs['Thickness'])) ?? '?'}" thick</div>`
  }

  return ''
}

// ── Sidebar ───────────────────────────────────────────────────
// Primary nav is "which assembly" (mirrors Designer's sidebar).
// Batches have been removed entirely — rarely used, and complicated
// both the nav hierarchy and card actions for little payoff.
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
  renderFabricateSidebar()
  renderFabricateContent()
}

// Kept as an alias — main.js calls selectBatch(null) on mode switch
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
 *  grid (mirrors Designer's parts-grid), grouped by subassembly, with
 *  a "Claimed by you" section pinned above everything else. */
async function renderAssemblyJobsView(area, jobList, assembly) {
  await primeJobCaches(jobList)

  const visible = jobList.filter(j => showHistory || j.status !== 'archived')
  const mine    = claimedByMeJobs(visible)
  const groups  = groupJobsBySubassembly(visible).map(g => ({ ...g, jobs: sortJobsForDisplay(g.jobs) }))

  const claimedSectionHTML = mine.length ? `
    <div class="section-heading fab-claimed-heading">
      <i class="ti ti-user-check" aria-hidden="true"></i> Claimed by you
      <span class="section-count">${mine.length}</span>
    </div>
    <div class="parts-grid">${sortJobsForDisplay(mine).map(j => fabJobCardHTML(j)).join('')}</div>` : ''

  const groupsHTML = groups.map(g => `
    <div class="section-heading">
      <i class="ti ${g.key ? 'ti-git-branch' : 'ti-box'}" aria-hidden="true"></i> ${g.label}
      <span class="section-count">${g.jobs.length}</span>
    </div>
    <div class="parts-grid">${g.jobs.map(j => fabJobCardHTML(j)).join('')}</div>`).join('')

  area.innerHTML = `<div class="asm-detail">
    <div class="asm-detail-toolbar">
      <button class="btn btn-sm" id="btn-back-fab-overview"><i class="ti ti-arrow-left" aria-hidden="true"></i> All jobs</button>
      <div style="flex:1"></div>
      ${assembly?.onshapeUrl ? `<a class="btn btn-sm" href="${assembly.onshapeUrl}" target="_blank" rel="noreferrer"><i class="ti ti-external-link" aria-hidden="true"></i> Onshape</a>` : ''}
    </div>
    <div class="asm-parts-toolbar">
      <div class="asm-parts-title">Jobs <span class="section-count">${visible.length}</span></div>
      <div style="flex:1"></div>
      <label class="fab-history-toggle"><input type="checkbox" id="chk-fab-history-inline" ${showHistory ? 'checked' : ''}> <span>Show archived</span></label>
    </div>
    ${visible.length
      ? claimedSectionHTML + groupsHTML
      : `<div class="empty" style="padding:40px 0">
          <i class="ti ti-list-check" aria-hidden="true"></i>
          <div class="empty-title">No jobs here</div>
        </div>`}
  </div>`

  document.getElementById('btn-back-fab-overview').addEventListener('click', () => selectAssembly(null))
  document.getElementById('chk-fab-history-inline')?.addEventListener('change', e => {
    showHistory = e.target.checked
    renderFabricateSidebar(); renderFabricateContent()
  })

  bindJobCardEvents(area)
}


async function renderOverview(area) {
  // "All jobs" — a "Claimed by you" section first, regardless of which
  // assembly a claimed job belongs to, then every assembly grouped
  // visually (same idea as Designer's "All assemblies" grid).
  const visibleJobs = jobs.filter(j => showHistory || j.status !== 'archived')

  if (!visibleJobs.length) {
    area.innerHTML = `<div class="empty">
      <i class="ti ti-settings-automation" aria-hidden="true"></i>
      <div class="empty-title">No fabrication jobs yet</div>
      <div class="empty-sub">Jobs are created from an assembly's parts table via "Send to Fabricate."</div>
    </div>`
    return
  }

  await primeJobCaches(visibleJobs)

  const mine = claimedByMeJobs(visibleJobs)
  const claimedSectionHTML = mine.length ? `
    <div class="section-heading fab-claimed-heading">
      <i class="ti ti-user-check" aria-hidden="true"></i> Claimed by you
      <span class="section-count">${mine.length}</span>
    </div>
    <div class="parts-grid">${sortJobsForDisplay(mine).map(j => fabJobCardHTML(j)).join('')}</div>` : ''

  const assemblies = getAssemblies().filter(a => jobsForAssembly(a.id).some(j => showHistory || j.status !== 'archived'))
  const unassigned = unassignedJobs().filter(j => showHistory || j.status !== 'archived')

  const sectionsHTML = assemblies.map(a => {
    const list = sortJobsForDisplay(jobsForAssembly(a.id).filter(j => showHistory || j.status !== 'archived'))
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
    <div class="parts-grid">${sortJobsForDisplay(unassigned).slice(0, 6).map(j => fabJobCardHTML(j)).join('')}</div>` : ''

  area.innerHTML = claimedSectionHTML + sectionsHTML + unassignedSectionHTML
  bindJobCardEvents(area)
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
/** Job card, "part-card"-shaped layout — mirrors
 *  partsTable.js's partCardHTML visually (same .part-card/.card-*
 *  classes) so Fabricate's grid reads consistently with Designer's.
 *  Primary actions live directly on the card, same principle as
 *  Designer's part cards (resolvePartIntent) — no click-through-to-
 *  modal detour just to claim a job. */function fabJobCardHTML(job) {
  const part      = partsCache[job.assemblyPartId]
  const partName  = part?.partName || '(deleted part)'
  const remaining = Math.max(0, job.quantityRequested - job.quantityMachined)
  const actionsHTML = fabJobActionsHTML(job, remaining)

  return `<div class="part-card fab-job-part-card" data-job-id="${job.id}">
    <div class="card-top">
      <div class="card-name-block" data-open-job="${job.id}" style="cursor:pointer">
        <div class="card-part-name">${partName}</div>
        <div class="card-part-number">${contextLabel(part)}</div>
      </div>
      <div class="card-qty">${job.quantityMachined} / ${job.quantityRequested}</div>
    </div>
    <div class="card-badges" data-open-job="${job.id}" style="cursor:pointer">
      ${jobStatusBadgeHTML(job)}
    </div>    
    ${fabDataHTML(part)}
    <div class="card-actions">${actionsHTML}</div>

  </div>`
}

/** Contextual action row for one job card, mirroring the shape of
 *  Designer's part-card actions (1–2 primary buttons + a small
 *  progress input where relevant). */
function fabJobActionsHTML(job, remaining) {
  if (job.status === 'queued') {
    return `
      <button class="btn btn-sm btn-primary" data-job-action="claim" data-id="${job.id}">
        <i class="ti ti-hand-stop" aria-hidden="true"></i> Claim
      </button>
      <button class="btn btn-sm btn-icon-only" data-job-action="delete" data-id="${job.id}" aria-label="Delete">
        <i class="ti ti-trash" aria-hidden="true"></i>
      </button>`
  }
  if (job.status === 'committed' || job.status === 'in_progress') {
    return `
      <div class="job-progress-input" style="flex:1">
        <input type="number" min="1" max="${remaining}" value="${Math.min(1, remaining)}" data-progress-input="${job.id}" style="width:44px">
        <button class="btn btn-sm" data-job-action="log" data-id="${job.id}"><i class="ti ti-plus" aria-hidden="true"></i> Log</button>
      </div>
      <button class="btn btn-sm btn-icon-only" data-job-action="release" data-id="${job.id}" aria-label="Release claim" title="Release claim">
        <i class="ti ti-hand-off" aria-hidden="true"></i>
      </button>`
  }
  if (job.status === 'complete') {
    return `<button class="btn btn-sm" data-job-action="archive" data-id="${job.id}"><i class="ti ti-archive" aria-hidden="true"></i> Archive</button>`
  }
  return `<span class="card-actions-empty">Archived</span>`
}

/** Delegated click/change binder for job cards — same delegation
 *  pattern partsTable.js's bindPartCardEvents uses. Rebinding on every
 *  render is safe since `area`'s innerHTML is fully replaced each time
 *  (no stacked listeners on a persistent container). Delegates on the
 *  whole `area` now rather than one #fab-jobs-grid — a view can render
 *  several grids (claimed section + one per subassembly group), and
 *  none of them have a stable shared id anymore. */
function bindJobCardEvents(area) {
  area.querySelectorAll('[data-open-job]').forEach(el =>
    el.addEventListener('click', () => openJobDetailModal(el.dataset.openJob))
  )

  area.addEventListener('click', async e => {
    const actionBtn = e.target.closest('[data-job-action]')
    if (!actionBtn) return
    e.stopPropagation()   // never also trigger the card's data-open-job click

    const jobId = actionBtn.dataset.id
    const action = actionBtn.dataset.jobAction

    if (action === 'claim')   { await handleClaimJob(jobId); return }
    if (action === 'release') { await handleReleaseClaim(jobId); return }
    if (action === 'archive') { await handleArchiveJob(jobId); return }
    if (action === 'delete')  { await handleDeleteJob(jobId); return }
    if (action === 'log') {
      const input = area.querySelector(`[data-progress-input="${jobId}"]`)
      const n = Math.max(1, parseInt(input?.value, 10) || 1)
      await handleRecordProgress(jobId, n)
      return
    }
  })
}


// ── Job table (shared by overview's "unbatched" drill-in and batch detail) ──
// DELETED — jobsTableHTML/jobRowHTML/batchSelectHTML/bindJobRowEvents
// and every batch-modal function (openBatchModal/closeBatchModal/
// saveBatch/deleteBatch/handleDropJobOnBatch) are removed below along
// with all batch state. Batches are no longer a Partshelf concept.

// tbody is recreated fresh by innerHTML on every render (same as
// designer.js's parts-tbody), so binding here each time is safe — no
// duplicate listeners stack up on the persistent #main-area container.


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

}


// ── Bind static events ───────────────────────────────────────
export function bindFabricateEvents() {

  document.getElementById('btn-close-job-detail').addEventListener('click', closeJobDetailModal)
  document.getElementById('job-detail-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeJobDetailModal()
  })
}