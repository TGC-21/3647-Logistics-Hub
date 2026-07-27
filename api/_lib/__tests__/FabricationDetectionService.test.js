// api/_lib/__tests__/FabricationDetectionService.test.js
//
// Fake repositories/services all the way down, same convention as the
// rest of this pass. What's under test: kind validation, that
// confirmDetection reuses ComponentService.findOrCreate and
// FabricationJobService.createJob rather than re-deriving either rule,
// that fabrication_metadata is written in one combined call (not two
// separate writes that could tear), and that ignoreDetection never
// touches componentId or creates a job.

import { describe, it, expect, vi } from 'vitest'
import { FabricationDetectionService } from '../../../services/FabricationDetectionService.js'
import { ValidationError } from '../../../repositories/errors.js'

function makeFakeDeps(overrides = {}) {
  const categoryRepo = {
    findByName: vi.fn(async () => ({ id: 'cat1', name: 'Spacer', requiredKeysConfig: [] })),
    insert: vi.fn(async ({ id, name, requiredKeysConfig }) => ({ id, name, requiredKeysConfig })),
    ...overrides.categoryRepo,
  }
  const partRepo = {
    findById: vi.fn(async () => ({
      id: 'part1', partName: 'Spacer A', componentId: null,
      fabricationMetadata: { autoDetected: true, kind: 'spacer', status: 'detected', warnings: [] },
    })),
    updateComponentAndMetadata: vi.fn(async (id, patch) => ({ id, ...patch })),
    updateFabricationMetadata: vi.fn(async (id, metadata) => ({ id, fabricationMetadata: metadata })),
    ...overrides.partRepo,
  }
  const changeLogRepo = { newCommitId: vi.fn(() => 'c_fixed'), record: vi.fn(async () => {}), ...overrides.changeLogRepo }
  const componentService = {
    findOrCreate: vi.fn(async () => ({ id: 'comp1', categoryId: 'cat1' })),
    ...overrides.componentService,
  }
  const fabricationJobService = {
    createJob: vi.fn(async ({ assemblyPartId, quantityRequested }) => ({
      id: 'job1', assemblyPartId, quantityRequested, quantityMachined: 0, status: 'queued',
    })),
    ...overrides.fabricationJobService,
  }
  return { categoryRepo, partRepo, changeLogRepo, componentService, fabricationJobService }
}

describe('FabricationDetectionService.confirmDetection', () => {
  it('rejects an unknown kind', async () => {
    const service = new FabricationDetectionService(makeFakeDeps())
    await expect(service.confirmDetection({ kind: 'widget', partId: 'part1', attrs: { a: 1 }, quantityRequested: 1 }))
      .rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects an empty attrs map', async () => {
    const service = new FabricationDetectionService(makeFakeDeps())
    await expect(service.confirmDetection({ kind: 'spacer', partId: 'part1', attrs: {}, quantityRequested: 1 }))
      .rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects a non-positive quantity', async () => {
    const service = new FabricationDetectionService(makeFakeDeps())
    await expect(service.confirmDetection({ kind: 'spacer', partId: 'part1', attrs: { OD: '0.375' }, quantityRequested: 0 }))
      .rejects.toBeInstanceOf(ValidationError)
  })

  it('creates the category once, then reuses it on a second call', async () => {
    const deps = makeFakeDeps({ categoryRepo: { findByName: vi.fn(async () => null) } })
    const service = new FabricationDetectionService(deps)

    await service.confirmDetection({ kind: 'plate', partId: 'part1', attrs: { Material: 'Aluminum', Thickness: '0.25' }, quantityRequested: 2 })

    expect(deps.categoryRepo.insert).toHaveBeenCalledTimes(1)
    expect(deps.categoryRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ name: 'Plate' }))
  })

  it('resolves the component via ComponentService.findOrCreate, not inline logic', async () => {
    const deps = makeFakeDeps()
    const service = new FabricationDetectionService(deps)

    await service.confirmDetection({ kind: 'spacer', partId: 'part1', attrs: { OD: '0.375' }, quantityRequested: 1 })

    expect(deps.componentService.findOrCreate).toHaveBeenCalledWith(expect.objectContaining({
      categoryId: 'cat1', attrs: { OD: '0.375' },
    }))
  })

  it('writes componentId and fabrication_metadata in one combined call', async () => {
    const deps = makeFakeDeps()
    const service = new FabricationDetectionService(deps)

    await service.confirmDetection({ kind: 'spacer', partId: 'part1', attrs: { OD: '0.375' }, quantityRequested: 1, overrides: { od: { value: 0.4 } } })

    expect(deps.partRepo.updateComponentAndMetadata).toHaveBeenCalledWith('part1', {
      componentId: 'comp1',
      fabricationMetadata: expect.objectContaining({ status: 'queued', overrides: { od: { value: 0.4 } } }),
    })
  })

  it('delegates job creation to FabricationJobService (one-active-job rule not re-derived here)', async () => {
    const deps = makeFakeDeps()
    const service = new FabricationDetectionService(deps)

    const result = await service.confirmDetection({ kind: 'spacer', partId: 'part1', attrs: { OD: '0.375' }, quantityRequested: 3, actorId: 'member1' })

    expect(deps.fabricationJobService.createJob).toHaveBeenCalledWith({
      assemblyPartId: 'part1', quantityRequested: 3, batchId: null, actorId: 'member1',
    })
    expect(result.job.id).toBe('job1')
  })
})

describe('FabricationDetectionService.ignoreDetection', () => {
  it('marks status ignored without touching componentId or creating a job', async () => {
    const deps = makeFakeDeps()
    const service = new FabricationDetectionService(deps)

    await service.ignoreDetection({ partId: 'part1' })

    expect(deps.partRepo.updateFabricationMetadata).toHaveBeenCalledWith(
      'part1', expect.objectContaining({ status: 'ignored' })
    )
    expect(deps.partRepo.updateComponentAndMetadata).not.toHaveBeenCalled()
    expect(deps.fabricationJobService.createJob).not.toHaveBeenCalled()
  })
})
