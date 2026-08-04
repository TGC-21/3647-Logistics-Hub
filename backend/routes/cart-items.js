// backend/routes/cart-items.js — converted from api/cart-items.js
//
// POST /api/cart-items
//   { action: 'create',            cartId, vendorListingId?, assemblyPartId?, nameOverride?, linkOverride?, priceOverride?, quantity, actorId? }
//   { action: 'advanceStatus',     itemId, actorId? }
//   { action: 'delete',            itemId, actorId? }
//   { action: 'findOrCreateCart',  vendorId, vendorName?, actorId? }
//   { action: 'ensurePartNumber',  value }

import { Hono } from 'hono'
import { CartService } from '../../src/services/CartService.js'
import { statusForError } from '../../src/repositories/errors.js'

const cartItems = new Hono()

cartItems.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const service = new CartService()

  try {
    switch (body.action) {
      case 'create': {
        const item = await service.createCartItem({
          cartId: body.cartId,
          vendorListingId: body.vendorListingId || null,
          assemblyPartId: body.assemblyPartId || null,
          nameOverride: body.nameOverride || '',
          linkOverride: body.linkOverride || '',
          priceOverride: body.priceOverride ?? null,
          quantity: body.quantity,
          actorId: body.actorId || null,
        })
        return c.json({ success: true, item })
      }
      case 'advanceStatus': {
        const item = await service.advanceItemStatus({ itemId: body.itemId, actorId: body.actorId || null })
        return c.json({ success: true, item })
      }
      case 'delete': {
        const result = await service.deleteItem({ itemId: body.itemId, actorId: body.actorId || null })
        return c.json({ success: true, ...result })
      }
      case 'findOrCreateCart': {
        const cart = await service.findOrCreateCartForVendor({
          vendorId: body.vendorId,
          vendorName: body.vendorName || '',
          actorId: body.actorId || null,
        })
        return c.json({ success: true, cart })
      }
      case 'ensurePartNumber': {
        const partNumber = await service.ensurePartNumberStub({ value: body.value })
        return c.json({ success: true, partNumber })
      }
      default:
        return c.json({
          error: `Unknown action "${body.action}" — expected one of: create, advanceStatus, delete, findOrCreateCart, ensurePartNumber.`,
        }, 400)
    }
  } catch (err) {
    console.error('[cart-items]', err)
    return c.json({ error: err.message ?? 'Internal server error' }, statusForError(err))
  }
})

export default cartItems