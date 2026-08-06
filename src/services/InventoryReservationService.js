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
import { CategoryRepository } from '../repositories/CategoryRepository.js'
import { ComponentRepository } from '../repositories/ComponentRepository.js'
import { AssemblyPartRepository } from '../repositories/AssemblyPartRepository.js'
import { PartNumberRepository } from '../repositories/PartNumberRepository.js'
import { ChangeLogRepository } from '../repositories/ChangeLogRepository.js'
import { ValidationError, ConflictError } from '../repositories/errors.js'
import { AssemblyPartService } from './AssemblyPartService.js'

const BULK_CATEGORY_NAME = 'Bulk / Untracked'
const BULK_FALLBACK_NAME = 'Bulk stock'

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }


export class InventoryReservationService {
  constructor({
    instanceRepo   = new InventoryInstanceRepository(),
    partRepo       = new AssemblyPartRepository(),
    partNumberRepo = new PartNumberRepository(),
    categoryRepo   = new CategoryRepository(),     // NEW
    componentRepo  = new ComponentRepository(),     // NEW
    changeLogRepo  = new ChangeLogRepository(),
    assemblyPartService = new AssemblyPartService({ partRepo, changeLogRepo }),
  } = {}) {
    this.instanceRepo        = instanceRepo
    this.partRepo             = partRepo
    this.partNumberRepo       = partNumberRepo
    this.categoryRepo         = categoryRepo
    this.componentRepo        = componentRepo
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

    /**
   * Find-or-creates the single well-known unlimited pile everything
   * quick-collected routes through — one fixed category, one fixed
   * component, one unlimited=true instance. Mirrors the
   * find-or-create-by-name pattern FabricationDetectionService._ensureCategory
   * / fabricateFlow.js's ensureCustomPartCategory already use.
   *
   * Cached at module scope for the lifetime of a warm serverless
   * invocation — the bulk pile's id never changes once created, so
   * there's no reason to re-query it on every quick-collect click.
   */
  async _ensureBulkInstance() {
    if (InventoryReservationService._bulkInstanceCache) {
      return InventoryReservationService._bulkInstanceCache
    }

    let category = await this.categoryRepo.findByName(BULK_CATEGORY_NAME)
    if (!category) {
      category = await this.categoryRepo.insert({ id: genId(), name: BULK_CATEGORY_NAME, requiredKeysConfig: [] })
    }

    const existingComponents = await this.componentRepo.findByCategory(category.id)
    let component = existingComponents[0]
    if (!component) {
      component = await this.componentRepo.insert({
        id: genId(), categoryId: category.id, attributes: [],
        fallbackName: BULK_FALLBACK_NAME,
        fallbackDescription: 'Untracked bulk stock used by quick-collect — not a real inventory count.',
        fallbackImage: null,
      })
    }

    const existingInstances = await this.instanceRepo.findByComponent(component.id)
    let instance = existingInstances.find(i => i.unlimited)
    if (!instance) {
      instance = await this.instanceRepo.insert({
        id: genId(), componentId: component.id, name: BULK_FALLBACK_NAME,
        location: 'Bulk / Untracked', quantity: 0, status: 'available', unlimited: true,
      })
    }

    InventoryReservationService._bulkInstanceCache = instance
    return instance
  }

  /**
   * "Quick collect" — reserves `quantity` units off the bulk pile for
   * `assemblyPartId`, without a category/component/location picker.
   * Deliberately routes through the SAME reserve() every real link
   * goes through (still qty-capped at remaining need, still recomputes
   * status, still creates a real fork row in linked_instance_ids) — the
   * only difference is which instance it reserves from.
   *
   * Deliberately does NOT pass componentId: reserve()'s
   * `part.componentId || componentId` fallback means the part's own
   * componentId is left untouched (stays null if it was null). This is
   * intentional — quick-collecting washers should never permanently
   * "resolve" the part's identity to the bulk-stock component, so
   * findInventory/sendToFabricate stay available and a later real link
   * still works normally.
   */
  async quickCollect({ assemblyPartId, quantity = 1, actorId = null }) {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new ValidationError('quantity must be a positive integer')
    }
    const bulk = await this._ensureBulkInstance()
    return this.reserve({
      assemblyPartId,
      instanceId: bulk.id,
      componentId: null,
      quantity,
      location: 'Bulk / Untracked',
      sourcePartNumber: null,
      actorId,
    })
  }
}

