// api/fabrication-detection.js — Vercel serverless function
//
// Migration Plan Phase 1, item 4 / Phase 2 caller cutover (seventh
// domain, after Categories/Cart/Fabrication Jobs/Inventory Reservation/
// Assembly Parts/Components). Thin, action-dispatched route for
// FabricationDetectionService.
//
// AUTH DECISION — same as every other migrated route in this pass (see
// api/categories.js for the full reasoning): now called directly by the
// browser (src/services/fabricationDetectionApi.js, from
// src/designer/fabDetection.js's confirm/ignore flows), so it can no
// longer require the harness-only shared secret. No auth gate, same as
// every other client-facing route. Revisit once Migration Plan Phase 3
// lands.
//
// POST /api/fabrication-detection
//   { action: 'confirm', kind, partId, attrs, quantityRequested, overrides?, actorId? }
//   { action: 'ignore',  partId, actorId? }

import { applyCors } from './_lib/onshape.js'
import { FabricationDetectionService } from '../src/services/FabricationDetectionService.js'
import { statusForError } from '../src/repositories/errors.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = req.body ?? {}
  const service = new FabricationDetectionService()

  try {
    switch (body.action) {
      case 'confirm': {
        const result = await service.confirmDetection({
          kind:               body.kind,
          partId:             body.partId,
          attrs:              body.attrs || {},
          quantityRequested:  body.quantityRequested,
          overrides:          body.overrides ?? null,
          actorId:            body.actorId || null,
        })
        return res.status(200).json({ success: true, ...result })
      }

      case 'ignore': {
        const part = await service.ignoreDetection({ partId: body.partId, actorId: body.actorId || null })
        return res.status(200).json({ success: true, part })
      }

      default:
        return res.status(400).json({
          error: `Unknown action "${body.action}" — expected one of: confirm, ignore.`,
        })
    }
  } catch (err) {
    console.error('[fabrication-detection]', err)
    return res.status(statusForError(err)).json({ error: err.message ?? 'Internal server error' })
  }
}