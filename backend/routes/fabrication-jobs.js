// backend/routes/fabrication-jobs.js — converted from api/fabrication-jobs.js
//
// POST /api/fabrication-jobs
//   { action: 'create',         assemblyPartId, quantityRequested, batchId?, actorId? }
//   { action: 'recordProgress', jobId, quantity, actorId? }
//   { action: 'deleteQueued',   jobId, actorId? }

import { Hono } from 'hono'
import { FabricationJobService } from '../../src/services/FabricationJobService.js'
import { statusForError } from '../../src/repositories/errors.js'

const fabricationJobs = new Hono()

fabricationJobs.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const service = new FabricationJobService()

  try {
    switch (body.action) {
      case 'create': {
        const job = await service.createJob({
          assemblyPartId: body.assemblyPartId,
          quantityRequested: body.quantityRequested,
          batchId: body.batchId || null,
          actorId: body.actorId || null,
        })
        return c.json({ success: true, job })
      }
      case 'recordProgress': {
        const job = await service.recordMachinedUnits({
          jobId: body.jobId,
          quantity: body.quantity,
          actorId: body.actorId || null,
        })
        return c.json({ success: true, job })
      }
      case 'deleteQueued': {
        const result = await service.deleteQueuedJob({ jobId: body.jobId, actorId: body.actorId || null })
        return c.json({ success: true, ...result })
      }
      default:
        return c.json({
          error: `Unknown action "${body.action}" — expected one of: create, recordProgress, deleteQueued.`,
        }, 400)
    }
  } catch (err) {
    console.error('[fabrication-jobs]', err)
    return c.json({ error: err.message ?? 'Internal server error' }, statusForError(err))
  }
})

export default fabricationJobs