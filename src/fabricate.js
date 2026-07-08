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
  moveJobToBatch, updateQueuedJobQuantity, deleteQueuedFabricationJob,
  claimFabricationJob, releaseFabricationJobClaim, recordMachinedUnits,
  archiveFabricationJob,
} from './db.js'
import { getAssemblies } from './designer.js'

// ── State ─────────────────────────────────────────────────────
let batches         = []
let jobs            = []          // ALL jobs, every status — filtered per-view
let partsCache      = {}          // assembly_part id → part row
let childNameCache  = new Map()   // assembly_children id → name (lazy-resolved)
let selectedBatchId = null        // null = overview, 'unbatched' = queue, else a batch id
let showHistory     = false       // "Show archived" topbar checkbox
let editingBatchId  = null
let claimingJobId   = null

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

let toastFn = msg => console.warn('[toast]', msg)
export function setFabricateToast(fn) { toastFn = fn }

// ── Boot ──────────────────────────────────────────────────────
export async function fabricateBoot() {
  ;[batches, jobs] = await Promise.all([fetchFabricationBatches(), fetchAllFabricationJobs()])
  partsCache = await fetchAssemblyPartsByIds([...new Set(jobs.map(j => j.assemblyPartId))])
}

/** Called by designer.js right after "Send to Fabricate" creates a job,
 *  so switching to the Fabricate tab shows it without a full reload. */
export function registerNewJob(job) {
  jobs.push(job)
}

function replaceJob(updated) {
  const idx = jobs.findIndex(j => j.id === updated.id)
  if (idx > -1) jobs[idx] = updated
}

// ── Derived helpers ──────────────────────────────────────────
function jobsForBatch(batchId) { return jobs.filter(j => j.batchId === batchId) }
function unbatchedJobs()       { return jobs.filter(j => !j.batchId) }
function activeJobs(list)      { return list.filter(j => j.status !== 'archived') }

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

function contextLabel(part) {
  if (!part) return '—'
  if (part.assemblyChildId) return `Sub: ${childNameCache.get(part.assemblyChildId) || '…'}`
  if (part.assemblyId) {
    const asm = getAssemblies().find(a => a.id === part.assemblyId)
    return asm ? asm.name : '—'
  }
  return '—'
}

// ── Sidebar ───────────────────────────────────────────────────
export function renderFabricateSidebar() {
  const navAll = document.getElementById('nav-all')
  navAll.innerHTML = `<i class="ti ti-list-details" aria-hidden="true"></i> All batches
    <span class="nav-count">${batches.length}</span>`
  navAll.className = 'nav-item' + (selectedBatchId === null ? ' active' : '')

  const catNav = document.getElementById('cat-nav')
  const unbatchedCount = activeJobs(unbatchedJobs()).length

  const unbatchedItem = `<div class="nav-item asm-nav-item${selectedBatchId === 'unbatched' ? ' active' : ''}" data-batch-nav="unbatched">
    <i class="ti ti-inbox" style="font-size:15px;flex-shrink:0" aria-hidden="true"></i>
    <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px">Unbatched queue</span>
    <span class="nav-count">${unbatchedCount}</span>
  </div>`

  const visibleBatches = showHistory ? batches : batches.filter(b => derivedBatchStatus(b.id) !== 'archived')

  const batchItems = visibleBatches.map(b => {
    const active = selectedBatchId === b.id
    return `<div class="nav-item asm-nav-item${active ? ' active' : ''}" data-batch-nav="${b.id}">
      <i class="ti ti-tool" style="font-size:15px;flex-shrink:0" aria-hidden="true"></i>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px">${b.name}</span>
      ${batchStatusBadgeHTML(derivedBatchStatus(b.id))}
    </div>`
  }).join('')

  catNav.innerHTML = unbatchedItem + batchItems

  // Hide the tags section — same convention Designer mode uses.
  document.getElementById('tags-divider').style.display  = 'none'
  document.getElementById('tags-label').style.display    = 'none'
  document.getElementById('tags-nav').innerHTML          = ''
  document.getElementById('sidebar-label-cats').textContent = 'Batches'

  catNav.querySelectorAll('[data-batch-nav]').forEach(el =>
    el.addEventListener('click', () => selectBatch(el.dataset.batchNav))
  )
}

export function selectBatch(id) {
  selectedBatchId = id === 'unbatched' ? 'unbatched' : (id || null)
  renderFabricateSidebar()
  renderFabricateContent()
}

// ── Content ───────────────────────────────────────────────────
export async function renderFabricateContent() {
  const title = document.getElementById('content-title')
  const meta  = document.getElementById('content-meta')
  const area  = document.getElementById('main-area')

  if (selectedBatchId === null) {
    title.textContent = 'Fabricate'
    meta.textContent  = `${batches.length} batch${batches.length === 1 ? '' : 'es'}`
    await renderOverview(area)
    return
  }

  if (selectedBatchId === 'unbatched') {
    title.textContent = 'Unbatched queue'
    meta.textContent  = 'Jobs not yet assigned to a machine run'
    area.innerHTML = `<div class="asm-detail">${await jobsTableHTML(unbatchedJobs(), true)}</div>`
    bindJobRowEvents()
    return
  }

  const batch = batches.find(b => b.id === selectedBatchId)
  if (!batch) { selectBatch(null); return }

  title.textContent = batch.name
  meta.innerHTML = `${batchStatusBadgeHTML(derivedBatchStatus(batch.id))}
    <span style="margin-left:8px;color:var(--color-text-tertiary)"><i class="ti ti-tool" aria-hidden="true"></i> ${batch.fabMethod}</span>`

  area.innerHTML = `<div class="asm-detail">
    <div class="asm-detail-toolbar">
      <button class="btn btn-sm" id="btn-back-batch"><i class="ti ti-arrow-left" aria-hidden="true"></i> All batches</button>
      <div style="flex:1"></div>
      <button class="btn btn-sm" id="btn-edit-batch"><i class="ti ti-edit" aria-hidden="true"></i><span> Edit</span></button>
    </div>
    ${batch.notes ? `<p class="asm-detail-desc">${batch.notes}</p>` : ''}
    ${await jobsTableHTML(jobsForBatch(batch.id), true)}
  </div>`

  document.getElementById('btn-back-batch').addEventListener('click', () => selectBatch(null))
  document.getElementById('btn-edit-batch').addEventListener('click', () => openBatchModal(batch.id))
  bindJobRowEvents()
}

async function renderOverview(area) {
  const unb = activeJobs(unbatchedJobs())
  const visibleBatches = showHistory ? batches : batches.filter(b => derivedBatchStatus(b.id) !== 'archived')

  if (!visibleBatches.length && !unb.length) {
    area.innerHTML = `<div class="empty">
      <i class="ti ti-settings-automation" aria-hidden="true"></i>
      <div class="empty-title">No fabrication jobs yet</div>
      <div class="empty-sub">Jobs are created from an assembly's parts table via "Send to Fabricate." Group them into a batch here once a few are queued.</div>
      <button class="btn btn-primary" id="empty-new-batch-btn"><i class="ti ti-plus"></i> New batch</button>
    </div>`
    document.getElementById('empty-new-batch-btn').addEventListener('click', () => openBatchModal())
    return
  }

  const unbatchedCardHTML = unb.length
    ? `<div class="asm-card" data-open-batch="unbatched">
        <div class="asm-card-header">
          <div class="asm-card-name"><i class="ti ti-inbox" aria-hidden="true"></i> Unbatched queue</div>
          <span class="asm-badge asm-badge--draft">${unb.length} job${unb.length === 1 ? '' : 's'}</span>
        </div>
        <div class="asm-card-desc">Jobs waiting to be grouped onto a machine run.</div>
      </div>`
    : ''

  const batchCardsHTML = visibleBatches.map(b => {
    const status = derivedBatchStatus(b.id)
    const count  = activeJobs(jobsForBatch(b.id)).length
    return `<div class="asm-card" data-open-batch="${b.id}">
      <div class="asm-card-header">
        <div class="asm-card-name">${b.name}</div>
        ${batchStatusBadgeHTML(status)}
      </div>
      <div class="asm-card-desc"><i class="ti ti-tool" aria-hidden="true"></i> ${b.fabMethod} — ${count} job${count === 1 ? '' : 's'}</div>
    </div>`
  }).join('')

  area.innerHTML = `<div class="asm-grid">${unbatchedCardHTML}${batchCardsHTML}</div>`
  area.querySelectorAll('[data-open-batch]').forEach(el =>
    el.addEventListener('click', () => selectBatch(el.dataset.openBatch))
  )
}

// ── Job table (shared by overview's "unbatched" drill-in and batch detail) ──
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
    <td><div class="part-name">${partName}</div></td>
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
    if (claimBtn) { openClaimModal(claimBtn.dataset.jobClaim); return }

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
    await deleteQueuedFabricationJob(jobId)
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
function openClaimModal(jobId) {
  claimingJobId = jobId
  const job  = jobs.find(j => j.id === jobId)
  const part = job ? partsCache[job.assemblyPartId] : null
  document.getElementById('claim-job-subtitle').textContent =
    job && part ? `${job.quantityRequested} × "${part.partName}"` : ''

  const nameInput = document.getElementById('claim-job-field-name')
  nameInput.value = localStorage.getItem('partshelf_claimed_by') || ''
  document.getElementById('claim-job-overlay').style.display = 'flex'
  setTimeout(() => nameInput.focus(), 80)
}

function closeClaimModal() {
  document.getElementById('claim-job-overlay').style.display = 'none'
  claimingJobId = null
}

async function confirmClaimJob() {
  const name = document.getElementById('claim-job-field-name').value.trim()
  if (!name) { document.getElementById('claim-job-field-name').focus(); toastFn('Enter your name to claim this job'); return }
  if (!claimingJobId) return

  const btn = document.getElementById('btn-confirm-claim-job')
  btn.disabled = true; btn.textContent = 'Claiming…'

  try {
    localStorage.setItem('partshelf_claimed_by', name)
    replaceJob(await claimFabricationJob(claimingJobId, name))
    closeClaimModal()
    renderFabricateSidebar(); renderFabricateContent()
    toastFn('Job claimed')
  } catch (e) {
    console.error(e)
    toastFn(e.message || 'Error claiming job')
  } finally {
    btn.disabled = false
    btn.innerHTML = '<i class="ti ti-hand-stop" aria-hidden="true"></i> Claim'
  }
}

// ── Batch modal ──────────────────────────────────────────────
export function openBatchModal(id) {
  editingBatchId = id || null
  const b = id ? batches.find(x => x.id === id) : null

  document.getElementById('batch-modal-title').textContent = b ? 'Edit batch' : 'New batch'
  document.getElementById('batch-field-name').value   = b?.name || ''
  document.getElementById('batch-field-method').value = b?.fabMethod || ''
  document.getElementById('batch-field-notes').value  = b?.notes || ''
  document.getElementById('btn-delete-batch').style.display = b ? 'inline-flex' : 'none'
  document.getElementById('batch-modal-overlay').style.display = 'flex'
  setTimeout(() => document.getElementById('batch-field-name').focus(), 80)
}

function closeBatchModal() {
  document.getElementById('batch-modal-overlay').style.display = 'none'
  editingBatchId = null
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
    closeBatchModal()
    renderFabricateSidebar(); renderFabricateContent()
    toastFn(editingBatchId ? 'Batch updated' : 'Batch created')
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

  document.getElementById('btn-close-claim-job').addEventListener('click', closeClaimModal)
  document.getElementById('btn-cancel-claim-job').addEventListener('click', closeClaimModal)
  document.getElementById('btn-confirm-claim-job').addEventListener('click', confirmClaimJob)
  document.getElementById('claim-job-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeClaimModal()
  })
}
