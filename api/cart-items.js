// api/cart-items.js — Vercel serverless function
//
// Phase 1 part 5 of MIGRATION_PLAN.md — thin, action-dispatched route
// for CartService, same convention api/fabrication-jobs.js established
// (see that file's own doc comment): no business rules, no direct
// Supabase table access here, just parse → call one CartService method
// → map the result or a typed error onto an HTTP response.
//
// Gated behind the harness shared secret for the same reason
// api/fabrication-jobs.js is: this route has no client (browser)
// caller yet (src/partOrders.js still talks to Supabase directly via
// db.js) — see MIGRATION_EXAMPLE.md's "known debt" #2. Wiring an actual
// client cutover for this route is a separate, later step
// (MIGRATION_PLAN.md's Phase 2), and needs its own auth decision first,
// same caveat api/fabrication-jobs.js carries.
//
// POST /api/cart-items
//   { action: 'create',            cartId, vendorListingId?, assemblyPartId?, nameOverride?, linkOverride?, priceOverride?, quantity, actorId? }
//   { action: 'advanceStatus',     itemId, actorId? }
//   { action: 'delete',            itemId, actorId? }
//   { action: 'findOrCreateCart',  vendorId, vendorName?, actorId? }
//   { action: 'ensurePartNumber',  value }

import { applyCors } from './_lib/onshape.js'
import { assertHarnessToken } from './_lib/harnessAuth.js'
import { CartService } from '../services/CartService.js'
import { statusForError } from '../repositories/errors.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = req.body ?? {}
  const service = new CartService()

  try {
    assertHarnessToken(req)

    switch (body.action) {
      case 'create': {
        const item = await service.createCartItem({
          cartId:          body.cartId,
          vendorListingId: body.vendorListingId || null,
          assemblyPartId:  body.assemblyPartId || null,
          nameOverride:    body.nameOverride || '',
          linkOverride:    body.linkOverride || '',
          priceOverride:   body.priceOverride ?? null,
          quantity:        body.quantity,
          actorId:         body.actorId || null,
        })
        return res.status(200).json({ success: true, item })
      }

      case 'advanceStatus': {
        const item = await service.advanceItemStatus({
          itemId:  body.itemId,
          actorId: body.actorId || null,
        })
        return res.status(200).json({ success: true, item })
      }

      case 'delete': {
        const result = await service.deleteItem({
          itemId:  body.itemId,
          actorId: body.actorId || null,
        })
        return res.status(200).json({ success: true, ...result })
      }

      case 'findOrCreateCart': {
        const cart = await service.findOrCreateCartForVendor({
          vendorId:   body.vendorId,
          vendorName: body.vendorName || '',
          actorId:    body.actorId || null,
        })
        return res.status(200).json({ success: true, cart })
      }

      case 'ensurePartNumber': {
        const partNumber = await service.ensurePartNumberStub({ value: body.value })
        return res.status(200).json({ success: true, partNumber })
      }

      default:
        return res.status(400).json({
          error: `Unknown action "${body.action}" — expected one of: create, advanceStatus, delete, findOrCreateCart, ensurePartNumber.`,
        })
    }
  } catch (err) {
    console.error('[cart-items]', err)
    return res.status(statusForError(err)).json({ error: err.message ?? 'Internal server error' })
  }
}
