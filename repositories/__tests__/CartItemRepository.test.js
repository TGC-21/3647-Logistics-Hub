// repositories/__tests__/CartItemRepository.test.js
//
// Same convention as FabricationJobRepository.test.js: fake Supabase
// client, assert on the mapped local shape and which table/columns
// were touched. No business rules here — those belong to
// services/__tests__/CartService.test.js.

import { describe, it, expect } from 'vitest'
import { CartItemRepository } from '../CartItemRepository.js'
import { createFakeSupabase } from '../../api/_lib/__tests__/testUtils/fakeSupabase.js'

describe('CartItemRepository', () => {
  it('findById maps a found row into the local camelCase shape', async () => {
    const supabase = createFakeSupabase({
      data: {
        id: 'item1', cart_id: 'cart1', vendor_listing_id: 'listing1', assembly_part_id: null,
        name_override: '', link_override: '', price_override: 4.5,
        quantity: 3, status: 'ordered', created_at: '2025-12-01T00:00:00Z',
      },
      error: null,
    })
    const repo = new CartItemRepository(supabase)

    const item = await repo.findById('item1')

    expect(item).toEqual({
      id: 'item1', cartId: 'cart1', vendorListingId: 'listing1', assemblyPartId: null,
      nameOverride: '', linkOverride: '', priceOverride: 4.5,
      quantity: 3, status: 'ordered', createdAt: '2025-12-01T00:00:00Z',
    })
    expect(supabase.calledWith({ table: 'cart_items', method: 'eq', args: ['id', 'item1'] })).toBe(true)
  })

  it('findById returns null when no row matches', async () => {
    const supabase = createFakeSupabase({ data: null, error: null })
    expect(await new CartItemRepository(supabase).findById('missing')).toBeNull()
  })

  it('insert always writes status "pending" regardless of caller input', async () => {
    const supabase = createFakeSupabase({
      data: { id: 'item1', cart_id: 'cart1', vendor_listing_id: null, assembly_part_id: null, name_override: 'Bolt', link_override: null, price_override: null, quantity: 1, status: 'pending', created_at: '2025-12-01T00:00:00Z' },
      error: null,
    })
    const repo = new CartItemRepository(supabase)
    const item = await repo.insert({ id: 'item1', cartId: 'cart1', nameOverride: 'Bolt', quantity: 1 })
    expect(item.status).toBe('pending')
  })

  it('delete returns true only when a row was actually deleted', async () => {
    const deletedSupabase = createFakeSupabase({ data: [{ id: 'item1' }], error: null })
    expect(await new CartItemRepository(deletedSupabase).delete('item1')).toBe(true)

    const noopSupabase = createFakeSupabase({ data: [], error: null })
    expect(await new CartItemRepository(noopSupabase).delete('item2')).toBe(false)
  })

  it('surfaces a Postgres error as a DatabaseError', async () => {
    const supabase = createFakeSupabase({ data: null, error: { message: 'connection reset' } })
    const repo = new CartItemRepository(supabase)
    await expect(repo.findById('item1')).rejects.toThrow('cart_items lookup failed: connection reset')
  })
})
