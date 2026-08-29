// services/CategoryService.js
//
// Migration Plan Phase 1, item 10. Two halves, deliberately kept
// together in one file since the plan groups them as one domain:
//
//   1. Pure validation/formatting functions — validateAttribute,
//      validateRequiredAttributes, migrateRequiredKeysIfNeeded, and
//      formatAttribute, ported verbatim from src/db.js's "Typed
//      characteristic helpers" section. No repository, no I/O — exported
//      standalone so any other service (ComponentService,
//      FabricationDetectionService, a future route) can validate
//      attrs against a category's requiredKeysConfig without needing a
//      CategoryService instance, the same way AssemblyPartService
//      exports computePartStatus/derivedAssemblyStatus as free
//      functions.
//   2. CategoryService class — the CRUD every other domain above
//      depends on indirectly (ComponentService.findOrCreate and
//      FabricationDetectionService.confirmDetection both resolve a
//      category before doing anything else) but which itself had no
//      dedicated service until now. Full create/rename/delete lands
//      here rather than being bolted onto ComponentService, since
//      "define what a category requires" and "resolve a component
//      against that definition" are different actions even though the
//      second always depends on the first.
//
// validateAttribute/validateRequiredAttributes are NOT re-implemented
// by ComponentService or FabricationDetectionService — both already
// trust their caller's `attrs` map (see ComponentService's own doc
// comment) and defer field-level validation to the client's confirm
// forms today. This service is what a route/harness caller SHOULD run
// first if it wants that same protection without a browser in front of
// it — see api/categories.js's `validateAttributes` action.

import { CategoryRepository } from '../repositories/CategoryRepository.js'
import { ChangeLogRepository } from '../repositories/ChangeLogRepository.js'
import { ValidationError, ConflictError } from '../repositories/errors.js'

function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

// ── Pure functions (no I/O) — ported from src/db.js unchanged ───────

/** Back-fills requiredKeysConfig for categories saved before typed
 *  characteristics existed — they only have requiredKeys (plain names),
 *  each of which becomes a "string" typed characteristic. No-op if
 *  config already exists. Mutates and returns `cat` for the client
 *  version's convenience; callers here should treat the return value as
 *  the thing to use, not rely on the mutation. */
export function migrateRequiredKeysIfNeeded(cat) {
  if (cat.requiredKeysConfig && cat.requiredKeysConfig.length > 0) {
    return cat
  }
  cat.requiredKeysConfig = (cat.requiredKeys || []).map(key => ({
    key, type: 'string', options: [], defaultUnit: '',
  }))
  return cat
}

/** Validate a single raw attribute value against its characteristic
 *  config. Returns { valid, error? }. */
export function validateAttribute(value, config) {
  if (!config) return { valid: true }

  // Structural data (axial-shaft segment lists) — never coerce to a
  // trimmed string like the other types below.
  if (config.type === 'segments') {
    if (!value || typeof value !== 'object' || !Array.isArray(value.segments) || value.segments.length === 0) {
      return { valid: false, error: 'At least one segment is required' }
    }
    const REQUIRED_DIMS = {
      round:  ['length', 'diameter'],
      hex:    ['length', 'acrossFlats'],
      square: ['length', 'width'],
      prism:  ['length', 'width'],
    }
    for (const seg of value.segments) {
      const fields = REQUIRED_DIMS[seg.type]
      if (!fields) return { valid: false, error: `Unknown segment type "${seg.type}"` }
      for (const f of fields) {
        if (typeof seg[f] !== 'number' || !Number.isFinite(seg[f]) || seg[f] <= 0) {
          return { valid: false, error: `Every ${seg.type} segment needs a positive ${f}` }
        }
      }
    }
    return { valid: true }
  }

  const trimmed = String(value ?? '').trim()

  if (config.type === 'enum') {
    if (!config.options || config.options.length === 0) return { valid: true }
    return config.options.includes(trimmed)
      ? { valid: true }
      : { valid: false, error: `Must be one of: ${config.options.join(', ')}` }
  }

  if (config.type === 'quantity') {
    const numMatch = trimmed.match(/^-?[\d.]+/)
    if (!numMatch || isNaN(parseFloat(numMatch[0]))) {
      return { valid: false, error: 'Must be a number' }
    }
    return { valid: true }
  }

  return { valid: true }
}

/** Normalizes a key for tolerant comparison: lowercase, underscores/
 *  hyphens treated as spaces, whitespace collapsed and trimmed. Two
 *  keys that normalize to the same string are treated as "the same
 *  characteristic" for reconciliation purposes below. */
function normalizeKeyForMatch(key) {
  return String(key ?? '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Rewrites an attrs map's keys onto a category's requiredKeysConfig
 * canonical spelling wherever they normalize to the same thing (case,
 * underscore/hyphen-for-space, extra whitespace) — e.g. "Chain_size"
 * or "chain size" both become "Chain size" if that's the category's
 * real key. This exists specifically to tolerate cosmetic key drift
 * from LLM-produced JSON, which reliably substitutes underscores for
 * spaces in object keys; it does NOT invent a match for a key that
 * isn't a close cosmetic variant of a real required key — anything
 * left unmatched passes through unchanged, so a genuinely wrong or
 * corrupted key still fails validateRequiredAttributes normally
 * rather than being silently accepted.
 *
 * Pure function, no I/O — safe to reuse from ComponentService or any
 * other write path without instantiating a CategoryService.
 */
export function reconcileAttrKeys(attrs, requiredKeysConfig) {
  if (!requiredKeysConfig?.length) return { ...attrs }
  const canonicalByNormalized = new Map(requiredKeysConfig.map(cfg => [normalizeKeyForMatch(cfg.key), cfg.key]))
  const result = {}
  for (const [key, value] of Object.entries(attrs || {})) {
    const canonical = canonicalByNormalized.get(normalizeKeyForMatch(key))
    result[canonical ?? key] = value
  }
  return result
}


/** Validate a full attributes array against a category's required
 *  characteristic configs. Returns { valid, errors } where errors is
 *  keyed by characteristic name. */
export function validateRequiredAttributes(attributes, requiredKeysConfig) {
  const errors = {}
  if (!requiredKeysConfig || requiredKeysConfig.length === 0) {
    return { valid: true, errors }
  }

  const byKey = {}
  ;(attributes || []).forEach(a => { byKey[a.key] = a.value })

  requiredKeysConfig.forEach(config => {
    const value = byKey[config.key]
    // Structural values (segments) fail the trim-string emptiness check
    // below even when populated — validateAttribute already knows how
    // to tell "empty" from "populated" for this type.
    if (config.type !== 'segments' && (!value || !String(value).trim())) {
      errors[config.key] = 'Required'
      return
    }
    const result = validateAttribute(value, config)
    if (!result.valid) errors[config.key] = result.error || 'Invalid value'
  })

  return { valid: Object.keys(errors).length === 0, errors }
}

/** Format a stored attribute value for display — mainly appends a
 *  characteristic's default unit to bare quantity values
 *  (e.g. "5" → "5 g"). Presentation-adjacent but small enough to keep
 *  alongside the validation it mirrors rather than starting a separate
 *  file for one function. */
export function formatAttribute(value, config) {
  if (config?.type === 'segments') {
    if (!value || !Array.isArray(value.segments)) return '—'
    const total = value.totalLength ?? value.segments.reduce((s, seg) => s + (seg.length || 0), 0)
    const unit  = config.segmentUnit || ''
    return `${value.segments.length} segment${value.segments.length === 1 ? '' : 's'}, ${total.toFixed(2)}${unit} total`
  }
  const str = String(value ?? '')
  if (!config || config.type !== 'quantity') return str
  if (!config.defaultUnit || str.includes(' ') || str === '') return str
  return `${str} ${config.defaultUnit}`
}

// ── CategoryService — CRUD every other domain resolves against ──────

export class CategoryService {
  constructor({
    categoryRepo  = new CategoryRepository(),
    changeLogRepo = new ChangeLogRepository(),
  } = {}) {
    this.categoryRepo  = categoryRepo
    this.changeLogRepo = changeLogRepo
  }

  async list() {
    const cats = await this.categoryRepo.findAll()
    return cats.map(migrateRequiredKeysIfNeeded)
  }

  async getById(id) {
    const cat = await this.categoryRepo.findById(id)
    return migrateRequiredKeysIfNeeded(cat)
  }

  /** Validates the requiredKeysConfig shape itself before writing it —
   *  every entry needs a non-blank key and a recognized type. This is
   *  new enforcement the client UI doesn't currently run server-side
   *  (main.js's renderReqKeysConfig only drops blank-key rows on save);
   *  it closes the gap for callers that aren't the browser form. */
  _validateConfig(requiredKeysConfig) {
    const VALID_TYPES = ['string', 'quantity', 'enum', 'segments']
    for (const cfg of requiredKeysConfig || []) {
      if (!cfg.key || !String(cfg.key).trim()) {
        throw new ValidationError('Every required characteristic needs a non-empty key')
      }
      if (!VALID_TYPES.includes(cfg.type)) {
        throw new ValidationError(`Unknown characteristic type "${cfg.type}" for key "${cfg.key}" — expected one of: ${VALID_TYPES.join(', ')}`)
      }
    }
  }

  async create({ name, requiredKeysConfig = [], actorId = null }) {
    if (!name || !name.trim()) throw new ValidationError('name is required')
    this._validateConfig(requiredKeysConfig)

    const existing = await this.categoryRepo.findByName(name.trim())
    if (existing) throw new ConflictError(`A category named "${name}" already exists.`)

    const created = await this.categoryRepo.insert({ id: genId(), name: name.trim(), requiredKeysConfig })

    await this.changeLogRepo.record({
      entityType: 'category', entityId: created.id, action: 'create',
      newValue: created, actorId, commitId: this.changeLogRepo.newCommitId(),
    })

    return created
  }

  async update({ id, name, requiredKeysConfig = [], actorId = null }) {
    if (!name || !name.trim()) throw new ValidationError('name is required')
    this._validateConfig(requiredKeysConfig)

    const before = await this.categoryRepo.findById(id)

    const clean = requiredKeysConfig.map(cfg => ({ ...cfg, key: cfg.key.trim() })).filter(cfg => cfg.key)
    const updated = await this.categoryRepo.update(id, { name: name.trim(), requiredKeysConfig: clean })

    // Field-level diff, same shape upsertCategoryVersioned's
    // recordUpdateDiff already writes client-side — one commit, one row
    // per field that actually changed.
    const commitId = this.changeLogRepo.newCommitId()
    if (before.name !== updated.name) {
      await this.changeLogRepo.record({
        entityType: 'category', entityId: id, action: 'update', field: 'name',
        oldValue: before.name, newValue: updated.name, actorId, commitId,
      })
    }
    if (JSON.stringify(before.requiredKeysConfig) !== JSON.stringify(updated.requiredKeysConfig)) {
      await this.changeLogRepo.record({
        entityType: 'category', entityId: id, action: 'update', field: 'requiredKeysConfig',
        oldValue: before.requiredKeysConfig, newValue: updated.requiredKeysConfig, actorId, commitId,
      })
    }

    return updated
  }

  /** Deleting a category never deletes its components — they're
   *  un-categorized by the schema's ON DELETE SET NULL (see
   *  CategoryRepository's doc comment), same "components outlive their
   *  category" behavior main.js's deleteCat has always had. */
  async delete({ id, actorId = null }) {
    const before = await this.categoryRepo.findById(id)
    await this.categoryRepo.deleteById(id)

    await this.changeLogRepo.record({
      entityType: 'category', entityId: id, action: 'delete',
      oldValue: before, actorId, commitId: this.changeLogRepo.newCommitId(),
    })

    return { deletedCategoryId: id }
  }

  /** Convenience pass-through so a route can validate a full attrs
   *  array against a category by id in one call, without the caller
   *  needing to fetch the category itself first. */
  async validateAttributesForCategory({ categoryId, attributes }) {
    const cat = await this.getById(categoryId)
    return validateRequiredAttributes(attributes, cat.requiredKeysConfig)
  }
}
