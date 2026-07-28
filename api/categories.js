// api/categories.js — Vercel serverless function
//
// Migration Plan Phase 1, item 10. Thin, action-dispatched, harness-token
// gated — same convention as every other route from this pass. No
// client caller yet (src/main.js's category modal still calls
// src/db.js's fetchCategories/upsertCategory/deleteCategory directly).
//
// POST /api/categories
//   { action: 'list' }
//   { action: 'get',                categoryId }
//   { action: 'create',             name, requiredKeysConfig?, actorId? }
//   { action: 'update',             categoryId, name, requiredKeysConfig?, actorId? }
//   { action: 'delete',             categoryId, actorId? }
//   { action: 'validateAttributes', categoryId, attributes }

import { applyCors } from './_lib/onshape.js'
import { assertHarnessToken } from './_lib/harnessAuth.js'
import { CategoryService } from '../services/CategoryService.js'
import { statusForError } from '../repositories/errors.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = req.body ?? {}
  const service = new CategoryService()

  try {
    assertHarnessToken(req)

    switch (body.action) {
      case 'list': {
        const categories = await service.list()
        return res.status(200).json({ success: true, categories })
      }

      case 'get': {
        const category = await service.getById(body.categoryId)
        return res.status(200).json({ success: true, category })
      }

      case 'create': {
        const category = await service.create({
          name:               body.name,
          requiredKeysConfig: body.requiredKeysConfig || [],
          actorId:            body.actorId || null,
        })
        return res.status(200).json({ success: true, category })
      }

      case 'update': {
        const category = await service.update({
          id:                 body.categoryId,
          name:               body.name,
          requiredKeysConfig: body.requiredKeysConfig || [],
          actorId:            body.actorId || null,
        })
        return res.status(200).json({ success: true, category })
      }

      case 'delete': {
        const result = await service.delete({ id: body.categoryId, actorId: body.actorId || null })
        return res.status(200).json({ success: true, ...result })
      }

      case 'validateAttributes': {
        const result = await service.validateAttributesForCategory({
          categoryId: body.categoryId,
          attributes: body.attributes || [],
        })
        return res.status(200).json({ success: true, ...result })
      }

      default:
        return res.status(400).json({
          error: `Unknown action "${body.action}" — expected one of: list, get, create, update, delete, validateAttributes.`,
        })
    }
  } catch (err) {
    console.error('[categories]', err)
    return res.status(statusForError(err)).json({ error: err.message ?? 'Internal server error' })
  }
}
