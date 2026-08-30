// backend/_lib/__tests__/InventoryInstanceRepository.test.js

import { describe, it, expect } from 'vitest'
import { InventoryInstanceRepository } from '../../../src/repositories/InventoryInstanceRepository.js'
import { createFakeSupabase } from './testUtils/fakeSupabase.js'

describe('InventoryInstanceRepository', () => {
  it('reserveUnits calls the reserve_inventory_units RPC, not a raw update', async () => {
    const supabase = createFakeSupabase({
      data: { id: 'inst1-fork-abc', component_id: 'c1', location: 'Bin A', quantity: 2, status: 'in_assembly' },
      error: null,
    })
    const repo = new InventoryInstanceRepository(supabase)

    const fork = await repo.reserveUnits('inst1', 2, 'Bin A')

    expect(fork.id).toBe('inst1-fork-abc')
    expect(fork.status).toBe('in_assembly')
    expect(supabase.calledWith({
      table: null, method: 'rpc',
      args: ['reserve_inventory_units', { p_instance_id: 'inst1', p_quantity: 2, p_location: 'Bin A' }],
    })).toBe(true)
  })

  it('unreserve flips status back to available', async () => {
    const supabase = createFakeSupabase({ data: { id: 'inst1', status: 'available' }, error: null })
    const repo = new InventoryInstanceRepository(supabase)

    const result = await repo.unreserve('inst1')

    expect(result.status).toBe('available')
    expect(supabase.calledWith({ table: 'inventory_instances', method: 'update' })).toBe(true)
  })

  it('findAvailableForComponent filters by status=available', async () => {
    const supabase = createFakeSupabase({ data: [], error: null })
    const repo = new InventoryInstanceRepository(supabase)

    await repo.findAvailableForComponent('c1')

    expect(supabase.calledWith({ table: 'inventory_instances', method: 'eq', args: ['status', 'available'] })).toBe(true)
  })

  it('surfaces a Postgres error as a DatabaseError', async () => {
    const supabase = createFakeSupabase({ data: null, error: { message: 'boom' } })
    const repo = new InventoryInstanceRepository(supabase)
    await expect(repo.findById('x')).rejects.toThrow('inventory_instances lookup failed: boom')
  })
})
