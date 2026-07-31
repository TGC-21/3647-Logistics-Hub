// repositories/TaskRepository.js
//
// Migration Plan Phase 1, item 9 ("Agenda"). Per the plan's own note,
// this is the one domain built service-first rather than migrated from
// an existing client mutator — src/agenda.js's data layer (fetchTasks/
// upsertTask/etc.) is already cleanly separated into its own "layer 1"
// per that file's own doc comment, so this repository mirrors its row
// mapping exactly rather than inventing a new shape.
//
// Only file that touches .from('tasks').

import { getSupabase } from './supabaseClient.js'
import { DatabaseError, NotFoundError } from './errors.js'

function toLocal(row) {
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

export class TaskRepository {
  constructor(supabase = getSupabase()) {
    this.db = supabase
  }

  async findById(id) {
    const { data, error } = await this.db.from('tasks').select('*').eq('id', id).maybeSingle()
    if (error) throw new DatabaseError(`tasks lookup failed: ${error.message}`, error)
    return data ? toLocal(data) : null
  }

  async requireById(id) {
    const found = await this.findById(id)
    if (!found) throw new NotFoundError(`Task ${id} not found`)
    return found
  }

  async insert({ id, title, description = '', deadline = null, status = 'not_started', priority = 'medium', assignerId = null, executors = [], startDate = null, completedAt = null }) {
    const { data, error } = await this.db
      .from('tasks')
      .insert({
        id, title, description, deadline, status, priority,
        assigner_id: assignerId, executors, start_date: startDate, completed_at: completedAt,
      })
      .select().single()
    if (error) throw new DatabaseError(`tasks insert failed: ${error.message}`, error)
    return toLocal(data)
  }

  /** Generic partial update — the service decides which fields are
   *  legal to change and what side effects (e.g. completedAt) apply;
   *  this repository just writes whatever patch it's given. */
  async update(id, patch) {
    const dbPatch = {}
    if (patch.title !== undefined)       dbPatch.title = patch.title
    if (patch.description !== undefined) dbPatch.description = patch.description
    if (patch.deadline !== undefined)    dbPatch.deadline = patch.deadline
    if (patch.status !== undefined)      dbPatch.status = patch.status
    if (patch.priority !== undefined)    dbPatch.priority = patch.priority
    if (patch.executors !== undefined)   dbPatch.executors = patch.executors
    if (patch.startDate !== undefined)   dbPatch.start_date = patch.startDate
    if (patch.completedAt !== undefined) dbPatch.completed_at = patch.completedAt

    const { data, error } = await this.db
      .from('tasks').update(dbPatch).eq('id', id).select().maybeSingle()
    if (error) throw new DatabaseError(`tasks update failed: ${error.message}`, error)
    return data ? toLocal(data) : null
  }

  /** task_links cascade-deletes with their task (ON DELETE CASCADE,
   *  schema_agenda.sql), so no separate link cleanup is needed here. */
  async delete(id) {
    const { error } = await this.db.from('tasks').delete().eq('id', id)
    if (error) throw new DatabaseError(`tasks delete failed: ${error.message}`, error)
  }
}
