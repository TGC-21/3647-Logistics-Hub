// services/__tests__/AssemblyService.test.js
//
// Same convention as the rest of this migration pass: plain fake
// repositories, no Supabase. Cascade delete is the highest-risk method
// here — these tests exist to prove the ORDER (snapshot before any
// delete, release inventory, clean up pending cart items, delete, THEN
// log) and the change-log shape (one commit, every child/part tagged
// causedByEntityType/causedByEntityId back to the root assembly).

import { describe, it, expect, vi } from 'vitest'
import { AssemblyService } from '../AssemblyService.js'
import { ValidationError } from '../../repositories/errors.js'

function makeFakeRepos(overrides = {}) {
  const assemblyRepo = {
    requireById: vi.fn(async () => ({ id: 'asm1', name: 'Old name', description: '', onshapeUrl: '', status: 'draft' })),
    insert: vi.fn(async ({ id, name, description, onshapeUrl, status }) => ({ id, name, description, onshapeUrl, status })),
    update: vi.fn(async (id, patch) => ({ id, name: 'Old name', description: '', onshapeUrl: '', status: 'draft', ...patch })),
    deleteById: vi.fn(async () => {}),
    ...overrides.assemblyRepo,
  }
  const assemblyChildRepo = {
    findWholeTree: vi.fn(async () => []),
    ...overrides.assemblyChildRepo,
  }
  const assemblyPartRepo = {
    findTreeForAssembly: vi.fn(async () => []),
    ...overrides.assemblyPartRepo,
  }
  const cartItemRepo = {
    deletePendingForAssemblyPartIds: vi.fn(async () => {}),
    ...overrides.cartItemRepo,
  }
  const inventoryInstanceRepo = {
    releaseMany: vi.fn(async () => {}),
    ...overrides.inventoryInstanceRepo,
  }
  const changeLogRepo = {
    newCommitId: vi.fn(() => 'c_fixed'),
    record: vi.fn(async () => {}),
    ...overrides.changeLogRepo,
  }
  return { assemblyRepo, assemblyChildRepo, assemblyPartRepo, cartItemRepo, inventoryInstanceRepo, changeLogRepo }
}

describe('AssemblyService.createAssembly', () => {
  it('rejects a blank name', async () => {
    const repos = makeFakeRepos()
    const service = new AssemblyService(repos)
    await expect(service.createAssembly({ name: '   ' })).rejects.toBeInstanceOf(ValidationError)
    expect(repos.assemblyRepo.insert).not.toHaveBeenCalled()
  })

  it('rejects an invalid status', async () => {
    const repos = makeFakeRepos()
    const service = new AssemblyService(repos)
    await expect(service.createAssembly({ name: 'Drivetrain', status: 'bogus' })).rejects.toBeInstanceOf(ValidationError)
  })

  it('creates the assembly and logs one create entry', async () => {
    const repos = makeFakeRepos()
    const service = new AssemblyService(repos)
    const asm = await service.createAssembly({ name: 'Drivetrain', actorId: 'member1' })
    expect(asm.name).toBe('Drivetrain')
    expect(repos.changeLogRepo.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'create', actorId: 'member1' }))
  })
})

describe('AssemblyService.updateAssembly', () => {
  it('logs only the fields that actually changed', async () => {
    const repos = makeFakeRepos({
      assemblyRepo: {
        requireById: vi.fn(async () => ({ id: 'asm1', name: 'Old', description: 'same', onshapeUrl: '', status: 'draft' })),
        update: vi.fn(async (id, patch) => ({ id, name: patch.name ?? 'Old', description: 'same', onshapeUrl: '', status: patch.status ?? 'draft' })),
      },
    })
    const service = new AssemblyService(repos)

    await service.updateAssembly({ assemblyId: 'asm1', name: 'New', description: 'same', actorId: 'member1' })

    const fieldsLogged = repos.changeLogRepo.record.mock.calls.map(([arg]) => arg.field)
    expect(fieldsLogged).toEqual(['name'])
  })

  it('rejects a blank name on update', async () => {
    const repos = makeFakeRepos()
    const service = new AssemblyService(repos)
    await expect(service.updateAssembly({ assemblyId: 'asm1', name: '   ' })).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('AssemblyService.deleteAssemblyWithCascade', () => {
  it('releases linked inventory, cleans up pending cart items, then deletes, in that order', async () => {
    const repos = makeFakeRepos({
      assemblyPartRepo: {
        findTreeForAssembly: vi.fn(async () => [
          { id: 'part1', linkedInstanceIds: ['inst1', 'inst2'] },
          { id: 'part2', linkedInstanceIds: [] },
        ]),
      },
    })
    const service = new AssemblyService(repos)
    const callOrder = []
    repos.inventoryInstanceRepo.releaseMany.mockImplementation(async () => { callOrder.push('release') })
    repos.cartItemRepo.deletePendingForAssemblyPartIds.mockImplementation(async () => { callOrder.push('cartCleanup') })
    repos.assemblyRepo.deleteById.mockImplementation(async () => { callOrder.push('delete') })

    await service.deleteAssemblyWithCascade({ assemblyId: 'asm1', actorId: 'member1' })

    expect(callOrder).toEqual(['release', 'cartCleanup', 'delete'])
    expect(repos.inventoryInstanceRepo.releaseMany).toHaveBeenCalledWith(['inst1', 'inst2'])
    expect(repos.cartItemRepo.deletePendingForAssemblyPartIds).toHaveBeenCalledWith(['part1', 'part2'])
  })

  it('logs one delete row per child and per part, all tagged back to the root assembly under one commit', async () => {
    const repos = makeFakeRepos({
      assemblyChildRepo: { findWholeTree: vi.fn(async () => [{ id: 'child1' }, { id: 'child2' }]) },
      assemblyPartRepo:  { findTreeForAssembly: vi.fn(async () => [{ id: 'part1', linkedInstanceIds: [] }]) },
    })
    const service = new AssemblyService(repos)

    const result = await service.deleteAssemblyWithCascade({ assemblyId: 'asm1', actorId: 'member1' })

    expect(result).toEqual({ deletedAssemblyId: 'asm1', deletedChildCount: 2, deletedPartCount: 1, commitId: 'c_fixed' })

    const calls = repos.changeLogRepo.record.mock.calls.map(([arg]) => arg)
    expect(calls).toHaveLength(4)   // 1 assembly + 2 children + 1 part
    expect(calls.every(c => c.commitId === 'c_fixed')).toBe(true)
    expect(calls.filter(c => c.entityType === 'assembly_child').every(c => c.causedByEntityType === 'assembly' && c.causedByEntityId === 'asm1')).toBe(true)
    expect(calls.filter(c => c.entityType === 'assembly_part').every(c => c.causedByEntityType === 'assembly' && c.causedByEntityId === 'asm1')).toBe(true)
    expect(calls.find(c => c.entityType === 'assembly').causedByEntityType).toBeUndefined()
  })

  it('does not call inventory release or cart cleanup when there is nothing to release/clean', async () => {
    const repos = makeFakeRepos()
    const service = new AssemblyService(repos)

    await service.deleteAssemblyWithCascade({ assemblyId: 'asm1' })

    expect(repos.inventoryInstanceRepo.releaseMany).not.toHaveBeenCalled()
    expect(repos.cartItemRepo.deletePendingForAssemblyPartIds).not.toHaveBeenCalled()
  })
})
