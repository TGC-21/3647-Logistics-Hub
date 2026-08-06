// backend/routes/inventory-reservation.js — converted from api/inventory-reservation.js
//
// POST /api/inventory-reservation
//   { action: 'reserve',   assemblyPartId, instanceId, componentId, quantity, location?, sourcePartNumber?, actorId? }
//   { action: 'unreserve', assemblyPartId, instanceId, unlinkedQuantity?, resetLocation?, actorId? }

import { Hono } from 'hono'
import { InventoryReservationService } from '../../src/services/InventoryReservationService.js'
import { statusForError } from '../../src/repositories/errors.js'

const inventoryReservation = new Hono()

inventoryReservation.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const service = new InventoryReservationService()

  try {
    switch (body.action) {
      case 'reserve': {
        const result = await service.reserve({
          assemblyPartId: body.assemblyPartId,
          instanceId: body.instanceId,
          componentId: body.componentId || null,
          quantity: body.quantity,
          location: body.location || '',
          sourcePartNumber: body.sourcePartNumber || null,
          actorId: body.actorId || null,
        })
        return c.json({ success: true, ...result })
      }
      case 'unreserve': {
        const part = await service.unreserve({
          assemblyPartId: body.assemblyPartId,
          instanceId: body.instanceId,
          unlinkedQuantity: body.unlinkedQuantity || 1,
          resetLocation: body.resetLocation ?? '',
          actorId: body.actorId || null,
        })
        return c.json({ success: true, part })
      }

      case 'quickCollect': {
        const result = await service.quickCollect({
          assemblyPartId: body.assemblyPartId,
          quantity:       body.quantity || 1,
          actorId:        body.actorId || null,
        })
        return c.json({ success: true, ...result })
      }
      default:
        return c.json({ error: `Unknown action "${body.action}" — expected one of: reserve, unreserve, quickCollect.` }, 400)
    }
  } catch (err) {
    console.error('[inventory-reservation]', err)
    return c.json({ error: err.message ?? 'Internal server error' }, statusForError(err))
  }
})

export default inventoryReservation