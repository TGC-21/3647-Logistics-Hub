// backend/routes/categories.js — converted from api/categories.js
//
// POST /api/categories
//   { action: 'list' }
//   { action: 'get',                categoryId }
//   { action: 'create',             name, requiredKeysConfig?, actorId? }
//   { action: 'update',             categoryId, name, requiredKeysConfig?, actorId? }
//   { action: 'delete',             categoryId, actorId? }
//   { action: 'validateAttributes', categoryId, attributes }

import { Hono } from 'hono'
import { CategoryService } from '../../src/services/CategoryService.js'
import { statusForError } from '../../src/repositories/errors.js'

const categories = new Hono()

categories.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const service = new CategoryService()

  try {
    switch (body.action) {
      case 'list': {
        const categories = await service.list()
        return c.json({ success: true, categories })
      }
      case 'get': {
        const category = await service.getById(body.categoryId)
        return c.json({ success: true, category })
      }
      case 'create': {
        const category = await service.create({
          name: body.name,
          requiredKeysConfig: body.requiredKeysConfig || [],
          actorId: body.actorId || null,
        })
        return c.json({ success: true, category })
      }
      case 'update': {
        const category = await service.update({
          id: body.categoryId,
          name: body.name,
          requiredKeysConfig: body.requiredKeysConfig || [],
          actorId: body.actorId || null,
        })
        return c.json({ success: true, category })
      }
      case 'delete': {
        const result = await service.delete({ id: body.categoryId, actorId: body.actorId || null })
        return c.json({ success: true, ...result })
      }
      case 'validateAttributes': {
        const result = await service.validateAttributesForCategory({
          categoryId: body.categoryId,
          attributes: body.attributes || [],
        })
        return c.json({ success: true, ...result })
      }
      default:
        return c.json({
          error: `Unknown action "${body.action}" — expected one of: list, get, create, update, delete, validateAttributes.`,
        }, 400)
    }
  } catch (err) {
    console.error('[categories]', err)
    return c.json({ error: err.message ?? 'Internal server error' }, statusForError(err))
  }
})

export default categories