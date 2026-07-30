// api/fabrication-jobs.js — Vercel serverless function
//
// THE REFERENCE ROUTE for AGENTIC_HARNESS.md's Phase 1 migration, now
// also live: Migration Plan Phase 2's second caller cutover (after
// Categories). Compare it to api/onshape-bom.js: no business rules, no
// direct Supabase table access, no knowledge of fabrication_jobs'
// column names. It only:
//   1. parses the HTTP request,
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
// AUTH DECISION — same one api/categories.js already made and documents
// in full: this route is now called directly by the browser
// (src/services/fabricationJobsApi.js), so the harness-only shared
// secret had to come off (a browser has no safe way to hold it). It
// runs with NO auth gate, same as every other pre-existing
// client-facing route (api/onshape-bom.js, api/onshape-detect-fabrication.js).
// Partshelf has no real per-member auth boundary yet — schema.sql's RLS
// is `using (true)` everywhere — so gating this route more tightly than
// the rest of the app would be a false sense of security, not real
// protection. Revisit once Migration Plan Phase 3 (the real auth
// boundary) lands for the whole app at once, not just this route.
//
// POST /api/fabrication-jobs
//   { action: 'create',         assemblyPartId, quantityRequested, batchId?, actorId? }
//   { action: 'recordProgress', jobId, quantity, actorId? }
//   { action: 'deleteQueued',   jobId, actorId? }

import { applyCors } from './_lib/onshape.js'
import { FabricationJobService } from '../src/services/FabricationJobService.js'
import { statusForError } from '../src/repositories/errors.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = req.body ?? {}
  const service = new FabricationJobService()

  try {
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