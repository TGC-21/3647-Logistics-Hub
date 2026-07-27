// api/fabrication-detection.js — Vercel serverless function
//
// Migration Plan Phase 1, item 4. Thin, action-dispatched, harness-token
// gated — same convention as the other three routes from this pass.
// Replaces (once callers cut over — Phase 2, not this pass) the three
// separate confirm*Detection code paths src/designer/fabDetection.js
// runs today for spacer/axial-shaft/plate.
//
// POST /api/fabrication-detection
//   { action: 'confirm', kind, partId, attrs, quantityRequested, overrides?, actorId? }
//   { action: 'ignore',  partId, actorId? }

import { applyCors } from './_lib/onshape.js'
import { assertHarnessToken } from './_lib/harnessAuth.js'
import { FabricationDetectionService } from '../services/FabricationDetectionService.js'
import { statusForError } from '../repositories/errors.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = req.body ?? {}
  const service = new FabricationDetectionService()

  try {
    assertHarnessToken(req)

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
