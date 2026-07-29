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
import { ChangeLogRepository } from '../repositories/ChangeLogRepository.js'
import { ValidationError } from '../repositories/errors.js'

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
    changeLogRepo = new ChangeLogRepository(),
  } = {}) {
    this.partRepo      = partRepo
    this.changeLogRepo = changeLogRepo
  }

  async getById(partId) {
    return this.partRepo.findById(partId)
  }

  async listForAssembly(assemblyId) {
    return this.partRepo.findForOwner({ assemblyId })
  }

  async listForChild(assemblyChildId) {
    return this.partRepo.findForOwner({ assemblyChildId })
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
}
