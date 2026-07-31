// api/components.js — Vercel serverless function
//
// Migration Plan Phase 1, item 3 / Phase 2 caller cutover (sixth domain,
// after Categories/Cart/Fabrication Jobs/Inventory Reservation/Assembly
// Parts). Thin, action-dispatched route for ComponentService.
//
// AUTH DECISION — same as every other migrated route in this pass (see
// api/categories.js for the full reasoning): now called directly by the
// browser (src/services/componentsApi.js, from src/main.js,
// src/designer/fabDetection.js, and src/designer/fabricateFlow.js), so
// it can no longer require the harness-only shared secret. No auth
// gate, same as every other client-facing route. Revisit once
// Migration Plan Phase 3 lands.
//
// POST /api/components
//   { action: 'findOrCreate',     categoryId, attrs, fallback?, actorId? }
//   { action: 'updateFallback',   componentId, name?, description?, image?, actorId? }
//   { action: 'deleteIfOrphaned', componentId, instanceCount, actorId? }

import { applyCors } from './_lib/onshape.js'
import { ComponentService } from '../src/services/ComponentService.js'
import { statusForError } from '../src/repositories/errors.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = req.body ?? {}
  const service = new ComponentService()

  try {
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

      case 'deleteIfOrphaned': {
        const deleted = await service.deleteIfOrphaned({
          componentId:   body.componentId,
          instanceCount: body.instanceCount,
          actorId:       body.actorId || null,
        })
        return res.status(200).json({ success: true, deleted })
      }

      default:
        return res.status(400).json({
          error: `Unknown action "${body.action}" — expected one of: findOrCreate, updateFallback, deleteIfOrphaned.`,
        })
    }
  } catch (err) {
    console.error('[components]', err)
    return res.status(statusForError(err)).json({ error: err.message ?? 'Internal server error' })
  }
}
