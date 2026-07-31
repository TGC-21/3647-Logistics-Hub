// repositories/InventoryInstanceRepository.js
//
// Only file that touches .from('inventory_instances') on the service
// side. Backs InventoryReservationService's reserve()/unreserve()/
// releaseAll() — reserveUnits() and unreserve() are the server-side
// equivalents of src/db.js's client-side reserveInstance/
// unreserveInstance, now that Phase 1 item 1 (Inventory Reservation)
// has actually been cut over (see MIGRATION_PLAN.md).

import { getSupabase } from './supabaseClient.js'
import { DatabaseError } from './errors.js'

function toLocal(row) {
  return {
    id:          row.id,
    componentId: row.component_id,
    name:        row.name ?? '',
    description: row.description ?? '',
    image:       row.image_url ?? null,
    location:    row.location ?? '',
    quantity:    row.quantity ?? 1,
    tags:        row.tags ?? [],
    status:      row.status ?? 'available',
    notes:       row.notes ?? '',
    createdAt:   row.created_at,
  }
}

export class InventoryInstanceRepository {
  constructor(supabase = getSupabase()) {
    this.db = supabase
  }

  async findById(id) {
    const { data, error } = await this.db
      .from('inventory_instances').select('*').eq('id', id).maybeSingle()
    if (error) throw new DatabaseError(`inventory_instances lookup failed: ${error.message}`, error)
    return data ? toLocal(data) : null
  }

  async findByIds(ids) {
    if (!ids || !ids.length) return []
    const { data, error } = await this.db
      .from('inventory_instances').select('*').in('id', ids)
    if (error) throw new DatabaseError(`inventory_instances lookup failed: ${error.message}`, error)
    return (data ?? []).map(toLocal)
  }

  /**
   * Forks `quantity` units off `instanceId` into a brand-new
   * 'in_assembly' row via the reserve_inventory_units() Postgres
   * function (schema.sql) — same atomic split-under-lock semantics
   * db.js's reserveInstance already relied on client-side; the
   * repository's job is just to expose it under a clean name and a
   * mapped return shape, not to re-derive the transaction in JS (same
   * reasoning FabricationJobRepository.recordMachinedUnits documents
   * for record_machined_units()).
   */
  async reserveUnits(instanceId, quantity, location) {
    const { data, error } = await this.db.rpc('reserve_inventory_units', {
      p_instance_id: instanceId,
      p_quantity:    quantity,
      p_location:    location || '',
    })
    if (error) throw new DatabaseError(`reserve_inventory_units failed: ${error.message}`, error)
    return toLocal(data)
  }

  /** Reverses reserveUnits — flips one specific forked instance back to
   *  'available'. Never merged back into the pile it was split from
   *  (same limitation src/db.js's unreserveInstance already documents).
   *  `resetLocation` is applied only when explicitly provided (mirrors
   *  the client's `resetLocation !== null` check) — pass '' (the
   *  default every current caller uses) to clear it outright. */
  async unreserve(instanceId, resetLocation = '') {
    const patch = { status: 'available' }
    if (resetLocation !== null) patch.location = resetLocation
    const { data, error } = await this.db
      .from('inventory_instances').update(patch).eq('id', instanceId).select().single()
    if (error) throw new DatabaseError(`inventory_instances unreserve failed: ${error.message}`, error)
    return toLocal(data)
  }

  /** Flips every listed instance back to 'available' with no location —
   *  used when a part's promised inventory link no longer has anywhere
   *  to point (its part vanished from a reimported BOM, or the whole
   *  assembly/part was deleted). No-ops on an empty list rather than
   *  issuing a pointless `.in('id', [])` query. */
  async releaseMany(instanceIds) {
    if (!instanceIds || !instanceIds.length) return
    const { error } = await this.db
      .from('inventory_instances')
      .update({ status: 'available', location: '' })
      .in('id', instanceIds)
    if (error) throw new DatabaseError(`inventory_instances release failed: ${error.message}`, error)
  }
}
