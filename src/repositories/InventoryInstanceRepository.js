// repositories/InventoryInstanceRepository.js
//
// Only file that touches .from('inventory_instances') on the service
// side. Deliberately just one method today — Phase 1 part 6 only needs
// "release these instances back to available," the same operation
// src/db.js's client-side releaseInstances performs. Reservation
// (reserve_inventory_units) stays client-side until Phase 1 part 1
// (Inventory Reservation) is actually migrated — see MIGRATION_PLAN.md.

import { getSupabase } from './supabaseClient.js'
import { DatabaseError } from './errors.js'

export class InventoryInstanceRepository {
  constructor(supabase = getSupabase()) {
    this.db = supabase
  }

  /** Flips every listed instance back to 'available' with no location —
   *  used when a part's promised inventory link no longer has anywhere
   *  to point (its part vanished from a reimported BOM, or the whole
   *  assembly was deleted). No-ops on an empty list rather than issuing
   *  a pointless `.in('id', [])` query. */
  async releaseMany(instanceIds) {
    if (!instanceIds || !instanceIds.length) return
    const { error } = await this.db
      .from('inventory_instances')
      .update({ status: 'available', location: '' })
      .in('id', instanceIds)
    if (error) throw new DatabaseError(`inventory_instances release failed: ${error.message}`, error)
  }
}
