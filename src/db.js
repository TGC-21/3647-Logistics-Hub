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

async function fetchComponents() {
  const { data, error } = await supabase
    .from('components')
    .select('*')
  if (error) throw error
  return data.map(dbComponentToLocal)
}

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


/** Only instances free to be linked to an assembly. */
export async function fetchAvailableInstances(componentId) {
  const { data, error } = await supabase
    .from('inventory_instances')
    .select('*')
    .eq('component_id', componentId)
    .eq('status', 'available')
    .order('created_at', { ascending: true })
  if (error) throw error
  return data.map(dbInstanceToLocal)
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

/** Aggregate counts per component — used to show "qty on hand" without
 *  pulling every instance row (e.g. for the inventory grid cards). */
export async function fetchInstanceCounts() {
  const { data, error } = await supabase
    .from('inventory_instances')
    .select('component_id, status')
  if (error) throw error

  const counts = {}
  for (const row of data) {
    if (!counts[row.component_id]) counts[row.component_id] = { total: 0, available: 0 }
    counts[row.component_id].total++
    if (row.status === 'available') counts[row.component_id].available++
  }
  return counts
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

/** Marks an instance as claimed by an assembly part and updates its
 *  location. Does NOT touch assembly_parts — the caller is responsible
 *  for pushing the instance id into that part's linked_instance_ids. */
export async function reserveInstance(instanceId, location) {
  const { data, error } = await supabase
    .from('inventory_instances')
    .update({ status: 'in_assembly', location })
    .eq('id', instanceId)
    .select()
    .single()
  if (error) throw error
  return dbInstanceToLocal(data)
}

/** Reverses reserveInstance — instance goes back to available. Location
 *  is left as-is by default (caller can pass a resetLocation to clear it,
 *  e.g. back to its original bin). */
export async function unreserveInstance(instanceId, resetLocation = null) {
  const patch = { status: 'available' }
  if (resetLocation !== null) patch.location = resetLocation
  const { data, error } = await supabase
    .from('inventory_instances')
    .update(patch)
    .eq('id', instanceId)
    .select()
    .single()
  if (error) throw error
  return dbInstanceToLocal(data)
}

/** Releases many instances at once (e.g. when deleting a part or an
 *  entire assembly) — flips them all back to available in one call
 *  instead of one round-trip per instance. */
export async function releaseInstances(instanceIds) {
  if (!instanceIds || !instanceIds.length) return
  const { error } = await supabase
    .from('inventory_instances')
    .update({ status: 'available', location: '' })
    .in('id', instanceIds)
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

// ── Assemblies ───────────────────────────────────────────────

export async function fetchAssemblies() {
  const { data, error } = await supabase
    .from('assemblies')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data.map(dbAssemblyToLocal)
}

export async function upsertAssembly(assembly) {
  const { data, error } = await supabase
    .from('assemblies')
    .upsert(localAssemblyToDb(assembly))
    .select()
    .single()
  if (error) throw error
  return dbAssemblyToLocal(data)
}

export async function deleteAssembly(id) {
  const { error } = await supabase.from('assemblies').delete().eq('id', id)
  if (error) throw error
}

// ── Assembly parts ────────────────────────────────────────────

export async function fetchAssemblyParts(assemblyId) {
  const { data, error } = await supabase
    .from('assembly_parts')
    .select('*')
    .eq('assembly_id', assemblyId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data.map(dbPartToLocal)
}

export async function upsertAssemblyPart(part) {
  const { data, error } = await supabase
    .from('assembly_parts')
    .upsert(localPartToDb(part))
    .select()
    .single()
  if (error) throw error
  return dbPartToLocal(data)
}

export async function bulkInsertAssemblyParts(parts) {
  const { data, error } = await supabase
    .from('assembly_parts')
    .insert(parts.map(localPartToDb))
    .select()
  if (error) throw error
  return data.map(dbPartToLocal)
}

export async function deleteAssemblyPart(id) {
  const { error } = await supabase.from('assembly_parts').delete().eq('id', id)
  if (error) throw error
}

// ── Assembly children (subassemblies) ─────────────────────────
// Subassemblies never live in `assemblies` — they're their own node type,
// nested under either a root assembly or another subassembly node. All
// writes happen server-side (api/onshape-bom.js, via the service key); the
// client only ever reads them.

/** Direct subassemblies of a root assembly. */
export async function fetchAssemblyChildren(parentAssemblyId) {
  const { data, error } = await supabase
    .from('assembly_children')
    .select('*')
    .eq('parent_assembly_id', parentAssemblyId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data.map(dbChildToLocal)
}

/** Subassemblies nested under ANOTHER subassembly node. */
export async function fetchChildrenOfChild(parentChildId) {
  const { data, error } = await supabase
    .from('assembly_children')
    .select('*')
    .eq('parent_child_id', parentChildId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data.map(dbChildToLocal)
}

export async function fetchAssemblyChildById(id) {
  const { data, error } = await supabase
    .from('assembly_children')
    .select('*')
    .eq('id', id)
    .single()
  if (error) throw error
  return dbChildToLocal(data)
}

/** Parts that belong directly to a subassembly node (not a root assembly). */
export async function fetchChildParts(childId) {
  const { data, error } = await supabase
    .from('assembly_parts')
    .select('*')
    .eq('assembly_child_id', childId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data.map(dbPartToLocal)
}

/** Recursively collects every linked_instance_id under a root assembly —
 *  its own direct parts, plus every nested subassembly's parts. Used to
 *  release inventory before an assembly (and its whole tree) is deleted. */
export async function fetchAllLinkedInstanceIdsForAssembly(assemblyId) {
  const ids = []

  const { data: rootParts, error: rootErr } = await supabase
    .from('assembly_parts')
    .select('linked_instance_ids')
    .eq('assembly_id', assemblyId)
  if (rootErr) throw rootErr
  rootParts.forEach(p => ids.push(...(p.linked_instance_ids || [])))

  const { data: directChildren, error: childErr } = await supabase
    .from('assembly_children')
    .select('id')
    .eq('parent_assembly_id', assemblyId)
  if (childErr) throw childErr

  const queue = (directChildren || []).map(c => c.id)
  while (queue.length) {
    const childId = queue.pop()

    const { data: childParts, error: cpErr } = await supabase
      .from('assembly_parts')
      .select('linked_instance_ids')
      .eq('assembly_child_id', childId)
    if (cpErr) throw cpErr
    childParts.forEach(p => ids.push(...(p.linked_instance_ids || [])))

    const { data: grandchildren, error: gcErr } = await supabase
      .from('assembly_children')
      .select('id')
      .eq('parent_child_id', childId)
    if (gcErr) throw gcErr
    queue.push(...(grandchildren || []).map(c => c.id))
  }

  return ids
}

/** Safety-net reconciliation: finds every inventory_instances row marked
 *  'in_assembly' that is NOT referenced by any assembly_parts.linked_instance_ids
 *  anywhere in the database, and releases it back to 'available'. Run this
 *  manually (e.g. from the browser console) if you suspect drift from before
 *  the Phase 4 release-on-delete/reimport fixes were in place. Read-only
 *  until the final update call — logs what it WOULD fix if dryRun is true.
 */
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
    if (!value || !String(value).trim()) {
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
    requiredFields: row.required_fields ?? [],   // [{ key, type, options? }]
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
    required_fields: cat.requiredFields ?? [],
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

function dbAssemblyToLocal(row) {
  return {
    id:                 row.id,
    name:               row.name,
    description:        row.description ?? '',
    onshapeUrl:         row.onshape_url ?? '',
    onshapeDocumentId:  row.onshape_document_id ?? '',
    onshapeWorkspaceId: row.onshape_workspace_id ?? '',
    onshapeElementId:   row.onshape_element_id ?? '',
    thumbnail:          row.thumbnail_url ?? null,
    status:             row.status ?? 'draft',
    createdAt:          row.created_at,
  }
}
function localAssemblyToDb(a) {
  return {
    id:                   a.id,
    name:                 a.name,
    description:          a.description ?? '',
    onshape_url:          a.onshapeUrl ?? '',
    onshape_document_id:  a.onshapeDocumentId ?? '',
    onshape_workspace_id: a.onshapeWorkspaceId ?? '',
    onshape_element_id:   a.onshapeElementId ?? '',
    thumbnail_url:        a.thumbnail ?? null,
    status:               a.status ?? 'draft',
  }
}

function dbPartToLocal(row) {
  return {
    id:                row.id,
    assemblyId:        row.assembly_id ?? null,
    assemblyChildId:   row.assembly_child_id ?? null,
    partName:          row.part_name,
    partNumber:        row.part_number ?? '',
    quantityNeeded:    row.quantity_needed ?? 1,
    quantityCollected: row.quantity_collected ?? 0,
    status:            row.status ?? 'pending',
    source:            row.source ?? 'manual',
    notes:             row.notes ?? '',
    onshapeReference:  row.onshape_reference ?? null,
    componentId:       row.component_id ?? null,
    linkedInstanceIds: row.linked_instance_ids ?? [],
    createdAt:         row.created_at,
  }
}
function localPartToDb(p) {
  return {
    id:                 p.id,
    assembly_id:        p.assemblyId ?? null,
    assembly_child_id:  p.assemblyChildId ?? null,
    part_name:          p.partName,
    part_number:        p.partNumber ?? '',
    quantity_needed:    p.quantityNeeded ?? 1,
    quantity_collected: p.quantityCollected ?? 0,
    status:             p.status ?? 'pending',
    source:             p.source ?? 'manual',
    notes:              p.notes ?? '',
    onshape_reference:  p.onshapeReference ?? null,
    component_id:       p.componentId ?? null,
    linked_instance_ids: p.linkedInstanceIds ?? [],
  }
}
function dbChildToLocal(row) {
  const wvmType = row.onshape_wvm_type || 'w'
  return {
    id:                 row.id,
    parentAssemblyId:   row.parent_assembly_id ?? null,
    parentChildId:      row.parent_child_id ?? null,
    name:               row.name,
    description:        row.description ?? '',
    thumbnail:          row.thumbnail_url ?? null,
    onshapeDocumentId:  row.onshape_document_id ?? '',
    onshapeWorkspaceId: row.onshape_workspace_id ?? '',
    onshapeWvmType:     wvmType,
    onshapeElementId:   row.onshape_element_id ?? '',
    onshapeUrl:         (row.onshape_document_id && row.onshape_workspace_id && row.onshape_element_id)
      ? `https://cad.onshape.com/documents/${row.onshape_document_id}/${wvmType}/${row.onshape_workspace_id}/e/${row.onshape_element_id}`
      : '',
    quantity:           row.quantity ?? 1,
    createdAt:          row.created_at,
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
