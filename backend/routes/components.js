// backend/routes/components.js — converted from api/components.js
// Covers ComponentService + InventoryInstanceService's write actions
// (same file split the original Vercel function used).
//
// POST /api/components
//   { action: 'findOrCreate',     categoryId, attrs, fallback?, actorId? }
//   { action: 'updateFallback',   componentId, name?, description?, image?, actorId? }
//   { action: 'deleteIfOrphaned', componentId, instanceCount, actorId? }
//   { action: 'createInstance',   categoryId, attrs, fallback?, name, description?, image?, location?, quantity?, tags?, notes?, actorId? }
//   { action: 'updateInstance',   instanceId, categoryId, attrs, fallback?, name, description?, image?, location?, quantity?, tags?, notes?, actorId? }
//   { action: 'deleteInstance',   instanceId, actorId? }

import { Hono } from 'hono'
import { ComponentService } from '../../src/services/ComponentService.js'
import { InventoryInstanceService } from '../../src/services/InventoryInstanceService.js'
import { statusForError } from '../../src/repositories/errors.js'

const components = new Hono()

components.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const service = new ComponentService()
  const instanceService = new InventoryInstanceService()

  try {
    switch (body.action) {
      case 'findOrCreate': {
        const component = await service.findOrCreate({
          categoryId: body.categoryId,
          attrs: body.attrs || {},
          fallback: body.fallback || null,
          actorId: body.actorId || null,
        })
        return c.json({ success: true, component })
      }
      case 'updateFallback': {
        const component = await service.updateFallback({
          componentId: body.componentId,
          name: body.name,
          description: body.description,
          image: body.image,
          actorId: body.actorId || null,
        })
        return c.json({ success: true, component })
      }
      case 'deleteIfOrphaned': {
        const deleted = await service.deleteIfOrphaned({
          componentId: body.componentId,
          instanceCount: body.instanceCount,
          actorId: body.actorId || null,
        })
        return c.json({ success: true, deleted })
      }
      case 'createInstance': {
        const instance = await instanceService.createInstance({
          categoryId: body.categoryId,
          attrs: body.attrs || {},
          fallback: body.fallback || null,
          name: body.name,
          description: body.description || '',
          image: body.image ?? null,
          location: body.location || '',
          quantity: body.quantity ?? 0,
          tags: body.tags || [],
          notes: body.notes || '',
          actorId: body.actorId || null,
        })
        return c.json({ success: true, instance })
      }
      case 'updateInstance': {
        const instance = await instanceService.updateInstance({
          instanceId: body.instanceId,
          categoryId: body.categoryId,
          attrs: body.attrs || {},
          fallback: body.fallback || null,
          name: body.name,
          description: body.description || '',
          image: body.image ?? null,
          location: body.location || '',
          quantity: body.quantity ?? 0,
          tags: body.tags || [],
          notes: body.notes || '',
          actorId: body.actorId || null,
        })
        return c.json({ success: true, instance })
      }
      case 'deleteInstance': {
        const result = await instanceService.deleteInstance({ instanceId: body.instanceId, actorId: body.actorId || null })
        return c.json({ success: true, ...result })
      }
      default:
        return c.json({
          error: `Unknown action "${body.action}" — expected one of: findOrCreate, updateFallback, deleteIfOrphaned, createInstance, updateInstance, deleteInstance.`,
        }, 400)
    }
  } catch (err) {
    console.error('[components]', err)
    return c.json({ error: err.message ?? 'Internal server error' }, statusForError(err))
  }
})

export default components