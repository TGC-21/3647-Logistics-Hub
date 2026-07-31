// services/__tests__/CartService.test.js
//
// Same convention as FabricationJobService.test.js: inject plain fake
// repository objects, never a real or fake Supabase client — these
// tests exist to prove CartService's own business rules (status
// transitions, delete guard, find-or-create semantics), independent of
// how any repository stores data.

import { describe, it, expect, vi } from 'vitest'
import { CartService } from '../CartService.js'
import { ValidationError, ConflictError } from '../../repositories/errors.js'

function makeFakeRepos(overrides = {}) {
  const cartItemRepo = {
    findById: vi.fn(async () => null),
    insert: vi.fn(async ({ id, cartId, quantity }) => ({
      id, cartId, vendorListingId: null, assemblyPartId: null,
      nameOverride: '', linkOverride: '', priceOverride: null,
      quantity, status: 'pending', createdAt: new Date().toISOString(),
    })),
    updateStatus: vi.fn(async (id, status) => ({ id, status })),
    delete: vi.fn(async () => true),
    ...overrides.cartItemRepo,
  }
  const cartRepo = {
    findOpenForVendor: vi.fn(async () => null),
    insert: vi.fn(async ({ id, name, vendorId }) => ({ id, name, vendorId, status: 'open', notes: '', createdAt: new Date().toISOString() })),
    ...overrides.cartRepo,
  }
  const partNumberRepo = {
    findByValue: vi.fn(async () => null),
    insert: vi.fn(async ({ id, value }) => ({ id, value, componentId: null, createdAt: new Date().toISOString() })),
    ...overrides.partNumberRepo,
  }
  const changeLogRepo = {
    newCommitId: vi.fn(() => 'c_fixed'),
    record: vi.fn(async () => {}),
    ...overrides.changeLogRepo,
  }
  return { cartItemRepo, cartRepo, partNumberRepo, changeLogRepo }
}

describe('CartService.createCartItem', () => {
  it('rejects a missing cartId', async () => {
    const repos = makeFakeRepos()
    const service = new CartService(repos)
    await expect(service.createCartItem({ cartId: null, quantity: 1 }))
      .rejects.toBeInstanceOf(ValidationError)
    expect(repos.cartItemRepo.insert).not.toHaveBeenCalled()
  })

  it('rejects a non-positive quantity', async () => {
    const repos = makeFakeRepos()
    const service = new CartService(repos)
    await expect(service.createCartItem({ cartId: 'cart1', quantity: 0 }))
      .rejects.toBeInstanceOf(ValidationError)
  })

  it('creates the item and logs one change_log entry', async () => {
    const repos = makeFakeRepos()
    const service = new CartService(repos)
    const item = await service.createCartItem({ cartId: 'cart1', quantity: 2, actorId: 'member1' })
    expect(item.quantity).toBe(2)
    expect(repos.changeLogRepo.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'create', actorId: 'member1' }))
  })
})

describe('CartService.advanceItemStatus', () => {
  it('advances pending -> ordered', async () => {
    const repos = makeFakeRepos({
      cartItemRepo: { findById: vi.fn(async () => ({ id: 'item1', status: 'pending' })) },
    })
    const service = new CartService(repos)
    await service.advanceItemStatus({ itemId: 'item1' })
    expect(repos.cartItemRepo.updateStatus).toHaveBeenCalledWith('item1', 'ordered')
  })

  it('refuses to advance past received', async () => {
    const repos = makeFakeRepos({
      cartItemRepo: { findById: vi.fn(async () => ({ id: 'item1', status: 'received' })) },
    })
    const service = new CartService(repos)
    await expect(service.advanceItemStatus({ itemId: 'item1' })).rejects.toBeInstanceOf(ConflictError)
    expect(repos.cartItemRepo.updateStatus).not.toHaveBeenCalled()
  })
})

describe('CartService.deleteItem', () => {
  it('refuses to delete a received item', async () => {
    const repos = makeFakeRepos({
      cartItemRepo: { findById: vi.fn(async () => ({ id: 'item1', status: 'received' })) },
    })
    const service = new CartService(repos)
    await expect(service.deleteItem({ itemId: 'item1' })).rejects.toBeInstanceOf(ConflictError)
    expect(repos.cartItemRepo.delete).not.toHaveBeenCalled()
  })

  it('deletes a pending item and logs it', async () => {
    const repos = makeFakeRepos({
      cartItemRepo: { findById: vi.fn(async () => ({ id: 'item1', status: 'pending' })) },
    })
    const service = new CartService(repos)
    const result = await service.deleteItem({ itemId: 'item1', actorId: 'member1' })
    expect(result.deletedItemId).toBe('item1')
    expect(repos.changeLogRepo.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'delete' }))
  })
})

describe('CartService.findOrCreateCartForVendor', () => {
  it('returns the existing open cart without creating a new one', async () => {
    const repos = makeFakeRepos({
      cartRepo: { findOpenForVendor: vi.fn(async () => ({ id: 'cart1', vendorId: 'v1' })) },
    })
    const service = new CartService(repos)
    const cart = await service.findOrCreateCartForVendor({ vendorId: 'v1', vendorName: 'McMaster' })
    expect(cart.id).toBe('cart1')
    expect(repos.cartRepo.insert).not.toHaveBeenCalled()
  })

  it('creates a new cart when none is open', async () => {
    const repos = makeFakeRepos()
    const service = new CartService(repos)
    const cart = await service.findOrCreateCartForVendor({ vendorId: 'v1', vendorName: 'McMaster' })
    expect(repos.cartRepo.insert).toHaveBeenCalledTimes(1)
    expect(cart.name).toBe('McMaster order')
  })
})

describe('CartService.ensurePartNumberStub', () => {
  it('rejects an empty value', async () => {
    const repos = makeFakeRepos()
    const service = new CartService(repos)
    await expect(service.ensurePartNumberStub({ value: '  ' })).rejects.toBeInstanceOf(ValidationError)
  })

  it('finds an existing part number instead of inserting a duplicate', async () => {
    const repos = makeFakeRepos({
      partNumberRepo: { findByValue: vi.fn(async () => ({ id: 'pn1', value: 'MCM-123' })) },
    })
    const service = new CartService(repos)
    const pn = await service.ensurePartNumberStub({ value: 'MCM-123' })
    expect(pn.id).toBe('pn1')
    expect(repos.partNumberRepo.insert).not.toHaveBeenCalled()
  })
})
