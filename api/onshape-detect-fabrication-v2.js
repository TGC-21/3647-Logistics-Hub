// api/onshape-detect-fabrication-v2.js — Vercel serverless function
//
// Migration Plan Phase 1, item 7 ("Fabrication detectors"). Thin,
// action-dispatched route for DetectionService, same convention
// api/onshape-bom-v2.js already established for item 6. Named "-v2"
// deliberately: the existing api/onshape-detect-fabrication.js keeps
// serving live traffic from src/designer/assemblyDetail.js's
// runFabricationDetection()/runFabricationDetectionForChild() unchanged.
// Client cutover to this route is Phase 2 work, done only once this
// path is proven out — see MIGRATION_PLAN.md's rule against bundling
// extraction with cutover. Once cutover happens, this file's contents
// can become the new api/onshape-detect-fabrication.js and the old
// monolithic handler retired.
//
// Gated behind the harness shared secret, same reasoning as every other
// route from this migration pass: no client caller yet.
//
// POST /api/onshape-detect-fabrication-v2
//   { action: 'detect', assemblyId }

import { applyCors } from './_lib/onshape.js'
import { assertHarnessToken } from './_lib/harnessAuth.js'
import { DetectionService } from '../src/services/DetectionService.js'
import { statusForError } from '../src/repositories/errors.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = req.body ?? {}
  const service = new DetectionService()

  try {
    assertHarnessToken(req)

    switch (body.action) {
      case 'detect': {
        const result = await service.detectFabricationCandidates({ assemblyId: body.assemblyId })
        return res.status(200).json({ success: true, ...result })
      }

      default:
        return res.status(400).json({
          error: `Unknown action "${body.action}" — expected one of: detect.`,
        })
    }
  } catch (err) {
    console.error('[onshape-detect-fabrication-v2]', err)
    return res.status(statusForError(err)).json({ error: err.message ?? 'Internal server error' })
  }
}
