// backend/routes/assembly-parts.js
//
// Converted from api/assembly-parts.js (Vercel serverless function) to a
// Hono route. Only the wrapper changed — action dispatch, service calls,
// and error handling below are unchanged from the original.
//
// POST /api/assembly-parts
//   { action: 'create',               assemblyId?, assemblyChildId?, partName, partNumber?, quantityNeeded?, notes?, actorId? }
//   { action: 'update',               partId, partName, partNumber?, quantityNeeded, notes?, actorId? }
//   { action: 'delete',               partId, actorId? }
//   { action: 'linkComponent',        partId, componentId, actorId? }
//   { action: 'updateQuantityNeeded', partId, quantityNeeded, actorId? }
//   { action: 'recomputeStatus',      partId, actorId? }
//   { action: 'computeOwnerStatus',   assemblyId }

import { Hono } from 'hono'
import { AssemblyPartService } from '../../src/services/AssemblyPartService.js'
import { statusForError } from '../../src/repositories/errors.js'

const assemblyParts = new Hono()

assemblyParts.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const service = new AssemblyPartService()

  try {
    switch (body.action) {
      case 'create': {
        const part = await service.createPart({
          assemblyId:      body.assemblyId || null,
          assemblyChildId: body.assemblyChildId || null,
          partName:        body.partName,
          partNumber:      body.partNumber || '',
          quantityNeeded:  body.quantityNeeded,
          notes:           body.notes || '',
          actorId:         body.actorId || null,
        })
        return c.json({ success: true, part })
      }

      case 'update': {
        const part = await service.updatePart({
          partId:         body.partId,
          partName:       body.partName,
          partNumber:     body.partNumber || '',
          quantityNeeded: body.quantityNeeded,
          notes:          body.notes || '',
          actorId:        body.actorId || null,
        })
        return c.json({ success: true, part })
      }

      case 'delete': {
        const result = await service.deletePart({ partId: body.partId, actorId: body.actorId || null })
        return c.json({ success: true, ...result })
      }

      case 'linkComponent': {
        const part = await service.linkComponent({
          partId:      body.partId,
          componentId: body.componentId,
          actorId:     body.actorId || null,
        })
        return c.json({ success: true, part })
      }

      case 'updateQuantityNeeded': {
        const part = await service.updateQuantityNeeded({
          partId:         body.partId,
          quantityNeeded: body.quantityNeeded,
          actorId:        body.actorId || null,
        })
        return c.json({ success: true, part })
      }

      case 'recomputeStatus': {
        const part = await service.recomputeStatus({ partId: body.partId, actorId: body.actorId || null })
        return c.json({ success: true, part })
      }

      case 'computeOwnerStatus': {
        const status = await service.computeOwnerStatus({ assemblyId: body.assemblyId })
        return c.json({ success: true, status })
      }

      default:
        return c.json({
          error: `Unknown action "${body.action}" — expected one of: create, update, delete, linkComponent, updateQuantityNeeded, recomputeStatus, computeOwnerStatus.`,
        }, 400)
    }
  } catch (err) {
    console.error('[assembly-parts]', err)
    return c.json({ error: err.message ?? 'Internal server error' }, statusForError(err))
  }
})

export default assemblyParts