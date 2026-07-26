// repositories/FabricationJobRepository.js
//
// The ONLY file that knows the `fabrication_jobs` table's column names
// or query shape. Every method takes/returns already-mapped camelCase
// objects, mirroring src/db.js's dbJobToLocal() mapping convention
// exactly — field names never change here, so a future client-side
// swap-over (pointing src/db.js's createFabricationJob at
// /api/fabrication-jobs instead of Supabase directly) doesn't ripple
// into every module that reads a job.
//
// "Repository" does NOT mean "one method per query the app happens to
// need everywhere" — this file only has what FabricationJobService
// actually calls. Add methods here as new services need them; don't
// pre-port every fabrication_jobs query from src/db.js speculatively
// (see MIGRATION_EXAMPLE.md's "start narrow" note).

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

  async findById(id) {
    const { data, error } = await this.db
      .from('fabrication_jobs').select('*').eq('id', id).maybeSingle()
    if (error) throw new DatabaseError(`fabrication_jobs lookup failed: ${error.message}`, error)
    return data ? toLocal(data) : null
  }

  /** The active (non-archived) job for a part, or null. Lets the
   *  service enforce "one active job per part" with a friendly error
   *  BEFORE hitting the DB — the real backstop against a race between
   *  two simultaneous requests is still the partial unique index
   *  (fabrication_jobs_one_active_per_part, schema.sql); this is a
   *  UX nicety layered on top of it, same intent as src/db.js's
   *  existing fetchActiveJobForPart. */
  async findActiveForPart(assemblyPartId) {
    const { data, error } = await this.db
      .from('fabrication_jobs').select('*')
      .eq('assembly_part_id', assemblyPartId)
      .neq('status', 'archived')
      .maybeSingle()
    if (error) throw new DatabaseError(`active job lookup failed: ${error.message}`, error)
    return data ? toLocal(data) : null
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

  /** Only a queued job may be deleted outright — the same status guard
   *  src/db.js's deleteQueuedFabricationJob enforces, kept at the query
   *  layer (not "fetch then check status in JS") so a job claimed a
   *  moment ago can't be deleted out from under whoever claimed it. */
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

  /** Wraps the existing atomic record_machined_units() Postgres function
   *  (schema.sql) rather than re-deriving its transaction in JS —
   *  Supabase's JS client has no multi-statement transaction API, so
   *  the DB function IS the real unit of work. The repository's job is
   *  just to expose it under a clean name and mapped return shape, not
   *  to reimplement what it does. */
  async recordMachinedUnits(jobId, quantity) {
    const { data, error } = await this.db.rpc('record_machined_units', {
      p_job_id: jobId, p_quantity: quantity,
    })
    if (error) throw new DatabaseError(error.message, error)
    return toLocal(data)
  }
}
