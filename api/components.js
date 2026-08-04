// api/components.js — Vercel serverless function
//
// Migration Plan Phase 1, item 3 / Phase 2 caller cutover (sixth domain,
// after Categories/Cart/Fabrication Jobs/Inventory Reservation/Assembly
// Parts). Thin, action-dispatched route for ComponentService, extended
// to also cover InventoryInstanceService's write actions
// (createInstance/updateInstance/deleteInstance). Folded into this same
// file rather than a new api/inventory-instances.js — Vercel's 12
// serverless function ceiling has no slack left (see the onshape-bom /
// onshape-detect-fabrication merge into onshape-assembly.js for the
// same reasoning), and "component identity" + "instances of a
// component" are close enough as domains that one action-dispatched
// route covering both isn't a stretch the way merging two unrelated
// domains would be.
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
//   { action: 'createInstance',   categoryId, attrs, fallback?, name, description?, image?, location?, quantity?, tags?, notes?, actorId? }
//   { action: 'updateInstance',   instanceId, categoryId, attrs, fallback?, name, description?, image?, location?, quantity?, tags?, notes?, actorId? }
//   { action: 'deleteInstance',   instanceId, actorId? }

import { applyCors } from './_lib/onshape.js'
import { ComponentService } from '../src/services/ComponentService.js'
import { InventoryInstanceService } from '../src/services/InventoryInstanceService.js'
import { statusForError } from '../src/repositories/errors.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = req.body ?? {}
  const service = new ComponentService()
  const instanceService = new InventoryInstanceService()

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

      case 'createInstance': {
        const instance = await instanceService.createInstance({
          categoryId:  body.categoryId,
          attrs:       body.attrs || {},
          fallback:    body.fallback || null,
          name:        body.name,
          description: body.description || '',
          image:       body.image ?? null,
          location:    body.location || '',
          quantity:    body.quantity ?? 0,
          tags:        body.tags || [],
          notes:       body.notes || '',
          actorId:     body.actorId || null,
        })
        return res.status(200).json({ success: true, instance })
      }

      case 'updateInstance': {
        const instance = await instanceService.updateInstance({
          instanceId:  body.instanceId,
          categoryId:  body.categoryId,
          attrs:       body.attrs || {},
          fallback:    body.fallback || null,
          name:        body.name,
          description: body.description || '',
          image:       body.image ?? null,
          location:    body.location || '',
          quantity:    body.quantity ?? 0,
          tags:        body.tags || [],
          notes:       body.notes || '',
          actorId:     body.actorId || null,
        })
        return res.status(200).json({ success: true, instance })
      }

      case 'deleteInstance': {
        const result = await instanceService.deleteInstance({
          instanceId: body.instanceId,
          actorId:    body.actorId || null,
        })
        return res.status(200).json({ success: true, ...result })
      }

      default:
        return res.status(400).json({
          error: `Unknown action "${body.action}" — expected one of: findOrCreate, updateFallback, deleteIfOrphaned, createInstance, updateInstance, deleteInstance.`,
        })
    }
  } catch (err) {
    console.error('[components]', err)
    return res.status(statusForError(err)).json({ error: err.message ?? 'Internal server error' })
  }
}
