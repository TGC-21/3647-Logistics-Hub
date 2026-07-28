// repositories/AssemblyRepository.js
//
// Only file that touches .from('assemblies'). Narrow slice for Phase 1
// part 6 (Onshape import/reimport) — CRUD verbs OnshapeImportService/
// OnshapeReimportService actually need, not a port of every assemblies
// query in src/db.js (fetchAssemblies, upsertAssembly for renames, etc.
// stay client-side until a service needs them too).

import { getSupabase } from './supabaseClient.js'
import { DatabaseError, NotFoundError } from './errors.js'

function toLocal(row) {
  return {
    id:                 row.id,
    name:               row.name,
    description:        row.description ?? '',
    onshapeUrl:         row.onshape_url ?? '',
    onshapeDocumentId:  row.onshape_document_id ?? '',
    onshapeWorkspaceId: row.onshape_workspace_id ?? '',
    onshapeElementId:   row.onshape_element_id ?? '',
    thumbnail:          row.thumbnail_url ?? null,
    status:             row.status ?? 'draft',
    createdAt:          row.created_at,
  }
}

export class AssemblyRepository {
  constructor(supabase = getSupabase()) {
    this.db = supabase
  }

  async findById(id) {
    const { data, error } = await this.db.from('assemblies').select('*').eq('id', id).maybeSingle()
    if (error) throw new DatabaseError(`assemblies lookup failed: ${error.message}`, error)
    return data ? toLocal(data) : null
  }

  async requireById(id) {
    const found = await this.findById(id)
    if (!found) throw new NotFoundError(`Assembly ${id} not found`)
    return found
  }

  /** Root assembly creation only — a subassembly node never lives here,
   *  see AssemblyChildRepository. */
  async insertRoot({ id, name, description, onshapeUrl, onshapeDocumentId, onshapeWorkspaceId, onshapeElementId, thumbnailUrl }) {
    const { data, error } = await this.db
      .from('assemblies')
      .insert({
        id, name,
        description:          description || '',
        onshape_url:          onshapeUrl || '',
        onshape_document_id:  onshapeDocumentId,
        onshape_workspace_id: onshapeWorkspaceId,
        onshape_element_id:   onshapeElementId,
        thumbnail_url:        thumbnailUrl || null,
        status:                'draft',
      })
      .select().single()
    if (error) throw new DatabaseError(`assemblies insert failed: ${error.message}`, error)
    return toLocal(data)
  }

  /** Cleanup path for a failed import — mirrors onshape-bom.js's
   *  "don't leave an empty orphan assembly behind" behavior. */
  async deleteById(id) {
    const { error } = await this.db.from('assemblies').delete().eq('id', id)
    if (error) throw new DatabaseError(`assemblies delete failed: ${error.message}`, error)
  }

  async updateStatus(id, status) {
    const { data, error } = await this.db
      .from('assemblies').update({ status }).eq('id', id).select().maybeSingle()
    if (error) throw new DatabaseError(`assemblies status update failed: ${error.message}`, error)
    return data ? toLocal(data) : null
  }
}
