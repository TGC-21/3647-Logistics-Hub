// services/__tests__/FabricationJobService.test.js
//
// Convention: a SERVICE test never touches Supabase, real or fake — it
// injects plain fake repository objects via the constructor. This is
// the entire point of Phase 0's ChangeLogRepository: before it existed,
// this service held a raw `supabase` field purely to feed
// recordChangeServer, which meant a "pure business rules" test still
// had to fake a Supabase client just to satisfy that one dependency.
// Now every dependency is a repository, so every dependency is a
// trivial object literal.
//
// These tests exist to prove the BUSINESS RULES this service exists to
// own — the ones described in the file's own doc comments — actually
// hold, independent of how any repository happens to store data.

import { describe, it, expect, vi } from 'vitest'
import { FabricationJobService } from '../FabricationJobService.js'
import { ValidationError, ConflictError } from '../../repositories/errors.js'

function makeFakeRepos(overrides = {}) {
  const jobRepo = {
    findById: vi.fn(async () => null),
    findActiveForPart: vi.fn(async () => null),
    insert: vi.fn(async ({ id }) => ({
      id, batchId: null, assemblyPartId: 'part1',
      quantityRequested: 1, quantityMachined: 0, status: 'queued',
      claimedBy: null, claimedAt: null, notes: '', createdAt: new Date().toISOString(),
    })),
    deleteIfQueued: vi.fn(async () => true),
    recordMachinedUnits: vi.fn(async () => ({ quantityMachined: 1 })),
    ...overrides.jobRepo,
  }
  const partRepo = {
    findById: vi.fn(async () => ({ id: 'part1', fabricationMetadata: {} })),
    updateFabricationMetadata: vi.fn(async (id, meta) => ({ id, fabricationMetadata: meta })),
    ...overrides.partRepo,
  }
  const changeLogRepo = {
    newCommitId: vi.fn(() => 'c_fixed'),
    record: vi.fn(async () => {}),
    ...overrides.changeLogRepo,
  }
  return { jobRepo, partRepo, changeLogRepo }
}

describe('FabricationJobService.createJob', () => {
  it('rejects a non-positive quantity before touching any repository', async () => {
    const repos = makeFakeRepos()
    const service = new FabricationJobService(repos)

    await expect(service.createJob({ assemblyPartId: 'part1', quantityRequested: 0 }))
      .rejects.toBeInstanceOf(ValidationError)
    expect(repos.jobRepo.insert).not.toHaveBeenCalled()
  })

  it('refuses a second active job for the same part', async () => {
    const repos = makeFakeRepos({
      jobRepo: { findActiveForPart: vi.fn(async () => ({ id: 'existing-job' })) },
    })
    const service = new FabricationJobService(repos)

    await expect(service.createJob({ assemblyPartId: 'part1', quantityRequested: 2 }))
      .rejects.toBeInstanceOf(ConflictError)
    expect(repos.jobRepo.insert).not.toHaveBeenCalled()
  })

  it('creates the job and logs one change_log entry when everything checks out', async () => {
    const repos = makeFakeRepos()
    const service = new FabricationJobService(repos)

    const job = await service.createJob({ assemblyPartId: 'part1', quantityRequested: 3, actorId: 'member1' })

    expect(job.quantityRequested).toBe(1)   // from the fake insert() stub, proves the return value flows through
    expect(repos.jobRepo.insert).toHaveBeenCalledTimes(1)
    expect(repos.changeLogRepo.record).toHaveBeenCalledTimes(1)
    expect(repos.changeLogRepo.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'create', actorId: 'member1' }))
  })
})

describe('FabricationJobService.recordMachinedUnits', () => {
  it('refuses to record more than the remaining quantity', async () => {
    const repos = makeFakeRepos({
      jobRepo: {
        findById: vi.fn(async () => ({
          id: 'job1', quantityRequested: 5, quantityMachined: 4, status: 'in_progress',
        })),
      },
    })
    const service = new FabricationJobService(repos)

    await expect(service.recordMachinedUnits({ jobId: 'job1', quantity: 2 }))
      .rejects.toBeInstanceOf(ConflictError)
    expect(repos.jobRepo.recordMachinedUnits).not.toHaveBeenCalled()
  })

  it('refuses to record progress on an archived job', async () => {
    const repos = makeFakeRepos({
      jobRepo: { findById: vi.fn(async () => ({ id: 'job1', quantityRequested: 5, quantityMachined: 5, status: 'archived' })) },
    })
    const service = new FabricationJobService(repos)

    await expect(service.recordMachinedUnits({ jobId: 'job1', quantity: 1 }))
      .rejects.toBeInstanceOf(ConflictError)
  })
})

describe('FabricationJobService.deleteQueuedJob', () => {
  it('reopens an auto-detected part for re-scanning when its queued job is deleted', async () => {
    const repos = makeFakeRepos({
      jobRepo: { findById: vi.fn(async () => ({ id: 'job1', assemblyPartId: 'part1', status: 'queued' })) },
      partRepo: {
        findById: vi.fn(async () => ({
          id: 'part1',
          fabricationMetadata: { autoDetected: true, status: 'queued', kind: 'spacer', warnings: [] },
        })),
      },
    })
    const service = new FabricationJobService(repos)

    const result = await service.deleteQueuedJob({ jobId: 'job1' })

    expect(repos.partRepo.updateFabricationMetadata).toHaveBeenCalledWith(
      'part1',
      expect.objectContaining({ status: 'detected' })
    )
    expect(result.reopenedPart).not.toBeNull()
  })

  it('leaves a manually-created part alone (no fabricationMetadata to reopen)', async () => {
    const repos = makeFakeRepos({
      jobRepo: { findById: vi.fn(async () => ({ id: 'job1', assemblyPartId: 'part1', status: 'queued' })) },
      partRepo: { findById: vi.fn(async () => ({ id: 'part1', fabricationMetadata: {} })) },
    })
    const service = new FabricationJobService(repos)

    const result = await service.deleteQueuedJob({ jobId: 'job1' })

    expect(repos.partRepo.updateFabricationMetadata).not.toHaveBeenCalled()
    expect(result.reopenedPart).toBeNull()
  })

  it('refuses to delete a job that is no longer queued', async () => {
    const repos = makeFakeRepos({
      jobRepo: {
        findById: vi.fn(async () => ({ id: 'job1', assemblyPartId: 'part1', status: 'committed' })),
        deleteIfQueued: vi.fn(async () => false),
      },
    })
    const service = new FabricationJobService(repos)

    await expect(service.deleteQueuedJob({ jobId: 'job1' })).rejects.toBeInstanceOf(ConflictError)
  })
})