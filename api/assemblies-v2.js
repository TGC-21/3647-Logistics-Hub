// api/assemblies-v2.js — Vercel serverless function
//
// Migration Plan Phase 1, item 8 ("Assembly / Assembly Children CRUD +
// cascade delete"). Thin, action-dispatched route for AssemblyService.
//
// AUTH DECISION — same as every other migrated route in this pass (see
// api/categories.js for the full reasoning): now called directly by the
// browser (src/services/assemblyApi.js, from
// src/designer/assemblyGrid.js's create/edit modal,
// src/designer/assemblyDetail.js's status sync and Onshape-link write,
// and its cascade-delete flow), so it can no longer require the
// harness-only shared secret. No auth gate. Revisit once Migration Plan
// Phase 3 lands.
//
// POST /api/assemblies-v2
//   { action: 'create', name, description?, onshapeUrl?, status?, actorId? }
//   { action: 'update', assemblyId, name?, description?, onshapeUrl?, status?, thumbnailUrl?, onshapeDocumentId?, onshapeWorkspaceId?, onshapeElementId?, actorId? }
//   { action: 'delete', assemblyId, actorId? }

import { applyCors } from './_lib/onshape.js'
import { AssemblyService } from '../src/services/AssemblyService.js'
import { statusForError } from '../src/repositories/errors.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = req.body ?? {}
  const service = new AssemblyService()

  try {

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
          assemblyId:         body.assemblyId,
          name:               body.name,
          description:        body.description,
          onshapeUrl:         body.onshapeUrl,
          status:             body.status,
          thumbnailUrl:       body.thumbnailUrl,
          onshapeDocumentId:  body.onshapeDocumentId,
          onshapeWorkspaceId: body.onshapeWorkspaceId,
          onshapeElementId:   body.onshapeElementId,
          actorId:            body.actorId || null,
        })
        return res.status(200).json({ success: true, assembly })
      }

      case 'delete': {
        const result = await service.deleteAssemblyWithCascade({
          assemblyId: body.assemblyId,
          actorId:    body.actorId || null,
        })
        return res.status(200).json({ success: true, result })
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