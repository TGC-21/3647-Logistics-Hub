// services/FabricationJobService.js
//
// Everything that answers "how should Partshelf behave when a
// fabrication job is created / progressed / deleted." Today that logic
// is scattered:
//   - the "one active job per part" guard lives as a query in src/db.js
//     (fetchActiveJobForPart), checked ad hoc by callers before they
//     remember to call createFabricationJob
//   - job creation itself is called directly from
//     src/designer/fabricateFlow.js AND src/designer/fabDetection.js,
//     each duplicating the same "create job, register it, re-render"
//     shape
//   - the rule "deleting a queued job must reopen its part for
//     re-detection, or the part becomes permanently unscannable" lives
//     inside a click handler in src/fabricate.js (handleDeleteJob) —
//     see the comment on deleteQueuedJob() below for why that's a bug
//     waiting to happen, not just a style issue
// This file is where all of that should live once callers migrate onto
// it — see MIGRATION_EXAMPLE.md for the rest of the story.
//
// HARD RULE: a service never imports @supabase/supabase-js and never
// touches req/res. It only talks to repositories (constructed with
// sane defaults, or injected — see the constructor) and returns plain
// objects or throws typed errors from repositories/errors.js. That is
// what makes this file callable from api/fabrication-jobs.js today AND,
// later, directly from the agent harness's tool executor without an
// HTTP round-trip in between (see AGENTIC_HARNESS.md's Phase 1).

import { FabricationJobRepository } from '../repositories/FabricationJobRepository.js'
import { AssemblyPartRepository } from '../repositories/AssemblyPartRepository.js'
import { ChangeLogRepository } from '../repositories/ChangeLogRepository.js'
import { ValidationError, ConflictError } from '../repositories/errors.js'
import { runBulk } from '../../backend/_lib/bulkOps.js'


function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

export class FabricationJobService {
  // Every dependency has a default so `new FabricationJobService()` is
  // enough for a normal route, but a test (or a future service that
  // already has repository instances) can inject its own — including
  // fake ones, with no real Supabase client anywhere in sight. This is
  // the payoff of Phase 0's ChangeLogRepository: this file has zero
  // knowledge of @supabase/supabase-js now, not even indirectly via a
  // passed-through client (compare to the previous version of this
  // file, which held `this.supabase` purely to feed recordChangeServer).
  constructor({
    jobRepo       = new FabricationJobRepository(),
    partRepo      = new AssemblyPartRepository(),
    changeLogRepo = new ChangeLogRepository(),
  } = {}) {
    this.jobRepo       = jobRepo
    this.partRepo      = partRepo
    this.changeLogRepo = changeLogRepo
  }

  async listJobs() {
    return this.jobRepo.findAll()
  }

  /** Searches fabrication jobs with their assembly-part identity already
   * joined in. This prevents the harness from listing every job and then
   * fanning out one getById call per part just to answer a name query. */
  async findJobs({ query = '', status = null } = {}) {
    const jobs = await this.jobRepo.findAll()
    const statusFiltered = status ? jobs.filter(job => job.status === status) : jobs
    const parts = await this.partRepo.findByIds(statusFiltered.map(job => job.assemblyPartId))
    const partById = new Map(parts.map(part => [part.id, part]))
    const needle = String(query).trim().toLowerCase()

    return statusFiltered
      .map(job => {
        const part = partById.get(job.assemblyPartId)
        return {
          id: job.id, status: job.status, quantityRequested: job.quantityRequested,
          quantityMachined: job.quantityMachined, batchId: job.batchId,
          assemblyPartId: job.assemblyPartId, partName: part?.partName ?? 'Unknown part',
          partNumber: part?.partNumber ?? '', fabricationKind: part?.fabricationMetadata?.kind ?? null,
        }
      })
      .filter(job => !needle || [job.partName, job.partNumber, job.fabricationKind]
        .some(value => String(value || '').toLowerCase().includes(needle)))
  }

  /**
   * Business rules:
   *   - quantityRequested must be a positive integer
   *   - the assembly part must exist (partRepo.findById throws
   *     NotFoundError otherwise — nothing special to add here)
   *   - a part may have at most one ACTIVE (non-archived) job. Checked
   *     here for a clean, friendly error; the DB's partial unique index
   *     (fabrication_jobs_one_active_per_part, schema.sql) is still the
   *     real backstop if two requests race.
   */
  async createJob({ assemblyPartId, quantityRequested, batchId = null, actorId = null }) {
    if (!assemblyPartId) throw new ValidationError('assemblyPartId is required')
    if (!Number.isInteger(quantityRequested) || quantityRequested <= 0) {
      throw new ValidationError('quantityRequested must be a positive integer')
    }

    await this.partRepo.findById(assemblyPartId)

    const existingActive = await this.jobRepo.findActiveForPart(assemblyPartId)
    if (existingActive) {
      throw new ConflictError('This part already has an active fabrication job.')
    }

    const job = await this.jobRepo.insert({ id: genId(), assemblyPartId, quantityRequested, batchId })

    await this.changeLogRepo.record({
      entityType: 'fabrication_job', entityId: job.id, action: 'create',
      newValue: job, actorId, commitId: this.changeLogRepo.newCommitId(),
    })

    return job
  }

  /**
   * Delegates the real unit of work to record_machined_units() —
   * schema.sql's Postgres function already atomically creates the
   * inventory instance, bumps the linked part's quantity_collected, and
   * advances the job in one transaction. This method's job is input
   * validation and turning "not enough remaining" into a typed
   * ConflictError instead of letting a raw Postgres exception surface.
   */
  async recordMachinedUnits({ jobId, quantity, actorId = null }) {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ValidationError('quantity must be a positive integer')
    }
    const job = await this.jobRepo.findById(jobId)
    if (!job) throw new ValidationError(`Fabrication job ${jobId} not found`)
    if (job.status === 'archived') throw new ConflictError('Cannot record progress on an archived job.')

    const remaining = job.quantityRequested - job.quantityMachined
    if (quantity > remaining) {
      throw new ConflictError(`Only ${remaining} unit(s) remaining on this job, ${quantity} requested.`)
    }

    const updated = await this.jobRepo.recordMachinedUnits(jobId, quantity)

    await this.changeLogRepo.record({
      entityType: 'fabrication_job', entityId: jobId, action: 'update', field: 'quantityMachined',
      oldValue: job.quantityMachined, newValue: updated.quantityMachined,
      actorId, commitId: this.changeLogRepo.newCommitId(),
    })

    return updated
  }

  /**
   * Deleting a queued job today ALSO has to reopen its linked part for
   * re-detection, because /api/onshape-detect-fabrication.js treats
   * fabrication_metadata.status === 'queued' as a TERMINAL state and
   * never rescans it (TERMINAL_DETECTION_STATUSES). If that reopen step
   * doesn't happen, the part is silently unscannable forever — which is
   * exactly the kind of cross-cutting rule that's dangerous to leave
   * living in a UI click handler (src/fabricate.js's handleDeleteJob
   * today): every OTHER future way to delete a queued job — a bulk
   * cleanup script, the agent harness, a different button somebody adds
   * later — has to remember to copy that same fix-up logic, or silently
   * reintroduce the bug. Putting it here means there's exactly one
   * place to get it right.
   */
  async deleteQueuedJob({ jobId, actorId = null }) {
    const job = await this.jobRepo.findById(jobId)
    if (!job) throw new ValidationError(`Fabrication job ${jobId} not found`)

    const part = await this.partRepo.findById(job.assemblyPartId).catch(() => null)

    const deleted = await this.jobRepo.deleteIfQueued(jobId)
    if (!deleted) {
      throw new ConflictError('Only an unclaimed (queued) job can be deleted — archive it instead.')
    }

    let reopenedPart = null
    if (part?.fabricationMetadata?.autoDetected && part.fabricationMetadata.status === 'queued') {
      reopenedPart = await this.partRepo.updateFabricationMetadata(part.id, {
        ...part.fabricationMetadata,
        status: 'detected',
        warnings: [
          ...(part.fabricationMetadata.warnings || []),
          'Fabrication job was deleted — re-confirm to send to Fabricate again.',
        ],
      })
    }

    await this.changeLogRepo.record({
      entityType: 'fabrication_job', entityId: jobId, action: 'delete',
      oldValue: job, actorId, commitId: this.changeLogRepo.newCommitId(),
    })

    return { deletedJobId: jobId, reopenedPart }
  }

    /** Bulk fetch — resolve several known job ids in one call. */
  async getByIds({ jobIds }) {
    if (!Array.isArray(jobIds) || !jobIds.length) throw new ValidationError('jobIds is required')
    const all = await this.jobRepo.findAll()
    const byId = new Map(all.map(j => [j.id, j]))
    return jobIds.map(id => byId.get(id)).filter(Boolean)
  }

  /** Bulk progress logging — [{ jobId, quantity }]. Useful for "mark all
   *  these jobs as fully machined" or logging a batch's worth of jobs
   *  finishing together. */
  async bulkRecordMachinedUnits({ updates, actorId = null }) {
    return runBulk(updates, (u) => this.recordMachinedUnits({ ...u, actorId }), { keyOf: u => u.jobId })
  }

  /** Bulk delete of unclaimed jobs — jobIds is a flat array. */
  async bulkDeleteQueuedJobs({ jobIds, actorId = null }) {
    return runBulk(jobIds.map(jobId => ({ jobId })), (u) => this.deleteQueuedJob({ ...u, actorId }), { keyOf: u => u.jobId })
  }
}
