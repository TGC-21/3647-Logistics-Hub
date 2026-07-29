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
}