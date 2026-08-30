// backend/_lib/__tests__/CategoryRepository.test.js

import { describe, it, expect } from 'vitest'
import { CategoryRepository } from '../../../src/repositories/CategoryRepository.js'
import { createFakeSupabase } from './testUtils/fakeSupabase.js'

describe('CategoryRepository.insert', () => {
  it('derives requiredKeys from requiredKeysConfig rather than trusting a separate list', async () => {
    const supabase = createFakeSupabase({
      data: { id: 'cat1', name: 'Plate', required_keys_config: [{ key: 'Material', type: 'enum' }] },
      error: null,
    })
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
})
