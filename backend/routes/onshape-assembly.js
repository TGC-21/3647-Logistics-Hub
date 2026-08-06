// backend/routes/onshape-assembly.js — converted from api/onshape-assembly.js
//
// POST /api/onshape-assembly
//   { action: 'import',   documentId, workspaceId, elementId, name?, thumbnailUrl?, actorId? }
//   { action: 'reimport', assemblyId, actorId? }
//   { action: 'detect',   assemblyId }

import { Hono } from 'hono'
import { OnshapeImportService } from '../../src/services/OnshapeImportService.js'
import { DetectionService } from '../../src/services/DetectionService.js'
import { OnshapeReimportService } from '../../src/services/OnshapeReimportService.js'
import { statusForError } from '../../src/repositories/errors.js'

const onshapeAssembly = new Hono()

onshapeAssembly.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const service = new DetectionService()

  try {
    switch (body.action) {
      case 'import': {
        const importService = new OnshapeImportService()
        const result = await importService.importAssembly({
          documentId: body.documentId,
          workspaceId: body.workspaceId,
          elementId: body.elementId,
          name: body.name || null,
          thumbnailUrl: body.thumbnailUrl || null,
          actorId: body.actorId || null,
        })
        return c.json({ success: true, ...result })
      }
      case 'reimport': {
        const reimportService = new OnshapeReimportService()
        const result = await reimportService.reimportAssembly({ assemblyId: body.assemblyId, actorId: body.actorId || null })
        return c.json({ success: true, ...result })
      }
      case 'detect': {
        const result = await service.detectFabricationCandidates({ assemblyId: body.assemblyId })
        return c.json({ success: true, ...result })
      }
      default:
        return c.json({ error: `Unknown action "${body.action}" — expected one of: import, reimport, detect.` }, 400)
    }
  } catch (err) {
    console.error('[onshape-assembly]', err)
    if (/Onshape API 404/.test(err.message || '')) {
      return c.json({
        error: 'Onshape couldn\'t find or generate a BOM for this assembly. Open its BOM tab in Onshape once to initialize it, confirm you picked an Assembly (not a Part Studio), then try again.',
      }, 404)
    }
    return c.json({ error: err.message ?? 'Internal server error' }, statusForError(err))
  }
})

export default onshapeAssembly