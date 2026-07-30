// api/inventory-reservation.js — Vercel serverless function
//
// Migration Plan Phase 1, item 1 / Phase 2 caller cutover (fourth
// domain, after Categories/Cart/Fabrication Jobs). Thin, action-dispatched
// route for InventoryReservationService.
//
// AUTH DECISION — same one every migrated route in this pass has made
// (see api/categories.js's own comment for the full reasoning): this
// route is now called directly by the browser
// (src/services/inventoryReservationApi.js, from
// src/designer/inventoryLink.js), so it can no longer require the
// harness-only shared secret — a browser has no safe way to hold it.
// It runs with NO auth gate, same as every other client-facing route.
// Partshelf has no real per-member auth boundary yet, so gating this
// one route more tightly than the rest of the app would be a false
// sense of security. Revisit once Migration Plan Phase 3 lands.
//
// POST /api/inventory-reservation
//   { action: 'reserve',   assemblyPartId, instanceId, componentId, quantity, location?, sourcePartNumber?, actorId? }
//   { action: 'unreserve', assemblyPartId, instanceId, unlinkedQuantity?, resetLocation?, actorId? }

import { applyCors } from './_lib/onshape.js'
import { InventoryReservationService } from '../src/services/InventoryReservationService.js'
import { statusForError } from '../src/repositories/errors.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = req.body ?? {}
  const service = new InventoryReservationService()

  try {
    switch (body.action) {
      case 'reserve': {
        const result = await service.reserve({
          assemblyPartId:    body.assemblyPartId,
          instanceId:        body.instanceId,
          componentId:       body.componentId || null,
          quantity:          body.quantity,
          location:          body.location || '',
          sourcePartNumber:  body.sourcePartNumber || null,
          actorId:           body.actorId || null,
        })
        return res.status(200).json({ success: true, ...result })
      }

      case 'unreserve': {
        const part = await service.unreserve({
          assemblyPartId:   body.assemblyPartId,
          instanceId:       body.instanceId,
          unlinkedQuantity: body.unlinkedQuantity || 1,
          resetLocation:    body.resetLocation ?? '',
          actorId:          body.actorId || null,
        })
        return res.status(200).json({ success: true, part })
      }

      default:
        return res.status(400).json({
          error: `Unknown action "${body.action}" — expected one of: reserve, unreserve.`,
        })
    }
  } catch (err) {
    console.error('[inventory-reservation]', err)
    return res.status(statusForError(err)).json({ error: err.message ?? 'Internal server error' })
  }
}
