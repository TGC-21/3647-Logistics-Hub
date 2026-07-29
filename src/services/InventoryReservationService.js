// services/InventoryReservationService.js
//
// Migration Plan Phase 1, item 1. Owns the rules currently living in
// src/designer/inventoryLink.js's linkInstanceToPart/unlinkInstanceFromPart
// click handlers:
//
//   - a part can never be reserved past its remaining gap
//     (quantityNeeded - quantityCollected already promised elsewhere is
//     NOT this service's concern — that's totalPromisedQty/
//     partCanPromiseMore in designer/state.js, still client-side view
//     logic, not a write-path rule)
//   - reserving forks units off an existing inventory pile via
//     reserve_inventory_units() (already DB-atomic) and appends the
//     fork's id to the part's linked_instance_ids
//   - a part's status (pending/partial/complete) is derived from
//     collected vs. needed after every reservation change — delegated
//     to AssemblyPartService so the rule has exactly one home (Plan
//     item 2), not reimplemented here
//   - confirming a reservation backfills part_numbers.component_id for
//     that vendor SKU, so future imports of the same part number
//     resolve to the same component automatically
//   - unlinking releases the specific forked instance back to
//     'available' (never merged back into the pile it was split from —
//     same limitation the original code documents) and, if that was the
//     part's last linked instance, clears componentId too
//
// This service does NOT own "which component should this part resolve
// to" — that's ComponentService (Plan item 3). It receives a
// componentId that's already been resolved and just does the
// reservation bookkeeping around it.

import { InventoryInstanceRepository } from '../repositories/InventoryInstanceRepository.js'
import { AssemblyPartRepository } from '../repositories/AssemblyPartRepository.js'
import { PartNumberRepository } from '../repositories/PartNumberRepository.js'
import { ChangeLogRepository } from '../repositories/ChangeLogRepository.js'
import { ValidationError, ConflictError } from '../repositories/errors.js'
import { AssemblyPartService } from './AssemblyPartService.js'

export class InventoryReservationService {
  constructor({
    instanceRepo   = new InventoryInstanceRepository(),
    partRepo       = new AssemblyPartRepository(),
    partNumberRepo = new PartNumberRepository(),
    changeLogRepo  = new ChangeLogRepository(),
    assemblyPartService = new AssemblyPartService({ partRepo, changeLogRepo }),
  } = {}) {
    this.instanceRepo        = instanceRepo
    this.partRepo             = partRepo
    this.partNumberRepo       = partNumberRepo
    this.changeLogRepo        = changeLogRepo
    this.assemblyPartService  = assemblyPartService
  }

  /**
   * Reserves `quantity` units of `instanceId` for `assemblyPartId`.
   * `componentId` is the component the part should resolve to if it
   * doesn't already have one (first reservation on a part establishes
   * its component; later reservations must agree with it — mismatches
   * are a caller bug, not something silently overwritten).
   */
  async reserve({ assemblyPartId, instanceId, componentId, quantity, location, sourcePartNumber = null, actorId = null }) {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ValidationError('quantity must be a positive integer')
    }

    const part = await this.partRepo.findById(assemblyPartId)
    const alreadyLinked   = part.quantityCollected || 0
    const remainingNeeded = part.quantityNeeded - alreadyLinked
    if (remainingNeeded <= 0) {
      throw new ConflictError(`"${part.partName}" already has ${part.quantityNeeded} linked — quantity needed is met.`)
    }
    const cappedQty = Math.min(quantity, remainingNeeded)

    const fork = await this.instanceRepo.reserveUnits(instanceId, cappedQty, location || '')

    const resolvedComponentId = part.componentId || componentId
    const updatedPart = await this.partRepo.updateReservationFields(assemblyPartId, {
      componentId:       resolvedComponentId,
      linkedInstanceIds: [...(part.linkedInstanceIds || []), fork.id],
      quantityCollected: alreadyLinked + cappedQty,
    })

    const withStatus = await this.assemblyPartService.recomputeStatus({ partId: assemblyPartId, actorId })

    if (sourcePartNumber && resolvedComponentId) {
      // Best-effort — a failed backfill shouldn't fail the reservation
      // that already succeeded (mirrors inventoryLink.js's own
      // try/catch-and-warn around this step).
      await this.partNumberRepo.backfillComponentId(sourcePartNumber, resolvedComponentId).catch(() => {})
    }

    await this.changeLogRepo.record({
      entityType: 'assembly_part', entityId: assemblyPartId, action: 'update', field: 'linkedInstanceIds',
      oldValue: part.linkedInstanceIds, newValue: withStatus.linkedInstanceIds,
      actorId, commitId: this.changeLogRepo.newCommitId(),
    })

    return { part: withStatus, fork }
  }

  /**
   * Releases one specific forked instance back to 'available' and
   * removes it from the part's linked_instance_ids. If that was the
   * part's only linked instance, componentId is cleared too — mirrors
   * inventoryLink.js's unlinkInstanceFromPart exactly (a part with zero
   * linked instances no longer has a confirmed component identity).
   */
  async unreserve({ assemblyPartId, instanceId, unlinkedQuantity = 1, resetLocation = '', actorId = null }) {
    const part = await this.partRepo.findById(assemblyPartId)

    await this.instanceRepo.unreserve(instanceId, resetLocation)

    const remaining = (part.linkedInstanceIds || []).filter(id => id !== instanceId)
    const updatedPart = await this.partRepo.updateReservationFields(assemblyPartId, {
      linkedInstanceIds: remaining,
      componentId:       remaining.length ? part.componentId : null,
      quantityCollected: Math.max(0, (part.quantityCollected || 0) - unlinkedQuantity),
    })

    const withStatus = await this.assemblyPartService.recomputeStatus({ partId: assemblyPartId, actorId })

    await this.changeLogRepo.record({
      entityType: 'assembly_part', entityId: assemblyPartId, action: 'update', field: 'linkedInstanceIds',
      oldValue: part.linkedInstanceIds, newValue: withStatus.linkedInstanceIds,
      actorId, commitId: this.changeLogRepo.newCommitId(),
    })

    return withStatus
  }

  /** Bulk release — used by part/assembly deletion, where every
   *  reservation the part(s) held needs to go back to available in one
   *  shot rather than one unreserve() call per instance. Deliberately
   *  does NOT touch assembly_parts here — the caller is about to delete
   *  those rows anyway (or has already), same ordering
   *  deleteAssemblyWithHistory/deleteCurrentAssembly already use
   *  (release inventory, then delete). */
  async releaseAll(instanceIds) {
    await this.instanceRepo.releaseMany(instanceIds)
  }
}
