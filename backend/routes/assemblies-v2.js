// backend/routes/assemblies-v2.js — converted from api/assemblies-v2.js
//
// POST /api/assemblies-v2
//   { action: 'create', name, description?, onshapeUrl?, status?, actorId? }
//   { action: 'update', assemblyId, name?, description?, onshapeUrl?, status?, thumbnailUrl?, onshapeDocumentId?, onshapeWorkspaceId?, onshapeElementId?, actorId? }
//   { action: 'delete', assemblyId, actorId? }

import { Hono } from 'hono'
import { AssemblyService } from '../../src/services/AssemblyService.js'
import { statusForError } from '../../src/repositories/errors.js'

const assembliesV2 = new Hono()

assembliesV2.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const service = new AssemblyService()

  try {
    switch (body.action) {
      case 'create': {
        const assembly = await service.createAssembly({
          name: body.name,
          description: body.description || '',
          onshapeUrl: body.onshapeUrl || '',
          status: body.status || 'draft',
          actorId: body.actorId || null,
        })
        return c.json({ success: true, assembly })
      }
      case 'update': {
        const assembly = await service.updateAssembly({
          assemblyId: body.assemblyId,
          name: body.name,
          description: body.description,
          onshapeUrl: body.onshapeUrl,
          status: body.status,
          thumbnailUrl: body.thumbnailUrl,
          onshapeDocumentId: body.onshapeDocumentId,
          onshapeWorkspaceId: body.onshapeWorkspaceId,
          onshapeElementId: body.onshapeElementId,
          actorId: body.actorId || null,
        })
        return c.json({ success: true, assembly })
      }
      case 'delete': {
        const result = await service.deleteAssemblyWithCascade({ assemblyId: body.assemblyId, actorId: body.actorId || null })
        return c.json({ success: true, result })
      }
      default:
        return c.json({ error: `Unknown action "${body.action}" — expected one of: create, update, delete.` }, 400)
    }
  } catch (err) {
    console.error('[assemblies-v2]', err)
    return c.json({ error: err.message ?? 'Internal server error' }, statusForError(err))
  }
})

export default assembliesV2