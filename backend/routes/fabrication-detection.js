// backend/routes/fabrication-detection.js — converted from api/fabrication-detection.js
//
// POST /api/fabrication-detection
//   { action: 'confirm', kind, partId, attrs, quantityRequested, overrides?, actorId? }
//   { action: 'ignore',  partId, actorId? }

import { Hono } from 'hono'
import { FabricationDetectionService } from '../../src/services/FabricationDetectionService.js'
import { statusForError } from '../../src/repositories/errors.js'

const fabricationDetection = new Hono()

fabricationDetection.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const service = new FabricationDetectionService()

  try {
    switch (body.action) {
      case 'confirm': {
        const result = await service.confirmDetection({
          kind: body.kind,
          partId: body.partId,
          attrs: body.attrs || {},
          quantityRequested: body.quantityRequested,
          overrides: body.overrides ?? null,
          actorId: body.actorId || null,
        })
        return c.json({ success: true, ...result })
      }
      case 'ignore': {
        const part = await service.ignoreDetection({ partId: body.partId, actorId: body.actorId || null })
        return c.json({ success: true, part })
      }
      default:
        return c.json({ error: `Unknown action "${body.action}" — expected one of: confirm, ignore.` }, 400)
    }
  } catch (err) {
    console.error('[fabrication-detection]', err)
    return c.json({ error: err.message ?? 'Internal server error' }, statusForError(err))
  }
})

export default fabricationDetection