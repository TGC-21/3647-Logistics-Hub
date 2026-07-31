// repositories/AssemblyPartRepository.js
//
// Only file that touches .from('assembly_parts'). Started narrow
// (findById, updateFabricationMetadata — see the Fabrication Jobs
// reference example) and grows on demand rather than being ported
// wholesale from src/db.js. Phase 1 part 6 (Onshape import/reimport)
// adds the tree-walk and bulk-write methods OnshapeImportService /
// OnshapeReimportService need — mirrors onshape-bom.js's
// walkAssemblyPartsTree, seedAssemblyContents's insert step, and the
// wipe step of reimportAssembly, just behind a repository boundary.

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
    source:              row.source ?? 'manual',
    notes:               row.notes ?? '',
    onshapeReference:    row.onshape_reference ?? null,
    componentId:         row.component_id ?? null,
    linkedInstanceIds:   row.linked_instance_ids ?? [],
    fabricationMetadata: row.fabrication_metadata ?? {},
    createdAt:           row.created_at,
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

  /** Every part belonging to one owner — a root assembly (assemblyId)
   *  or a subassembly node (assemblyChildId), exactly one of which the
   *  caller passes, mirroring the DB's own exactly-one-owner
   *  constraint. Used by AssemblyPartService.listForAssembly/
   *  listForChild/computeOwnerStatus. */
  async findForOwner({ assemblyId = null, assemblyChildId = null } = {}) {
    if (!!assemblyId === !!assemblyChildId) {
      throw new DatabaseError('findForOwner requires exactly one of assemblyId or assemblyChildId')
    }
    let query = this.db.from('assembly_parts').select('*')
    query = assemblyId ? query.eq('assembly_id', assemblyId) : query.eq('assembly_child_id', assemblyChildId)
    const { data, error } = await query
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

  /** Bulk insert for one node's worth of direct parts (a root assembly
   *  OR one subassembly node) — `rows` are already shaped with either
   *  assemblyId or assemblyChildId set, per the DB's
   *  assembly_parts_exactly_one_owner constraint. */
  async bulkInsert(rows) {
    if (!rows.length) return []
    const { data, error } = await this.db
      .from('assembly_parts')
      .insert(rows.map(p => ({
        id:                   p.id,
        assembly_id:          p.assemblyId ?? null,
        assembly_child_id:    p.assemblyChildId ?? null,
        part_name:            p.partName,
        part_number:          p.partNumber ?? '',
        quantity_needed:      p.quantityNeeded ?? 1,
        quantity_collected:   p.quantityCollected ?? 0,
        status:               p.status ?? 'pending',
        source:               p.source ?? 'manual',
        notes:                p.notes ?? '',
        onshape_reference:    p.onshapeReference ?? null,
        fabrication_metadata: p.fabricationMetadata ?? {},
      })))
      .select()
    if (error) throw new DatabaseError(`assembly_parts bulk insert failed: ${error.message}`, error)
    return data.map(toLocal)
  }

  /** Every assembly_parts row anywhere under a root assembly — its own
   *  direct parts, plus every nested assembly_children node's parts,
   *  recursively. Mirrors onshape-bom.js's walkAssemblyPartsTree /
   *  onshape-detect-fabrication.js's fetchWholeTreeParts (three
   *  independent copies of this walk existed before repositories
   *  existed — this is meant to eventually be the one shared version). */
  async findTreeForAssembly(assemblyId) {
    const allParts = []

    const { data: rootParts, error: rootErr } = await this.db
      .from('assembly_parts').select('*').eq('assembly_id', assemblyId)
    if (rootErr) throw new DatabaseError(`assembly_parts tree lookup failed: ${rootErr.message}`, rootErr)
    allParts.push(...(rootParts || []))

    const { data: directChildren, error: childErr } = await this.db
      .from('assembly_children').select('id').eq('parent_assembly_id', assemblyId)
    if (childErr) throw new DatabaseError(`assembly_children lookup failed: ${childErr.message}`, childErr)

    const queue = (directChildren || []).map(c => c.id)
    while (queue.length) {
      const childId = queue.pop()

      const { data: childParts, error: cpErr } = await this.db
        .from('assembly_parts').select('*').eq('assembly_child_id', childId)
      if (cpErr) throw new DatabaseError(`assembly_parts tree lookup failed: ${cpErr.message}`, cpErr)
      allParts.push(...(childParts || []))

      const { data: grandchildren, error: gcErr } = await this.db
        .from('assembly_children').select('id').eq('parent_child_id', childId)
      if (gcErr) throw new DatabaseError(`assembly_children lookup failed: ${gcErr.message}`, gcErr)
      queue.push(...(grandchildren || []).map(c => c.id))
    }

    return allParts.map(toLocal)
  }

  /** Wipes every assembly_parts row directly owned by the root — its
   *  nested children's parts go with them once
   *  AssemblyChildRepository.deleteDirectChildren cascades (same
   *  two-step wipe order reimportAssembly already uses: parts first,
   *  then children, though the FK cascade would handle either order). */
  async deleteDirectForAssembly(assemblyId) {
    const { error } = await this.db.from('assembly_parts').delete().eq('assembly_id', assemblyId)
    if (error) throw new DatabaseError(`assembly_parts delete failed: ${error.message}`, error)
  }

  // ── Whitelisted camelCase -> column mapping for partial updates ──
  // Every service-level "patch a few fields" call (reservation bookkeeping,
  // status recompute, quantity edits, the manual Add/Edit modal) funnels
  // through this one mapping so a new writable field only needs adding
  // here once, not re-derived per call site.
  static #PATCHABLE_FIELDS = {
    componentId:       'component_id',
    linkedInstanceIds: 'linked_instance_ids',
    quantityCollected: 'quantity_collected',
    quantityNeeded:    'quantity_needed',
    status:            'status',
    partName:          'part_name',
    partNumber:        'part_number',
    notes:             'notes',
    fabricationMetadata: 'fabrication_metadata',
  }

  /** Generic partial update — accepts any subset of the whitelisted
   *  camelCase fields above. Used both directly (AssemblyPartService's
   *  create/update/status flows) and by the two thin wrappers below,
   *  kept for callers that read better with a named, narrower method. */
  async updateFields(id, patch) {
    const columns = {}
    for (const [key, value] of Object.entries(patch)) {
      const column = AssemblyPartRepository.#PATCHABLE_FIELDS[key]
      if (!column) throw new DatabaseError(`assembly_parts update: unrecognized field "${key}"`)
      columns[column] = value
    }
    const { data, error } = await this.db
      .from('assembly_parts').update(columns).eq('id', id).select().single()
    if (error) throw new DatabaseError(`assembly_parts update failed: ${error.message}`, error)
    return toLocal(data)
  }

  /** Reservation bookkeeping writes (componentId/linkedInstanceIds/
   *  quantityCollected/status) — a named alias of updateFields so
   *  InventoryReservationService/AssemblyPartService call sites read as
   *  what they mean, not just "some patch." */
  async updateReservationFields(id, patch) {
    return this.updateFields(id, patch)
  }

  async updateQuantityNeeded(id, quantityNeeded) {
    return this.updateFields(id, { quantityNeeded })
  }

  /** FabricationDetectionService.confirmDetection's one-round-trip write:
   *  the resolved component id + the updated fabrication_metadata
   *  envelope (status flipped to 'queued', overrides preserved/merged),
   *  written together so a confirm never leaves a part with a
   *  componentId but a stale 'detected' status (or vice versa) if
   *  something failed between two separate writes. */
  async updateComponentAndMetadata(id, { componentId, fabricationMetadata }) {
    return this.updateFields(id, { componentId, fabricationMetadata })
  }

  /** Single-row create — the manual Add Part modal's path (as opposed
   *  to bulkInsert, used by Onshape/CSV import). Owner (assemblyId XOR
   *  assemblyChildId) must already be resolved by the caller, same
   *  constraint the DB itself enforces. */
  async insert(row) {
    const { data, error } = await this.db
      .from('assembly_parts')
      .insert({
        id:                   row.id,
        assembly_id:          row.assemblyId ?? null,
        assembly_child_id:    row.assemblyChildId ?? null,
        part_name:            row.partName,
        part_number:          row.partNumber ?? '',
        quantity_needed:      row.quantityNeeded ?? 1,
        quantity_collected:   row.quantityCollected ?? 0,
        status:               row.status ?? 'pending',
        source:               row.source ?? 'manual',
        notes:                row.notes ?? '',
        onshape_reference:    row.onshapeReference ?? null,
        component_id:         row.componentId ?? null,
        linked_instance_ids:  row.linkedInstanceIds ?? [],
        fabrication_metadata: row.fabricationMetadata ?? {},
      })
      .select().single()
    if (error) throw new DatabaseError(`assembly_parts insert failed: ${error.message}`, error)
    return toLocal(data)
  }

  /** Deletes one row outright — the manual Delete Part action. Releasing
   *  any inventory the part had reserved is InventoryReservationService's
   *  job, not this repository's; AssemblyPartService.deletePart
   *  orchestrates the two in order (release, then delete). */
  async deleteById(id) {
    const { error } = await this.db.from('assembly_parts').delete().eq('id', id)
    if (error) throw new DatabaseError(`assembly_parts delete failed: ${error.message}`, error)
  }

  /** Carry-over write used by reimport: an old part's real inventory
   *  link + collected count, applied onto its NEW replacement row. */
  async applyCarryOver(id, { linkedInstanceIds, quantityCollected, status }) {
    const { error } = await this.db
      .from('assembly_parts')
      .update({ linked_instance_ids: linkedInstanceIds, quantity_collected: quantityCollected, status })
      .eq('id', id)
    if (error) throw new DatabaseError(`assembly_parts carry-over update failed: ${error.message}`, error)
  }
}