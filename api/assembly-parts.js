// api/assembly-parts.js — Vercel serverless function
//
// Migration Plan Phase 1, item 2. Thin, action-dispatched, harness-token
// gated — same convention as api/fabrication-jobs.js and
// api/inventory-reservation.js. No client caller yet.
//
// POST /api/assembly-parts
//   { action: 'updateQuantityNeeded', partId, quantityNeeded, actorId? }
//   { action: 'recomputeStatus',      partId, actorId? }
//   { action: 'computeOwnerStatus',   assemblyId }

import { applyCors } from './_lib/onshape.js'
import { assertHarnessToken } from './_lib/harnessAuth.js'
import { AssemblyPartService } from '../services/AssemblyPartService.js'
import { statusForError } from '../repositories/errors.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = req.body ?? {}
  const service = new AssemblyPartService()

  try {
    assertHarnessToken(req)

    switch (body.action) {
      case 'updateQuantityNeeded': {
        const part = await service.updateQuantityNeeded({
          partId:         body.partId,
          quantityNeeded: body.quantityNeeded,
          actorId:        body.actorId || null,
        })
        return res.status(200).json({ success: true, part })
      }

      case 'recomputeStatus': {
        const part = await service.recomputeStatus({ partId: body.partId, actorId: body.actorId || null })
        return res.status(200).json({ success: true, part })
      }

      case 'computeOwnerStatus': {
        const status = await service.computeOwnerStatus({ assemblyId: body.assemblyId })
        return res.status(200).json({ success: true, status })
      }

      default:
        return res.status(400).json({
          error: `Unknown action "${body.action}" — expected one of: updateQuantityNeeded, recomputeStatus, computeOwnerStatus.`,
        })
    }
  } catch (err) {
    console.error('[assembly-parts]', err)
    return res.status(statusForError(err)).json({ error: err.message ?? 'Internal server error' })
  }
}
