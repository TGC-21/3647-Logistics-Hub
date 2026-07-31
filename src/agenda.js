// agenda.js — Agenda workflow (tasks + task links)
//
// See AGENDA.md for the feature spec. Structured in three layers, kept
// deliberately separate so the UI (Day view now, Week/Month later) can
// change without touching the other two:
//
//   1. Data layer   — fetchTasks/upsertTask/etc. Pure Supabase I/O, no
//                      view assumptions (no "day view" grouping here).
//   2. View-model    — pure functions over an already-fetched task list
//                      (deadline/priority sort, overdue detection,
//                      day-bucket grouping). Swapping or adding a view
//                      only ever touches this layer + the render layer.
//   3. Render/bind    — Day view only for phase 1, mirrors partOrders.js's
//                      boot()/renderXSidebar()/renderXContent()/bindXEvents()
//                      shape so main.js's mode-switching stays uniform.
//
// entity_type values for task_links match the five kinds referenced in
// AGENDA.md's Integrations diagram, folded onto existing tables (no new
// "CAD file" or generic "part" concept introduced):
//   assembly | assembly_part | inventory_instance | fabrication_job | cart_item

import { supabase } from './db.js'
import { fetchAssemblies, fetchAssemblyPartsByIds } from './db.js'
import { getCurrentMemberId, fetchMemberById } from './members.js'
import { deleteTask, duplicateTask, setTaskStatus, addTaskLink, removeTaskLink, createTask, updateTask } from './services/agendaApi.js'

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

let toastFn = msg => console.warn('[toast]', msg)
export function setAgendaToast(fn) { toastFn = fn }

// ══════════════════════════════════════════════════════════════
// 1. DATA LAYER
// ══════════════════════════════════════════════════════════════

function dbTaskToLocal(row) {
  return {
    id:          row.id,
    title:       row.title,
    description: row.description ?? '',
    deadline:    row.deadline ?? null,
    status:      row.status ?? 'not_started',
    priority:    row.priority ?? 'medium',
    assignerId:  row.assigner_id ?? null,
    executors:   row.executors ?? [],
    startDate:   row.start_date ?? null,
    createdAt:   row.created_at,
    completedAt: row.completed_at ?? null,
  }
}
function localTaskToDb(t) {
  return {
    id:            t.id,
    title:         t.title,
    description:   t.description ?? '',
    deadline:      t.deadline ?? null,
    status:        t.status ?? 'not_started',
    priority:      t.priority ?? 'medium',
    assigner_id:   t.assignerId ?? null,
    executors:     t.executors ?? [],
    start_date:    t.startDate ?? null,
    completed_at:  t.completedAt ?? null,
  }
}
function dbLinkToLocal(row) {
  return { id: row.id, taskId: row.task_id, entityType: row.entity_type, entityId: row.entity_id, createdAt: row.created_at }
}

export async function fetchTasks() {
  const { data, error } = await supabase.from('tasks').select('*').order('created_at', { ascending: false })
  if (error) {
    toastFn('mashallah habibi')
    throw error
  }
  return data.map(dbTaskToLocal)
}

export async function fetchTaskById(id) {
  const { data, error } = await supabase.from('tasks').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data ? dbTaskToLocal(data) : null
}

export async function upsertTask(task) {
  const { data, error } = await supabase.from('tasks').upsert(localTaskToDb(task)).select().single()
  if (error) throw error
  return dbTaskToLocal(data)
}

/** Convenience status transitions — thin wrappers so callers don't have
 *  to remember to set/clear completed_at by hand. */

// ── Task links ───────────────────────────────────────────────
export async function fetchTaskLinks(taskId) {
  const { data, error } = await supabase.from('task_links').select('*').eq('task_id', taskId)
  if (error) throw error
  return data.map(dbLinkToLocal)
}

/** Bulk version — one query for many tasks' links (Day view rendering
 *  many task cards without a per-card round trip). Returns a map keyed
 *  by task_id -> array of links. */
export async function fetchLinksForTasks(taskIds) {
  if (!taskIds || !taskIds.length) return {}
  const { data, error } = await supabase.from('task_links').select('*').in('task_id', taskIds)
  if (error) throw error
  const map = {}
  for (const row of data) {
    const link = dbLinkToLocal(row)
    if (!map[link.taskId]) map[link.taskId] = []
    map[link.taskId].push(link)
  }
  return map
}




/** Resolves a link's display name/subtitle by fetching the referenced
 *  row directly — kept intentionally simple (one small query per entity
 *  type touched) rather than a generic resolver, since there are only
 *  five fixed types. Returns null if the entity no longer exists (the
 *  "orphaned link" case task_links.sql's comment calls out). */
async function resolveLinkDisplay(link) {
  try {
    if (link.entityType === 'assembly') {
      const { data } = await supabase.from('assemblies').select('name').eq('id', link.entityId).maybeSingle()
      return data ? { label: data.name, icon: 'ti-box' } : null
    }
    if (link.entityType === 'assembly_part') {
      const { data } = await supabase.from('assembly_parts').select('part_name').eq('id', link.entityId).maybeSingle()
      return data ? { label: data.part_name, icon: 'ti-list-details' } : null
    }
    if (link.entityType === 'inventory_instance') {
      const { data } = await supabase.from('inventory_instances').select('name').eq('id', link.entityId).maybeSingle()
      return data ? { label: data.name || 'Inventory item', icon: 'ti-package' } : null
    }
    if (link.entityType === 'fabrication_job') {
      const { data } = await supabase.from('fabrication_jobs').select('id, quantity_requested, assembly_part_id').eq('id', link.entityId).maybeSingle()
      if (!data) return null
      const { data: part } = await supabase.from('assembly_parts').select('part_name').eq('id', data.assembly_part_id).maybeSingle()
      return { label: `Fab job: ${part?.part_name || '?'} × ${data.quantity_requested}`, icon: 'ti-tool' }
    }
    if (link.entityType === 'cart_item') {
      const { data } = await supabase.from('cart_items').select('name_override').eq('id', link.entityId).maybeSingle()
      return data ? { label: data.name_override || 'Cart item', icon: 'ti-shopping-cart' } : null
    }
  } catch (e) { console.warn('[agenda] resolveLinkDisplay failed', e) }
  return null
}

// ══════════════════════════════════════════════════════════════
// 2. VIEW-MODEL (pure functions over an already-fetched task list)
// ══════════════════════════════════════════════════════════════

/** Overdue is derived, never stored — mirrors derivedAssemblyStatus's
 *  pattern in designer/state.js. */
export function isOverdue(task) {
  return !!task.deadline && task.status !== 'complete' && task.status !== 'archived' && new Date(task.deadline) < new Date()
}

export function isVisibleInAgenda(task) {
  // Archived tasks are hidden from the default views (same convention
  // Fabricate uses for archived jobs — "Show archived" toggle to see them).
  return task.status !== 'archived'
}

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 }

/** Sort used by Day view: overdue first, then by deadline (soonest
 *  first, undated last), then priority. */
export function sortForDayView(tasks) {
  return [...tasks].sort((a, b) => {
    const overdueA = isOverdue(a), overdueB = isOverdue(b)
    if (overdueA !== overdueB) return overdueA ? -1 : 1
    const da = a.deadline ? new Date(a.deadline).getTime() : Infinity
    const db_ = b.deadline ? new Date(b.deadline).getTime() : Infinity
    if (da !== db_) return da - db_
    return (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1)
  })
}

function startOfDay(d) { const c = new Date(d); c.setHours(0, 0, 0, 0); return c }
function endOfDay(d)   { const c = new Date(d); c.setHours(23, 59, 59, 999); return c }

/** A task is "ongoing" for a given day if: it has no deadline (always
 *  ongoing until completed/archived), or its startDate..deadline span
 *  includes that day, or (no startDate) its deadline is on/after that
 *  day. This is what lets a multi-day task (start_date set, deadline
 *  later) show up on every day in between — needed for Week/Month later,
 *  harmless for Day view now. */
export function tasksForDay(tasks, day) {
  const dayStart = startOfDay(day), dayEnd = endOfDay(day)
  return tasks.filter(t => {
    if (!isVisibleInAgenda(t)) return false
    const start = t.startDate ? new Date(t.startDate) : null
    const deadline = t.deadline ? new Date(t.deadline) : null

    if (!deadline) {
      // No deadline: "ongoing" from its start date (or forever, if none)
      // until completed.
      return !start || start <= dayEnd
    }
    if (start) return start <= dayEnd && deadline >= dayStart
    return deadline >= dayStart   // no start_date recorded — show until due, and once overdue (isOverdue handles surfacing it every day per AGENDA.md)
  }).concat(
    // Overdue tasks with a deadline strictly before `day` still need to
    // show on TODAY specifically (AGENDA.md: "continue displaying the
    // task every day"), even though the date-range test above wouldn't
    // otherwise include a day past the deadline. Only applies when `day`
    // is today.
    isSameDay(day, new Date())
      ? tasks.filter(t => isVisibleInAgenda(t) && isOverdue(t) && !tasksForDayIncludesAlready(t, dayStart, dayEnd))
      : []
  )
}
function isSameDay(a, b) { return startOfDay(a).getTime() === startOfDay(b).getTime() }
function tasksForDayIncludesAlready(t, dayStart, dayEnd) {
  const deadline = t.deadline ? new Date(t.deadline) : null
  return deadline && deadline >= dayStart && deadline <= dayEnd
}

export function formatDayHeading(day) {
  return day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

// ══════════════════════════════════════════════════════════════
// 3. RENDER / BIND — Day view (phase 1)
// ══════════════════════════════════════════════════════════════

let tasks        = []
let currentDay    = new Date()
let editingTaskId = null
let editingLinks  = []          // working copy of links while modal is open
let pendingDeepLinkTaskId = null   // set by consumeAgendaDeepLink(), opened once boot finishes

export async function agendaBoot() {
  tasks = await fetchTasks()
}

/** Called once from main.js at startup — reads "?task=<id>" WITHOUT
 *  isolating the view (unlike ?asm=/?child=, this does not strip
 *  navigation). It just remembers the id so the normal Agenda boot can
 *  open that task's modal once the page has otherwise loaded normally,
 *  per the product decision that task deep-links shouldn't lock users
 *  out of the rest of the app. */
export function consumeAgendaDeepLink() {
  const params = new URLSearchParams(location.search)
  const taskId = params.get('task')
  if (taskId) pendingDeepLinkTaskId = taskId
  return !!taskId
}

export function registerNewTask(task) { tasks.unshift(task) }

// ── Sidebar ───────────────────────────────────────────────────
export function renderAgendaSidebar() {
  const navAll = document.getElementById('nav-all')
  const visible = tasks.filter(isVisibleInAgenda)
  navAll.innerHTML = `<i class="ti ti-calendar" aria-hidden="true"></i> Today
    <span class="nav-count">${tasksForDay(tasks, currentDay).length}</span>`
  navAll.className = 'nav-item active'   // Day view is the only destination in phase 1

  const catNav = document.getElementById('cat-nav')
  const archivedCount = tasks.length - visible.length
  catNav.innerHTML = `
    <div class="nav-item" id="agenda-nav-jump-today">
      <i class="ti ti-calendar-event" style="font-size:15px" aria-hidden="true"></i> Jump to today
    </div>
    ${archivedCount ? `<div class="nav-item" id="agenda-nav-archived">
      <i class="ti ti-archive" style="font-size:15px" aria-hidden="true"></i> Archived
      <span class="nav-count">${archivedCount}</span>
    </div>` : ''}`

  document.getElementById('tags-divider').style.display = 'none'
  document.getElementById('tags-label').style.display   = 'none'
  document.getElementById('tags-nav').innerHTML         = ''
  document.getElementById('sidebar-label-cats').textContent = 'Agenda'

  document.getElementById('agenda-nav-jump-today')?.addEventListener('click', () => { currentDay = new Date(); renderAgendaContent() })
  document.getElementById('agenda-nav-archived')?.addEventListener('click', () => renderArchivedList())
}

// ── Content: Day view ────────────────────────────────────────
export async function renderAgendaContent() {
  const title = document.getElementById('content-title')
  const meta  = document.getElementById('content-meta')
  const area  = document.getElementById('main-area')

  title.textContent = formatDayHeading(currentDay)
  const dayTasks = sortForDayView(tasksForDay(tasks, currentDay))
  meta.textContent = `${dayTasks.length} task${dayTasks.length === 1 ? '' : 's'}`

  area.innerHTML = `<div class="asm-detail">
    <div class="asm-detail-toolbar">
      <button class="btn btn-sm" id="btn-agenda-prev-day"><i class="ti ti-chevron-left" aria-hidden="true"></i></button>
      <button class="btn btn-sm" id="btn-agenda-today">Today</button>
      <button class="btn btn-sm" id="btn-agenda-next-day"><i class="ti ti-chevron-right" aria-hidden="true"></i></button>
      <div style="flex:1"></div>
      <span style="font-size:11px;color:var(--color-text-tertiary)"><i class="ti ti-info-circle" aria-hidden="true"></i> Week/Month views coming later</span>
    </div>
    ${dayTasks.length ? `<div class="asm-grid" id="agenda-task-grid">${dayTasks.map(taskCardHTML).join('')}</div>` : `
      <div class="empty">
        <i class="ti ti-calendar-off" aria-hidden="true"></i>
        <div class="empty-title">Nothing on the agenda today</div>
        <div class="empty-sub">Create a task to get started.</div>
        <button class="btn btn-primary" id="empty-new-task-btn"><i class="ti ti-plus"></i> New task</button>
      </div>`}
  </div>`

  document.getElementById('btn-agenda-prev-day').addEventListener('click', () => { currentDay.setDate(currentDay.getDate() - 1); renderAgendaSidebar(); renderAgendaContent() })
  document.getElementById('btn-agenda-next-day').addEventListener('click', () => { currentDay.setDate(currentDay.getDate() + 1); renderAgendaSidebar(); renderAgendaContent() })
  document.getElementById('btn-agenda-today').addEventListener('click', () => { currentDay = new Date(); renderAgendaSidebar(); renderAgendaContent() })
  document.getElementById('empty-new-task-btn')?.addEventListener('click', () => openTaskModal())

  area.querySelectorAll('[data-open-task]').forEach(el =>
    el.addEventListener('click', () => openTaskModal(el.dataset.openTask))
  )

  // Consume a pending deep-link (?task=<id>) exactly once, after the
  // normal Day view has rendered — the modal opens ON TOP of a fully
  // navigable Agenda, per the product decision (not an isolated view).
  if (pendingDeepLinkTaskId) {
    const id = pendingDeepLinkTaskId
    pendingDeepLinkTaskId = null
    if (tasks.some(t => t.id === id)) openTaskModal(id)
    else toastFn('That task could not be found — it may have been deleted.')
  }
}

function renderArchivedList() {
  const title = document.getElementById('content-title')
  const meta  = document.getElementById('content-meta')
  const area  = document.getElementById('main-area')
  const archived = tasks.filter(t => t.status === 'archived')

  title.textContent = 'Archived tasks'
  meta.textContent = `${archived.length} task${archived.length === 1 ? '' : 's'}`
  area.innerHTML = archived.length
    ? `<div class="asm-grid">${archived.map(taskCardHTML).join('')}</div>`
    : `<div class="empty"><i class="ti ti-archive" aria-hidden="true"></i><div class="empty-title">No archived tasks</div></div>`
  area.querySelectorAll('[data-open-task]').forEach(el =>
    el.addEventListener('click', () => openTaskModal(el.dataset.openTask))
  )
}

const PRIORITY_BADGE = {
  high:   '<span class="part-badge part-badge--pending" style="background:var(--color-danger-light);color:var(--color-danger)">High</span>',
  medium: '<span class="part-badge part-badge--partial">Medium</span>',
  low:    '<span class="part-badge part-badge--pending">Low</span>',
}
const STATUS_BADGE = {
  not_started: '<span class="asm-badge asm-badge--draft"><i class="ti ti-circle-dashed"></i> Not started</span>',
  in_progress: '<span class="asm-badge asm-badge--active"><i class="ti ti-loader-2"></i> In progress</span>',
  complete:    '<span class="asm-badge asm-badge--complete"><i class="ti ti-check"></i> Complete</span>',
  archived:    '<span class="asm-badge asm-badge--draft"><i class="ti ti-archive"></i> Archived</span>',
}

function taskCardHTML(task) {
  const overdue = isOverdue(task)
  const deadlineStr = task.deadline
    ? new Date(task.deadline).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : null
  return `<div class="asm-card" data-open-task="${task.id}" ${overdue ? 'style="border-color:var(--color-danger)"' : ''}>
    <div class="asm-card-header">
      <div class="asm-card-name">${task.title}</div>
      ${STATUS_BADGE[task.status] || ''}
    </div>
    ${task.description ? `<div class="asm-card-desc">${task.description}</div>` : ''}
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:2px">
      ${PRIORITY_BADGE[task.priority] || ''}
      ${deadlineStr ? `<span class="card-meta-item" style="${overdue ? 'color:var(--color-danger);font-weight:600' : ''}">
        <i class="ti ti-clock" aria-hidden="true"></i> ${overdue ? 'Overdue — ' : 'Due '}${deadlineStr}
      </span>` : ''}
      ${task.executors.length ? `<span class="card-meta-item"><i class="ti ti-users" aria-hidden="true"></i> ${task.executors.length}</span>` : ''}
    </div>
  </div>`
}

// ── Task modal (create / edit) ──────────────────────────────
export function openTaskModal(id) {
  editingTaskId = id || null
  const task = id ? tasks.find(t => t.id === id) : null

  document.getElementById('task-modal-title').textContent = task ? 'Edit task' : 'New task'
  document.getElementById('task-field-title').value       = task?.title || ''
  document.getElementById('task-field-desc').value        = task?.description || ''
  document.getElementById('task-field-deadline').value    = task?.deadline ? toLocalInputValue(task.deadline) : ''
  document.getElementById('task-field-start').value       = task?.startDate ? toLocalInputValue(task.startDate) : ''
  document.getElementById('task-field-status').value      = task?.status || 'not_started'
  document.getElementById('task-field-priority').value    = task?.priority || 'medium'
  document.getElementById('task-field-executors').value   = (task?.executors || []).join(', ')

  document.getElementById('btn-delete-task').style.display     = task ? 'inline-flex' : 'none'
  document.getElementById('btn-duplicate-task').style.display  = task ? 'inline-flex' : 'none'
  document.getElementById('btn-reopen-task').style.display     = (task && (task.status === 'complete' || task.status === 'archived')) ? 'inline-flex' : 'none'

  editingLinks = []
  renderTaskLinksSection()
  if (task) fetchTaskLinks(task.id).then(links => { editingLinks = links; renderTaskLinksSection() })

  document.getElementById('task-modal-overlay').style.display = 'flex'
  setTimeout(() => document.getElementById('task-field-title').focus(), 80)

  // Reflect the deep-link/normal-nav url without a page reload — clears
  // ?task= once opened manually so a later save/close doesn't re-open it.
  if (id) {
    const url = new URL(location.href)
    url.searchParams.set('task', id)
    history.replaceState(null, '', url)
  }
}

function toLocalInputValue(iso) {
  const d = new Date(iso)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function closeTaskModal() {
  document.getElementById('task-modal-overlay').style.display = 'none'
  editingTaskId = null
  editingLinks = []
  const url = new URL(location.href)
  url.searchParams.delete('task')
  history.replaceState(null, '', url)
}

async function saveTask() {
  const title = document.getElementById('task-field-title').value.trim()
  if (!title) { document.getElementById('task-field-title').focus(); toastFn('Title is required'); return }

  const deadlineVal = document.getElementById('task-field-deadline').value
  const startVal    = document.getElementById('task-field-start').value
  const status      = document.getElementById('task-field-status').value
  const existing    = editingTaskId ? tasks.find(t => t.id === editingTaskId) : null

  const payload = {
    title,
    description: document.getElementById('task-field-desc').value.trim(),
    deadline:    deadlineVal ? new Date(deadlineVal).toISOString() : null,
    startDate:   startVal ? new Date(startVal).toISOString() : null,
    status,
    priority:    document.getElementById('task-field-priority').value,
    assignerId:  existing?.assignerId || getCurrentMemberId(),
    executors:   document.getElementById('task-field-executors').value.split(',').map(s => s.trim()).filter(Boolean),
  }

  const btn = document.getElementById('btn-save-task')
  btn.disabled = true; btn.textContent = 'Saving…'
  try {
    if (editingTaskId) {
      updateTask({
        taskId: editingTaskId, 
        title, 
        description: document.getElementById('task-field-desc').value.trim(), 
        deadline: deadlineVal ? new Date(deadlineVal).toISOString() : null, 
        startDate: startVal ? new Date(startVal).toISOString() : null, 
        status, 
        priority: document.getElementById('task-field-priority').value, 
        executors: document.getElementById('task-field-executors').value.split(',').map(s => s.trim()).filter(Boolean)
      })
    } else {
      createTask({
        taskId: editingTaskId, 
        title, 
        description: document.getElementById('task-field-desc').value.trim(), 
        deadline: deadlineVal ? new Date(deadlineVal).toISOString() : null, 
        startDate: startVal ? new Date(startVal).toISOString() : null, 
        status, 
        priority: document.getElementById('task-field-priority').value, 
        assignerId:  existing?.assignerId || getCurrentMemberId(),
        executors: document.getElementById('task-field-executors').value.split(',').map(s => s.trim()).filter(Boolean)
      })
    }
    closeTaskModal()
    renderAgendaSidebar(); renderAgendaContent()
    toastFn(editingTaskId ? 'Task updated' : 'Task created')
  } catch (e) {
    console.error(e)
    toastFn(e.message || 'Error saving task')
  } finally {
    btn.disabled = false
    btn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i> Save'
  }
}

async function handleDeleteTask() {
  if (!editingTaskId) return
  const task = tasks.find(t => t.id === editingTaskId)
  if (!task || !confirm(`Delete task "${task.title}"? This cannot be undone.`)) return
  try {
    await deleteTask({taskId: editingTaskId})
    tasks = tasks.filter(t => t.id !== editingTaskId)
    closeTaskModal()
    renderAgendaSidebar(); renderAgendaContent()
    toastFn('Task deleted')
  } catch (e) { console.error(e); toastFn(e.message || 'Error deleting task') }
}

async function handleDuplicateTask() {
  if (!editingTaskId) return
  const task = tasks.find(t => t.id === editingTaskId)
  if (!task) return
  try {
    const saved = await duplicateTask({taskId: editingTaskId})
    tasks.unshift(saved)
    closeTaskModal()
    renderAgendaSidebar(); renderAgendaContent()
    toastFn('Task duplicated')
  } catch (e) { console.error(e); toastFn(e.message || 'Error duplicating task') }
}

async function handleReopenTask() {
  if (!editingTaskId) return
  const task = tasks.find(t => t.id === editingTaskId)
  if (!task) return
  try {
    const saved = await setTaskStatus({taskId: editingTaskId, status: 'not_started'})
    const idx = tasks.findIndex(t => t.id === editingTaskId)
    if (idx > -1) tasks[idx] = saved
    openTaskModal(editingTaskId)   // re-render modal with the new status reflected
    renderAgendaSidebar(); renderAgendaContent()
    toastFn('Task reopened')
  } catch (e) { console.error(e); toastFn(e.message || 'Error reopening task') }
}

// ── Task links section (inside the modal) ───────────────────
async function renderTaskLinksSection() {
  const el = document.getElementById('task-links-list')
  if (!el) return

  if (!editingLinks.length) {
    el.innerHTML = `<div class="req-keys-empty">No linked items yet.</div>`
    return
  }
  el.innerHTML = editingLinks.map(l => `<div class="onshape-list-item" data-link-row="${l.id}" style="cursor:default">
    <div class="onshape-list-item-icon"><i class="ti ti-loader-2 spin" aria-hidden="true"></i></div>
    <div class="onshape-list-item-text"><div class="onshape-list-item-name">Loading…</div></div>
    <button class="btn-icon" data-remove-link="${l.id}" aria-label="Remove link"><i class="ti ti-x" aria-hidden="true"></i></button>
  </div>`).join('')

  // Resolve display info in parallel, then patch each row in place.
  await Promise.all(editingLinks.map(async l => {
    const info = await resolveLinkDisplay(l)
    const row = el.querySelector(`[data-link-row="${l.id}"]`)
    if (!row) return
    row.querySelector('.onshape-list-item-icon').innerHTML = `<i class="ti ${info?.icon || 'ti-link-off'}" aria-hidden="true"></i>`
    row.querySelector('.onshape-list-item-name').textContent = info?.label || '(deleted item)'
  }))

  el.querySelectorAll('[data-remove-link]').forEach(btn =>
    btn.addEventListener('click', async () => {
      const linkId = btn.dataset.removeLink
      try {
        if (editingTaskId) await removeTaskLink(linkId)
        editingLinks = editingLinks.filter(l => l.id !== linkId)
        renderTaskLinksSection()
      } catch (e) { console.error(e); toastFn(e.message || 'Error removing link') }
    })
  )
}

async function handleAddLink() {
  if (!editingTaskId) { toastFn('Save the task once before linking items to it'); return }
  const type = document.getElementById('task-link-type-select').value
  const query = document.getElementById('task-link-search-input').value.trim()
  if (!query) { toastFn('Type something to search for'); return }

  try {
    const matchId = await findEntityIdForLink(type, query)
    if (!matchId) { toastFn('No match found'); return }
    const link = await addTaskLink({taskid: editingTaskId, entityType: type, entityId: matchId})
    editingLinks.push(link)
    document.getElementById('task-link-search-input').value = ''
    renderTaskLinksSection()
    toastFn('Linked')
  } catch (e) { console.error(e); toastFn(e.message || 'Error linking item') }
}

/** Minimal best-effort lookup by name/title substring across the five
 *  linkable tables — deliberately simple (first match wins) rather than
 *  a full picker UI, consistent with keeping phase 1 lean; a proper
 *  searchable picker (styled like inv-link-overlay) is an easy follow-up
 *  once the UI direction is settled. */
async function findEntityIdForLink(type, query) {
  const q = `%${query}%`
  if (type === 'assembly') {
    const { data } = await supabase.from('assemblies').select('id').ilike('name', q).limit(1)
    return data?.[0]?.id || null
  }
  if (type === 'assembly_part') {
    const { data } = await supabase.from('assembly_parts').select('id').ilike('part_name', q).limit(1)
    return data?.[0]?.id || null
  }
  if (type === 'inventory_instance') {
    const { data } = await supabase.from('inventory_instances').select('id').ilike('name', q).limit(1)
    return data?.[0]?.id || null
  }
  if (type === 'cart_item') {
    const { data } = await supabase.from('cart_items').select('id').ilike('name_override', q).limit(1)
    return data?.[0]?.id || null
  }
  if (type === 'fabrication_job') {
    // Jobs have no name of their own — match by the linked part's name instead.
    const { data: parts } = await supabase.from('assembly_parts').select('id').ilike('part_name', q).limit(5)
    if (!parts?.length) return null
    const { data: jobs } = await supabase.from('fabrication_jobs').select('id').in('assembly_part_id', parts.map(p => p.id)).neq('status', 'archived').limit(1)
    return jobs?.[0]?.id || null
  }
  return null
}

// ── Static event bindings ────────────────────────────────────────
export function bindAgendaEvents() {
  document.getElementById('btn-close-task-modal').addEventListener('click', closeTaskModal)
  document.getElementById('btn-cancel-task').addEventListener('click', closeTaskModal)
  document.getElementById('btn-save-task').addEventListener('click', saveTask)
  document.getElementById('btn-delete-task').addEventListener('click', handleDeleteTask)
  document.getElementById('btn-duplicate-task').addEventListener('click', handleDuplicateTask)
  document.getElementById('btn-reopen-task').addEventListener('click', handleReopenTask)
  document.getElementById('btn-add-task-link').addEventListener('click', handleAddLink)
  document.getElementById('task-modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeTaskModal()
  })
  document.getElementById('btn-new-task-topbar')?.addEventListener('click', () => openTaskModal())
}