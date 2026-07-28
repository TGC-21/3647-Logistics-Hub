// api/assemblies-v2.js — Vercel serverless function
//
// Migration Plan Phase 1, item 8 ("Assembly / Assembly Children CRUD +
// cascade delete"). Thin, action-dispatched route for AssemblyService,
// same convention as every other "-v2" route in this migration pass.
// Named "-v2" deliberately: src/designer/assemblyGrid.js (create/edit)
// and src/designer/assemblyDetail.js's deleteCurrentAssembly (via
// deleteAssemblyWithHistory) keep calling Supabase directly with the
// anon key, unchanged. Client cutover is Phase 2 work.
//
// Gated behind the harness shared secret, same reasoning as every
// other route from this migration pass: no client caller yet.
//
// POST /api/assemblies-v2
//   { action: 'create', name, description?, onshapeUrl?, status?, actorId? }
//   { action: 'update', assemblyId, name?, description?, onshapeUrl?, status?, actorId? }
//   { action: 'delete', assemblyId, actorId? }

import { applyCors } from './_lib/onshape.js'
import { assertHarnessToken } from './_lib/harnessAuth.js'
import { AssemblyService } from '../services/AssemblyService.js'
import { statusForError } from '../repositories/errors.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = req.body ?? {}
  const service = new AssemblyService()

  try {
    assertHarnessToken(req)

    switch (body.action) {
      case 'create': {
        const assembly = await service.createAssembly({
          name:        body.name,
          description: body.description || '',
          onshapeUrl:  body.onshapeUrl || '',
          status:      body.status || 'draft',
          actorId:     body.actorId || null,
        })
        return res.status(200).json({ success: true, assembly })
      }

      case 'update': {
        const assembly = await service.updateAssembly({
          assemblyId:  body.assemblyId,
          name:        body.name,
          description: body.description,
          onshapeUrl:  body.onshapeUrl,
          status:      body.status,
          actorId:     body.actorId || null,
        })
        return res.status(200).json({ success: true, assembly })
      }

      case 'delete': {
        const result = await service.deleteAssemblyWithCascade({
          assemblyId: body.assemblyId,
          actorId:    body.actorId || null,
        })
        return res.status(200).json({ success: true, ...result })
      }

      default:
        return res.status(400).json({
          error: `Unknown action "${body.action}" — expected one of: create, update, delete.`,
        })
    }
  } catch (err) {
    console.error('[assemblies-v2]', err)
    return res.status(statusForError(err)).json({ error: err.message ?? 'Internal server error' })
  }
}
