// services/AssemblyPartService.js
//
// Migration Plan Phase 1, item 2. `computePartStatus` and
// `derivedAssemblyStatus` currently exist independently in three places:
//   - src/designer/state.js (client render logic)
//   - server-side, inline, in api/onshape-bom.js's computePartStatus
//     helper (reimport carry-over)
//   - implicitly duplicated wherever a caller sets `.status` by hand
//     instead of calling either of the above (src/designer/partsTable.js's
//     savePart, for one)
// This service is the single home for "given collected vs. needed, what
// is this part's status" going forward. It does NOT replace the
// client's state.js helpers outright in this pass (that's Plan Phase 2,
// caller cutover) — it gives every future write-path service
// (InventoryReservationService, the eventual FabricationDetectionService)
// one place to call instead of re-deriving the same three-line
// if/else themselves.

import { AssemblyPartRepository } from '../repositories/AssemblyPartRepository.js'
import { InventoryInstanceRepository } from '../repositories/InventoryInstanceRepository.js'
import { ChangeLogRepository } from '../repositories/ChangeLogRepository.js'
import { ValidationError } from '../repositories/errors.js'

// Missing from this file — every sibling service (AgendaService,
// CartService, CategoryService, ComponentService, etc.) defines its own
// local copy of this same helper. createPart() below calls genId()
// without it, which would throw a ReferenceError at runtime.
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

/** Pure function — no repository, no I/O. Exported so both this service
 *  and (eventually) a route-level bulk-status endpoint can call it
 *  without an object round-trip for a trivial calculation. Mirrors
 *  designer/state.js's computePartStatus exactly. */
export function computePartStatus({ quantityCollected, quantityNeeded }) {
  const collected = quantityCollected || 0
  if (collected >= quantityNeeded) return 'complete'
  if (collected > 0) return 'partial'
  return 'pending'
}

/** Pure function mirroring designer/state.js's derivedAssemblyStatus —
 *  given every part belonging to one assembly, what should the
 *  assembly's own overall status be. */
export function derivedAssemblyStatus(parts) {
  if (!parts.length) return 'draft'
  if (parts.every(p => computePartStatus(p) === 'complete')) return 'complete'
  if (parts.some(p => computePartStatus(p) !== 'pending')) return 'active'
  return 'draft'
}

export class AssemblyPartService {
  constructor({
    partRepo      = new AssemblyPartRepository(),
    instanceRepo  = new InventoryInstanceRepository(),
    changeLogRepo = new ChangeLogRepository(),
  } = {}) {
    this.partRepo      = partRepo
    this.instanceRepo  = instanceRepo
    this.changeLogRepo = changeLogRepo
  }

  async getById(partId) {
    return this.partRepo.findById(partId)
  }

  async listForAssembly({ assemblyId }) {
    if (!assemblyId) throw new ValidationError('assemblyId is required')
    return this.partRepo.findForOwner({ assemblyId })
  }

  async listForChild({ assemblyChildId }) {
    return this.partRepo.findForOwner({ assemblyChildId })
  }

  /** Returns every part in a root assembly, including all nested
   * subassemblies. This is the read surface for questions such as "what
   * parts are in Intake?"; callers should not have to infer completeness
   * from a sequence of root/direct-child reads. */
  async listTreeForAssembly({ assemblyId }) {
    if (!assemblyId) throw new ValidationError('assemblyId is required')
    return this.partRepo.findTreeForAssembly(assemblyId)
  }

  /** Focused read surface for the harness. Searches names, part numbers, and
   * notes server-side so the model does not have to enumerate part records. */
  async search({ query, assemblyId = null }) {
    const needle = String(query || '').trim().toLowerCase()
    if (!needle) throw new ValidationError('query is required')
    const parts = assemblyId
      ? await this.partRepo.findTreeForAssembly(assemblyId)
      : await this.partRepo.findAll()
    return parts.filter(part => [part.partName, part.partNumber, part.notes]
      .some(value => String(value || '').toLowerCase().includes(needle)))
      .map(part => ({
        id: part.id, assemblyId: part.assemblyId, assemblyChildId: part.assemblyChildId,
        partName: part.partName, partNumber: part.partNumber,
        quantityNeeded: part.quantityNeeded, quantityCollected: part.quantityCollected,
        status: part.status, fabricationKind: part.fabricationMetadata?.kind ?? null,
      }))
  }

  /** Re-reads the current row and writes back whatever `status`
   *  computePartStatus derives from it — the one place every other
   *  service calls after touching quantityCollected, instead of
   *  computing status inline and passing it along as part of a larger
   *  patch (which is how the duplication crept in across three files in
   *  the first place). No-ops the write if status already matches. */
  async recomputeStatus({ partId, actorId = null }) {
    const part = await this.partRepo.findById(partId)
    const nextStatus = computePartStatus(part)
    if (nextStatus === part.status) return part

    const updated = await this.partRepo.updateReservationFields(partId, { status: nextStatus })

    await this.changeLogRepo.record({
      entityType: 'assembly_part', entityId: partId, action: 'update', field: 'status',
      oldValue: part.status, newValue: nextStatus,
      actorId, commitId: this.changeLogRepo.newCommitId(),
    })

    return updated
  }

  /** Redefining the requirement itself (Add/Edit part modal), not
   *  fulfilling it — kept distinct from reservation writes. Recomputes
   *  status afterward since shrinking quantityNeeded below what's
   *  already collected can flip a 'partial' part to 'complete'. */
  async updateQuantityNeeded({ partId, quantityNeeded, actorId = null }) {
    if (!Number.isInteger(quantityNeeded) || quantityNeeded <= 0) {
      throw new ValidationError('quantityNeeded must be a positive integer')
    }
    const before = await this.partRepo.findById(partId)
    await this.partRepo.updateQuantityNeeded(partId, quantityNeeded)

    await this.changeLogRepo.record({
      entityType: 'assembly_part', entityId: partId, action: 'update', field: 'quantityNeeded',
      oldValue: before.quantityNeeded, newValue: quantityNeeded,
      actorId, commitId: this.changeLogRepo.newCommitId(),
    })

    return this.recomputeStatus({ partId, actorId })
  }

  /** Computes what the OWNING assembly's overall status should be,
   *  given its current parts — callers (e.g. a future AssemblyService)
   *  still own actually writing that onto the assemblies row; this
   *  method only answers the question, consistent with repositories/
   *  services never reaching across domain boundaries to write tables
   *  they don't own. */
  async computeOwnerStatus({ assemblyId }) {
    const parts = await this.partRepo.findForOwner({ assemblyId })
    return derivedAssemblyStatus(parts)
  }

  /** Manual "Add part" — as opposed to bulkInsert (Onshape/CSV import),
   *  which stays on AssemblyPartRepository directly since those flows
   *  aren't migrated yet. Exactly one owner (assemblyId XOR
   *  assemblyChildId) is required, same constraint the DB itself
   *  enforces (assembly_parts_exactly_one_owner) — checked here first
   *  so a caller bug surfaces as a clean ValidationError instead of a
   *  raw Postgres constraint violation. */
  async createPart({ assemblyId = null, assemblyChildId = null, partName, partNumber = '', quantityNeeded = 1, notes = '', actorId = null }) {
    if (!partName || !partName.trim()) throw new ValidationError('Part name is required')
    if (!Number.isInteger(quantityNeeded) || quantityNeeded <= 0) {
      throw new ValidationError('quantityNeeded must be a positive integer')
    }
    if (!!assemblyId === !!assemblyChildId) {
      throw new ValidationError('A part must belong to exactly one of assemblyId or assemblyChildId')
    }

    const part = await this.partRepo.insert({
      id: genId(),
      assemblyId, assemblyChildId,
      partName: partName.trim(), partNumber, quantityNeeded,
      quantityCollected: 0, status: 'pending', source: 'manual', notes,
    })

    await this.changeLogRepo.record({
      entityType: 'assembly_part', entityId: part.id, action: 'create',
      newValue: part, actorId, commitId: this.changeLogRepo.newCommitId(),
    })

    return part
  }

  /** Manual "Edit part" — name/number/quantity/notes, the fields the
   *  Add/Edit modal actually exposes. Deliberately does not touch
   *  componentId/linkedInstanceIds/quantityCollected (reservation
   *  bookkeeping — InventoryReservationService's domain) or
   *  fabricationMetadata (FabricationDetectionService's, once that
   *  cuts over). Recomputes status afterward, same reasoning
   *  updateQuantityNeeded already documents (shrinking the requirement
   *  can flip partial -> complete). */
  async updatePart({ partId, partName, partNumber = '', quantityNeeded, notes = '', actorId = null }) {
    if (!partName || !partName.trim()) throw new ValidationError('Part name is required')
    if (!Number.isInteger(quantityNeeded) || quantityNeeded <= 0) {
      throw new ValidationError('quantityNeeded must be a positive integer')
    }

    const before = await this.partRepo.findById(partId)
    await this.partRepo.updateFields(partId, {
      partName: partName.trim(), partNumber, quantityNeeded, notes,
    })

    const commitId = this.changeLogRepo.newCommitId()
    const diffs = [
      ['partName', before.partName, partName.trim()],
      ['partNumber', before.partNumber, partNumber],
      ['quantityNeeded', before.quantityNeeded, quantityNeeded],
      ['notes', before.notes, notes],
    ]
    for (const [field, oldValue, newValue] of diffs) {
      if (oldValue !== newValue) {
        await this.changeLogRepo.record({
          entityType: 'assembly_part', entityId: partId, action: 'update', field,
          oldValue, newValue, actorId, commitId,
        })
      }
    }

    return this.recomputeStatus({ partId, actorId })
  }

  /** Manual "Delete part" — releases any reserved inventory back to
   *  available FIRST (same order the old client-side deletePart/
   *  deleteChildPart click handlers used: release, then delete), then
   *  removes the row. A part with no linkedInstanceIds skips the
   *  release call entirely rather than paying an empty-array round trip. */
  async deletePart({ partId, actorId = null }) {
    const part = await this.partRepo.findById(partId)

    if (part.linkedInstanceIds?.length) {
      await this.instanceRepo.releaseMany(part.linkedInstanceIds)
    }

    await this.partRepo.deleteById(partId)

    await this.changeLogRepo.record({
      entityType: 'assembly_part', entityId: partId, action: 'delete',
      oldValue: part, actorId, commitId: this.changeLogRepo.newCommitId(),
    })

    return { deletedPartId: partId, releasedInstanceCount: part.linkedInstanceIds?.length || 0 }
  }

  /** "Send to Fabricate" step 1's "use an existing catalog component"
   *  path (src/designer/fabricateFlow.js's selectFabComponent) — links
   *  a part to an already-resolved component, nothing else. Deliberately
   *  narrower than updatePart (name/number/qty/notes) and separate from
   *  FabricationDetectionService's componentId+fabricationMetadata
   *  combined write — this one only ever touches componentId. */
  async linkComponent({ partId, componentId, actorId = null }) {
    if (!componentId) throw new ValidationError('componentId is required')

    const before = await this.partRepo.findById(partId)
    const after  = await this.partRepo.updateReservationFields(partId, { componentId })

    if (before.componentId !== after.componentId) {
      await this.changeLogRepo.record({
        entityType: 'assembly_part', entityId: partId, action: 'update', field: 'componentId',
        oldValue: before.componentId, newValue: after.componentId,
        actorId, commitId: this.changeLogRepo.newCommitId(),
      })
    }

    return after
  }
}
