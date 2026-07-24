// src/changeLog.js
//
// Git/Onshape-style version history for Supabase-backed entities
// (inventory_instances, components, assemblies, assembly_children,
// assembly_parts, categories, ...). One row per FIELD changed; multiple
// rows sharing a commit_id represent one user action/save, so a UI can
// reconstruct "what did this save actually touch" as a unit rather than
// a flat event stream.
//
// This module is intentionally the ONLY place that talks to the
// change_log table — db.js's mutators call into it (see
// db_changelog_integration.md for the exact wiring), but never write to
// change_log directly, so the row shape/rules stay centralized.

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

// ── History queries ──────────────────────────────────────────────

/** Full history for one entity, newest first. */
export async function fetchEntityHistory(entityType, entityId) {
  const { data, error } = await supabase
    .from('change_log')
    .select('*')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

/** Every row belonging to one commit (i.e. one save/action), in field
 *  order as written — lets a UI show "this save changed: Name, OD, ID". */
export async function fetchCommit(commitId) {
  const { data, error } = await supabase
    .from('change_log')
    .select('*')
    .eq('commit_id', commitId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data
}

/** Everything that was cascade-deleted as a result of one parent entity
 *  going away — e.g. every assembly_part + assembly_child wiped out when
 *  an assembly was deleted. Distinct from fetchEntityHistory(assembly, id),
 *  which only shows the assembly's OWN rows (its create/update/delete),
 *  not what it took down with it. */
export async function fetchCascadeChildren(causedByEntityType, causedByEntityId) {
  const { data, error } = await supabase
    .from('change_log')
    .select('*')
    .eq('caused_by_entity_type', causedByEntityType)
    .eq('caused_by_entity_id', causedByEntityId)
    .order('entity_type', { ascending: true })
  if (error) throw error
  return data
}

/** Recent activity across every entity type — a simple activity feed. */
export async function fetchRecentActivity(limit = 50) {
  const { data, error } = await supabase
    .from('change_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data
}