// services/__tests__/CategoryService.test.js
//
// Same convention as the rest of this pass: pure functions tested
// directly with no mocking at all, and the CategoryService class tested
// against plain fake repository objects — never Supabase, real or fake.

import { describe, it, expect, vi } from 'vitest'
import {
  CategoryService, validateAttribute, validateRequiredAttributes,
  migrateRequiredKeysIfNeeded, formatAttribute,
} from '../CategoryService.js'
import { ValidationError, ConflictError } from '../../repositories/errors.js'

describe('validateAttribute (pure)', () => {
  it('accepts any non-empty string for a string type', () => {
    expect(validateAttribute('Aluminum', { type: 'string' })).toEqual({ valid: true })
  })

  it('requires a number for quantity', () => {
    expect(validateAttribute('abc', { type: 'quantity' }).valid).toBe(false)
    expect(validateAttribute('0.375', { type: 'quantity' }).valid).toBe(true)
    expect(validateAttribute('0.375 in', { type: 'quantity' }).valid).toBe(true)   // leading numeric match
  })

  it('requires membership in options for enum', () => {
    const config = { type: 'enum', options: ['ROUND', 'HEX'] }
    expect(validateAttribute('ROUND', config).valid).toBe(true)
    expect(validateAttribute('SQUARE', config).valid).toBe(false)
  })

  it('validates segment structure for the segments type', () => {
    const config = { type: 'segments' }
    expect(validateAttribute(null, config).valid).toBe(false)
    expect(validateAttribute({ segments: [] }, config).valid).toBe(false)
    expect(validateAttribute({ segments: [{ type: 'round', length: 1, diameter: 0.5 }] }, config).valid).toBe(true)
    expect(validateAttribute({ segments: [{ type: 'round', length: 1, diameter: -1 }] }, config).valid).toBe(false)
    expect(validateAttribute({ segments: [{ type: 'unknown', length: 1 }] }, config).valid).toBe(false)
  })

  it('passes through when no config is given', () => {
    expect(validateAttribute('anything', null)).toEqual({ valid: true })
  })
})

describe('validateRequiredAttributes (pure)', () => {
  const config = [
    { key: 'OD', type: 'quantity' },
    { key: 'Spacer Type', type: 'enum', options: ['ROUND', 'HEX'] },
  ]

  it('flags missing required keys', () => {
    const result = validateRequiredAttributes([], config)
    expect(result.valid).toBe(false)
    expect(result.errors.OD).toBe('Required')
    expect(result.errors['Spacer Type']).toBe('Required')
  })

  it('passes when every required key is present and valid', () => {
    const attrs = [{ key: 'OD', value: '0.375' }, { key: 'Spacer Type', value: 'ROUND' }]
    expect(validateRequiredAttributes(attrs, config)).toEqual({ valid: true, errors: {} })
  })

  it('is trivially valid when the category has no required keys', () => {
    expect(validateRequiredAttributes([], [])).toEqual({ valid: true, errors: {} })
  })
})

describe('migrateRequiredKeysIfNeeded (pure)', () => {
  it('backfills a string-typed config from a legacy plain requiredKeys list', () => {
    const cat = { id: 'c1', requiredKeys: ['Material', 'Thickness'], requiredKeysConfig: [] }
    const migrated = migrateRequiredKeysIfNeeded(cat)
    expect(migrated.requiredKeysConfig).toEqual([
      { key: 'Material', type: 'string', options: [], defaultUnit: '' },
      { key: 'Thickness', type: 'string', options: [], defaultUnit: '' },
    ])
  })

  it('is a no-op once requiredKeysConfig already exists', () => {
    const cat = { requiredKeys: ['X'], requiredKeysConfig: [{ key: 'Y', type: 'quantity' }] }
    expect(migrateRequiredKeysIfNeeded(cat).requiredKeysConfig).toEqual([{ key: 'Y', type: 'quantity' }])
  })
})

describe('formatAttribute (pure)', () => {
  it('appends the default unit to a bare quantity value', () => {
    expect(formatAttribute('5', { type: 'quantity', defaultUnit: 'g' })).toBe('5 g')
  })
  it('leaves a value with a unit already present alone', () => {
    expect(formatAttribute('5 g', { type: 'quantity', defaultUnit: 'g' })).toBe('5 g')
  })
  it('summarizes a segments value', () => {
    const value = { totalLength: 2, segments: [{ length: 1 }, { length: 1 }] }
    expect(formatAttribute(value, { type: 'segments', segmentUnit: 'in' })).toBe('2 segments, 2.00in total')
  })
})

function makeFakeRepos(overrides = {}) {
  const categoryRepo = {
    findAll: vi.fn(async () => []),
    findById: vi.fn(async () => ({ id: 'cat1', name: 'Spacer', requiredKeys: [], requiredKeysConfig: [] })),
    findByName: vi.fn(async () => null),
    insert: vi.fn(async ({ id, name, requiredKeysConfig }) => ({ id, name, requiredKeysConfig })),
    update: vi.fn(async (id, { name, requiredKeysConfig }) => ({ id, name, requiredKeysConfig })),
    deleteById: vi.fn(async () => {}),
    ...overrides.categoryRepo,
  }
  const changeLogRepo = { newCommitId: vi.fn(() => 'c_fixed'), record: vi.fn(async () => {}), ...overrides.changeLogRepo }
  return { categoryRepo, changeLogRepo }
}

describe('CategoryService.create', () => {
  it('requires a name', async () => {
    const service = new CategoryService(makeFakeRepos())
    await expect(service.create({ name: '' })).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects a duplicate name', async () => {
    const repos = makeFakeRepos({ categoryRepo: { findByName: vi.fn(async () => ({ id: 'existing' })) } })
    const service = new CategoryService(repos)
    await expect(service.create({ name: 'Spacer' })).rejects.toBeInstanceOf(ConflictError)
    expect(repos.categoryRepo.insert).not.toHaveBeenCalled()
  })

  it('rejects a requiredKeysConfig entry with an unknown type', async () => {
    const service = new CategoryService(makeFakeRepos())
    await expect(service.create({ name: 'Widget', requiredKeysConfig: [{ key: 'X', type: 'bogus' }] }))
      .rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects a requiredKeysConfig entry with a blank key', async () => {
    const service = new CategoryService(makeFakeRepos())
    await expect(service.create({ name: 'Widget', requiredKeysConfig: [{ key: '  ', type: 'string' }] }))
      .rejects.toBeInstanceOf(ValidationError)
  })

  it('creates and logs the category when everything checks out', async () => {
    const repos = makeFakeRepos()
    const service = new CategoryService(repos)
    const cat = await service.create({ name: 'Widget', requiredKeysConfig: [{ key: 'Size', type: 'string' }], actorId: 'member1' })
    expect(cat.name).toBe('Widget')
    expect(repos.changeLogRepo.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'create', actorId: 'member1' }))
  })
})

describe('CategoryService.update', () => {
  it('logs a field-level diff only for fields that actually changed', async () => {
    const repos = makeFakeRepos({
      categoryRepo: {
        findById: vi.fn(async () => ({ id: 'cat1', name: 'Spacer', requiredKeysConfig: [{ key: 'OD', type: 'quantity' }] })),
        update: vi.fn(async (id, { name, requiredKeysConfig }) => ({ id, name, requiredKeysConfig })),
      },
    })
    const service = new CategoryService(repos)

    // Same requiredKeysConfig, only the name changes.
    await service.update({ id: 'cat1', name: 'Spacers', requiredKeysConfig: [{ key: 'OD', type: 'quantity' }] })

    const fieldsLogged = repos.changeLogRepo.record.mock.calls.map(([arg]) => arg.field)
    expect(fieldsLogged).toEqual(['name'])
  })
})

describe('CategoryService.delete', () => {
  it('deletes and logs, trusting the schema to un-categorize components', async () => {
    const repos = makeFakeRepos()
    const service = new CategoryService(repos)
    const result = await service.delete({ id: 'cat1' })
    expect(repos.categoryRepo.deleteById).toHaveBeenCalledWith('cat1')
    expect(result).toEqual({ deletedCategoryId: 'cat1' })
  })
})
