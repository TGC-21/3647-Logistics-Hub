// services/CartService.js
//
// Phase 1 part 5 of MIGRATION_PLAN.md — "Cart / Part Orders." Mirrors
// FabricationJobService's shape closely, per the plan's own framing:
// cart_items has a similar queued-ish lifecycle (pending → ordered →
// received) to fabrication_jobs (queued → committed → in_progress →
// complete → archived), just without a DB-enforced "one active per
// part" constraint (a part's remaining gap CAN legitimately be split
// across more than one cart item — see resolveCartItemDisplay's doc
// comment in src/db.js) — so this service does NOT invent that
// constraint; it only owns the rules that genuinely exist today,
// scattered across src/partOrders.js's click handlers:
//   - status only ever advances forward, one step at a time
//     (pending → ordered → received), never backward and never past
//     received (handleAdvanceStatus in src/partOrders.js today has no
//     guard against calling it again on an already-received item)
//   - a received item represents a completed purchase and shouldn't be
//     deleted outright — same reasoning fabrication_jobs protects a
//     'complete'/'archived' job from deletion (only 'queued' can be
//     deleted there); cart_items has no such DB-level guard today
//   - findOrCreateCartForVendor / ensurePartNumberStub are pure
//     find-or-create helpers, same shape as db.js's client versions,
//     given a server-side home so a route (or the harness) can call
//     them without going through the browser's anon-key client
//
// No @supabase/supabase-js import, no req/res — same hard rule every
// other service in this codebase follows.

import { CartItemRepository } from '../repositories/CartItemRepository.js'
import { CartRepository } from '../repositories/CartRepository.js'
import { PartNumberRepository } from '../repositories/PartNumberRepository.js'
import { ChangeLogRepository } from '../repositories/ChangeLogRepository.js'
import { ValidationError, ConflictError } from '../repositories/errors.js'

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

const STATUS_ORDER = ['pending', 'ordered', 'received']

export class CartService {
  constructor({
    cartItemRepo   = new CartItemRepository(),
    cartRepo       = new CartRepository(),
    partNumberRepo = new PartNumberRepository(),
    changeLogRepo  = new ChangeLogRepository(),
  } = {}) {
    this.cartItemRepo   = cartItemRepo
    this.cartRepo       = cartRepo
    this.partNumberRepo = partNumberRepo
    this.changeLogRepo  = changeLogRepo
  }

  /**
   * Business rules:
   *   - cartId is required (a cart item never exists without a cart —
   *     mirrors createJob's assemblyPartId requirement)
   *   - quantity must be a positive integer
   * vendorListingId/assemblyPartId are both optional and independent —
   * an ad hoc item (no listing) and a general-restock item (no
   * assembly link) are both legitimate, same as src/partOrders.js's
   * saveItemModal already allows.
   */

  async listCarts() {
    return this.cartRepo.findAll()
  }

  async listItemsForCart({ cartId }) {
    if (!cartId) throw new ValidationError('cartId is required')
    return this.cartItemRepo.findByCartId(cartId)
 }

  async createCartItem({ cartId, vendorListingId = null, assemblyPartId = null, nameOverride = '', linkOverride = '', priceOverride = null, quantity, actorId = null }) {
    if (!cartId) throw new ValidationError('cartId is required')
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ValidationError('quantity must be a positive integer')
    }

    const item = await this.cartItemRepo.insert({
      id: genId(), cartId, vendorListingId, assemblyPartId,
      nameOverride, linkOverride, priceOverride, quantity,
    })

    await this.changeLogRepo.record({
      entityType: 'cart_item', entityId: item.id, action: 'create',
      newValue: item, actorId, commitId: this.changeLogRepo.newCommitId(),
    })

    return item
  }

  /**
   * Advances exactly one step: pending → ordered → received. Refuses
   * to advance an already-received item (there is no step past
   * received) rather than silently no-op'ing — a caller advancing
   * twice by mistake should find out, not have it swallowed.
   */
  async advanceItemStatus({ itemId, actorId = null }) {
    const item = await this.cartItemRepo.findById(itemId)
    if (!item) throw new ValidationError(`Cart item ${itemId} not found`)

    const currentIdx = STATUS_ORDER.indexOf(item.status)
    if (currentIdx === -1 || currentIdx >= STATUS_ORDER.length - 1) {
      throw new ConflictError(`Cart item is already "${item.status}" — nothing further to advance to.`)
    }

    const nextStatus = STATUS_ORDER[currentIdx + 1]
    const updated = await this.cartItemRepo.updateStatus(itemId, nextStatus)

    await this.changeLogRepo.record({
      entityType: 'cart_item', entityId: itemId, action: 'update', field: 'status',
      oldValue: item.status, newValue: nextStatus,
      actorId, commitId: this.changeLogRepo.newCommitId(),
    })

    return updated
  }

  /**
   * A 'received' item is a completed purchase — deleting it would
   * erase the record that it happened, the same reasoning
   * fabrication_jobs' deleteIfQueued only ever allows deleting a
   * 'queued' job. 'pending'/'ordered' items are still just plans and
   * are safe to remove outright.
   */
  async deleteItem({ itemId, actorId = null }) {
    const item = await this.cartItemRepo.findById(itemId)
    if (!item) throw new ValidationError(`Cart item ${itemId} not found`)
    if (item.status === 'received') {
      throw new ConflictError('This item has already been received — it can\'t be deleted outright.')
    }

    const deleted = await this.cartItemRepo.delete(itemId)
    if (!deleted) throw new ConflictError('Could not delete this cart item — it may have already been removed.')

    await this.changeLogRepo.record({
      entityType: 'cart_item', entityId: itemId, action: 'delete',
      oldValue: item, actorId, commitId: this.changeLogRepo.newCommitId(),
    })

    return { deletedItemId: itemId }
  }

  /** Find-or-create the open cart for a vendor — server-side twin of
   *  db.js's findOrCreateCartForVendor, for callers (routes, the
   *  harness) that aren't the browser's anon-key client. */
  async findOrCreateCartForVendor({ vendorId, vendorName, actorId = null }) {
    if (!vendorId) throw new ValidationError('vendorId is required')

    const existing = await this.cartRepo.findOpenForVendor(vendorId)
    if (existing) return existing

    const cart = await this.cartRepo.insert({ id: genId(), name: `${vendorName || 'Vendor'} order`, vendorId })

    await this.changeLogRepo.record({
      entityType: 'cart', entityId: cart.id, action: 'create',
      newValue: cart, actorId, commitId: this.changeLogRepo.newCommitId(),
    })

    return cart
  }

  /** Find-or-create a stub part_numbers row for a raw vendor SKU
   *  string — server-side twin of db.js's ensurePartNumberStub. No
   *  change-log entry, matching the client version's behavior (a stub
   *  row with no component_id yet isn't considered commit-worthy until
   *  it's actually linked to a component). */
  async ensurePartNumberStub({ value }) {
    const trimmed = (value || '').trim()
    if (!trimmed) throw new ValidationError('value is required')

    const existing = await this.partNumberRepo.findByValue(trimmed)
    if (existing) return existing

    return this.partNumberRepo.insert({ id: genId(), value: trimmed })
  }
}
