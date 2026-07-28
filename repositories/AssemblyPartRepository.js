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
