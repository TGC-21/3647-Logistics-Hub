// api/_lib/__tests__/InventoryReservationService.test.js
//
// Fake repositories all the way down, same convention as
// FabricationJobService.test.js — this file proves the business rules
// InventoryReservationService exists to own: quantity is capped at the
// part's remaining gap, reserving past a fully-met part is rejected,
// and unreserving clears componentId once the last instance is removed.

import { describe, it, expect, vi } from 'vitest'
import { InventoryReservationService } from '../../../services/InventoryReservationService.js'
import { ConflictError, ValidationError } from '../../../repositories/errors.js'

function makeFakeDeps(overrides = {}) {
  const instanceRepo = {
    reserveUnits: vi.fn(async (instanceId, qty) => ({ id: `${instanceId}-fork-1`, quantity: qty, status: 'in_assembly' })),
    unreserve: vi.fn(async () => ({ id: 'fork1', status: 'available' })),
    releaseMany: vi.fn(async () => {}),
    ...overrides.instanceRepo,
  }
  const partRepo = {
    findById: vi.fn(async () => ({
      id: 'part1', partName: 'Bearing', quantityNeeded: 4, quantityCollected: 1,
      componentId: null, linkedInstanceIds: [], status: 'partial',
    })),
    updateReservationFields: vi.fn(async (id, patch) => ({
      id, quantityNeeded: 4, quantityCollected: 1, linkedInstanceIds: [], componentId: null, status: 'partial', ...patch,
    })),
    ...overrides.partRepo,
  }
  const partNumberRepo = { backfillComponentId: vi.fn(async () => {}), ...overrides.partNumberRepo }
  const changeLogRepo = { newCommitId: vi.fn(() => 'c_fixed'), record: vi.fn(async () => {}), ...overrides.changeLogRepo }
  const assemblyPartService = {
    recomputeStatus: vi.fn(async ({ partId }) => ({
      id: partId, quantityNeeded: 4, quantityCollected: 3, linkedInstanceIds: ['inst9-fork-1'], componentId: 'c1', status: 'partial',
    })),
    ...overrides.assemblyPartService,
  }
  return { instanceRepo, partRepo, partNumberRepo, changeLogRepo, assemblyPartService }
}

describe('InventoryReservationService.reserve', () => {
  it('rejects a non-positive quantity before touching any repository', async () => {
    const deps = makeFakeDeps()
    const service = new InventoryReservationService(deps)
    await expect(service.reserve({ assemblyPartId: 'part1', instanceId: 'inst9', quantity: 0 }))
      .rejects.toBeInstanceOf(ValidationError)
    expect(deps.instanceRepo.reserveUnits).not.toHaveBeenCalled()
  })

  it('refuses to reserve any more once the part is fully met', async () => {
    const deps = makeFakeDeps({
      partRepo: { findById: vi.fn(async () => ({ id: 'part1', partName: 'Bearing', quantityNeeded: 2, quantityCollected: 2, linkedInstanceIds: [] })) },
    })
    const service = new InventoryReservationService(deps)
    await expect(service.reserve({ assemblyPartId: 'part1', instanceId: 'inst9', quantity: 1 }))
      .rejects.toBeInstanceOf(ConflictError)
    expect(deps.instanceRepo.reserveUnits).not.toHaveBeenCalled()
  })

  it('caps the reserved quantity at the remaining gap, not the requested amount', async () => {
    const deps = makeFakeDeps({
      partRepo: {
        findById: vi.fn(async () => ({ id: 'part1', partName: 'Bearing', quantityNeeded: 4, quantityCollected: 3, componentId: null, linkedInstanceIds: [] })),
      },
    })
    const service = new InventoryReservationService(deps)

    await service.reserve({ assemblyPartId: 'part1', instanceId: 'inst9', quantity: 10 })

    // Only 1 remains (4 - 3), even though 10 was requested.
    expect(deps.instanceRepo.reserveUnits).toHaveBeenCalledWith('inst9', 1, '')
  })

  it('backfills the part number to component link on success', async () => {
    const deps = makeFakeDeps()
    const service = new InventoryReservationService(deps)

    await service.reserve({
      assemblyPartId: 'part1', instanceId: 'inst9', componentId: 'c1', quantity: 1, sourcePartNumber: 'SKU-1',
    })

    expect(deps.partNumberRepo.backfillComponentId).toHaveBeenCalledWith('SKU-1', expect.any(String))
  })
})

describe('InventoryReservationService.unreserve', () => {
  it('flips the instance back to available and drops it from the part', async () => {
    const deps = makeFakeDeps({
      partRepo: {
        findById: vi.fn(async () => ({
          id: 'part1', partName: 'Bearing', quantityNeeded: 4, quantityCollected: 2,
          componentId: 'c1', linkedInstanceIds: ['inst9-fork-1'],
        })),
      },
    })
    const service = new InventoryReservationService(deps)

    await service.unreserve({ assemblyPartId: 'part1', instanceId: 'inst9-fork-1', unlinkedQuantity: 1 })

    expect(deps.instanceRepo.unreserve).toHaveBeenCalledWith('inst9-fork-1', '')
    expect(deps.partRepo.updateReservationFields).toHaveBeenCalledWith('part1', {
      linkedInstanceIds: [],
      componentId: null,   // last linked instance removed -> component cleared
      quantityCollected: 1,
    })
  })
})
