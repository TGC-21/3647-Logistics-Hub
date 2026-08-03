// repositories/ChangeLogRepository.js
//
// Phase 0, item 1 of MIGRATION_PLAN.md. Wraps api/_lib/changeLog.js's
// recordChangeServer/genCommitId behind the same repository contract
// every other data source in this codebase uses — closes the "known
// debt" flagged in MIGRATION_EXAMPLE.md's Fabrication Jobs example,
// where FabricationJobService had to construct getSupabase() itself
// just to pass it through to the change-log helper.
//
// Every service going forward should depend on THIS, injected via its
// constructor, instead of holding a raw Supabase client for logging
// purposes. That's what makes a service's tests never need a fake
// Supabase client at all (see services/__tests__/FabricationJobService.test.js)
// — only repository tests touch the fake client, at the actual
// boundary where SQL/RPC calls happen.
//
// Deliberately thin: this does NOT reimplement change-log writing — it
// gives the existing server-side helper a class-shaped home so it can
// be constructor-injected and swapped for a fake in tests, same as
// FabricationJobRepository/AssemblyPartRepository already are.

import { getSupabase } from './supabaseClient.js'
import { recordChangeServer, genCommitId } from '../../api/_lib/changeLog.js'
import { DatabaseError } from './errors.js'

export class ChangeLogRepository {
  constructor(supabase = getSupabase()) {
    this.db = supabase
  }

  /** One commit_id per logical service action — call once per public
   *  service method invocation and thread the result through every
   *  record() call belonging to that action, same convention
   *  src/changeLog.js's genCommitId() already established client-side
   *  (so a UI action and a service action "commit" the same way, even
   *  though they're logged from different processes). */
  newCommitId() {
    return genCommitId()
  }

  /** Writes one change_log row. Non-throwing on failure by design —
   *  same reasoning recordChangeServer's own doc comment gives: a
   *  logging failure should never block or fail the real mutation it's
   *  describing. Callers don't need to wrap this in try/catch. */
  async record({
    entityType, entityId, action, field = null, oldValue = null, newValue = null,
    actorId = null, commitId, causedByEntityType = null, causedByEntityId = null,
  }) {
    await recordChangeServer(this.db, {
      entityType, entityId, action, field, oldValue, newValue,
      actorId, commitId, causedByEntityType, causedByEntityId,
    })
  }
  
  /** One entity's own history — its create, every update, and its
   *  delete if it's gone. Does NOT include rows CAUSED BY it (see
   *  findCascadeChildren) — mirrors src/changeLog.js's fetchEntityHistory,
   *  now the server-side (harness-reachable) equivalent of the same
   *  query. Rows are returned in their raw DB (snake_case) shape rather
   *  than mapped through a toLocal() — change_log rows are read-only
   *  history data, not a domain entity with its own writable fields, so
   *  there's no "local" shape to map to; callers (ChangeLogService and,
   *  through it, historyPanel.js) already consume this exact shape. */
  async findByEntity(entityType, entityId) {
    const { data, error } = await this.db
      .from('change_log')
      .select('*')
      .eq('entity_type', entityType)
      .eq('entity_id', entityId)
      .order('created_at', { ascending: false })
    if (error) throw new DatabaseError(`change_log lookup failed: ${error.message}`, error)
    return data ?? []
  }

  /** Every row sharing one commit_id, in write order — one save/action
   *  reconstructed as a unit rather than a flat stream. */
  async findByCommit(commitId) {
    const { data, error } = await this.db
      .from('change_log')
      .select('*')
      .eq('commit_id', commitId)
      .order('created_at', { ascending: true })
    if (error) throw new DatabaseError(`change_log lookup failed: ${error.message}`, error)
    return data ?? []
  }

  /** Everything cascade-deleted (or otherwise caused) by one parent
   *  entity going away — e.g. every assembly_part + assembly_child
   *  wiped out when an assembly was deleted. Distinct from
   *  findByEntity(assembly, id), which only shows the assembly's OWN
   *  rows, not what it took down with it. */
  async findByCausedBy(causedByEntityType, causedByEntityId) {
    const { data, error } = await this.db
      .from('change_log')
      .select('*')
      .eq('caused_by_entity_type', causedByEntityType)
      .eq('caused_by_entity_id', causedByEntityId)
      .order('entity_type', { ascending: true })
    if (error) throw new DatabaseError(`change_log lookup failed: ${error.message}`, error)
    return data ?? []
  }

  /** Recent activity across every entity type — a simple activity feed. */
  async findRecent(limit = 50) {
    const { data, error } = await this.db
      .from('change_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) throw new DatabaseError(`change_log lookup failed: ${error.message}`, error)
    return data ?? []
  }
}