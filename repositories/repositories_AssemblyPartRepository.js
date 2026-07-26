// repositories/AssemblyPartRepository.js
//
// Deliberately a NARROW slice of assembly_parts access — only what
// FabricationJobService needs (look up a part, patch its
// fabrication_metadata). This is NOT meant to become a full port of
// every assembly_parts query in src/db.js in one pass; other services
// (AssemblyPartService, InventoryLinkService, ...) will grow this file
// or add sibling repositories as they're migrated. Building the whole
// surface up front, before any service actually needs it, is exactly
// the kind of speculative work MIGRATION_EXAMPLE.md recommends against.

import { getSupabase } from './supabaseClient.js'
import { DatabaseError, NotFoundError } from './errors.js'

function toLocal(row) {
  return {
    id:                  row.id,
    assemblyId:          row.assembly_id ?? null,
    assemblyChildId:     row.assembly_child_id ?? null,
    partName:            row.part_name,
    componentId:         row.component_id ?? null,
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

  async updateFabricationMetadata(id, metadata) {
    const { data, error } = await this.db
      .from('assembly_parts')
      .update({ fabrication_metadata: metadata })
      .eq('id', id).select().single()
    if (error) throw new DatabaseError(`fabrication_metadata update failed: ${error.message}`, error)
    return toLocal(data)
  }
}
