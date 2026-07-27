// repositories/PartNumberRepository.js
//
// Narrow slice pulled in by Migration Plan Phase 1 item 1 (Inventory
// Reservation) for exactly one rule: "confirming a component for a part
// number backfills that link for future imports." Not a port of the
// full vendor/listing surface in src/db.js (Cart/Part Orders is its own
// later domain — Plan item 5).

import { getSupabase } from './supabaseClient.js'
import { DatabaseError } from './errors.js'

export class PartNumberRepository {
  constructor(supabase = getSupabase()) {
    this.db = supabase
  }

  /** Backfills component_id onto every part_numbers row matching
   *  `value` that doesn't already have one — never overwrites an
   *  existing (already-confirmed) component_id, so two genuinely
   *  different SKUs that happen to share a typo'd value don't silently
   *  merge. Mirrors src/db.js's linkPartNumberToComponent exactly. */
  async backfillComponentId(value, componentId) {
    const trimmed = (value || '').trim()
    if (!trimmed || !componentId) return
    const { error } = await this.db
      .from('part_numbers')
      .update({ component_id: componentId })
      .eq('value', trimmed)
      .is('component_id', null)
    if (error) throw new DatabaseError(`part_numbers backfill failed: ${error.message}`, error)
  }
}
