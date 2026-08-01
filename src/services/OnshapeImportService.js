// services/OnshapeImportService.js
//
// Phase 1 part 6 of MIGRATION_PLAN.md — the "fetch/seed tree" half of
// api/onshape-bom.js's split (buildAssembly + seedAssemblyContents +
// seedSubassembliesConcurrently). OnshapeReimportService composes this
// service rather than duplicating its tree-seeding logic — reimport is
// "wipe, then seed again," and seeding is exactly what this class does.
//
// Deliberately does NOT re-implement Onshape fetching/BOM parsing —
// resolveBomWithSubassemblies, fetchDocumentOwnerId, MAX_CHILD_DEPTH,
// MAX_ONSHAPE_CONCURRENCY etc. in api/_lib/onshape.js are already pure
// (no SQL, no req/res) and are reused as-is, the same way a service is
// allowed to call another service. api/_lib/onshape.js is this
// codebase's "external API client" layer, not a repository — nothing
// about how it talks to Onshape belongs behind a DB repository
// boundary.
//
// No @supabase/supabase-js import, no req/res — only repositories and
// the Onshape client helpers.

import {
  resolveBomWithSubassemblies, fetchBom, parseBomRows, fetchDocumentOwnerId,
  MAX_CHILD_DEPTH, MAX_ONSHAPE_CONCURRENCY,
} from '../../api/_lib/onshape.js'
import { AssemblyRepository } from '../repositories/AssemblyRepository.js'
import { AssemblyChildRepository } from '../repositories/AssemblyChildRepository.js'
import { AssemblyPartRepository } from '../repositories/AssemblyPartRepository.js'
import { PartNumberRepository } from '../repositories/PartNumberRepository.js'
import { ChangeLogRepository } from '../repositories/ChangeLogRepository.js'
import { ValidationError } from '../repositories/errors.js'

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

export class OnshapeImportService {
  constructor({
    assemblyRepo      = new AssemblyRepository(),
    assemblyChildRepo = new AssemblyChildRepository(),
    assemblyPartRepo  = new AssemblyPartRepository(),
    partNumberRepo    = new PartNumberRepository(),
    changeLogRepo     = new ChangeLogRepository(),
  } = {}) {
    this.assemblyRepo      = assemblyRepo
    this.assemblyChildRepo = assemblyChildRepo
    this.assemblyPartRepo  = assemblyPartRepo
    this.partNumberRepo    = partNumberRepo
    this.changeLogRepo     = changeLogRepo
  }

  /**
   * Creates a brand-new root assembly from an Onshape assembly element
   * and seeds its full tree (direct parts + recursively-resolved
   * subassembly nodes). Mirrors onshape-bom.js's buildAssembly — same
   * "delete the orphan assembly row if seeding fails partway through"
   * behavior, so a failed import never leaves an empty assembly behind.
   */
  async importAssembly({ documentId, workspaceId, elementId, name, thumbnailUrl = null, actorId = null }) {
    if (!documentId || !workspaceId || !elementId) {
      throw new ValidationError('documentId, workspaceId, and elementId are required')
    }

    const rootOwnerId = await fetchDocumentOwnerId(documentId)
    const assemblyId  = genId()
    const onshapeUrl  = `https://cad.onshape.com/documents/${documentId}/w/${workspaceId}/e/${elementId}`
    const assemblyName = name || `Onshape assembly — ${new Date().toLocaleDateString()}`

    const assembly = await this.assemblyRepo.insertRoot({
      id: assemblyId, name: assemblyName, description: `Linked from Onshape on ${new Date().toLocaleString()}`,
      onshapeUrl, onshapeDocumentId: documentId, onshapeWorkspaceId: workspaceId,
      onshapeElementId: elementId, thumbnailUrl,
    })

    let partCount, childCount
    try {
      const resolveCache = new Map()
      ;({ partCount, childCount } = await this.seedAssemblyContents({
        documentId, workspaceId, elementId, depth: 0, rootOwnerId,
        partsOwner:    { assemblyId },
        childrenOwner: { parentAssemblyId: assemblyId },
        resolveCache,
      }))
    } catch (e) {
      await this.assemblyRepo.deleteById(assemblyId)
      throw e
    }

    await this.changeLogRepo.record({
      entityType: 'assembly', entityId: assemblyId, action: 'create',
      newValue: { id: assemblyId, name: assemblyName }, actorId, commitId: this.changeLogRepo.newCommitId(),
    })

    return {
      assemblyId, partCount, childCount, onshapeUrl, assembly,
      message: `"${assemblyName}": ${partCount} part(s), ${childCount} subassembly(ies).`,
    }
  }

  /**
   * Writes parts + subassembly nodes owned by a single node (a root
   * assembly OR a subassembly node), then recurses into each
   * subassembly it finds. `partsOwner`/`childrenOwner` are
   * { assemblyId } / { assemblyChildId } and { parentAssemblyId } /
   * { parentChildId } respectively — exactly one of each pair, mirroring
   * onshape-bom.js's seedAssemblyContents. `resolveCache` is shared
   * across the WHOLE import tree (root call creates it) so a
   * subassembly instanced more than once anywhere is only ever fetched
   * once — see resolveBomWithSubassemblies's own cache param.
   */
  async seedAssemblyContents({ documentId, workspaceId, elementId, wvmType = 'w', depth, rootOwnerId, partsOwner, childrenOwner, resolveCache }) {
    let directParts   = []
    let subassemblies = []

    if (depth < MAX_CHILD_DEPTH) {
      const resolved = await resolveBomWithSubassemblies(documentId, workspaceId, elementId, wvmType, rootOwnerId, undefined, resolveCache)
      directParts   = resolved.directParts
      subassemblies = resolved.subassemblies
    } else {
      const bomData = await fetchBom(documentId, workspaceId, elementId, wvmType)
      directParts   = parseBomRows(bomData).parts
    }

    if (directParts.length) {
      await this.assemblyPartRepo.bulkInsert(directParts.map(p => ({
        id: genId(), ...partsOwner,
        partName: p.partName, partNumber: p.partNumber,
        quantityNeeded: p.quantity, quantityCollected: 0,
        status: 'pending', source: 'onshape', notes: '',
        onshapeReference: p.raw, fabricationMetadata: {},
      })))
    }

    // Best-effort part_numbers stubs, same as onshape-bom.js — a
    // failure here should never fail the whole import.
    for (const p of directParts) {
      if (!p.partNumber) continue
      try { await this.partNumberRepo.insert({ id: genId(), value: p.partNumber }) }
      catch (e) { console.warn(`[OnshapeImportService] part_numbers stub failed for "${p.partNumber}": ${e.message}`) }
    }

    const childCount = await this.seedSubassembliesConcurrently(subassemblies, { depth, rootOwnerId, childrenOwner, resolveCache })

    return { partCount: directParts.length, childCount }
  }

  /** Worker-pool fan-out over sibling subassemblies, capped at
   *  MAX_ONSHAPE_CONCURRENCY — same reasoning onshape-bom.js's version
   *  gives: a wide tree shouldn't fire dozens of simultaneous requests
   *  at Onshape just because a node happens to have many children. */
  async seedSubassembliesConcurrently(subassemblies, { depth, rootOwnerId, childrenOwner, resolveCache }) {
    let childCount = 0
    let cursor = 0

    const worker = async () => {
      while (cursor < subassemblies.length) {
        const sub = subassemblies[cursor++]
        const childId = genId()

        await this.assemblyChildRepo.insert({
          id: childId, ...childrenOwner,
          name: sub.partName,
          onshapeDocumentId:  sub.resolvedDocumentId,
          onshapeWorkspaceId: sub.resolvedWorkspaceId,
          onshapeWvmType:     sub.resolvedWvmType || 'w',
          onshapeElementId:   sub.resolvedElementId,
          quantity:           sub.quantity,
        })
        childCount++

        await this.seedAssemblyContents({
          documentId:  sub.resolvedDocumentId,
          workspaceId: sub.resolvedWorkspaceId,
          wvmType:     sub.resolvedWvmType || 'w',
          elementId:   sub.resolvedElementId,
          depth:       depth + 1,
          rootOwnerId,
          partsOwner:    { assemblyChildId: childId },
          childrenOwner: { parentChildId: childId },
          resolveCache,
        })
      }
    }

    const workerCount = Math.min(MAX_ONSHAPE_CONCURRENCY, subassemblies.length)
    await Promise.all(Array.from({ length: workerCount }, worker))
    return childCount
  }
}
