// repositories/__tests__/CategoryRepository.test.js
//
// Same convention as CartItemRepository.test.js: fake Supabase client,
// assert on mapped local shape and which table/columns were touched.
// Business rules (name-uniqueness, config validation) belong to
// services/__tests__/CategoryService.test.js.

import { describe, it, expect } from 'vitest'
import { CategoryRepository } from '../CategoryRepository.js'
import { createFakeSupabase } from '../../backend/_lib/__tests__/testUtils/fakeSupabase.js'

describe('CategoryRepository', () => {
  it('findAll orders by name', async () => {
    const supabase = createFakeSupabase({ data: [], error: null })
    const repo = new CategoryRepository(supabase)
    await repo.findAll()
    expect(supabase.calledWith({ table: 'categories', method: 'order', args: ['name'] })).toBe(true)
  })

  it('insert derives requiredKeys from requiredKeysConfig rather than trusting a separate list', async () => {
    const supabase = createFakeSupabase({ data: { id: 'cat1', name: 'Plate' }, error: null })
    const repo = new CategoryRepository(supabase)

    await repo.insert({
      id: 'cat1', name: 'Plate',
      requiredKeysConfig: [{ key: 'Material', type: 'enum' }, { key: 'Thickness', type: 'quantity' }],
    })

    expect(supabase.calledWith({
      table: 'categories', method: 'insert',
      args: [{
        id: 'cat1', name: 'Plate',
        required_keys: ['Material', 'Thickness'],
        required_keys_config: [{ key: 'Material', type: 'enum' }, { key: 'Thickness', type: 'quantity' }],
      }],
    })).toBe(true)
  })

  it('update re-derives requiredKeys the same way insert does', async () => {
    const supabase = createFakeSupabase({ data: { id: 'cat1', name: 'Spacer' }, error: null })
    const repo = new CategoryRepository(supabase)

    await repo.update('cat1', { name: 'Spacer', requiredKeysConfig: [{ key: 'OD', type: 'quantity' }] })

    expect(supabase.calledWith({
      table: 'categories', method: 'update',
      args: [{ name: 'Spacer', required_keys: ['OD'], required_keys_config: [{ key: 'OD', type: 'quantity' }] }],
    })).toBe(true)
  })

  it('deleteById issues a plain delete — no cascade logic here (schema handles it via ON DELETE SET NULL)', async () => {
    const supabase = createFakeSupabase({ data: null, error: null })
    const repo = new CategoryRepository(supabase)
    await repo.deleteById('cat1')
    expect(supabase.calledWith({ table: 'categories', method: 'delete' })).toBe(true)
    expect(supabase.calledWith({ table: 'categories', method: 'eq', args: ['id', 'cat1'] })).toBe(true)
  })
})
