// api/categories.js — Vercel serverless function
//
// Migration Plan Phase 1, item 10 / Phase 2 caller cutover. Thin,
// action-dispatched route for CategoryService.
//
// AUTH DECISION (the thing every route in this migration pass deferred
// with "needs a real decision, not just removal" — see
// api/_lib/harnessAuth.js's own doc comment): this route is now called
// directly by the browser (src/services/categoriesApi.js, from the
// Manage Categories modal), so it can no longer require the
// harness-only shared secret — a browser has no safe way to hold that
// secret. The decision made here is to run this route with NO auth
// gate at all, same as every other pre-existing client-facing route in
// this codebase (api/onshape-bom.js, api/onshape-detect-fabrication.js,
// etc.) — Partshelf has no real per-member auth boundary yet (schema.sql's
// RLS is `using (true)` everywhere, members.js's login is explicitly
// "identification, not authentication"), so gating this one route more
// tightly than the rest of the app would be a false sense of security,
// not real protection. Revisit once Migration Plan Phase 3 (the real
// auth boundary) lands — at that point EVERY route, not just this one,
// gets a real decision.
//
// POST /api/categories
//   { action: 'list' }
//   { action: 'get',                categoryId }
//   { action: 'create',             name, requiredKeysConfig?, actorId? }
//   { action: 'update',             categoryId, name, requiredKeysConfig?, actorId? }
//   { action: 'delete',             categoryId, actorId? }
//   { action: 'validateAttributes', categoryId, attributes }

import { applyCors } from './_lib/onshape.js'
import { CategoryService } from '../src/services/CategoryService.js'
import { statusForError } from '../src/repositories/errors.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = req.body ?? {}
  const service = new CategoryService()

  try {
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
