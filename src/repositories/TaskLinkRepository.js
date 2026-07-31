// repositories/TaskLinkRepository.js
//
// Only file that touches .from('task_links'). Mirrors src/agenda.js's
// dbLinkToLocal row shape. No FK to any of the five linkable tables
// (they don't share a common parent) — same tradeoff change_log
// already accepts for caused_by_entity_type/id — so an orphaned link
// (its target since deleted) is an app-layer concern, not something
// this repository resolves; AgendaService/callers handle that the same
// way src/agenda.js's resolveLinkDisplay already does client-side.

import { getSupabase } from './supabaseClient.js'
import { DatabaseError } from './errors.js'

function toLocal(row) {
  return {
    id:         row.id,
    taskId:     row.task_id,
    entityType: row.entity_type,
    entityId:   row.entity_id,
    createdAt:  row.created_at,
  }
}

export class TaskLinkRepository {
  constructor(supabase = getSupabase()) {
    this.db = supabase
  }

  async findByTaskId(taskId) {
    const { data, error } = await this.db.from('task_links').select('*').eq('task_id', taskId)
    if (error) throw new DatabaseError(`task_links lookup failed: ${error.message}`, error)
    return (data || []).map(toLocal)
  }

  async insert({ id, taskId, entityType, entityId }) {
    const { data, error } = await this.db
      .from('task_links')
      .insert({ id, task_id: taskId, entity_type: entityType, entity_id: entityId })
      .select().single()
    if (error) throw new DatabaseError(`task_links insert failed: ${error.message}`, error)
    return toLocal(data)
  }

  /** Returns true only if a row was actually removed — lets the
   *  service distinguish "already gone" from "just deleted", same
   *  convention FabricationJobRepository.deleteIfQueued established. */
  async delete(id) {
    const { data, error } = await this.db.from('task_links').delete().eq('id', id).select()
    if (error) throw new DatabaseError(`task_links delete failed: ${error.message}`, error)
    return data.length > 0
  }
}
