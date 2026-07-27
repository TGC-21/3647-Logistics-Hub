// api/components.js — Vercel serverless function
//
// Migration Plan Phase 1, item 3. Thin, action-dispatched, harness-token
// gated — same convention as the other two routes in this pass. No
// client caller yet (src/db.js's findOrCreateComponent is still what
// main.js, fabDetection.js, and fabricateFlow.js all call directly).
//
// POST /api/components
//   { action: 'findOrCreate',    categoryId, attrs, fallback?, actorId? }
//   { action: 'updateFallback',  componentId, name?, description?, image?, actorId? }

import { applyCors } from './_lib/onshape.js'
import { assertHarnessToken } from './_lib/harnessAuth.js'
import { ComponentService } from '../services/ComponentService.js'
import { statusForError } from '../repositories/errors.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = req.body ?? {}
  const service = new ComponentService()

  try {
    assertHarnessToken(req)

    switch (body.action) {
      case 'findOrCreate': {
        const component = await service.findOrCreate({
          categoryId: body.categoryId,
          attrs:      body.attrs || {},
          fallback:   body.fallback || null,
          actorId:    body.actorId || null,
        })
        return res.status(200).json({ success: true, component })
      }

      case 'updateFallback': {
        const component = await service.updateFallback({
          componentId: body.componentId,
          name:        body.name,
          description: body.description,
          image:       body.image,
          actorId:     body.actorId || null,
        })
        return res.status(200).json({ success: true, component })
      }

      default:
        return res.status(400).json({
          error: `Unknown action "${body.action}" — expected one of: findOrCreate, updateFallback.`,
        })
    }
  } catch (err) {
    console.error('[components]', err)
    return res.status(statusForError(err)).json({ error: err.message ?? 'Internal server error' })
  }
}
