// services/OnshapeReimportService.js
//
// Phase 1 part 6 of MIGRATION_PLAN.md — the "snapshot/carry-over/
// reconcile" half of api/onshape-bom.js's split (reimportAssembly +
// carryOverPromisesAfterReimport + fetchWholeTreeFabricationMetadata).
// Composes OnshapeImportService for the actual reseed step rather than
// duplicating tree-seeding logic — reimport really is just
// "snapshot → wipe → reseed → relink," and seeding is that service's
// whole job.
//
// Reuses buildSourceKey / fabricationIdentityKey from api/_lib/onshape.js
// unchanged — the "same underlying Onshape part across two imports"
// identity rules live there and shouldn't be re-derived here.
//
// No @supabase/supabase-js import, no req/res.

import { buildSourceKey, fabricationIdentityKey, fetchDocumentOwnerId } from '../api/_lib/onshape.js'
import { OnshapeImportService } from './OnshapeImportService.js'
import { AssemblyRepository } from '../repositories/AssemblyRepository.js'
import { AssemblyChildRepository } from '../repositories/AssemblyChildRepository.js'
import { AssemblyPartRepository } from '../repositories/AssemblyPartRepository.js'
import { FabricationJobRepository } from '../repositories/FabricationJobRepository.js'
import { CartItemRepository } from '../repositories/CartItemRepository.js'
import { InventoryInstanceRepository } from '../repositories/InventoryInstanceRepository.js'
import { ChangeLogRepository } from '../repositories/ChangeLogRepository.js'
import { ValidationError, ConflictError } from '../repositories/errors.js'

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }
function computePartStatus(collected, needed) { return collected >= needed ? 'complete' : collected > 0 ? 'partial' : 'pending' }

/** A row carried forward with status 'queued'/'confirmed' implies an
 *  active fabrication_jobs row, but that job was just cascade-deleted
 *  along with the old assembly_parts row it pointed to. Downgrading
 *  back to 'detected' keeps the row reviewable instead of silently
 *  claiming a job exists that doesn't — same rule onshape-bom.js's
 *  reconcileRestoredMetadata already enforces. */
function reconcileRestoredMetadata(meta) {
  if (meta.status !== 'queued' && meta.status !== 'confirmed') return meta
  return {
    ...meta,
    status: 'detected',
    warnings: [
      ...(meta.warnings || []),
      'This part\'s fabrication job was lost on reimport (assembly parts are rebuilt from scratch) — please re-confirm and re-send to Fabricate.',
    ],
  }
}

export class OnshapeReimportService {
  constructor({
    assemblyRepo          = new AssemblyRepository(),
    assemblyChildRepo     = new AssemblyChildRepository(),
    assemblyPartRepo       = new AssemblyPartRepository(),
    fabricationJobRepo     = new FabricationJobRepository(),
    cartItemRepo           = new CartItemRepository(),
    inventoryInstanceRepo  = new InventoryInstanceRepository(),
    changeLogRepo          = new ChangeLogRepository(),
    importService          = new OnshapeImportService({ assemblyRepo, assemblyChildRepo, assemblyPartRepo, changeLogRepo }),
  } = {}) {
    this.assemblyRepo         = assemblyRepo
    this.assemblyChildRepo    = assemblyChildRepo
    this.assemblyPartRepo     = assemblyPartRepo
    this.fabricationJobRepo   = fabricationJobRepo
    this.cartItemRepo         = cartItemRepo
    this.inventoryInstanceRepo = inventoryInstanceRepo
    this.changeLogRepo        = changeLogRepo
    this.importService        = importService
  }

  async reimportAssembly({ assemblyId, actorId = null }) {
    const assembly = await this.assemblyRepo.requireById(assemblyId)
    if (!assembly.onshapeElementId) throw new ValidationError('Assembly is not linked to Onshape.')

    // ── 1. Snapshot the OLD tree before anything is wiped ──────────
    const oldParts = await this.assemblyPartRepo.findTreeForAssembly(assemblyId)
    const oldPartIds = oldParts.map(p => p.id)
    const oldSourceKeyById = Object.fromEntries(oldParts.map(p => [p.id, buildSourceKey(p.onshapeReference)]))

    const oldJobs      = await this.fabricationJobRepo.findByAssemblyPartIds(oldPartIds)
    const oldCartItems = await this.cartItemRepo.findByAssemblyPartIds(oldPartIds)

    // Preserve auto-detection metadata keyed by a stable Onshape
    // identity so it can be restored onto the matching NEW row once
    // the tree is rebuilt (see fabricationIdentityKey's own doc
    // comment for why partIdentity, not partId, is used).
    const fabricationMetadataByKey = {}
    for (const p of oldParts) {
      const key = fabricationIdentityKey(p.onshapeReference)
      if (key && p.fabricationMetadata?.kind) fabricationMetadataByKey[key] = p.fabricationMetadata
    }

    // ── 2. Wipe + reseed ─────────────────────────────────────────
    const linkedIds = oldParts.flatMap(p => p.linkedInstanceIds || [])
    if (linkedIds.length) await this.inventoryInstanceRepo.releaseMany(linkedIds)

    await this.assemblyPartRepo.deleteDirectForAssembly(assemblyId)
    await this.assemblyChildRepo.deleteDirectChildren(assemblyId)

    const rootOwnerId = await fetchDocumentOwnerId(assembly.onshapeDocumentId)
    const resolveCache = new Map()
    const { partCount, childCount } = await this.importService.seedAssemblyContents({
      documentId:  assembly.onshapeDocumentId,
      workspaceId: assembly.onshapeWorkspaceId,
      elementId:   assembly.onshapeElementId,
      depth: 0, rootOwnerId,
      partsOwner:    { assemblyId },
      childrenOwner: { parentAssemblyId: assemblyId },
      resolveCache,
    })

    // Restore fabrication_metadata by identity key onto whichever new
    // rows match (bulkInsert itself doesn't know about detection
    // history — that's this service's concern, not the import
    // service's) and downgrade any job-implying statuses that no
    // longer have a real job behind them.
    const newParts = await this.assemblyPartRepo.findTreeForAssembly(assemblyId)
    for (const p of newParts) {
      const key = fabricationIdentityKey(p.onshapeReference)
      const restored = key && fabricationMetadataByKey[key]
      if (restored) {
        await this.assemblyPartRepo.updateFabricationMetadata(p.id, reconcileRestoredMetadata(restored))
      }
    }

    await this.assemblyRepo.updateStatus(assemblyId, 'draft')

    // ── 3. Build the NEW tree's source-key index ────────────────
    const newBySourceKey = new Map()
    for (const p of newParts) {
      const key = buildSourceKey(p.onshapeReference)
      if (!key) continue
      if (newBySourceKey.has(key)) {
        console.warn(`[OnshapeReimportService] Duplicate source key on reimport (${key}) — keeping the first match.`)
        continue
      }
      newBySourceKey.set(key, p)
    }

    const summary = await this.carryOverPromises({ oldParts, oldSourceKeyById, oldJobs, oldCartItems, newBySourceKey })

    await this.logReimportChanges({ assemblyId, oldParts, newParts, actorId })

    const messageParts = [
      `Re-imported: ${partCount} part(s), ${childCount} subassembly(ies).`,
      `${summary.relinkedInventoryCount} part(s) kept their existing inventory links.`,
      summary.relinkedJobsCount ? `${summary.relinkedJobsCount} fabrication job(s) carried forward.` : null,
      summary.relinkedCartItemsCount ? `${summary.relinkedCartItemsCount} cart item(s) stayed earmarked to their part.` : null,
      summary.lostPartsWithLinksCount ? `${summary.lostPartsWithLinksCount} part(s) no longer in the BOM had their reserved inventory released.` : null,
      summary.lostJobsCount ? `${summary.lostJobsCount} fabrication job(s) could not be carried forward.` : null,
    ].filter(Boolean).join(' ')

    return { assemblyId, partCount, childCount, ...summary, message: messageParts }
  }

  /** For every OLD part, resolves whether a NEW part shares its source
   *  key (same underlying Onshape part) and, if so, carries its real
   *  inventory link + collected count, jobs, and cart earmarks onto the
   *  replacement row. A part with no match genuinely no longer exists
   *  in this BOM — its reserved inventory is released. */
  async carryOverPromises({ oldParts, oldSourceKeyById, oldJobs, oldCartItems, newBySourceKey }) {
    let relinkedInventoryCount = 0
    let lostPartsWithLinksCount = 0
    let relinkedJobsCount = 0
    let lostJobsCount = 0
    let relinkedCartItemsCount = 0

    const instancesToRelease = []
    const activeJobClaimedForNewPartId = new Set()

    for (const oldPart of oldParts) {
      const key = oldSourceKeyById[oldPart.id]
      const newPart = key ? newBySourceKey.get(key) : null

      if (!newPart) {
        if (oldPart.linkedInstanceIds?.length) {
          instancesToRelease.push(...oldPart.linkedInstanceIds)
          lostPartsWithLinksCount++
        }
        continue
      }

      if (oldPart.linkedInstanceIds?.length || oldPart.quantityCollected > 0) {
        try {
          await this.assemblyPartRepo.applyCarryOver(newPart.id, {
            linkedInstanceIds: oldPart.linkedInstanceIds || [],
            quantityCollected: oldPart.quantityCollected || 0,
            status: computePartStatus(oldPart.quantityCollected || 0, newPart.quantityNeeded),
          })
          relinkedInventoryCount++
        } catch (e) {
          console.warn(`[OnshapeReimportService] Failed carrying inventory links onto ${newPart.id}: ${e.message}`)
        }
      }
    }

    for (const job of oldJobs) {
      const oldPart = oldParts.find(p => p.id === job.assemblyPartId)
      const key = oldPart ? oldSourceKeyById[oldPart.id] : null
      const newPart = key ? newBySourceKey.get(key) : null

      if (!newPart) { lostJobsCount++; continue }

      const isActive = job.status !== 'complete' && job.status !== 'archived'
      if (isActive) {
        if (activeJobClaimedForNewPartId.has(newPart.id)) {
          console.warn(`[OnshapeReimportService] Skipping duplicate active job for part ${newPart.id} on reimport.`)
          lostJobsCount++
          continue
        }
        activeJobClaimedForNewPartId.add(newPart.id)
      }

      try {
        await this.fabricationJobRepo.insertCarryOver({
          id: genId(), batchId: job.batchId, assemblyPartId: newPart.id,
          quantityRequested: job.quantityRequested, quantityMachined: job.quantityMachined,
          status: job.status, claimedBy: job.claimedBy, claimedAt: job.claimedAt,
          notes: job.notes, createdAt: job.createdAt,
        })
        relinkedJobsCount++
      } catch (e) {
        console.warn(`[OnshapeReimportService] Failed relinking fabrication job onto ${newPart.id}: ${e.message}`)
        lostJobsCount++
      }
    }

    for (const item of oldCartItems) {
      const oldPart = oldParts.find(p => p.id === item.assemblyPartId)
      const key = oldPart ? oldSourceKeyById[oldPart.id] : null
      const newPart = key ? newBySourceKey.get(key) : null
      if (!newPart) continue

      try {
        await this.cartItemRepo.updateAssemblyPartId(item.id, newPart.id)
        relinkedCartItemsCount++
      } catch (e) {
        console.warn(`[OnshapeReimportService] Failed relinking cart item ${item.id} onto ${newPart.id}: ${e.message}`)
      }
    }

    if (instancesToRelease.length) {
      try { await this.inventoryInstanceRepo.releaseMany(instancesToRelease) }
      catch (e) { console.warn(`[OnshapeReimportService] Failed releasing instances for removed parts: ${e.message}`) }
    }

    return { relinkedInventoryCount, lostPartsWithLinksCount, relinkedJobsCount, lostJobsCount, relinkedCartItemsCount }
  }

  /** One commit summarizing the reimport: a part/child-count diff on
   *  the assembly itself, plus one delete row for every part that
   *  genuinely dropped out and one create row for every genuinely new
   *  part. Carried-over parts (same source key either side) are not
   *  re-logged — nothing about their identity changed. */
  async logReimportChanges({ assemblyId, oldParts, newParts, actorId }) {
    const commitId = this.changeLogRepo.newCommitId()

    const oldKeys = new Set(oldParts.map(p => buildSourceKey(p.onshapeReference)).filter(Boolean))
    const newKeys = new Set(newParts.map(p => buildSourceKey(p.onshapeReference)).filter(Boolean))

    await this.changeLogRepo.record({
      entityType: 'assembly', entityId: assemblyId, action: 'update', field: 'reimport',
      oldValue: { partCount: oldParts.length }, newValue: { partCount: newParts.length },
      actorId, commitId,
    })

    for (const p of oldParts) {
      const key = buildSourceKey(p.onshapeReference)
      if (key && newKeys.has(key)) continue
      await this.changeLogRepo.record({
        entityType: 'assembly_part', entityId: p.id, action: 'delete',
        oldValue: p, actorId, commitId,
        causedByEntityType: 'assembly', causedByEntityId: assemblyId,
      })
    }

    for (const p of newParts) {
      const key = buildSourceKey(p.onshapeReference)
      if (key && oldKeys.has(key)) continue
      await this.changeLogRepo.record({
        entityType: 'assembly_part', entityId: p.id, action: 'create',
        newValue: p, actorId, commitId,
        causedByEntityType: 'assembly', causedByEntityId: assemblyId,
      })
    }
  }
}
