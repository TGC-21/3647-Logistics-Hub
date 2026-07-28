// repositories/AssemblyChildRepository.js
//
// Only file that touches .from('assembly_children'). A row here is
// always owned by exactly one parent — either a root assembly
// (parent_assembly_id) or another subassembly node (parent_child_id) —
// per schema.sql's assembly_children_exactly_one_parent constraint;
// callers are responsible for setting exactly one of the two.

import { getSupabase } from './supabaseClient.js'
import { DatabaseError } from './errors.js'

function toLocal(row) {
  return {
    id:                 row.id,
    parentAssemblyId:   row.parent_assembly_id ?? null,
    parentChildId:      row.parent_child_id ?? null,
    name:               row.name,
    thumbnail:          row.thumbnail_url ?? null,
    onshapeDocumentId:  row.onshape_document_id ?? '',
    onshapeWorkspaceId: row.onshape_workspace_id ?? '',
    onshapeWvmType:     row.onshape_wvm_type ?? 'w',
    onshapeElementId:   row.onshape_element_id ?? '',
    quantity:           row.quantity ?? 1,
    createdAt:          row.created_at,
  }
}

export class AssemblyChildRepository {
  constructor(supabase = getSupabase()) {
    this.db = supabase
  }

  async insert({ id, parentAssemblyId = null, parentChildId = null, name, onshapeDocumentId, onshapeWorkspaceId, onshapeWvmType = 'w', onshapeElementId, quantity }) {
    const { data, error } = await this.db
      .from('assembly_children')
      .insert({
        id,
        parent_assembly_id:   parentAssemblyId,
        parent_child_id:      parentChildId,
        name,
        onshape_document_id:  onshapeDocumentId,
        onshape_workspace_id: onshapeWorkspaceId,
        onshape_wvm_type:     onshapeWvmType,
        onshape_element_id:   onshapeElementId,
        quantity,
      })
      .select().single()
    if (error) throw new DatabaseError(`assembly_children insert failed: ${error.message}`, error)
    return toLocal(data)
  }

  async findDirectChildren(parentAssemblyId) {
    const { data, error } = await this.db
      .from('assembly_children').select('id').eq('parent_assembly_id', parentAssemblyId)
    if (error) throw new DatabaseError(`assembly_children lookup failed: ${error.message}`, error)
    return (data || []).map(toLocal)
  }

  async findChildrenOfChild(parentChildId) {
    const { data, error } = await this.db
      .from('assembly_children').select('id').eq('parent_child_id', parentChildId)
    if (error) throw new DatabaseError(`assembly_children lookup failed: ${error.message}`, error)
    return (data || []).map(toLocal)
  }

  /** Deletes only the ROOT's direct children rows — each row's own
   *  nested children and assembly_parts cascade via FK
   *  (parent_child_id / assembly_child_id both ON DELETE CASCADE in
   *  schema.sql), so one delete here is enough to take the whole
   *  subtree with it. */
  async deleteDirectChildren(parentAssemblyId) {
    const { error } = await this.db
      .from('assembly_children').delete().eq('parent_assembly_id', parentAssemblyId)
    if (error) throw new DatabaseError(`assembly_children delete failed: ${error.message}`, error)
  }
}
