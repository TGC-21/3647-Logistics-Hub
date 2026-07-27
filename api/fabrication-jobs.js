// api/fabrication-jobs.js — Vercel serverless function
//
// THIS IS THE REFERENCE ROUTE for AGENTIC_HARNESS.md's Phase 1
// migration. Compare it to api/onshape-bom.js: no business rules, no
// direct Supabase table access, no knowledge of fabrication_jobs'
// column names. It only:
//   1. parses the HTTP request (and would authenticate it, once
//      Partshelf has a real auth boundary — see AGENTIC_HARNESS.md's
//      open questions),
//   2. calls exactly one FabricationJobService method,
//   3. maps the result — or a typed error from repositories/errors.js —
//      onto an HTTP response.
//
// One file, action-dispatched by body.action, rather than introducing
// REST-style nested routes (api/fabrication-jobs/[id]/progress.js etc)
// that nothing else in api/ uses today. This mirrors the convention
// api/onshape-bom.js already established with its `body.reimport` flag
// — new routes built this way should keep doing the same, not invent a
// second routing style.
//
// POST /api/fabrication-jobs
//   { action: 'create',         assemblyPartId, quantityRequested, batchId?, actorId? }
//   { action: 'recordProgress', jobId, quantity, actorId? }
//   { action: 'deleteQueued',   jobId, actorId? }

import { applyCors } from './_lib/onshape.js'
import { assertHarnessToken } from './_lib/harnessAuth.js'
import { FabricationJobService } from '../services/FabricationJobService.js'
import { statusForError } from '../repositories/errors.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = req.body ?? {}
  const service = new FabricationJobService()

  try {
    // This route has no client (browser) callers yet — see
    // MIGRATION_EXAMPLE.md — so it's safe to gate behind the harness
    // shared secret from day one. When client cutover happens for this
    // route, this line needs a real decision (see api/_lib/harnessAuth.js),
    // not just removal.
    assertHarnessToken(req)

    switch (body.action) {
      case 'create': {
        const job = await service.createJob({
          assemblyPartId:    body.assemblyPartId,
          quantityRequested: body.quantityRequested,
          batchId:           body.batchId || null,
          actorId:           body.actorId || null,
        })
        return res.status(200).json({ success: true, job })
      }

      case 'recordProgress': {
        const job = await service.recordMachinedUnits({
          jobId:    body.jobId,
          quantity: body.quantity,
          actorId:  body.actorId || null,
        })
        return res.status(200).json({ success: true, job })
      }

      case 'deleteQueued': {
        const result = await service.deleteQueuedJob({
          jobId:   body.jobId,
          actorId: body.actorId || null,
        })
        return res.status(200).json({ success: true, ...result })
      }

      default:
        return res.status(400).json({
          error: `Unknown action "${body.action}" — expected one of: create, recordProgress, deleteQueued.`,
        })
    }
  } catch (err) {
    console.error('[fabrication-jobs]', err)
    return res.status(statusForError(err)).json({ error: err.message ?? 'Internal server error' })
  }
}