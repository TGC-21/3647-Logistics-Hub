// services/__tests__/OnshapeReimportService.test.js
//
// Same convention as FabricationJobService.test.js / CartService.test.js:
// plain fake repositories, no Supabase, no mocking of api/_lib/onshape.js
// (buildSourceKey/fabricationIdentityKey are pure and used as-is).
// Scoped to carryOverPromises and logReimportChanges — the two methods
// that contain the actual "did this part survive reimport" business
// rules. reimportAssembly() itself (the top-level orchestrator) is
// thin glue over these plus OnshapeImportService.seedAssemblyContents,
// which is exercised indirectly through OnshapeImportService's own
// integration rather than re-mocked here.

import { describe, it, expect, vi } from 'vitest'
import { OnshapeReimportService } from '../OnshapeReimportService.js'

function ref(partIdentity, extra = {}) {
  return { documentId: 'doc1', wvmType: 'w', wvmId: 'wsA', elementId: 'elA', partIdentity, fullConfiguration: '', ...extra }
}

function makeFakeRepos() {
  return {
    assemblyRepo:      { requireById: vi.fn(), updateStatus: vi.fn(async () => {}) },
    assemblyChildRepo: { deleteDirectChildren: vi.fn(async () => {}) },
    assemblyPartRepo: {
      applyCarryOver: vi.fn(async () => {}),
      deleteDirectForAssembly: vi.fn(async () => {}),
      findTreeForAssembly: vi.fn(async () => []),
      updateFabricationMetadata: vi.fn(async () => {}),
    },
    fabricationJobRepo: {
      findByAssemblyPartIds: vi.fn(async () => []),
      insertCarryOver: vi.fn(async () => {}),
    },
    cartItemRepo: {
      findByAssemblyPartIds: vi.fn(async () => []),
      updateAssemblyPartId: vi.fn(async () => {}),
    },
    inventoryInstanceRepo: { releaseMany: vi.fn(async () => {}) },
    changeLogRepo: { newCommitId: vi.fn(() => 'c_fixed'), record: vi.fn(async () => {}) },
    importService: { seedAssemblyContents: vi.fn(async () => ({ partCount: 0, childCount: 0 })) },
  }
}

describe('OnshapeReimportService.carryOverPromises', () => {
  it('carries an inventory link forward onto the matching new part', async () => {
    const repos = makeFakeRepos()
    const service = new OnshapeReimportService(repos)

    const oldParts = [{ id: 'old1', linkedInstanceIds: ['inst1'], quantityCollected: 2, onshapeReference: ref('p1') }]
    const oldSourceKeyById = { old1: 'doc1::w::wsA::elA::p1::' }
    const newBySourceKey = new Map([['doc1::w::wsA::elA::p1::', { id: 'new1', quantityNeeded: 5 }]])

    const summary = await service.carryOverPromises({ oldParts, oldSourceKeyById, oldJobs: [], oldCartItems: [], newBySourceKey })

    expect(repos.assemblyPartRepo.applyCarryOver).toHaveBeenCalledWith('new1', {
      linkedInstanceIds: ['inst1'], quantityCollected: 2, status: 'partial',
    })
    expect(summary.relinkedInventoryCount).toBe(1)
    expect(summary.lostPartsWithLinksCount).toBe(0)
  })

  it('releases inventory for a part with no match in the new tree', async () => {
    const repos = makeFakeRepos()
    const service = new OnshapeReimportService(repos)

    const oldParts = [{ id: 'old1', linkedInstanceIds: ['inst1', 'inst2'], quantityCollected: 2, onshapeReference: ref('p1') }]
    const oldSourceKeyById = { old1: 'doc1::w::wsA::elA::p1::' }

    const summary = await service.carryOverPromises({ oldParts, oldSourceKeyById, oldJobs: [], oldCartItems: [], newBySourceKey: new Map() })

    expect(repos.inventoryInstanceRepo.releaseMany).toHaveBeenCalledWith(['inst1', 'inst2'])
    expect(summary.lostPartsWithLinksCount).toBe(1)
    expect(summary.relinkedInventoryCount).toBe(0)
  })

  it('re-creates a surviving active job against the new part id', async () => {
    const repos = makeFakeRepos()
    const service = new OnshapeReimportService(repos)

    const oldParts = [{ id: 'old1', linkedInstanceIds: [], quantityCollected: 0, onshapeReference: ref('p1') }]
    const oldSourceKeyById = { old1: 'doc1::w::wsA::elA::p1::' }
    const newBySourceKey = new Map([['doc1::w::wsA::elA::p1::', { id: 'new1', quantityNeeded: 3 }]])
    const oldJobs = [{ id: 'job1', assemblyPartId: 'old1', status: 'queued', quantityRequested: 3, quantityMachined: 0, batchId: null, claimedBy: null, claimedAt: null, notes: '', createdAt: 'now' }]

    const summary = await service.carryOverPromises({ oldParts, oldSourceKeyById, oldJobs, oldCartItems: [], newBySourceKey })

    expect(repos.fabricationJobRepo.insertCarryOver).toHaveBeenCalledWith(
      expect.objectContaining({ assemblyPartId: 'new1', status: 'queued', quantityRequested: 3 })
    )
    expect(summary.relinkedJobsCount).toBe(1)
    expect(summary.lostJobsCount).toBe(0)
  })

  it('counts a job as lost when its part has no match in the new tree', async () => {
    const repos = makeFakeRepos()
    const service = new OnshapeReimportService(repos)

    const oldParts = [{ id: 'old1', linkedInstanceIds: [], quantityCollected: 0, onshapeReference: ref('p1') }]
    const oldSourceKeyById = { old1: 'doc1::w::wsA::elA::p1::' }
    const oldJobs = [{ id: 'job1', assemblyPartId: 'old1', status: 'queued', quantityRequested: 3, quantityMachined: 0 }]

    const summary = await service.carryOverPromises({ oldParts, oldSourceKeyById, oldJobs, oldCartItems: [], newBySourceKey: new Map() })

    expect(repos.fabricationJobRepo.insertCarryOver).not.toHaveBeenCalled()
    expect(summary.lostJobsCount).toBe(1)
  })

  it('never carries a second active job onto the same new part (source-key collision guard)', async () => {
    const repos = makeFakeRepos()
    const service = new OnshapeReimportService(repos)

    const oldParts = [
      { id: 'oldA', linkedInstanceIds: [], quantityCollected: 0, onshapeReference: ref('p1') },
      { id: 'oldB', linkedInstanceIds: [], quantityCollected: 0, onshapeReference: ref('p1') },
    ]
    const oldSourceKeyById = { oldA: 'k1', oldB: 'k1' }
    const newBySourceKey = new Map([['k1', { id: 'new1', quantityNeeded: 3 }]])
    const oldJobs = [
      { id: 'jobA', assemblyPartId: 'oldA', status: 'queued', quantityRequested: 1, quantityMachined: 0 },
      { id: 'jobB', assemblyPartId: 'oldB', status: 'queued', quantityRequested: 1, quantityMachined: 0 },
    ]

    const summary = await service.carryOverPromises({ oldParts, oldSourceKeyById, oldJobs, oldCartItems: [], newBySourceKey })

    expect(repos.fabricationJobRepo.insertCarryOver).toHaveBeenCalledTimes(1)
    expect(summary.relinkedJobsCount).toBe(1)
    expect(summary.lostJobsCount).toBe(1)
  })

  it('re-earmarks a cart item onto the new part id when a match exists', async () => {
    const repos = makeFakeRepos()
    const service = new OnshapeReimportService(repos)

    const oldParts = [{ id: 'old1', linkedInstanceIds: [], quantityCollected: 0, onshapeReference: ref('p1') }]
    const oldSourceKeyById = { old1: 'k1' }
    const newBySourceKey = new Map([['k1', { id: 'new1', quantityNeeded: 1 }]])
    const oldCartItems = [{ id: 'item1', assemblyPartId: 'old1' }]

    const summary = await service.carryOverPromises({ oldParts, oldSourceKeyById, oldJobs: [], oldCartItems, newBySourceKey })

    expect(repos.cartItemRepo.updateAssemblyPartId).toHaveBeenCalledWith('item1', 'new1')
    expect(summary.relinkedCartItemsCount).toBe(1)
  })
})

describe('OnshapeReimportService.logReimportChanges', () => {
  it('logs a delete for a part that dropped out and a create for a genuinely new one, but nothing for a carried-over part', async () => {
    const repos = makeFakeRepos()
    const service = new OnshapeReimportService(repos)

    const oldParts = [
      { id: 'survivor-old', onshapeReference: ref('p1') },
      { id: 'removed-old',  onshapeReference: ref('p2') },
    ]
    const newParts = [
      { id: 'survivor-new', onshapeReference: ref('p1') },
      { id: 'added-new',    onshapeReference: ref('p3') },
    ]

    await service.logReimportChanges({ assemblyId: 'asm1', oldParts, newParts, actorId: 'member1' })

    const actions = repos.changeLogRepo.record.mock.calls.map(([arg]) => ({ entityType: arg.entityType, entityId: arg.entityId, action: arg.action }))

    expect(actions).toContainEqual({ entityType: 'assembly_part', entityId: 'removed-old', action: 'delete' })
    expect(actions).toContainEqual({ entityType: 'assembly_part', entityId: 'added-new', action: 'create' })
    expect(actions.find(a => a.entityId === 'survivor-old' || a.entityId === 'survivor-new')).toBeUndefined()
    // Plus the one summary "reimport" update row on the assembly itself.
    expect(actions).toContainEqual({ entityType: 'assembly', entityId: 'asm1', action: 'update' })
  })
})
