// services/AgendaService.js
//
// Migration Plan Phase 1, item 9 ("Agenda"). Built service-first rather
// than migrated, per the plan's own note — this is the newest, smallest
// domain, and its data layer (src/agenda.js) was already written as a
// clean 3-layer split (data / view-model / render), so there's no messy
// existing mutator to lift-and-shift the way parts 1-8 did. That view-
// model layer (isOverdue, sortForDayView, tasksForDay, etc.) is pure
// display logic over an already-fetched list and stays exactly where it
// is — nothing about it touches a database, so it has no business being
// in a service.
//
// What DOES belong here is the one real business rule currently
// duplicated between src/agenda.js's saveTask() and setTaskStatus():
// how a task's completedAt should react to a status change. Today
// that's:
//   status === 'complete'  -> completedAt = now (or keep existing, in
//                              setTaskStatus's case)
//   status === 'archived'  -> completedAt is left alone (an archived
//                              task that was never completed keeps
//                              completedAt null; one that WAS completed
//                              first keeps its original completion time)
//   anything else           -> completedAt = null (e.g. reopening a task)
// Two independent call sites computing this identically is exactly the
// kind of duplication the other 8 parts of this migration exist to
// collapse into one place.
//
// Per AGENDA.md / schema_agenda.sql's own product decision, tasks are
// deliberately NOT versioned (no change_log integration) for v1 — this
// service matches that; adding change-log support later is a schema +
// service change together, not something to bolt on silently here.
//
// No @supabase/supabase-js import, no req/res.

import { TaskRepository } from '../repositories/TaskRepository.js'
import { TaskLinkRepository } from '../repositories/TaskLinkRepository.js'
import { ValidationError } from '../repositories/errors.js'
import { runBulk } from '../../backend/_lib/bulkOps.js'


function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

const VALID_STATUSES   = ['not_started', 'in_progress', 'complete', 'archived']
const VALID_PRIORITIES = ['low', 'medium', 'high']
// Matches task_links_entity_type_valid in schema_agenda.sql exactly —
// checked here too so a bad entityType fails with a friendly
// ValidationError instead of a raw Postgres constraint violation,
// same reasoning every other service's DB-backstopped check follows.
const VALID_LINK_ENTITY_TYPES = ['assembly', 'assembly_part', 'inventory_instance', 'fabrication_job', 'cart_item']

/** The one place completedAt's status-reaction rule lives — see the
 *  file-level doc comment above for why. `current` is the task's
 *  existing completedAt (preserved for 'archived' and for re-completing
 *  an already-complete task without resetting its original timestamp). */
function completedAtForStatus(status, current) {
  if (status === 'complete') return current || new Date().toISOString()
  if (status === 'archived') return current
  return null
}

export class AgendaService {
  constructor({
    taskRepo     = new TaskRepository(),
    taskLinkRepo = new TaskLinkRepository(),
  } = {}) {
    this.taskRepo     = taskRepo
    this.taskLinkRepo = taskLinkRepo
  }

  /**
   * Business rules:
   *   - title is required
   *   - status/priority, if given, must be one of the valid enum values
   *     (the DB itself enforces this via CHECK constraints — same
   *     "friendly error before the DB backstop" pattern as everywhere
   *     else in this migration)
   *   - completedAt is always DERIVED from status via
   *     completedAtForStatus, never accepted directly from the caller
   */

  async listTasks() {
    return this.taskRepo.findAll()
  }

  async createTask({ title, description = '', deadline = null, startDate = null, status = 'not_started', priority = 'medium', assignerId = null, executors = [] }) {
    const trimmedTitle = (title || '').trim()
    if (!trimmedTitle) throw new ValidationError('title is required')
    if (!VALID_STATUSES.includes(status))     throw new ValidationError(`Invalid status "${status}"`)
    if (!VALID_PRIORITIES.includes(priority)) throw new ValidationError(`Invalid priority "${priority}"`)

    return this.taskRepo.insert({
      id: genId(), title: trimmedTitle, description, deadline, startDate,
      status, priority, assignerId, executors,
      completedAt: completedAtForStatus(status, null),
    })
  }

  /**
   * Edits any subset of a task's editable fields. If `status` is
   * included, completedAt is recomputed from it via
   * completedAtForStatus regardless of whether the caller also passed
   * a completedAt — that field is never settable directly, matching
   * createTask.
   */
  async updateTask({ taskId, title, description, deadline, startDate, status, priority, executors }) {
    const existing = await this.taskRepo.requireById(taskId)

    if (title !== undefined && !title.trim()) throw new ValidationError('title cannot be blank')
    if (status !== undefined && !VALID_STATUSES.includes(status)) throw new ValidationError(`Invalid status "${status}"`)
    if (priority !== undefined && !VALID_PRIORITIES.includes(priority)) throw new ValidationError(`Invalid priority "${priority}"`)

    const patch = {}
    if (title !== undefined)       patch.title = title.trim()
    if (description !== undefined) patch.description = description
    if (deadline !== undefined)    patch.deadline = deadline
    if (startDate !== undefined)   patch.startDate = startDate
    if (priority !== undefined)    patch.priority = priority
    if (executors !== undefined)   patch.executors = executors
    if (status !== undefined) {
      patch.status = status
      patch.completedAt = completedAtForStatus(status, existing.completedAt)
    }

    return this.taskRepo.update(taskId, patch)
  }

  /** Thin, explicit convenience wrapper over updateTask for the common
   *  "just change the status" action (e.g. a Kanban-style drag), same
   *  shape src/agenda.js's own setTaskStatus already has client-side. */
  async setTaskStatus({ taskId, status }) {
    return this.updateTask({ taskId, status })
  }

  /** Copies a task's content but never its identity/lifecycle — new id,
   *  " (copy)" suffix, reset to not_started with no completedAt — same
   *  as src/agenda.js's client-side duplicateTask. */
  async duplicateTask({ taskId }) {
    const original = await this.taskRepo.requireById(taskId)
    return this.taskRepo.insert({
      id: genId(),
      title: `${original.title} (copy)`,
      description: original.description,
      deadline: original.deadline,
      startDate: original.startDate,
      status: 'not_started',
      priority: original.priority,
      assignerId: original.assignerId,
      executors: original.executors,
      completedAt: null,
    })
  }

  async deleteTask({ taskId }) {
    await this.taskRepo.requireById(taskId)
    await this.taskRepo.delete(taskId)
    return { deletedTaskId: taskId }
  }

  /** Links a task to an existing entity elsewhere in the app (an
   *  assembly, a fabrication job, etc.) — see AGENDA.md's Integrations
   *  section. Validates the task exists and the entityType is one of
   *  the five recognized kinds; does NOT validate that entityId itself
   *  resolves to a real row (no shared FK to check against — same
   *  "orphaned link is an app-layer concern" tradeoff task_links'
   *  schema comment already accepts). */
  async addTaskLink({ taskId, entityType, entityId }) {
    await this.taskRepo.requireById(taskId)
    if (!VALID_LINK_ENTITY_TYPES.includes(entityType)) {
      throw new ValidationError(`Invalid entityType "${entityType}" — expected one of: ${VALID_LINK_ENTITY_TYPES.join(', ')}.`)
    }
    if (!entityId) throw new ValidationError('entityId is required')

    return this.taskLinkRepo.insert({ id: genId(), taskId, entityType, entityId })
  }

  async removeTaskLink({ linkId }) {
    const deleted = await this.taskLinkRepo.delete(linkId)
    if (!deleted) throw new ValidationError(`Task link ${linkId} not found`)
    return { deletedLinkId: linkId }
  }

    async bulkSetTaskStatus({ updates, actorId = null }) {
    return runBulk(updates, (u) => this.setTaskStatus(u), { keyOf: u => u.taskId })
  }

  async bulkDeleteTasks({ taskIds }) {
    return runBulk(taskIds.map(taskId => ({ taskId })), (u) => this.deleteTask(u), { keyOf: u => u.taskId })
  }
}
