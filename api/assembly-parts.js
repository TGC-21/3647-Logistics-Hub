// api/assembly-parts.js — Vercel serverless function
//
// Migration Plan Phase 1, item 2 / Phase 2 caller cutover (fifth domain,
// after Categories/Cart/Fabrication Jobs/Inventory Reservation). Thin,
// action-dispatched route for AssemblyPartService.
//
// AUTH DECISION — same as every other migrated route in this pass (see
// api/categories.js for the full reasoning): now called directly by the
// browser (src/services/assemblyPartsApi.js, from
// src/designer/partsTable.js's Add/Edit/Delete part flow), so it can no
// longer require the harness-only shared secret. No auth gate, same as
// every other client-facing route — Partshelf has no real per-member
// auth boundary yet. Revisit once Migration Plan Phase 3 lands.
//
// POST /api/assembly-parts
//   { action: 'create',              assemblyId?, assemblyChildId?, partName, partNumber?, quantityNeeded?, notes?, actorId? }
//   { action: 'update',              partId, partName, partNumber?, quantityNeeded, notes?, actorId? }
//   { action: 'delete',              partId, actorId? }
//   { action: 'linkComponent',       partId, componentId, actorId? }
//   { action: 'updateQuantityNeeded', partId, quantityNeeded, actorId? }
//   { action: 'recomputeStatus',      partId, actorId? }
//   { action: 'computeOwnerStatus',   assemblyId }

import { applyCors } from './_lib/onshape.js'
import { AssemblyPartService } from '../src/services/AssemblyPartService.js'
import { statusForError } from '../src/repositories/errors.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = req.body ?? {}
  const service = new AssemblyPartService()

  try {
    switch (body.action) {
      case 'create': {
        const part = await service.createPart({
          assemblyId:      body.assemblyId || null,
          assemblyChildId: body.assemblyChildId || null,
          partName:        body.partName,
          partNumber:      body.partNumber || '',
          quantityNeeded:  body.quantityNeeded,
          notes:           body.notes || '',
          actorId:         body.actorId || null,
        })
        return res.status(200).json({ success: true, part })
      }

      case 'update': {
        const part = await service.updatePart({
          partId:         body.partId,
          partName:       body.partName,
          partNumber:     body.partNumber || '',
          quantityNeeded: body.quantityNeeded,
          notes:          body.notes || '',
          actorId:        body.actorId || null,
        })
        return res.status(200).json({ success: true, part })
      }

      case 'delete': {
        const result = await service.deletePart({ partId: body.partId, actorId: body.actorId || null })
        return res.status(200).json({ success: true, ...result })
      }

      case 'linkComponent': {
        const part = await service.linkComponent({
          partId:      body.partId,
          componentId: body.componentId,
          actorId:     body.actorId || null,
        })
        return res.status(200).json({ success: true, part })
      }

      case 'updateQuantityNeeded': {
        const part = await service.updateQuantityNeeded({
          partId:         body.partId,
          quantityNeeded: body.quantityNeeded,
          actorId:        body.actorId || null,
        })
        return res.status(200).json({ success: true, part })
      }

      case 'recomputeStatus': {
        const part = await service.recomputeStatus({ partId: body.partId, actorId: body.actorId || null })
        return res.status(200).json({ success: true, part })
      }

      case 'computeOwnerStatus': {
        const status = await service.computeOwnerStatus({ assemblyId: body.assemblyId })
        return res.status(200).json({ success: true, status })
      }

      default:
        return res.status(400).json({
          error: `Unknown action "${body.action}" — expected one of: create, update, delete, linkComponent, updateQuantityNeeded, recomputeStatus, computeOwnerStatus.`,
        })
    }
  } catch (err) {
    console.error('[assembly-parts]', err)
    return res.status(statusForError(err)).json({ error: err.message ?? 'Internal server error' })
  }
}