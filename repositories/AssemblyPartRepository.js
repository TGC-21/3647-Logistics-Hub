// repositories/AssemblyPartRepository.js
//
// Started narrow (Fabrication Jobs example: look up a part, patch its
// fabrication_metadata). Migration Plan Phase 1 items 1 (Inventory
// Reservation) and 2 (Assembly Parts core CRUD + status derivation)
// grow it to cover reservation bookkeeping (linked_instance_ids,
// quantity_collected, status) and the plain quantity/status fields
// AssemblyPartService owns — still NOT a full port of every
// assembly_parts query in src/db.js (onshape import/reimport's bulk
// tree-walk queries stay put until Plan item 6 touches that file).

import { getSupabase } from './supabaseClient.js'
import { DatabaseError, NotFoundError } from './errors.js'

function toLocal(row) {
  return {
    id:                  row.id,
    assemblyId:          row.assembly_id ?? null,
    assemblyChildId:     row.assembly_child_id ?? null,
    partName:            row.part_name,
    partNumber:          row.part_number ?? '',
    quantityNeeded:      row.quantity_needed ?? 1,
    quantityCollected:   row.quantity_collected ?? 0,
    status:              row.status ?? 'pending',
    componentId:         row.component_id ?? null,
    linkedInstanceIds:   row.linked_instance_ids ?? [],
    onshapeReference:    row.onshape_reference ?? null,
    fabricationMetadata: row.fabrication_metadata ?? {},
  }
}

export class AssemblyPartRepository {
  constructor(supabase = getSupabase()) {
    this.db = supabase
  }

  async findById(id) {
    const { data, error } = await this.db
      .from('assembly_parts').select('*').eq('id', id).maybeSingle()
    if (error) throw new DatabaseError(`assembly_parts lookup failed: ${error.message}`, error)
    if (!data) throw new NotFoundError(`Assembly part ${id} not found`)
    return toLocal(data)
  }

  /** All direct parts of a root assembly, or all parts of a subassembly
   *  node — exactly one of the two ids should be provided. Used by
   *  AssemblyPartService for status-derivation across a whole assembly. */
  async findForOwner({ assemblyId = null, assemblyChildId = null }) {
    let query = this.db.from('assembly_parts').select('*')
    query = assemblyId ? query.eq('assembly_id', assemblyId) : query.eq('assembly_child_id', assemblyChildId)
    const { data, error } = await query.order('created_at', { ascending: true })
    if (error) throw new DatabaseError(`assembly_parts lookup failed: ${error.message}`, error)
    return (data ?? []).map(toLocal)
  }

  async updateFabricationMetadata(id, metadata) {
    const { data, error } = await this.db
      .from('assembly_parts')
      .update({ fabrication_metadata: metadata })
      .eq('id', id).select().single()
    if (error) throw new DatabaseError(`fabrication_metadata update failed: ${error.message}`, error)
    return toLocal(data)
  }

  /** Confirming a detected fabrication candidate resolves a part's
   *  componentId AND flips fabrication_metadata.status to 'queued' in
   *  the same logical action — writing them separately would leave a
   *  window where a part has a componentId but stale metadata (or vice
   *  versa) if the second write failed. One write, one row returned. */
  async updateComponentAndMetadata(id, { componentId, fabricationMetadata }) {
    const { data, error } = await this.db
      .from('assembly_parts')
      .update({ component_id: componentId, fabrication_metadata: fabricationMetadata })
      .eq('id', id).select().single()
    if (error) throw new DatabaseError(`assembly_parts update failed: ${error.message}`, error)
    return toLocal(data)
  }

  /** Patches whichever reservation-related fields changed
   *  (componentId / linkedInstanceIds / quantityCollected / status) in
   *  one write — used by both InventoryReservationService (link/unlink)
   *  and AssemblyPartService (any other status-affecting edit). Only
   *  the keys actually present in `patch` are sent to Postgres, so a
   *  caller that only changes status doesn't clobber linkedInstanceIds
   *  with a stale copy. */
  async updateReservationFields(id, patch) {
    const dbPatch = {}
    if ('componentId' in patch)       dbPatch.component_id        = patch.componentId
    if ('linkedInstanceIds' in patch) dbPatch.linked_instance_ids = patch.linkedInstanceIds
    if ('quantityCollected' in patch) dbPatch.quantity_collected  = patch.quantityCollected
    if ('status' in patch)            dbPatch.status              = patch.status

    const { data, error } = await this.db
      .from('assembly_parts').update(dbPatch).eq('id', id).select().single()
    if (error) throw new DatabaseError(`assembly_parts update failed: ${error.message}`, error)
    return toLocal(data)
  }

  /** Plain quantity-needed edit (Add/Edit part modal) — kept separate
   *  from updateReservationFields since it's a different business
   *  action (redefining the requirement, not fulfilling it) even though
   *  both ultimately touch the same row. */
  async updateQuantityNeeded(id, quantityNeeded) {
    const { data, error } = await this.db
      .from('assembly_parts').update({ quantity_needed: quantityNeeded }).eq('id', id).select().single()
    if (error) throw new DatabaseError(`assembly_parts update failed: ${error.message}`, error)
    return toLocal(data)
  }
}
