// services/FabricationDetectionService.js
//
// Migration Plan Phase 1, item 4. Replaces the three near-identical
// confirmSpacerDetection / confirmAxialShaftDetection / confirmPlateDetection
// functions in src/designer/fabDetection.js — each of which does exactly
// the same five steps (ensure category → find-or-create component →
// write componentId + fabrication_metadata onto the part → create a
// fabrication job → done) with only the category name/required-keys
// config and the attrs shape differing between the three kinds. That
// was the single biggest duplicated-business-logic surface in the repo
// per MIGRATION_PLAN.md's own note — this service is the one home for
// "confirm a detected fabrication candidate" going forward, built
// entirely on top of the three services Plan items 1–3 already
// extracted rather than re-deriving any of their rules:
//
//   - ComponentService.findOrCreate      (item 3) resolves the component
//   - FabricationJobService.createJob    (reference example) owns the
//     "one active job per part" rule and its own change-log entry
//   - AssemblyPartRepository             (item 2) gets the combined
//     componentId+fabrication_metadata write this action needs in one
//     round trip
//
// Deliberately does NOT own attribute-level validation (e.g. "OD must
// be a positive number") — that's src/db.js's validateAttribute today,
// a UI-form concern the confirm overlay already runs before submitting.
// This service trusts the `attrs` map it's given and focuses on the
// business action itself: resolve identity, promise fabrication, log it.

import { CategoryRepository } from '../repositories/CategoryRepository.js'
import { AssemblyPartRepository } from '../repositories/AssemblyPartRepository.js'
import { ChangeLogRepository } from '../repositories/ChangeLogRepository.js'
import { ComponentService } from './ComponentService.js'
import { FabricationJobService } from './FabricationJobService.js'
import { ValidationError } from '../repositories/errors.js'

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

// ── Per-kind category shape — the one place these now live, replacing
//    fabDetection.js's SPACER_CATEGORY_NAME/SPACER_REQUIRED_KEYS_CONFIG,
//    AXIAL_SHAFT_*, and PLATE_* module-level constants. ─────────────────
const KIND_CONFIG = {
  spacer: {
    categoryName: 'Spacer',
    requiredKeysConfig: [
      { key: 'Spacer Type', type: 'enum', options: ['ROUND', 'HEX', 'HEX375'] },
      { key: 'OD', type: 'quantity', defaultUnit: 'in' },
      { key: 'ID or Across Flats', type: 'quantity', defaultUnit: 'in' },
      { key: 'Length', type: 'quantity', defaultUnit: 'in' },
    ],
    describe: () => 'Auto-detected spacer',
  },
  'axial-shaft': {
    categoryName: 'Axial Shaft',
    requiredKeysConfig: [
      { key: 'Profile', type: 'segments', segmentUnit: 'in' },
    ],
    describe: () => 'Auto-detected axial shaft',
  },
  plate: {
    categoryName: 'Plate',
    requiredKeysConfig: [
      { key: 'Material', type: 'enum', options: ['Aluminum', 'Polycarbonate', 'Acrylic', 'Steel', 'Other'] },
      { key: 'Thickness', type: 'quantity', defaultUnit: 'in' },
    ],
    describe: attrs => `Auto-detected ${String(attrs?.Material || '').toLowerCase() || 'custom'} plate`,
  },
}

export class FabricationDetectionService {
  constructor({
    categoryRepo         = new CategoryRepository(),
    partRepo             = new AssemblyPartRepository(),
    changeLogRepo        = new ChangeLogRepository(),
    componentService     = new ComponentService({ categoryRepo, changeLogRepo }),
    fabricationJobService = new FabricationJobService({ partRepo, changeLogRepo }),
  } = {}) {
    this.categoryRepo         = categoryRepo
    this.partRepo              = partRepo
    this.changeLogRepo         = changeLogRepo
    this.componentService      = componentService
    this.fabricationJobService = fabricationJobService
  }

  static supportedKinds() { return Object.keys(KIND_CONFIG) }

  /** Find-or-create the fixed category for one detection kind — mirrors
   *  fabDetection.js's ensureSpacerCategory/ensureAxialShaftCategory/
   *  ensurePlateCategory, now written once instead of three times. */
  async _ensureCategory(kind) {
    const config = KIND_CONFIG[kind]
    const existing = await this.categoryRepo.findByName(config.categoryName)
    if (existing) return existing
    return this.categoryRepo.insert({ id: genId(), name: config.categoryName, requiredKeysConfig: config.requiredKeysConfig })
  }

  /**
   * Confirms a detected candidate: resolves (or creates) the component
   * it represents, marks the part's fabrication_metadata 'queued'
   * (preserving whatever else was on it — detected dimensions, source
   * info — and recording `overrides` if the user edited any detected
   * value), and creates the fabrication job promising `quantityRequested`
   * units. Returns { part, component, job }.
   *
   * `attrs` is the already-resolved { key: value } map for this kind's
   * category (e.g. { 'Spacer Type': 'ROUND', OD: '0.375', ... }) — built
   * by the caller from whatever the confirm overlay's fields (or
   * detected values) resolved to, same contract ComponentService.findOrCreate
   * already expects.
   */
  async confirmDetection({ kind, partId, attrs, quantityRequested, overrides = null, actorId = null }) {
    if (!KIND_CONFIG[kind]) {
      throw new ValidationError(`Unknown detection kind "${kind}" — expected one of: ${FabricationDetectionService.supportedKinds().join(', ')}`)
    }
    if (!partId) throw new ValidationError('partId is required')
    if (!attrs || typeof attrs !== 'object' || !Object.keys(attrs).length) {
      throw new ValidationError('attrs is required')
    }
    if (!Number.isInteger(quantityRequested) || quantityRequested <= 0) {
      throw new ValidationError('quantityRequested must be a positive integer')
    }

    const config = KIND_CONFIG[kind]
    const part = await this.partRepo.findById(partId)
    const category = await this._ensureCategory(kind)

    const component = await this.componentService.findOrCreate({
      categoryId: category.id,
      attrs,
      fallback: { name: part.partName, description: config.describe(attrs), image: null },
      actorId,
    })

    const existingMeta = part.fabricationMetadata || {}
    const updatedMeta = {
      ...existingMeta,
      status: 'queued',
      overrides: overrides ?? existingMeta.overrides ?? null,
    }

    await this.partRepo.updateComponentAndMetadata(partId, {
      componentId: component.id,
      fabricationMetadata: updatedMeta,
    })

    await this.changeLogRepo.record({
      entityType: 'assembly_part', entityId: partId, action: 'update', field: 'fabricationMetadata.status',
      oldValue: existingMeta.status ?? null, newValue: 'queued',
      actorId, commitId: this.changeLogRepo.newCommitId(),
    })

    // FabricationJobService.createJob already enforces "one active job
    // per part" and logs its own change_log entry — not re-derived here.
    const job = await this.fabricationJobService.createJob({
      assemblyPartId: partId, quantityRequested, batchId: null, actorId,
    })

    const updatedPart = await this.partRepo.findById(partId)
    return { part: updatedPart, component, job }
  }

  /** "Not a spacer/shaft/plate" — marks the candidate ignored without
   *  touching componentId or creating a job. Kind-agnostic: nothing
   *  about the ignore path differs between the three kinds, so unlike
   *  confirmDetection it doesn't need KIND_CONFIG at all. */
  async ignoreDetection({ partId, actorId = null }) {
    if (!partId) throw new ValidationError('partId is required')
    const part = await this.partRepo.findById(partId)
    const existingMeta = part.fabricationMetadata || {}
    const updatedMeta = { ...existingMeta, status: 'ignored' }

    const updated = await this.partRepo.updateFabricationMetadata(partId, updatedMeta)

    await this.changeLogRepo.record({
      entityType: 'assembly_part', entityId: partId, action: 'update', field: 'fabricationMetadata.status',
      oldValue: existingMeta.status ?? null, newValue: 'ignored',
      actorId, commitId: this.changeLogRepo.newCommitId(),
    })

    return updated
  }
}
