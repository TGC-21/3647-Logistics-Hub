// services/AssemblyService.js
//
// Migration Plan Phase 1, item 8 ("Assembly / Assembly Children CRUD +
// cascade delete"). Per the plan's own framing, this is mostly a
// lift-and-shift: src/designer/versionedMutations.js's
// deleteAssemblyWithHistory was already shaped like a service method
// (snapshot → cleanup → delete → log) — it just lived on the client,
// talking to Supabase with the anon key, alongside a couple of thin
// upsert wrappers (upsertAssemblyVersioned) for the plain rename/create
// flow. This file gives both a server-side home behind repositories,
// same discipline every other service in this migration follows.
//
// Deliberately scoped to ROOT assemblies only, matching the plan's
// bullet — assembly_children rows are never created or edited directly
// by a user (they only ever come from an Onshape import, see
// OnshapeImportService/OnshapeReimportService), so this service has no
// createChild/updateChild methods. AssemblyChildRepository's role here
// is read-only: walking the subtree so cascade delete can snapshot it
// before the DB's own FK cascade removes it.
//
// No @supabase/supabase-js import, no req/res.

import { AssemblyRepository } from '../repositories/AssemblyRepository.js'
import { AssemblyChildRepository } from '../repositories/AssemblyChildRepository.js'
import { AssemblyPartRepository } from '../repositories/AssemblyPartRepository.js'
import { CartItemRepository } from '../repositories/CartItemRepository.js'
import { InventoryInstanceRepository } from '../repositories/InventoryInstanceRepository.js'
import { ChangeLogRepository } from '../repositories/ChangeLogRepository.js'
import { ValidationError } from '../repositories/errors.js'

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

export class AssemblyService {
  constructor({
    assemblyRepo          = new AssemblyRepository(),
    assemblyChildRepo      = new AssemblyChildRepository(),
    assemblyPartRepo       = new AssemblyPartRepository(),
    cartItemRepo           = new CartItemRepository(),
    inventoryInstanceRepo  = new InventoryInstanceRepository(),
    changeLogRepo          = new ChangeLogRepository(),
  } = {}) {
    this.assemblyRepo         = assemblyRepo
    this.assemblyChildRepo    = assemblyChildRepo
    this.assemblyPartRepo     = assemblyPartRepo
    this.cartItemRepo         = cartItemRepo
    this.inventoryInstanceRepo = inventoryInstanceRepo
    this.changeLogRepo        = changeLogRepo
  }

  async listAssemblies() {
    return this.assemblyRepo.findAll()
  }

  /** Plain "New assembly" creation — no Onshape link. A user links one
   *  later via the separate Onshape import flow, same as today. */
  async createAssembly({ name, description = '', onshapeUrl = '', status = 'draft', actorId = null }) {
    const trimmedName = (name || '').trim()
    if (!trimmedName) throw new ValidationError('name is required')
    if (!['draft', 'active', 'complete'].includes(status)) {
      throw new ValidationError(`Invalid status "${status}" — expected draft, active, or complete.`)
    }

    const assembly = await this.assemblyRepo.insert({ id: genId(), name: trimmedName, description, onshapeUrl, status })

    await this.changeLogRepo.record({
      entityType: 'assembly', entityId: assembly.id, action: 'create',
      newValue: assembly, actorId, commitId: this.changeLogRepo.newCommitId(),
    })

    return assembly
  }

  /** Edits the fields a user can actually change from the Edit
   *  assembly modal — name/description/onshapeUrl/status. Logs a
   *  field-level diff under one commit, same convention
   *  recordUpdateDiff already established client-side. */
  async updateAssembly({ assemblyId, name, description, onshapeUrl, status, thumbnailUrl, onshapeDocumentId, onshapeWorkspaceId, onshapeElementId, actorId = null }) {
    const before = await this.assemblyRepo.requireById(assemblyId)

    if (name !== undefined && !name.trim()) throw new ValidationError('name cannot be blank')
    if (status !== undefined && !['draft', 'active', 'complete'].includes(status)) {
      throw new ValidationError(`Invalid status "${status}" — expected draft, active, or complete.`)
    }

    const patch = {}
    if (name !== undefined)               patch.name = name.trim()
    if (description !== undefined)        patch.description = description
    if (onshapeUrl !== undefined)         patch.onshapeUrl = onshapeUrl
    if (status !== undefined)             patch.status = status
    if (thumbnailUrl !== undefined)       patch.thumbnailUrl = thumbnailUrl
    if (onshapeDocumentId !== undefined)  patch.onshapeDocumentId = onshapeDocumentId
    if (onshapeWorkspaceId !== undefined) patch.onshapeWorkspaceId = onshapeWorkspaceId
    if (onshapeElementId !== undefined)   patch.onshapeElementId = onshapeElementId

    const after = await this.assemblyRepo.update(assemblyId, patch)

    const commitId = this.changeLogRepo.newCommitId()
    for (const field of ['name', 'description', 'onshapeUrl', 'status', 'thumbnail', 'onshapeDocumentId', 'onshapeWorkspaceId', 'onshapeElementId']) {
      if (before[field] === after[field]) continue
      await this.changeLogRepo.record({
        entityType: 'assembly', entityId: assemblyId, action: 'update', field,
        oldValue: before[field], newValue: after[field], actorId, commitId,
      })
    }

    return after
  }

  /**
   * Deletes a root assembly and its ENTIRE tree — every nested
   * assembly_children node at any depth, and every assembly_parts row
   * anywhere in that tree. Snapshots everything BEFORE any delete
   * happens, so every row gets its own DELETE change_log entry, all
   * sharing one commitId and tagged causedByEntityType/causedByEntityId
   * pointing at the root assembly — exactly
   * deleteAssemblyWithHistory's contract, just repository-backed.
   *
   * Order matters and mirrors the client version:
   *   1. snapshot (children + parts, full tree)
   *   2. release every linked inventory instance back to available
   *   3. delete 'pending' cart items earmarked into the tree (ordered/
   *      received ones survive un-earmarked via the FK)
   *   4. delete the assembly row itself (cascades children + parts)
   *   5. log everything, now that the delete is known to have succeeded
   */
  async deleteAssemblyWithCascade({ assemblyId, actorId = null }) {
    const assembly = await this.assemblyRepo.requireById(assemblyId)

    // 1. Snapshot
    const childSnapshots = await this.assemblyChildRepo.findWholeTree(assemblyId)
    const partSnapshots  = await this.assemblyPartRepo.findTreeForAssembly(assemblyId)

    // 2. Release linked inventory
    const linkedIds = partSnapshots.flatMap(p => p.linkedInstanceIds || [])
    if (linkedIds.length) await this.inventoryInstanceRepo.releaseMany(linkedIds)

    // 3. Clean up pending cart items
    const partIds = partSnapshots.map(p => p.id)
    if (partIds.length) await this.cartItemRepo.deletePendingForAssemblyPartIds(partIds)

    // 4. Delete (cascades assembly_children + assembly_parts)
    await this.assemblyRepo.deleteById(assemblyId)

    // 5. Log, now that the delete succeeded
    const commitId = this.changeLogRepo.newCommitId()

    await this.changeLogRepo.record({
      entityType: 'assembly', entityId: assemblyId, action: 'delete',
      oldValue: assembly, actorId, commitId,
    })

    for (const child of childSnapshots) {
      await this.changeLogRepo.record({
        entityType: 'assembly_child', entityId: child.id, action: 'delete',
        oldValue: child, actorId, commitId,
        causedByEntityType: 'assembly', causedByEntityId: assemblyId,
      })
    }

    for (const part of partSnapshots) {
      await this.changeLogRepo.record({
        entityType: 'assembly_part', entityId: part.id, action: 'delete',
        oldValue: part, actorId, commitId,
        causedByEntityType: 'assembly', causedByEntityId: assemblyId,
      })
    }

    return {
      deletedAssemblyId: assemblyId,
      deletedChildCount: childSnapshots.length,
      deletedPartCount:  partSnapshots.length,
      commitId,
    }
  }


}