// backend/_lib/__tests__/AssemblyPartService.test.js
//
// Same convention as FabricationJobService.test.js: inject plain fake
// repository objects, never touch Supabase (real or fake) at this
// layer. computePartStatus/derivedAssemblyStatus are also exercised
// directly as pure functions, since they're exported specifically so
// callers don't need a service instance for a three-line calculation.

import { describe, it, expect, vi } from 'vitest'
import {
  AssemblyPartService, computePartStatus, derivedAssemblyStatus,
} from '../../../services/AssemblyPartService.js'
import { ValidationError } from '../../../repositories/errors.js'

describe('computePartStatus (pure)', () => {
  it('is pending when nothing is collected', () => {
    expect(computePartStatus({ quantityCollected: 0, quantityNeeded: 3 })).toBe('pending')
  })
  it('is partial when some but not all is collected', () => {
    expect(computePartStatus({ quantityCollected: 1, quantityNeeded: 3 })).toBe('partial')
  })
  it('is complete once collected meets or exceeds needed', () => {
    expect(computePartStatus({ quantityCollected: 3, quantityNeeded: 3 })).toBe('complete')
    expect(computePartStatus({ quantityCollected: 4, quantityNeeded: 3 })).toBe('complete')
  })
})

describe('derivedAssemblyStatus (pure)', () => {
  it('is draft for an assembly with no parts', () => {
    expect(derivedAssemblyStatus([])).toBe('draft')
  })
  it('is complete only when every part is complete', () => {
    const parts = [{ quantityCollected: 2, quantityNeeded: 2 }, { quantityCollected: 1, quantityNeeded: 1 }]
    expect(derivedAssemblyStatus(parts)).toBe('complete')
  })
  it('is active once any part has partial progress', () => {
    const parts = [{ quantityCollected: 1, quantityNeeded: 2 }, { quantityCollected: 0, quantityNeeded: 1 }]
    expect(derivedAssemblyStatus(parts)).toBe('active')
  })
})

function makeFakeRepos(overrides = {}) {
  const partRepo = {
    findById: vi.fn(async () => ({
      id: 'part1', quantityNeeded: 3, quantityCollected: 1, status: 'partial', linkedInstanceIds: [],
    })),
    updateReservationFields: vi.fn(async (id, patch) => ({ id, quantityNeeded: 3, quantityCollected: 1, ...patch })),
    updateQuantityNeeded: vi.fn(async (id, q) => ({ id, quantityNeeded: q })),
    findForOwner: vi.fn(async () => []),
    ...overrides.partRepo,
  }
  const changeLogRepo = {
    newCommitId: vi.fn(() => 'c_fixed'),
    record: vi.fn(async () => {}),
    ...overrides.changeLogRepo,
  }
  return { partRepo, changeLogRepo }
}

describe('AssemblyPartService.recomputeStatus', () => {
  it('writes the newly-derived status when it changed', async () => {
    const repos = makeFakeRepos({
      partRepo: {
        findById: vi.fn(async () => ({ id: 'part1', quantityNeeded: 2, quantityCollected: 2, status: 'partial' })),
      },
    })
    const service = new AssemblyPartService(repos)

    const result = await service.recomputeStatus({ partId: 'part1' })

    expect(repos.partRepo.updateReservationFields).toHaveBeenCalledWith('part1', { status: 'complete' })
    expect(result.status).toBe('complete')
  })

  it('is a no-op write when status already matches', async () => {
    const repos = makeFakeRepos({
      partRepo: {
        findById: vi.fn(async () => ({ id: 'part1', quantityNeeded: 3, quantityCollected: 1, status: 'partial' })),
      },
    })
    const service = new AssemblyPartService(repos)

    await service.recomputeStatus({ partId: 'part1' })

    expect(repos.partRepo.updateReservationFields).not.toHaveBeenCalled()
  })
})

describe('AssemblyPartService assembly reads', () => {
  it('passes the assembly id from the harness-shaped argument object to the repository', async () => {
    const repos = makeFakeRepos()
    const service = new AssemblyPartService(repos)

    await service.listForAssembly({ assemblyId: 'assembly-0200-c' })

    expect(repos.partRepo.findForOwner).toHaveBeenCalledWith({ assemblyId: 'assembly-0200-c' })
  })

  it('rejects a missing assembly id instead of querying with an object or undefined', async () => {
    const service = new AssemblyPartService(makeFakeRepos())
    await expect(service.listForAssembly({})).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('AssemblyPartService.updateQuantityNeeded', () => {
  it('rejects a non-positive quantity', async () => {
    const service = new AssemblyPartService(makeFakeRepos())
    await expect(service.updateQuantityNeeded({ partId: 'part1', quantityNeeded: 0 }))
      .rejects.toBeInstanceOf(ValidationError)
  })
})
