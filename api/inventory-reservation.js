// api/inventory-reservation.js — Vercel serverless function
//
// Migration Plan Phase 1, item 1. Same shape as api/fabrication-jobs.js:
// thin, action-dispatched, harness-token gated (no client caller yet —
// src/designer/inventoryLink.js still talks to Supabase directly; that
// cutover is Plan Phase 2, done only after this route is exercised).
//
// POST /api/inventory-reservation
//   { action: 'reserve',   assemblyPartId, instanceId, componentId, quantity, location?, sourcePartNumber?, actorId? }
//   { action: 'unreserve', assemblyPartId, instanceId, unlinkedQuantity?, resetLocation?, actorId? }

import { applyCors } from './_lib/onshape.js'
import { assertHarnessToken } from './_lib/harnessAuth.js'
import { InventoryReservationService } from '../services/InventoryReservationService.js'
import { statusForError } from '../repositories/errors.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = req.body ?? {}
  const service = new InventoryReservationService()

  try {
    assertHarnessToken(req)

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
