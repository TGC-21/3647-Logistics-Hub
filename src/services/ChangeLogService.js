// services/ChangeLogService.js
//
// Promotes change-log from a support utility duplicated across
// src/changeLog.js (browser, anon key) and repositories/ChangeLogRepository.js
// (server, service key) into a first-class domain, matching every other
// piece of business logic in this migration. Two problems this closes:
//
//   1. src/changeLog.js has no server-side equivalent for READS
//      (fetchEntityHistory/fetchCascadeChildren/fetchRecentActivity) —
//      historyPanel.js can only run those against the browser's anon-key
//      client today, which means the agent harness (or any other
//      non-browser caller) has no way to ask "what happened to this
//      entity" at all. This service is that missing read surface.
//   2. diffFields/recordUpdateDiff exist only in src/changeLog.js today.
//      Every migrated Service currently either re-derives its own
//      field-by-field diff inline (see AssemblyService.updateAssembly)
//      or writes a single non-diffed record (see most other services).
//      Centralizing the diff helper here means future services get the
//      same "only log fields that actually changed" behavior for free,
//      instead of copying the loop a fourth time.
//
// This does NOT change what ChangeLogRepository.record()/newCommitId()
// do — those stay exactly as every existing service already calls them.
// This service is additive: a second, read-capable surface over the
// same repository, plus one new write helper (recordUpdateDiff) that
// existing services can adopt incrementally.
//
// No @supabase/supabase-js import, no req/res.

import { ChangeLogRepository } from '../repositories/ChangeLogRepository.js'

export class ChangeLogService {
  constructor({
    changeLogRepo = new ChangeLogRepository(),
  } = {}) {
    this.changeLogRepo = changeLogRepo
  }

  newCommitId() {
    return this.changeLogRepo.newCommitId()
  }

  async record(entry) {
    return this.changeLogRepo.record(entry)
  }

  /** Pure diff between two flat objects — only returns keys that
   *  actually changed, each as { field, oldValue, newValue }. Uses JSON
   *  comparison so it also catches changes to nested values (arrays,
   *  small objects) without a separate deep-equal dependency. Exported
   *  as a static so a caller (or a test) can use it without
   *  constructing a service instance, same reasoning
   *  AssemblyPartService exports computePartStatus/derivedAssemblyStatus
   *  as free functions. */
  static diffFields(oldObj, newObj, keys) {
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

  /** Runs diffFields and records every changed field under one
   *  commitId in one call. Returns the number of fields logged — a
   *  caller can use that to decide whether to bother creating a commit
   *  at all when nothing actually changed. */
  async recordUpdateDiff({ entityType, entityId, before, after, keys, actorId, commitId }) {
    const changes = ChangeLogService.diffFields(before, after, keys)
    for (const c of changes) {
      await this.changeLogRepo.record({ entityType, entityId, action: 'update', actorId, commitId, ...c })
    }
    return changes.length
  }

  /** One entity's own history, newest first — its create, every
   *  update, and its delete if it's gone. */
  async fetchEntityHistory(entityType, entityId) {
    return this.changeLogRepo.findByEntity(entityType, entityId)
  }

  /** Every row belonging to one commit (one save/action), in write
   *  order — lets a caller show "this save changed: Name, OD, ID". */
  async fetchCommit(commitId) {
    return this.changeLogRepo.findByCommit(commitId)
  }

  /** Everything cascade-deleted (or otherwise caused) by one parent
   *  entity — e.g. every assembly_part + assembly_child wiped out when
   *  an assembly was deleted. */
  async fetchCascadeChildren(causedByEntityType, causedByEntityId) {
    return this.changeLogRepo.findByCausedBy(causedByEntityType, causedByEntityId)
  }

  /** Recent activity across every entity type — a simple activity feed. */
  async fetchRecentActivity(limit = 50) {
    return this.changeLogRepo.findRecent(limit)
  }
}