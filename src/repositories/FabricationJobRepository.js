// repositories/FabricationJobRepository.js
//
// The ONLY file that knows the `fabrication_jobs` table's column names
// or query shape. Phase 1 part 4 (see MIGRATION_EXAMPLE.md) shipped the
// core CRUD; Phase 1 part 6 (Onshape import/reimport) adds the two
// carry-over methods OnshapeReimportService needs — finding every job
// belonging to a soon-to-be-wiped part tree, and re-creating a job
// against its replacement row after reimport rebuilds the tree (every
// assembly_parts row gets a brand-new id on reimport, so nothing about
// a job's assembly_part_id survives the rebuild on its own).

import { getSupabase } from './supabaseClient.js'
import { DatabaseError } from './errors.js'

function toLocal(row) {
  return {
    id:                row.id,
    batchId:           row.batch_id ?? null,
    assemblyPartId:    row.assembly_part_id,
    quantityRequested: row.quantity_requested ?? 1,
    quantityMachined:  row.quantity_machined ?? 0,
    status:            row.status ?? 'queued',
    claimedBy:         row.claimed_by ?? null,
    claimedAt:         row.claimed_at ?? null,
    notes:             row.notes ?? '',
    createdAt:         row.created_at,
  }
}

export class FabricationJobRepository {
  constructor(supabase = getSupabase()) {
    this.db = supabase
  }

  /** Every job, any status — the harness's "what's in the fab queue"
   *  read. Deliberately unfiltered here; callers wanting only active
   *  jobs already have findActiveForPart for the per-part case. */
  async findAll() {
    const { data, error } = await this.db.from('fabrication_jobs').select('*').order('created_at', { ascending: true })
    if (error) throw new DatabaseError(`fabrication_jobs lookup failed: ${error.message}`, error)
    return (data ?? []).map(toLocal)
  }

  async findById(id) {
    const { data, error } = await this.db
      .from('fabrication_jobs').select('*').eq('id', id).maybeSingle()
    if (error) throw new DatabaseError(`fabrication_jobs lookup failed: ${error.message}`, error)
    return data ? toLocal(data) : null
  }

  async findActiveForPart(assemblyPartId) {
    const { data, error } = await this.db
      .from('fabrication_jobs').select('*')
      .eq('assembly_part_id', assemblyPartId)
      .neq('status', 'archived')
      .maybeSingle()
    if (error) throw new DatabaseError(`active job lookup failed: ${error.message}`, error)
    return data ? toLocal(data) : null
  }

  /** Every job (any status) belonging to any part in a given set — used
   *  by reimport to snapshot ALL jobs for the whole old tree before it
   *  gets wiped, not just the active ones (a completed/archived job is
   *  historical fact and still needs to carry forward). */
  async findByAssemblyPartIds(assemblyPartIds) {
    if (!assemblyPartIds || !assemblyPartIds.length) return []
    const { data, error } = await this.db
      .from('fabrication_jobs').select('*').in('assembly_part_id', assemblyPartIds)
    if (error) throw new DatabaseError(`fabrication_jobs lookup failed: ${error.message}`, error)
    return (data || []).map(toLocal)
  }

  async insert({ id, assemblyPartId, quantityRequested, batchId }) {
    const { data, error } = await this.db
      .from('fabrication_jobs')
      .insert({
        id,
        assembly_part_id:   assemblyPartId,
        quantity_requested: quantityRequested,
        batch_id:           batchId || null,
        status:             'queued',
      })
      .select().single()
    if (error) throw new DatabaseError(`fabrication_jobs insert failed: ${error.message}`, error)
    return toLocal(data)
  }

  /** Re-creates a job verbatim against a NEW assembly_part_id, preserving
   *  every field (status, quantities, claim info, timestamps) — this is
   *  a carry-over, not a fresh job, so it must not reset any of that.
   *  Used once per surviving old job during reimport. */
  async insertCarryOver({ id, batchId, assemblyPartId, quantityRequested, quantityMachined, status, claimedBy, claimedAt, notes, createdAt }) {
    const { error } = await this.db.from('fabrication_jobs').insert({
      id,
      batch_id:            batchId,
      assembly_part_id:    assemblyPartId,
      quantity_requested:  quantityRequested,
      quantity_machined:   quantityMachined,
      status,
      claimed_by:          claimedBy,
      claimed_at:          claimedAt,
      notes,
      created_at:          createdAt,
    })
    if (error) throw new DatabaseError(`fabrication_jobs carry-over insert failed: ${error.message}`, error)
  }

  async deleteIfQueued(id) {
    const { data, error } = await this.db
      .from('fabrication_jobs').delete().eq('id', id).eq('status', 'queued').select()
    if (error) throw new DatabaseError(`fabrication_jobs delete failed: ${error.message}`, error)
    return data.length > 0
  }

  async archiveIfComplete(id) {
    const { data, error } = await this.db
      .from('fabrication_jobs')
      .update({ status: 'archived' }).eq('id', id).eq('status', 'complete')
      .select().maybeSingle()
    if (error) throw new DatabaseError(`fabrication_jobs archive failed: ${error.message}`, error)
    return data ? toLocal(data) : null
  }

  async recordMachinedUnits(jobId, quantity) {
    const { data, error } = await this.db.rpc('record_machined_units', {
      p_job_id: jobId, p_quantity: quantity,
    })
    if (error) throw new DatabaseError(error.message, error)
    return toLocal(data)
  }

  
}
