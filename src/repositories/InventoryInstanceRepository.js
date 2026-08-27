// repositories/InventoryInstanceRepository.js
//
// Only file that touches .from('inventory_instances'). Originally built
// narrow for InventoryReservationService's reserve()/unreserve()/
// releaseAll() (Phase 1 item 1) — now extended with full CRUD
// (insert/update/deleteById/findAll/findByComponent/
// findAvailableForComponent/countsByComponentIds) to back
// InventoryInstanceService, the last domain still on raw src/db.js
// (see the Inventory Instance CRUD migration roadmap). Same rule as
// every other repository: narrow surface grown on demand, not a
// wholesale port of every inventory_instances query db.js still has —
// db.js's read-only helpers (fetchInventoryInstances, etc.) stay
// client-side for now; only the WRITE path (and the reads a write-path
// service needs to compose, e.g. an orphan check) move here.

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
    unlimited:   row.unlimited ?? false,       // NEW
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

  /** Assembly parts that currently point at an inventory instance. */
  async findAssemblyPartsLinkingInstance(instanceId) {
    const { data, error } = await this.db
      .from('assembly_parts').select('id').contains('linked_instance_ids', [instanceId])
    if (error) throw new DatabaseError(`assembly_parts lookup failed: ${error.message}`, error)
    return data ?? []
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

  /** Every instance — the plain Inventory tab's listing. Deliberately
   *  does NOT join components (that's ComponentRepository's table,
   *  composed by the SERVICE, not queried across tables here — same
   *  "repositories don't reach across table boundaries" discipline
   *  every other repository in this codebase follows). Callers that
   *  need the joined shape (fallback name/description/image, category)
   *  compose findAll() + ComponentRepository.findById() themselves. */
  async findAll() {
    const { data, error } = await this.db
      .from('inventory_instances').select('*').order('created_at', { ascending: false })
    if (error) throw new DatabaseError(`inventory_instances lookup failed: ${error.message}`, error)
    return (data ?? []).map(toLocal)
  }

  /** Every instance belonging to one component, any status — used by
   *  the "link inventory" picker's full listing (as opposed to
   *  findAvailableForComponent's status-filtered version). */
  async findByComponent(componentId) {
    const { data, error } = await this.db
      .from('inventory_instances').select('*').eq('component_id', componentId).order('created_at', { ascending: true })
    if (error) throw new DatabaseError(`inventory_instances lookup failed: ${error.message}`, error)
    return (data ?? []).map(toLocal)
  }


  /** Every instance across MULTIPLE components in one query — used
   *  after a component search returns several matches, so the harness
   *  can get every match's locations in one tool call instead of one
   *  InventoryInstanceService.listForComponent call per match. */
  async findByComponentIds(componentIds) {
    const ids = [...new Set((componentIds ?? []).filter(Boolean))]
    if (!ids.length) return []
    const { data, error } = await this.db
      .from('inventory_instances').select('*').in('component_id', ids).order('created_at', { ascending: true })
    if (error) throw new DatabaseError(`inventory_instances lookup failed: ${error.message}`, error)
    return (data ?? []).map(toLocal)
  }

  /** Only instances free to be linked to an assembly part — mirrors
   *  db.js's fetchAvailableInstances, now available server-side. */
  async findAvailableForComponent(componentId) {
    const { data, error } = await this.db
      .from('inventory_instances')
      .select('*')
      .eq('component_id', componentId)
      .eq('status', 'available')
      .order('created_at', { ascending: true })
    if (error) throw new DatabaseError(`inventory_instances lookup failed: ${error.message}`, error)
    return (data ?? []).map(toLocal)
  }

  /** Per-component { total, available } counts, restricted to a given
   *  id set — what InventoryInstanceService.deleteInstance needs to
   *  decide whether the instance's component is now orphaned, mirroring
   *  db.js's fetchInstanceCountsForComponents. One query for however
   *  many componentIds are passed, not one round trip per id. */
  async countsByComponentIds(componentIds) {
    const ids = [...new Set((componentIds ?? []).filter(Boolean))]
    if (!ids.length) return {}
    const { data, error } = await this.db
      .from('inventory_instances').select('component_id, status').in('component_id', ids)
    if (error) throw new DatabaseError(`inventory_instances lookup failed: ${error.message}`, error)
    const counts = {}
    for (const id of ids) counts[id] = { total: 0, available: 0 }
    for (const row of data ?? []) {
      counts[row.component_id].total++
      if (row.status === 'available') counts[row.component_id].available++
    }
    return counts
  }

  /** Full create — id is caller-supplied (the service generates it),
   *  same convention every other repository's insert() follows
   *  (AssemblyPartRepository.insert, ComponentRepository.insert). */
// insert() gains one field:
async insert({ id, componentId, name = '', description = '', image = null, location = '', quantity = 1, tags = [], status = 'available', notes = '', unlimited = false }) {
  const { data, error } = await this.db
    .from('inventory_instances')
    .insert({
      id,
      component_id: componentId,
      name:         name || null,
      description:  description || null,
      image_url:    image || null,
      location,
      quantity,
      tags,
      status,
      notes,
      unlimited,   // NEW
    })
    .select().single()
  if (error) throw new DatabaseError(`inventory_instances insert failed: ${error.message}`, error)
  return toLocal(data)
}

  // ── Whitelisted camelCase -> column mapping for partial updates ──
  // Same discipline AssemblyPartRepository.#PATCHABLE_FIELDS follows —
  // one place to add a new writable field, rather than re-deriving the
  // mapping per call site.
  static #PATCHABLE_FIELDS = {
    componentId: 'component_id',
    name:        'name',
    description: 'description',
    image:       'image_url',
    location:    'location',
    quantity:    'quantity',
    tags:        'tags',
    status:      'status',
    notes:       'notes',
  }

  /** Generic partial update — the manual Edit Component modal's write
   *  path. Does NOT touch reservation fields (status/location are
   *  patchable here too, but reserveUnits()/unreserve()/releaseMany()
   *  above remain the only path for the RESERVATION-driven versions of
   *  those same columns — this method is for a user editing an
   *  instance's own fields directly). */
  async update(id, patch) {
    const columns = {}
    for (const [key, value] of Object.entries(patch)) {
      const column = InventoryInstanceRepository.#PATCHABLE_FIELDS[key]
      if (!column) throw new DatabaseError(`inventory_instances update: unrecognized field "${key}"`)
      columns[column] = value
    }
    const { data, error } = await this.db
      .from('inventory_instances').update(columns).eq('id', id).select().single()
    if (error) throw new DatabaseError(`inventory_instances update failed: ${error.message}`, error)
    return toLocal(data)
  }

  async deleteById(id) {
    const { error } = await this.db.from('inventory_instances').delete().eq('id', id)
    if (error) throw new DatabaseError(`inventory_instances delete failed: ${error.message}`, error)
  }
}
