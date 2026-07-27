// api/_lib/__tests__/ComponentService.test.js
//
// Fake repositories, same convention as the other service tests. The
// rule under test: findOrCreate must return an EXISTING component when
// one already matches the (categoryId, attrs) signature, and must only
// insert when nothing matches — this is the whole point of the
// component-identity abstraction (README.md: "a component is identified
// by its attributes and category, NOT by name").

import { describe, it, expect, vi } from 'vitest'
import { ComponentService } from '../../../services/ComponentService.js'
import { ValidationError } from '../../../repositories/errors.js'

const CATEGORY = {
  id: 'cat1',
  requiredKeysConfig: [
    { key: 'OD', type: 'quantity', defaultUnit: 'in' },
    { key: 'Length', type: 'quantity', defaultUnit: 'in' },
  ],
}

function makeFakeRepos(overrides = {}) {
  const componentRepo = {
    findByCategory: vi.fn(async () => []),
    insert: vi.fn(async ({ id, categoryId, attributes }) => ({
      id, categoryId, attributes, fallbackName: '', fallbackDescription: '', fallbackImage: null,
    })),
    findById: vi.fn(async () => null),
    ...overrides.componentRepo,
  }
  const categoryRepo = { findById: vi.fn(async () => CATEGORY), ...overrides.categoryRepo }
  const changeLogRepo = { newCommitId: vi.fn(() => 'c_fixed'), record: vi.fn(async () => {}), ...overrides.changeLogRepo }
  return { componentRepo, categoryRepo, changeLogRepo }
}

describe('ComponentService.findOrCreate', () => {
  it('requires a categoryId', async () => {
    const service = new ComponentService(makeFakeRepos())
    await expect(service.findOrCreate({ attrs: {} })).rejects.toBeInstanceOf(ValidationError)
  })

  it('returns an existing component when attributes match by signature, ignoring key order', async () => {
    const existing = {
      id: 'comp1', categoryId: 'cat1',
      attributes: [{ key: 'Length', value: '1.25' }, { key: 'OD', value: '0.375' }],
    }
    const repos = makeFakeRepos({ componentRepo: { findByCategory: vi.fn(async () => [existing]) } })
    const service = new ComponentService(repos)

    const result = await service.findOrCreate({ categoryId: 'cat1', attrs: { OD: '0.375', Length: '1.25' } })

    expect(result.id).toBe('comp1')
    expect(repos.componentRepo.insert).not.toHaveBeenCalled()
  })

  it('creates a new component when nothing matches, and logs it', async () => {
    const repos = makeFakeRepos()
    const service = new ComponentService(repos)

    const result = await service.findOrCreate({
      categoryId: 'cat1', attrs: { OD: '0.5', Length: '2' }, fallback: { name: 'Spacer', description: '', image: null },
    })

    expect(repos.componentRepo.insert).toHaveBeenCalledTimes(1)
    expect(result.categoryId).toBe('cat1')
    expect(repos.changeLogRepo.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'create' }))
  })

  it('does not treat a near-miss dimension as a match', async () => {
    const existing = { id: 'comp1', categoryId: 'cat1', attributes: [{ key: 'OD', value: '0.375' }, { key: 'Length', value: '1.25' }] }
    const repos = makeFakeRepos({ componentRepo: { findByCategory: vi.fn(async () => [existing]) } })
    const service = new ComponentService(repos)

    const result = await service.findOrCreate({ categoryId: 'cat1', attrs: { OD: '0.375', Length: '1.5' } })

    expect(repos.componentRepo.insert).toHaveBeenCalledTimes(1)
    expect(result.id).not.toBe('comp1')
  })
})

describe('ComponentService.deleteIfOrphaned', () => {
  it('does not delete when instances still reference the component', async () => {
    const repos = makeFakeRepos()
    const service = new ComponentService(repos)
    const deleted = await service.deleteIfOrphaned({ componentId: 'comp1', instanceCount: 2 })
    expect(deleted).toBe(false)
  })
})
