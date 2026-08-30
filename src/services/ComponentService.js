// services/ComponentService.js
//
// Migration Plan Phase 1, item 3. Owns "what makes two components the
// same" — today re-derived independently in src/db.js's
// findOrCreateComponent, called near-identically from three separate
// client call sites (src/main.js's saveItem, src/designer/fabDetection.js's
// three confirm*Detection functions, src/designer/fabricateFlow.js's
// confirmFabEstablishComponent). This service is the one home for that
// operation going forward — Plan item 4 (fab detection confirm) will be
// built directly on top of it rather than duplicating it a fourth time.
//
// The actual signature/canonicalization rules are NOT re-implemented
// here — src/componentMatch.js's buildComponentSignature is pure logic
// (no DOM, no Supabase, no @supabase/supabase-js) already shared by
// every client call site, so this service imports it directly rather
// than forking a second copy that could drift from the client's. That
// keeps "how two components compare as equal" a single source of truth
// on both sides of the eventual client/route boundary.

import { ComponentRepository } from '../repositories/ComponentRepository.js'
import { CategoryRepository } from '../repositories/CategoryRepository.js'
import { ChangeLogRepository } from '../repositories/ChangeLogRepository.js'
import { ValidationError } from '../repositories/errors.js'
import { validateRequiredAttributes, reconcileAttrKeys } from './CategoryService.js'
import { buildComponentSignature } from '../componentMatch.js'

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

export class ComponentService {
  constructor({
    componentRepo = new ComponentRepository(),
    categoryRepo  = new CategoryRepository(),
    changeLogRepo = new ChangeLogRepository(),
  } = {}) {
    this.componentRepo = componentRepo
    this.categoryRepo  = categoryRepo
    this.changeLogRepo = changeLogRepo
  }

  /**
   * Finds an existing component matching (categoryId, attrs) per the
   * category's requiredKeysConfig typing rules, or creates a new one.
   * `attrs` is a plain { key: value } map (not the DB's [{key,value}]
   * array shape — same contract src/db.js's findOrCreateComponent
   * already established for every caller).
   *
   * `fallback` seeds fallback_name/description/image ONLY on create —
   * matching an existing component never overwrites its fallback
   * display info as a side effect of this call.
   */
  async findOrCreate({ categoryId, attrs, fallback, actorId = null }) {
    if (!categoryId) throw new ValidationError('categoryId is required')

    const category = await this.categoryRepo.findById(categoryId)
    const fields = category.requiredKeysConfig || []

    // Reconcile attrs keys against the category's own key spelling
    // before validating. LLM-produced keys reliably drift in
    // cosmetic-only ways — "Chain_size" for "Chain size", "chain size"
    // for "Chain Size", stray whitespace — that a strict equality
    // check would (correctly, but unhelpfully) reject even though the
    // model clearly meant the real required key. reconcileAttrKeys
    // rewrites any attrs key that normalizes to the same thing as a
    // required key onto that key's canonical spelling; anything left
    // over is a genuinely different/unmatched key, which
    // validateRequiredAttributes below will still catch normally
    // (e.g. a truly missing key, or sentinel-token corruption that
    // survived toolSchema.js's sanitization).
    const reconciledAttrs = reconcileAttrKeys(attrs || {}, fields)

    if (fields.length) {
      const attributesArrayForValidation = Object.entries(reconciledAttrs).map(([key, value]) => ({ key, value }))
      const { valid, errors } = validateRequiredAttributes(attributesArrayForValidation, fields)
      if (!valid) {
        const detail = Object.entries(errors).map(([key, msg]) => `"${key}": ${msg}`).join('; ')
        const error = new ValidationError(`Attributes do not satisfy category "${category.name}"'s required characteristics — ${detail}`)
        error.details = { categoryId, fields: errors, allowed: Object.fromEntries(fields.filter(f => f.type === 'enum').map(f => [f.key, f.options || []])) }
        throw error
      }
    }

    const signature = buildComponentSignature(categoryId, fields, reconciledAttrs)

    const candidates = await this.componentRepo.findByCategory(categoryId)
    const match = candidates.find(c => {
      const existingAttrs = Object.fromEntries((c.attributes || []).map(a => [a.key, a.value]))
      return buildComponentSignature(categoryId, fields, existingAttrs) === signature
    })
    if (match) return match

    const attributesArray = Object.entries(reconciledAttrs).map(([key, value]) => ({ key, value }))

    const created = await this.componentRepo.insert({
      id:                   genId(),
      categoryId,
      attributes:           attributesArray,
      fallbackName:         fallback?.name ?? '',
      fallbackDescription:  fallback?.description ?? '',
      fallbackImage:        fallback?.image ?? null,
    })

    await this.changeLogRepo.record({
      entityType: 'component', entityId: created.id, action: 'create',
      newValue: created, actorId, commitId: this.changeLogRepo.newCommitId(),
    })

    return created
  }

   /** Every component, category-name-joined for readability — same
   *  shape src/db.js's fetchComponentsForFabricatePicker already
   *  builds client-side, given a service-level home here for the
   *  harness's list_components tool. */
  async listAll() {
    const [components, categories] = await Promise.all([
      this.componentRepo.findAll(),
      this.categoryRepo.findAll(),
    ])
    const catById = Object.fromEntries(categories.map(c => [c.id, c]))
    return components.map(c => ({
      ...c,
      categoryName: c.categoryId ? (catById[c.categoryId]?.name || 'Uncategorized') : 'Uncategorized',
    }))
  }

  /** Lists component identities owned by one exact category. */
  async listForCategory({ categoryId }) {
    if (!categoryId) throw new ValidationError('categoryId is required')
    const [components, category] = await Promise.all([
      this.componentRepo.findByCategory(categoryId),
      this.categoryRepo.findById(categoryId),
    ])
    return components.map(component => ({ ...component, categoryName: category.name }))
  }


  /** Free-text search across name/description/attribute values — the
   *  "find a 24T gear" case. Joins category name in, same shape as
   *  listAll(), so a caller never needs a second lookup for readable
   *  results. */
  async search({ query }) {
    if (!query || !query.trim()) throw new ValidationError('query is required')
    const [matches, categories] = await Promise.all([
      this.componentRepo.search(query),
      this.categoryRepo.findAll(),
    ])
    const catById = Object.fromEntries(categories.map(c => [c.id, c]))
    return matches.map(c => ({
      ...c,
      categoryName: c.categoryId ? (catById[c.categoryId]?.name || 'Uncategorized') : 'Uncategorized',
    }))
  }


  async updateFallback({ componentId, name, description, image, actorId = null }) {
    if (!componentId) throw new ValidationError('componentId is required')
    const before = await this.componentRepo.findById(componentId).catch(() => null)
    const updated = await this.componentRepo.updateFallback(componentId, { name, description, image })

    await this.changeLogRepo.record({
      entityType: 'component', entityId: componentId, action: 'update', field: 'fallback',
      oldValue: before ? { name: before.fallbackName, description: before.fallbackDescription, image: before.fallbackImage } : null,
      newValue: { name, description, image },
      actorId, commitId: this.changeLogRepo.newCommitId(),
    })
    return updated
  }

  /** Deletes a component IF nothing references it anymore. Callers pass
   *  in the current instance count rather than this service reaching
   *  into inventory_instances itself — keeps ComponentService from
   *  needing an InventoryInstanceRepository dependency just for a
   *  single count check owned by the reservation domain. Returns
   *  whether a delete actually happened. */
  async deleteIfOrphaned({ componentId, instanceCount, actorId = null }) {
    if (!componentId) throw new ValidationError('componentId is required')
    if (!Number.isInteger(instanceCount) || instanceCount < 0) {
      throw new ValidationError('instanceCount must be a non-negative integer')
    }
    if (instanceCount > 0) return false
    const before = await this.componentRepo.findById(componentId).catch(() => null)
    await this.componentRepo.deleteById(componentId)

    if (before) {
      await this.changeLogRepo.record({
        entityType: 'component', entityId: componentId, action: 'delete',
        oldValue: before, actorId, commitId: this.changeLogRepo.newCommitId(),
      })
    }
    return true
  }
}
