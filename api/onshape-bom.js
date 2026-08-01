// api/onshape-bom-v2.js — Vercel serverless function
//
// Phase 1 part 6 of MIGRATION_PLAN.md — thin, action-dispatched route
// for OnshapeImportService / OnshapeReimportService, same convention
// api/fabrication-jobs.js and api/cart-items.js already established.
// Named "-v2" deliberately: the existing api/onshape-bom.js keeps
// serving live traffic from src/designer/onshapePicker.js and
// src/designer/assemblyDetail.js unchanged. Client cutover to this
// route is Phase 2 work, done only once this path is proven out — see
// MIGRATION_PLAN.md's own rule against bundling extraction with cutover.
// Once cutover happens, this file's contents can simply become the new
// api/onshape-bom.js and the old monolithic handler retired.
//
// Gated behind the harness shared secret, same reasoning as the other
// two migrated routes: no client caller yet.
//
// POST /api/onshape-bom-v2
//   { action: 'import',   documentId, workspaceId, elementId, name?, thumbnailUrl?, actorId? }
//   { action: 'reimport', assemblyId, actorId? }

import { applyCors } from './_lib/onshape.js'
import { OnshapeImportService } from '../src/services/OnshapeImportService.js'
import { OnshapeReimportService } from '../src/services/OnshapeReimportService.js'
import { statusForError } from '../src/repositories/errors.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = req.body ?? {}

  try {

    switch (body.action) {
      case 'import': {
        const service = new OnshapeImportService()
        const result = await service.importAssembly({
          documentId:   body.documentId,
          workspaceId:  body.workspaceId,
          elementId:    body.elementId,
          name:         body.name || null,
          thumbnailUrl: body.thumbnailUrl || null,
          actorId:      body.actorId || null,
        })
        return res.status(200).json({ success: true, ...result })
      }

      case 'reimport': {
        const service = new OnshapeReimportService()
        const result = await service.reimportAssembly({
          assemblyId: body.assemblyId,
          actorId:    body.actorId || null,
        })
        return res.status(200).json({ success: true, ...result })
      }

      default:
        return res.status(400).json({
          error: `Unknown action "${body.action}" — expected one of: import, reimport.`,
        })
    }
  } catch (err) {
    console.error('[onshape-bom-v2]', err)
    if (/Onshape API 404/.test(err.message || '')) {
      return res.status(404).json({
        error: 'Onshape couldn\'t find or generate a BOM for this assembly. Open its BOM tab in Onshape once to initialize it, confirm you picked an Assembly (not a Part Studio), then try again.',
      })
    }
    return res.status(statusForError(err)).json({ error: err.message ?? 'Internal server error' })
  }
}
