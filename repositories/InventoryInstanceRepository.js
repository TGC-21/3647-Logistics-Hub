// repositories/InventoryInstanceRepository.js
//
// Migration Plan Phase 1, item 1 (Inventory Reservation). Narrow slice
// of inventory_instances access — only what InventoryReservationService
// needs: look up a specific instance, look up available instances for a
// component, atomically fork/reserve units off an instance (wraps the
// existing reserve_inventory_units() Postgres function — same "the DB
// function IS the transaction" reasoning FabricationJobRepository
// already applies to record_machined_units), flip a reservation back to
// available, and bulk-release many instances at once (assembly/part
// deletion path). This is NOT a port of every inventory_instances query
// in src/db.js — grow it later if/when another service needs more.

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
    if (error) throw new DatabaseError(`inventory_instances bulk lookup failed: ${error.message}`, error)
    return (data ?? []).map(toLocal)
  }

  /** Free-to-link instances of one component — same "available" filter
   *  src/db.js's fetchAvailableInstances applies. */
  async findAvailableForComponent(componentId) {
    const { data, error } = await this.db
      .from('inventory_instances').select('*')
      .eq('component_id', componentId).eq('status', 'available')
      .order('created_at', { ascending: true })
    if (error) throw new DatabaseError(`available instances lookup failed: ${error.message}`, error)
    return (data ?? []).map(toLocal)
  }

  /** Atomically forks `quantity` units off `instanceId` into a new
   *  'in_assembly' row via reserve_inventory_units() — the DB function
   *  already owns the "lock the source row, fail if not enough on hand,
   *  delete the source if exactly emptied" transaction; this method's
   *  job is just to expose it under a clean name with a mapped return
   *  shape, not to re-derive it in JS (mirrors
   *  FabricationJobRepository.recordMachinedUnits' reasoning exactly). */
  async reserveUnits(instanceId, quantity, location) {
    const { data, error } = await this.db.rpc('reserve_inventory_units', {
      p_instance_id: instanceId,
      p_quantity:    quantity,
      p_location:    location,
    })
    if (error) throw new DatabaseError(error.message, error)
    return toLocal(data)
  }

  /** Reverses a reservation — the specific forked row goes back to
   *  'available'. Does not merge back into the pile it was split from
   *  (same limitation src/db.js's unreserveInstance already documents).
   *  `resetLocation` is left untouched (null) by default. */
  async unreserve(instanceId, resetLocation = null) {
    const patch = { status: 'available' }
    if (resetLocation !== null) patch.location = resetLocation
    const { data, error } = await this.db
      .from('inventory_instances').update(patch).eq('id', instanceId).select().maybeSingle()
    if (error) throw new DatabaseError(`unreserve failed: ${error.message}`, error)
    return data ? toLocal(data) : null
  }

  /** Bulk release — many instances back to 'available' with location
   *  cleared, in one call. Used by assembly/part deletion paths. */
  async releaseMany(instanceIds) {
    if (!instanceIds || !instanceIds.length) return
    const { error } = await this.db
      .from('inventory_instances')
      .update({ status: 'available', location: '' })
      .in('id', instanceIds)
    if (error) throw new DatabaseError(`bulk release failed: ${error.message}`, error)
  }

  /** How many instances currently reference a component — used to
   *  decide whether a component is now orphaned and safe to delete. */
  async countForComponent(componentId) {
    const { count, error } = await this.db
      .from('inventory_instances')
      .select('id', { count: 'exact', head: true })
      .eq('component_id', componentId)
    if (error) throw new DatabaseError(`instance count failed: ${error.message}`, error)
    return count ?? 0
  }
}
