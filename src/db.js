import { createClient } from '@supabase/supabase-js'
import { buildComponentSignature } from './componentMatch'
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    'Missing Supabase credentials.\n' +
    'Copy .env.example to .env and fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'
  )
}

export const supabase = createClient(supabaseUrl, supabaseKey)

// ── Categories ───────────────────────────────────────────────

export async function fetchCategories() {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .order('name')
  if (error) throw error
  return data.map(dbCatToLocal)
}

export async function upsertCategory(cat) {
  const { data, error } = await supabase
    .from('categories')
    .upsert(localCatToDb(cat))
    .select()
    .single()
  if (error) throw error
  return dbCatToLocal(data)
}

export async function deleteCategory(id) {
  const { error } = await supabase.from('categories').delete().eq('id', id)
  if (error) throw error
}

// ── Components (internal config — not shown directly in UI) ──

export async function fetchComponents() {
  const { data, error } = await supabase
    .from('components')
    .select('*')
  if (error) throw error
  return data.map(dbComponentToLocal)
}

/**
 * All components, each carrying its category's name + requiredKeysConfig
 * inline — built for the Send-to-Fabricate "establish component" search
 * step, which needs to render/filter by category and attributes without
 * a second round-trip per row. Unlike fetchInventoryInstances' component
 * join, this returns EVERY component regardless of whether it currently
 * has any inventory_instances — fabrication needs to match/create a
 * component before any physical stock exists.
 */

async function fetchComponentById(id) {
  const { data, error } = await supabase.from('components').select('*').eq('id', id).single()
  if (error) throw error
  return dbComponentToLocal(data)
}

/** Manual edit of a component's fallback display info ("component view"). */
export async function updateComponentFallback(componentId, { name, description, image }) {
  const { data, error } = await supabase
    .from('components')
    .update({
      fallback_name:        name ?? '',
      fallback_description: description ?? '',
      fallback_image_url:   image ?? null,
    })
    .eq('id', componentId)
    .select()
    .single()
  if (error) throw error
  return dbComponentToLocal(data)
}

/**
 * Finds an existing component matching (categoryId, attrs) per the
 * category's requiredKeyConfig typing rules, or creates a new one.
 * `fallback` seeds fallback_name/description/image ONLY on create.
 * `attrs` must be { key: value } — convert from the {key,value} array
 * shape (e.g. via Object.fromEntries) before calling.
*/

export async function findOrCreateComponent({ categoryId, fields, attrs, fallback, genId }) {
  const signature = buildComponentSignature(categoryId, fields, attrs)

  const { data: candidates, error } = await supabase
    .from('components')
    .select('*')
    .eq('category_id', categoryId)
  if (error) throw error

  const match = (candidates ?? []).find(c =>
    buildComponentSignature(categoryId, fields, attrsArrayToMap(attrsFromDb(c.attributes))) === signature
  )
  if (match) return dbComponentToLocal(match)

  const { data, error: insErr } = await supabase
    .from('components')
    .insert({
      id:                   genId(),
      category_id:          categoryId,
      attributes:           attrsToDb(attrs),
      fallback_name:        fallback?.name ?? '',
      fallback_description: fallback?.description ?? '',
      fallback_image_url:   fallback?.image ?? null,
    })
    .select()
    .single()
  if (insErr) throw insErr
  return dbComponentToLocal(data)
}

/** Deletes a component IF it has zero remaining instances. Call after
 *  removing/re-parenting an instance away from it. */
export async function deleteComponentIfOrphaned(componentId) {
  const { count, error: countErr } = await supabase
    .from('inventory_instances')
    .select('id', { count: 'exact', head: true })
    .eq('component_id', componentId)
  if (countErr) throw countErr
  if (count > 0) return false
  const { error } = await supabase.from('components').delete().eq('id', componentId)
  if (error) throw error
  return true
}

// ── Inventory instances (what the UI treats as "the component") ──
// One row = one physical pile of a component, in one location. Carries
// its own optional name/description/image overrides plus the reservation
// state used when an assembly part claims it (status/linked location).

/** All instances, joined with their component's category/attributes/
 *  fallback display info — this is what the Inventory grid renders. */
export async function fetchInventoryInstances() {
  const { data, error } = await supabase
    .from('inventory_instances')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error

  const componentIds = [...new Set(data.map(r => r.component_id))]
  const { data: comps, error: compErr } = await supabase
    .from('components')
    .select('*')
    .in('id', componentIds.length ? componentIds : ['__none__'])
  if (compErr) throw compErr
  const compById = Object.fromEntries((comps ?? []).map(c => [c.id, dbComponentToLocal(c)]))

  return data.map(row => dbInstanceToLocal(row, compById[row.component_id]))
}

/** All instances belonging to ONE component — used by the Designer's
 *  "link inventory to this assembly part" picker. */
export async function fetchInstancesForComponent(componentId) {
  const { data, error } = await supabase
    .from('inventory_instances')
    .select('*')
    .eq('component_id', componentId)
    .order('created_at', { ascending: true })
  if (error) throw error
  const component = await fetchComponentById(componentId)
  return data.map(row => dbInstanceToLocal(row, component))
}

/** Only instances free to be linked to an assembly. */
 export async function fetchAvailableInstances(componentId) {
   const { data, error } = await supabase
     .from('inventory_instances')
     .select('*')
     .eq('component_id', componentId)
     .eq('status', 'available')
     .order('created_at', { ascending: true })
   if (error) throw error
  const component = await fetchComponentById(componentId)
  return data.map(row => dbInstanceToLocal(row, component))
 }

export async function upsertInventoryInstance(instance) {
  const { data, error } = await supabase
    .from('inventory_instances')
    .upsert(localInstanceToDb(instance))
    .select()
    .single()
  if (error) throw error
  return dbInstanceToLocal(data, instance.component)
}

export async function deleteInventoryInstance(id) {
  const { error } = await supabase.from('inventory_instances').delete().eq('id', id)
  if (error) throw error
}

// ── Image storage ─────────────────────────────────────────────

export async function uploadImage(id, file) {
  const ext  = file.name.split('.').pop() || 'jpg'
  const path = `${id}.${ext}`
  await supabase.storage.from('component-images').remove([path])
  const { error } = await supabase.storage
    .from('component-images')
    .upload(path, file, { upsert: true })
  if (error) throw error
  const { data } = supabase.storage.from('component-images').getPublicUrl(path)
  return data.publicUrl
}

export async function deleteImage(id) {
  await supabase.storage
    .from('component-images')
    .remove([`${id}.jpg`, `${id}.jpeg`, `${id}.png`, `${id}.webp`])
}

// /** Safety-net reconciliation: finds every inventory_instances row marked
//  *  'in_assembly' that is NOT referenced by any assembly_parts.linked_instance_ids
//  *  anywhere in the database, and releases it back to 'available'. Run this
//  *  manually (e.g. from the browser console) if you suspect drift from before
//  *  the Phase 4 release-on-delete/reimport fixes were in place. Read-only
//  *  until the final update call — logs what it WOULD fix if dryRun is true.
//  */
export async function reconcileOrphanedInstances(dryRun = true) {
  const { data: inAssembly, error: instErr } = await supabase
    .from('inventory_instances')
    .select('id')
    .eq('status', 'in_assembly')
  if (instErr) throw instErr

  const { data: allParts, error: partsErr } = await supabase
    .from('assembly_parts')
    .select('linked_instance_ids')
  if (partsErr) throw partsErr

  const referencedIds = new Set()
  allParts.forEach(p => (p.linked_instance_ids || []).forEach(id => referencedIds.add(id)))

  const orphanedIds = inAssembly
    .map(i => i.id)
    .filter(id => !referencedIds.has(id))

  if (!orphanedIds.length) {
    console.log('[reconcile] No orphaned instances found.')
    return { orphanedCount: 0, orphanedIds: [] }
  }

  console.warn(`[reconcile] Found ${orphanedIds.length} orphaned instance(s):`, orphanedIds)

  if (!dryRun) {
    const { error } = await supabase
      .from('inventory_instances')
      .update({ status: 'available', location: '' })
      .in('id', orphanedIds)
    if (error) throw error
    console.log(`[reconcile] Released ${orphanedIds.length} orphaned instance(s).`)
  } else {
    console.log('[reconcile] Dry run — no changes made. Call reconcileOrphanedInstances(false) to apply.')
  }

  return { orphanedCount: orphanedIds.length, orphanedIds }
}


// ── Typed characteristic helpers ──────────────────────────────
//
// A category's `requiredKeysConfig` is an array of characteristic
// definitions, each shaped like:
//   { key: "Inner Diameter", type: "enum", options: ["0.25", "0.5"] }
//   { key: "Material",       type: "string" }
//   { key: "Weight",         type: "quantity", defaultUnit: "g" }
//
// `type` is one of: 'string' | 'quantity' | 'enum'.
//
// `requiredKeys` (a plain string array) is kept in sync alongside
// `requiredKeysConfig` for any old code/queries that only care about names.

/**
 * Back-fills `requiredKeysConfig` for categories saved before this feature
 * existed — they only have `requiredKeys` (plain names), so each becomes a
 * "string" typed characteristic. No-op if config already exists.
 */
export function migrateRequiredKeysIfNeeded(cat) {
  if (cat.requiredKeysConfig && cat.requiredKeysConfig.length > 0) {
    return cat
  }
  cat.requiredKeysConfig = (cat.requiredKeys || []).map(key => ({
    key,
    type: 'string',
    options: [],
    defaultUnit: '',
  }))
  return cat
}

/**
 * Validate a single raw attribute value against its characteristic config.
 * Returns { valid, error? }.
 */
export function validateAttribute(value, config) {
  if (!config) return { valid: true }

  // Structural data — never coerce to a trimmed string like the other
  // types below. `value` here is the { totalLength, segments } object
  // itself (see AXIAL_SHAFT_DETECTION_ROADMAP.md), not a form-field string.
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

/**
 * Validate a full attributes array against a category's required
 * characteristic configs. Returns { valid, errors } where errors is keyed
 * by characteristic name.
 */
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
    // below even when populated — validateAttribute itself already knows
    // how to tell "empty" from "populated" for this type.
    if (config.type !== 'segments' && (!value || !String(value).trim())) {
      errors[config.key] = 'Required'
      return
    }
    const result = validateAttribute(value, config)
    if (!result.valid) errors[config.key] = result.error || 'Invalid value'
  })

  return { valid: Object.keys(errors).length === 0, errors }
}

/**
 * Format a stored attribute value for display — mainly appends a
 * characteristic's default unit to bare quantity values (e.g. "5" → "5 g").
 */
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

// ── Mapping helpers ───────────────────────────────────────────

function dbCatToLocal(row) {
  const cat = {
    id: row.id,
    name: row.name,
    requiredKeys: row.required_keys ?? [],
    requiredKeysConfig: row.required_keys_config ?? [],   // [{ key, type, options? }]
  }
  return migrateRequiredKeysIfNeeded(cat)
}
function localCatToDb(cat) {
  // requiredKeys is always derived from requiredKeysConfig so the two
  // never drift apart — requiredKeysConfig is the single source of truth.
  const requiredKeys = (cat.requiredKeysConfig || []).map(c => c.key).filter(Boolean)
  return {
    id:                    cat.id,
    name:                  cat.name,
    required_keys:         requiredKeys,
    required_keys_config:  cat.requiredKeysConfig ?? [],
  }
}

function attrsFromDb(jsonb) {
    // stored as [{ key, value }] in the DB, kept as an array on the local
  // component object since the instance-edit UI does .find(a => a.key===…).
  return jsonb ?? []
}
/** Converts the array shape above into { key: value } for signature
 *  matching (findOrCreateComponent expects a plain map). */
function attrsArrayToMap(attrsArray) {
  return (attrsArray ?? []).reduce((m, a) => { m[a.key] = a.value; return m }, {})
}
function attrsToDb(attrsObj) {
  // Accepts either a { key: value } map or an array already in DB shape.
  if (Array.isArray(attrsObj)) return attrsObj.map(({ key, value }) => ({ key, value }))
  return Object.entries(attrsObj ?? {}).map(([key, value]) => ({ key, value }))
}

export { attrsArrayToMap }

function dbComponentToLocal(row) {
  return {
    id:          row.id,
    categoryId:  row.category_id ?? null,
    attributes:  attrsFromDb(row.attributes),
    fallbackName:        row.fallback_name ?? '',
    fallbackDescription: row.fallback_description ?? '',
    fallbackImage:       row.fallback_image_url ?? null,
    createdAt:   row.created_at,
  }
}

function dbInstanceToLocal(row, component) {
  return {
    id:          row.id,
    componentId: row.component_id,
    // Instance-level overrides fall back to the component's config values
    name:        row.name || component?.fallbackName || '',
    description: row.description ?? component?.fallbackDescription ?? '',
    image:       row.image_url ?? component?.fallbackImage ?? null,
    location:    row.location ?? '',
    quantity:    row.quantity ?? 1,
    tags:        row.tags ?? [],
    status:      row.status ?? 'available',
    notes:       row.notes ?? '',
    categoryId:  component?.categoryId ?? null,
    attributes:  component?.attributes ?? [],
    createdAt:   row.created_at,
  }
}

function localInstanceToDb(inst) {
  return {
    id:           inst.id,
    component_id: inst.componentId,
    name:         inst.name || null,
    description:  inst.description || null,
    image_url:    inst.image || null,
    location:     inst.location ?? '',
    quantity:     inst.quantity ?? 1,
    tags:         inst.tags ?? [],
    status:       inst.status ?? 'available',
    notes:        inst.notes ?? '',
  }
}

export async function fetchInstancesByIds(ids) {
  if (!ids || !ids.length) return []
  const { data, error } = await supabase
    .from('inventory_instances')
    .select('*')
    .in('id', ids)
  if (error) throw error
  return data.map(dbInstanceToLocal)
}

export async function updateInstanceLocation(id, location) {
  const { data, error } = await supabase
    .from('inventory_instances')
    .update({ location })
    .eq('id', id)
    .select()
    .single()
  if (error) throw error
  return dbInstanceToLocal(data)
}

// ── Part numbers (vendor SKUs) ──────────────────────────────
// See PART_ORDERS design: one row per vendor SKU string, optionally
// linked to a component. Created as a stub (component_id null) during
// Onshape BOM import; backfilled the first time a user confirms which
// component that part number actually is (see linkPartNumberToComponent).

function dbPartNumberToLocal(row) {
  return {
    id:          row.id,
    componentId: row.component_id ?? null,
    value:       row.value,
    createdAt:   row.created_at,
  }
}

/** Find-or-create a stub part_numbers row for a raw vendor SKU string.
 *  Called during Onshape BOM import for every part row that carries a
 *  part number — cheap upsert on the `value` unique constraint. Never
 *  overwrites an existing row's component_id. */
export async function ensurePartNumberStub(value, genId) {
  const trimmed = (value || '').trim()
  if (!trimmed) return null

  const { data: existing, error: findErr } = await supabase
    .from('part_numbers').select('*').eq('value', trimmed).maybeSingle()
  if (findErr) throw findErr
  if (existing) return dbPartNumberToLocal(existing)

  const { data, error } = await supabase
    .from('part_numbers')
    .insert({ id: genId(), value: trimmed, component_id: null })
    .select()
    .single()
  if (error) {
    const { data: retry } = await supabase.from('part_numbers').select('*').eq('value', trimmed).maybeSingle()
    if (retry) return dbPartNumberToLocal(retry)
    throw error
  }
  return dbPartNumberToLocal(data)
}

/** Backfills component_id onto every part_numbers row matching `value`
 *  that doesn't already have one. Called when a user links an inventory
 *  instance to an assembly_part — the confirmed component becomes the
 *  part number's component from then on. Never overwrites an existing
 *  (already-confirmed) component_id, so two genuinely different SKUs
 *  that happen to share a typo'd value don't silently merge. */
export async function linkPartNumberToComponent(value, componentId) {
  const trimmed = (value || '').trim()
  if (!trimmed || !componentId) return
  const { error } = await supabase
    .from('part_numbers')
    .update({ component_id: componentId })
    .eq('value', trimmed)
    .is('component_id', null)
  if (error) throw error
}

export async function fetchPartNumberByValue(value) {
  const trimmed = (value || '').trim()
  if (!trimmed) return null
  const { data, error } = await supabase.from('part_numbers').select('*').eq('value', trimmed).maybeSingle()
  if (error) throw error
  return data ? dbPartNumberToLocal(data) : null
}

export async function fetchPartNumbersForComponent(componentId) {
  const { data, error } = await supabase.from('part_numbers').select('*').eq('component_id', componentId)
  if (error) throw error
  return data.map(dbPartNumberToLocal)
}

export async function fetchAllPartNumbers() {
  const { data, error } = await supabase.from('part_numbers').select('*').order('created_at', { ascending: false })
  if (error) throw error
  return data.map(dbPartNumberToLocal)
}

export async function upsertPartNumber(pn) {
  const { data, error } = await supabase
    .from('part_numbers')
    .upsert({ id: pn.id, component_id: pn.componentId ?? null, value: pn.value })
    .select()
    .single()
  if (error) throw error
  return dbPartNumberToLocal(data)
}

export async function deletePartNumber(id) {
  const { error } = await supabase.from('part_numbers').delete().eq('id', id)
  if (error) throw error
}

// "Heavily filtered" inventory suggestion — unchanged behavior, still
// keyed off part_numbers.component_id (sourcing split doesn't affect this).
export async function fetchSuggestedInstancesForPartNumber(partNumberValue) {
  const pn = await fetchPartNumberByValue(partNumberValue)
  if (!pn || !pn.componentId) return []
  return fetchAvailableInstances(pn.componentId)
}


/** Uploads a temporary/chat image without colliding with the
 * inventory-instance `{id}.jpg` naming convention. */
export async function uploadAgentImage(memberId, file) {
  const ext = (file.type.split('/')[1] || 'jpeg').replace('jpeg', 'jpg')
  const path = `chat/${memberId}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from('component-images').upload(path, file, {
    upsert: false, contentType: file.type, cacheControl: '3600',
  })
  if (error) throw error
  const { data } = supabase.storage.from('component-images').getPublicUrl(path)
  return { url: data.publicUrl, mimeType: file.type, name: file.name, path }
}
