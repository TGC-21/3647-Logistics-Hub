// services/InventoryInstanceService.js
//
// Migration: Inventory Instance CRUD — the last domain still on raw
// src/db.js (see the roadmap in conversation). Owns the write rules
// currently duplicated inline in src/main.js's saveItem/deleteFromDetail
// click handlers:
//
//   - creating/editing an instance always resolves (find-or-creates) the
//     (category, attres) component it belongs to FIRST, via
//     ComponentService.findOrCreate — an instance never exists without
//     a resolved component identity, same rule db.js's old
//     findOrCreateComponent enforced inline in saveItem
//   - editing an instance that re-parents it onto a DIFFERENT component
//     (changing category or a required attribute) must orphan-check the
//     OLD component afterward — main.js's saveItem does this by hand
//     today (fetchInstanceCountsForComponents + deleteComponentIfOrphaned)
//   - deleting an instance must first unreserve it from every assembly
//     part that currently has it linked (fetchAssemblyPartsLinkingInstance
//     + one unreserve() call per part in main.js's deleteFromDetail
//     today), THEN delete the row, THEN orphan-check its component
//
// Deliberately does NOT touch Supabase Storage (image upload/removal) —
// that's a file-upload concern, not a table write, and stays exactly
// where it already is: the browser calling db.js's uploadImage/
// deleteImage directly with the anon key. This service only ever
// receives an already-resolved image URL (or null) and writes it to the
// `image_url` column like any other field. Callers (main.js) are
// responsible for uploading first and passing the resulting URL in.
//
// No @supabase/supabase-js import, no req/res.

import { InventoryInstanceRepository } from '../repositories/InventoryInstanceRepository.js'

import { CategoryRepository } from '../repositories/CategoryRepository.js'
import { ChangeLogRepository } from '../repositories/ChangeLogRepository.js'
import { ComponentService } from './ComponentService.js'

import { ChangeLogService } from './ChangeLogService.js'
import { ValidationError } from '../repositories/errors.js'
import { runBulk } from '../../backend/_lib/bulkOps.js'

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }
// Fixed name for the fallback category a component resolves to when the
// user saves an instance with no category picked. Mirrors
// FabricationDetectionService's _ensureCategory / fabricateFlow.js's
// ensureCustomPartCategory — find-or-create by a well-known name, no
// required characteristics, rather than loosening
// ComponentService.findOrCreate's "categoryId is required" rule (that
// rule stays load-bearing for every OTHER caller).
const UNCATEGORIZED_CATEGORY_NAME = 'Uncategorized'
const PATCHABLE_KEYS = ['name', 'description', 'image', 'location', 'quantity', 'tags', 'status', 'notes']

export class InventoryInstanceService {
  constructor({
    instanceRepo        = new InventoryInstanceRepository(),

    categoryRepo        = new CategoryRepository(),
    changeLogRepo       = new ChangeLogRepository(),
    componentService    = new ComponentService({ categoryRepo, changeLogRepo }),

    changeLogService    = new ChangeLogService({ changeLogRepo }),
  } = {}) {
    this.instanceRepo       = instanceRepo

    this.categoryRepo       = categoryRepo
    this.changeLogRepo      = changeLogRepo
    this.componentService   = componentService

    this.changeLogService   = changeLogService
  }

 /** Returns `categoryId` unchanged if given, otherwise resolves (or
   *  creates, on first use) the fixed "Uncategorized" category and
   *  returns ITS id — so a user saving an instance with no category
   *  picked still gets a component with a real categoryId, satisfying
   *  ComponentService.findOrCreate's invariant instead of requiring an
   *  exception to it. */
  async _resolveCategoryId(categoryId) {
    if (categoryId) return categoryId
    const existing = await this.categoryRepo.findByName(UNCATEGORIZED_CATEGORY_NAME)
    if (existing) return existing.id
    const created = await this.categoryRepo.insert({ id: genId(), name: UNCATEGORIZED_CATEGORY_NAME, requiredKeysConfig: [] })
    return created.id
  }

  async getById(id) {
    return this.instanceRepo.findById(id)
  }

  async listAll() {
    return this.instanceRepo.findAll()
  }

  async listForComponent(componentId) {
    return this.instanceRepo.findByComponent(componentId)
  }

  /** Links an already-uploaded image (including a chat attachment) to an
   * inventory instance without requiring the full component edit payload. */
  async linkImage({ instanceId, imageUrl, actorId = null }) {
    if (!instanceId) throw new ValidationError('instanceId is required')
    if (!imageUrl || typeof imageUrl !== 'string') throw new ValidationError('imageUrl is required')
    const before = await this.instanceRepo.findById(instanceId)
    if (!before) throw new ValidationError(`Inventory instance ${instanceId} not found`)
    const after = await this.instanceRepo.update(instanceId, { image: imageUrl })
    await this.changeLogService.recordUpdateDiff({
      entityType: 'inventory_instance', entityId: instanceId,
      before, after, keys: ['image'], actorId,
      commitId: this.changeLogRepo.newCommitId(),
    })
    return after
  }

  async listForComponents({ componentIds }) {
    return this.instanceRepo.findByComponentIds(componentIds)
  }
  /**
   * Creates a brand-new instance. Resolves (or creates) the component it
   * belongs to first — `categoryId`/`attrs`/`fallback` are the exact
   * shape ComponentService.findOrCreate already expects (fallback seeds
   * fallback_name/description/image ONLY if this call actually creates
   * a new component).
   */
  async createInstance({ categoryId, attrs, fallback = null, name, description = '', image = null, location = '', quantity = 0, tags = [], notes = '', actorId = null }) {
    if (!name || !name.trim()) throw new ValidationError('name is required')

    const resolvedCategoryId = await this._resolveCategoryId(categoryId)
    const component = await this.componentService.findOrCreate({ categoryId: resolvedCategoryId, attrs, fallback, actorId })

    const instance = await this.instanceRepo.insert({
      id: genId(), componentId: component.id,
      name: name.trim(), description, image, location, quantity, tags, status: 'available', notes,
    })

    await this.changeLogRepo.record({
      entityType: 'inventory_instance', entityId: instance.id, action: 'create',
      newValue: instance, actorId, commitId: this.changeLogRepo.newCommitId(),
    })

    return instance
  }

  /**
   * Edits an existing instance's own fields AND re-resolves its
   * component from the (possibly changed) category/attrs — mirrors
   * saveItem's "component may fork or re-parent on edit" behavior
   * exactly. If the resolved component differs from the instance's
   * previous one, the OLD component is orphan-checked afterward (same
   * order main.js already used: write the instance first, THEN check
   * whether the component it left behind is now unreferenced).
   */
  async updateInstance({ instanceId, categoryId, attrs, fallback = null, name, description = '', image = null, location = '', quantity = 0, tags = [], notes = '', actorId = null }) {
    if (!name || !name.trim()) throw new ValidationError('name is required')

    const before = await this.instanceRepo.findById(instanceId)
    if (!before) throw new ValidationError(`Inventory instance ${instanceId} not found`)

    const resolvedCategoryId = await this._resolveCategoryId(categoryId)
    const component = await this.componentService.findOrCreate({ categoryId: resolvedCategoryId, attrs, fallback, actorId })

    const after = await this.instanceRepo.update(instanceId, {
      componentId: component.id,
      name: name.trim(), description, image, location, quantity, tags, notes,
    })

    const commitId = this.changeLogRepo.newCommitId()
    await this.changeLogService.recordUpdateDiff({
      entityType: 'inventory_instance', entityId: instanceId,
      before, after, keys: [...PATCHABLE_KEYS, 'componentId'],
      actorId, commitId,
    })

    if (before.componentId && before.componentId !== component.id) {
      const counts = await this.instanceRepo.countsByComponentIds([before.componentId])
      const instanceCount = counts[before.componentId]?.total ?? 0
      await this.componentService.deleteIfOrphaned({ componentId: before.componentId, instanceCount, actorId })
    }

    return after
  }

  /**
   * Deletes an instance outright. Order matters and mirrors
   * deleteFromDetail exactly: unreserve it from every assembly part
   * that currently links it (so those parts' quantityCollected/status
   * don't end up pointing at a row that no longer exists), THEN delete
   * the row, THEN orphan-check its component. Returns how many parts
   * had to be unreserved, mainly for a caller's own toast/log message.
   */
  async deleteInstance({ instanceId, actorId = null }) {
    const instance = await this.instanceRepo.findById(instanceId)
    if (!instance) throw new ValidationError(`Inventory instance ${instanceId} not found`)

  
    await this.instanceRepo.deleteById(instanceId)

    const counts = await this.instanceRepo.countsByComponentIds([instance.componentId])
    const instanceCount = counts[instance.componentId]?.total ?? 0
    const componentDeleted = await this.componentService.deleteIfOrphaned({ componentId: instance.componentId, instanceCount, actorId })

    await this.changeLogRepo.record({
      entityType: 'inventory_instance', entityId: instanceId, action: 'delete',
      oldValue: instance, actorId, commitId: this.changeLogRepo.newCommitId(),
    })

    return { deletedInstanceId: instanceId, unreservedPartCount: linkingParts.length, componentDeleted }
  }

  async getByIds({ instanceIds }) {
    if (!Array.isArray(instanceIds) || !instanceIds.length) throw new ValidationError('instanceIds is required')
    return this.instanceRepo.findByIds(instanceIds)
  }

  async bulkDeleteInstances({ instanceIds, actorId = null }) {
    return runBulk(instanceIds.map(instanceId => ({ instanceId })), (u) => this.deleteInstance({ ...u, actorId }), { keyOf: u => u.instanceId })
  }
}
