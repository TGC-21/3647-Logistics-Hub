// src/changeLog.js
//
// Write-only now. This used to also be the client-side READ path for
// change_log (fetchEntityHistory/fetchCommit/fetchCascadeChildren/
// fetchRecentActivity) — those moved to services/ChangeLogService.js,
// reachable via api/change-log.js and, client-side, src/services/
// changeLogApi.js, so every caller (the browser, and eventually the
// agent harness) reads through the same service instead of the browser
// hitting change_log directly with the anon key. historyPanel.js and
// partsTable.js were switched over to changeLogApi.js for their reads.
//
// What's left here is genCommitId/recordChange/diffFields/
// recordUpdateDiff, kept ONLY because versionedMutations.js's one
// remaining wrapper (upsertInventoryInstanceVersioned — inventory
// instance CRUD, which has no Service/Repository home yet) still needs
// a way to write change_log rows from the browser. That is this file's
// entire remaining reason to exist. Once inventory instances get a real
// InventoryInstanceService, this file's write functions become
// redundant with ChangeLogRepository.record()/recordUpdateDiff() and
// this file should be deleted outright, not extended.
//
// Do not add new callers here. A new domain that needs versioned writes
// should get a Service + ChangeLogRepository, following every other
// domain in MIGRATION_PLAN.md — not a new function in this file.

import { supabase } from './db.js'

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

/** One commit_id per logical save/action — call this once per mutator
 *  invocation and thread the result through every recordChange/
 *  recordCascadeDelete call that belongs to that same action. */
export function genCommitId() {
  return 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/**
 * Writes one change_log row. Deliberately non-throwing on failure — a
 * logging failure should never block the real mutation from succeeding
 * or surfacing its own error, same reasoning onshape-bom.js already
 * applies to its best-effort part_numbers stub inserts.
 */
export async function recordChange({
  entityType, entityId, action, field = null, oldValue = null, newValue = null,
  actorId = null, commitId, causedByEntityType = null, causedByEntityId = null,
}) {
  if (!commitId) throw new Error('recordChange requires a commitId — call genCommitId() once per action and thread it through.')

  const { error } = await supabase.from('change_log').insert({
    id:                    genId(),
    entity_type:           entityType,
    entity_id:             entityId,
    action,
    field,
    old_value:             oldValue ?? null,
    new_value:             newValue ?? null,
    actor_id:              actorId || null,
    commit_id:             commitId,
    caused_by_entity_type: causedByEntityType,
    caused_by_entity_id:   causedByEntityId,
  })
  if (error) console.warn(`[change_log] insert failed for ${entityType}:${entityId}:`, error.message)
}

/**
 * Field-level diff between two flat objects — only returns keys that
 * actually changed, each as { field, oldValue, newValue } ready to
 * spread into recordChange(). Uses JSON comparison so it also catches
 * changes to nested values (arrays, small objects) without needing a
 * separate deep-equal dependency.
 */
export function diffFields(oldObj, newObj, keys) {
  const changes = []
  for (const k of keys) {
    const before = oldObj?.[k]
    const after  = newObj?.[k]
    if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) {
      changes.push({ field: k, oldValue: before ?? null, newValue: after ?? null })
    }
  }
  return changes
}

/** Convenience wrapper: runs diffFields and records every changed field
 *  under one commitId in one call, instead of the caller doing both
 *  steps manually every time. Returns the number of fields logged. */
export async function recordUpdateDiff({ entityType, entityId, before, after, keys, actorId, commitId }) {
  const changes = diffFields(before, after, keys)
  for (const c of changes) {
    await recordChange({ entityType, entityId, action: 'update', actorId, commitId, ...c })
  }
  return changes.length
}
