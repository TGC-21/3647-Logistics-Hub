// src/versionedMutations.js
//
// Version-tracked wrapper for the one write path that still legitimately
// belongs here: inventory instance CRUD (the plain Inventory tab), which
// was never one of MIGRATION_PLAN.md's ten migrated domains and so has
// no Service/Repository home yet. Every other wrapper this file used to
// export (upsertAssemblyPartVersioned, upsertAssemblyVersioned,
// upsertCategoryVersioned, findOrCreateComponentVersioned,
// deleteAssemblyPartVersioned, deleteAssemblyWithHistory) has been
// removed — their domains all migrated to a real Service that logs its
// own change_log entries via ChangeLogRepository, and the wrappers here
// had become dead code (deleteAssemblyWithHistory) or, worse, a second
// write path racing the migrated one (upsertAssemblyVersioned — see
// assemblyGrid.js's saveAssembly, which used to call both).
//
// This file — and src/changeLog.js's write half — should go away
// entirely once inventory instances get a real InventoryInstanceService.
// Until then, this is a deliberate, narrow exception, not a pattern to
// extend: no new function should be added here. A new domain that needs
// versioned writes should get a Service + ChangeLogRepository instead,
// following every other domain in MIGRATION_PLAN.md.

import { supabase } from '../db.js'
import { upsertInventoryInstance } from '../db.js'
import { genCommitId, recordChange, recordUpdateDiff } from '../changeLog.js'

export async function upsertInventoryInstanceVersioned(instance, actorId) {
  const isUpdate = !!instance.id
  const before = isUpdate
    ? (await supabase.from('inventory_instances').select('*').eq('id', instance.id).maybeSingle()).data
    : null

  const saved = await upsertInventoryInstance(instance)
  const commitId = genCommitId()

  if (!before) {
    await recordChange({ entityType: 'inventory_instance', entityId: saved.id, action: 'create', newValue: saved, actorId, commitId })
  } else {
    await recordUpdateDiff({
      entityType: 'inventory_instance', entityId: saved.id, before, after: saved,
      keys: ['name', 'description', 'location', 'quantity', 'status', 'notes', 'tags'],
      actorId, commitId,
    })
  }
  return saved
}
