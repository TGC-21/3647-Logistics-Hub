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
export async function fetchComponentsForFabricatePicker() {
  const [{ data: comps, error: compErr }, { data: cats, error: catErr }] = await Promise.all([
    supabase.from('components').select('*'),
    supabase.from('categories').select('*'),
  ])
  if (compErr) throw compErr
  if (catErr) throw catErr

  const catById = Object.fromEntries((cats ?? []).map(c => [c.id, dbCatToLocal(c)]))

  return (comps ?? []).map(row => {
    const component = dbComponentToLocal(row)
    const category   = catById[component.categoryId] || null
    return { ...component, categoryName: category?.name || 'Uncategorized', category }
  })
}

/**
 * Per-component instance counts restricted to a specific set of ids —
 * thin wrapper around the same query fetchInstanceCounts runs, but
 * scoped so the Designer parts table can cheaply ask "does part X's
 * linked component actually have any stock?" without pulling counts
 * for the entire catalog on every render.
 */
export async function fetchInstanceCountsForComponents(componentIds) {
  const ids = [...new Set((componentIds ?? []).filter(Boolean))]
  if (!ids.length) return {}

  const { data, error } = await supabase
    .from('inventory_instances')
    .select('component_id, status')
    .in('component_id', ids)
  if (error) throw error

  const counts = {}
  for (const id of ids) counts[id] = { total: 0, available: 0 }
  for (const row of data) {
    counts[row.component_id].total++
    if (row.status === 'available') counts[row.component_id].available++
  }
  return counts
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

/**
 * Forks `quantity` units off an existing inventory instance into a new,
 * dedicated 'in_assembly' row, via a single atomic RPC call (no read-then-
 * write race). Does NOT touch assembly_parts — the caller is responsible
 * for pushing the RETURNED fork's id into that part's linked_instance_ids
 * (not the original instanceId, which may no longer exist if this
 * reservation emptied it).
 *
 * Throws if `quantity` exceeds what's currently available on that row.
 */
export async function reserveInstance(instanceId, quantity, location) {
  const { data, error } = await supabase.rpc('reserve_inventory_units', {
    p_instance_id: instanceId,
    p_quantity:    quantity,
    p_location:    location,
  })
  if (error) throw error
  return dbInstanceToLocal(data)
}

/** Reverses reserveInstance — instance goes back to available. Location
 *  is left as-is by default (caller can pass a resetLocation to clear it,
 *  e.g. back to its original bin). Operates on the specific forked row —
 *  it is NOT merged back into the pile it was split from. Repeated
 *  link/unlink cycles will fragment inventory into several quantity-1 (or
 *  quantity-N) rows over time; merging instances back together is a
 *  separate, not-yet-built feature. */
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

/** Single assembly_part by id — used to refresh one row's collected/
 *  promised numbers after recordMachinedUnits() without refetching the
 *  whole assembly. */
export async function fetchAssemblyPartById(id) {
  const { data, error } = await supabase
    .from('assembly_parts')
    .select('*')
    .eq('id', id)
    .single()
  if (error) throw error
  return dbPartToLocal(data)
}

/** Bulk version of fetchAssemblyPartById — one query for many parts, used
 *  by the Fabricate tab to render job rows (part name, needed qty, etc.)
 *  without a round trip per job. Returns a map keyed by id. */
export async function fetchAssemblyPartsByIds(ids) {
  if (!ids || !ids.length) return {}
  const { data, error } = await supabase
    .from('assembly_parts')
    .select('*')
    .in('id', ids)
  if (error) throw error
  return Object.fromEntries(data.map(row => [row.id, dbPartToLocal(row)]))
}

// ── Fabrication (Fabricate workflow: batches & jobs) ───────────
// A batch groups jobs going on the same machine/setup. A job is a promise
// to machine N units for exactly one assembly_part — see schema.sql for
// the full lifecycle (queued → committed → in_progress → complete →
// archived) and the constraints backing it (one active job per part,
// quantity_machined <= quantity_requested).

export async function fetchFabricationBatches() {
  const { data, error } = await supabase
    .from('fabrication_batches')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data.map(dbBatchToLocal)
}

export async function upsertFabricationBatch(batch) {
  const { data, error } = await supabase
    .from('fabrication_batches')
    .upsert(localBatchToDb(batch))
    .select()
    .single()
  if (error) throw error
  return dbBatchToLocal(data)
}

/** Deleting a batch only un-groups its jobs (batch_id → null, via the FK's
 *  on delete set null) — it never deletes or archives the jobs themselves. */
export async function deleteFabricationBatch(id) {
  const { error } = await supabase.from('fabrication_batches').delete().eq('id', id)
  if (error) throw error
}

/** All jobs, across every batch — the raw material the Fabricate tab
 *  groups into "unbatched queue" + "by batch" sections client-side. */
export async function fetchAllFabricationJobs() {
  const { data, error } = await supabase
    .from('fabrication_jobs')
    .select('*')
    .order('created_at', { ascending: true })
  if (error) throw error
  return data.map(dbJobToLocal)
}

export async function fetchFabricationJobsForBatch(batchId) {
  const { data, error } = await supabase
    .from('fabrication_jobs')
    .select('*')
    .eq('batch_id', batchId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data.map(dbJobToLocal)
}

/** The active (non-archived) job for one assembly_part, or null. Used to
 *  gate "Send to Fabricate" (hidden once a job exists) and to show
 *  collected/promised on the assembly detail parts table. */
export async function fetchActiveJobForPart(assemblyPartId) {
  const { data, error } = await supabase
    .from('fabrication_jobs')
    .select('*')
    .eq('assembly_part_id', assemblyPartId)
    .neq('status', 'archived')
    .maybeSingle()
  if (error) throw error
  return data ? dbJobToLocal(data) : null
}

/** Bulk version of the above — one query instead of N — for rendering an
 *  assembly's whole parts table without a per-row round trip. Returns a
 *  map keyed by assembly_part_id. */
export async function fetchActiveJobsForParts(assemblyPartIds) {
  if (!assemblyPartIds || !assemblyPartIds.length) return {}
  const { data, error } = await supabase
    .from('fabrication_jobs')
    .select('*')
    .in('assembly_part_id', assemblyPartIds)
    .neq('status', 'archived')
  if (error) throw error
  return Object.fromEntries(data.map(row => [row.assembly_part_id, dbJobToLocal(row)]))
}

/**
 * Creates a new queued job promising `quantityRequested` units for
 * `assemblyPartId`. Throws (via the DB's partial unique index) if that
 * part already has an active job — callers should check
 * fetchActiveJobForPart first to show a friendlier error than a raw
 * constraint violation.
 */
export async function createFabricationJob({ assemblyPartId, quantityRequested, batchId, genId }) {
  const { data, error } = await supabase
    .from('fabrication_jobs')
    .insert({
      id:                 genId(),
      assembly_part_id:   assemblyPartId,
      quantity_requested: quantityRequested,
      batch_id:           batchId || null,
      status:             'queued',
    })
    .select()
    .single()
  if (error) throw error
  return dbJobToLocal(data)
}

/** Batch reassignment is allowed at any (non-archived) status — it's
 *  scheduling, not the commitment itself. */
export async function moveJobToBatch(jobId, batchId) {
  const { data, error } = await supabase
    .from('fabrication_jobs')
    .update({ batch_id: batchId || null })
    .eq('id', jobId)
    .neq('status', 'archived')
    .select()
    .single()
  if (error) throw error
  return dbJobToLocal(data)
}

/** Only a queued job can have its requested quantity edited or be
 *  deleted outright — once committed, the promise is frozen. */
export async function updateQueuedJobQuantity(jobId, quantityRequested) {
  const { data, error } = await supabase
    .from('fabrication_jobs')
    .update({ quantity_requested: quantityRequested })
    .eq('id', jobId)
    .eq('status', 'queued')
    .select()
    .single()
  if (error) throw error
  return dbJobToLocal(data)
}

export async function deleteQueuedFabricationJob(jobId) {
  const { data, error } = await supabase
    .from('fabrication_jobs')
    .delete()
    .eq('id', jobId)
    .eq('status', 'queued')
    .select()
  if (error) throw error
  if (!data.length) throw new Error('Only an unclaimed (queued) job can be deleted — archive it instead.')
}

/** Claim a job: queued → committed. Guards against a double-claim race by
 *  only succeeding if the row was still 'queued' at update time. */
export async function claimFabricationJob(jobId, claimedBy) {
  const { data, error } = await supabase
    .from('fabrication_jobs')
    .update({ status: 'committed', claimed_by: claimedBy, claimed_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'queued')
    .select()
  if (error) throw error
  if (!data.length) throw new Error('This job was already claimed by someone else — refresh and try again.')
  return dbJobToLocal(data[0])
}

/** Escape hatch — releases a claim back to the unclaimed queue. Allowed
 *  from 'committed' or 'in_progress' (partial machining is kept; only the
+ *  claim itself is released) so a job never gets permanently stuck to
 *  someone who can't finish it. */
export async function releaseFabricationJobClaim(jobId) {
  const { data, error } = await supabase
    .from('fabrication_jobs')
    .update({ status: 'queued', claimed_by: null, claimed_at: null })
    .eq('id', jobId)
    .in('status', ['committed', 'in_progress'])
    .select()
    .single()
  if (error) throw error
  return dbJobToLocal(data)
}

/**
 * The core Fabricate → Inventory handoff. Records `quantity` newly
 * finished units against a job via the record_machined_units() RPC,
 * which atomically creates an inventory_instances row, bumps the linked
 * assembly_part's quantity_collected + linked_instance_ids, and advances
 * the job's own quantity_machined/status. Returns the updated job — the
 * caller should also refetch the assembly_part (fetchAssemblyPartById)
 * to refresh collected/promised in the UI.
 */
export async function recordMachinedUnits(jobId, quantity) {
  const { data, error } = await supabase.rpc('record_machined_units', {
    p_job_id:   jobId,
    p_quantity: quantity,
  })
  if (error) throw error
  return dbJobToLocal(data)
}

/** complete → archived. Terminal — archived jobs are hidden from the
 *  active Fabricate view but never deleted (they're the audit trail of
 *  what was promised and delivered). */
export async function archiveFabricationJob(jobId) {
  const { data, error } = await supabase
    .from('fabrication_jobs')
    .update({ status: 'archived' })
    .eq('id', jobId)
    .eq('status', 'complete')
    .select()
    .single()
  if (error) throw error
  return dbJobToLocal(data)
}

// ── Part orders (inventory-first, assembly-optional) ───────────
// A part_order restocks a COMPONENT (required) and may optionally
// earmark itself toward one assembly_part (assembly_part_id), the same
// "promised" concept fabrication_jobs uses — see schema.sql's
// part_orders migration for the full lifecycle (cart → ordered →
// received → archived) and why there's no "one active order per part"
// constraint here (unlike fabrication_jobs' partial unique index):
// orders are routinely NOT assembly-scoped at all, and a part's gap can
// legitimately be split across more than one order.

/** All orders, across every component — mirrors fetchAllFabricationJobs.
 *  The Part Orders view groups/filters these client-side (cart vs.
 *  ordered vs. received vs. archived), same pattern Fabricate uses for
 *  jobs. */
export async function fetchAllPartOrders() {
  const { data, error } = await supabase
    .from('part_orders')
    .select('*')
    .order('created_at', { ascending: true })
  if (error) throw error
  return data.map(dbPartOrderToLocal)
}

/** Every order (any status) for one component — used by a component's
 *  "on order" readout, e.g. alongside fetchInstanceCounts's on-hand
 *  count in Inventory mode. */
export async function fetchOrdersForComponent(componentId) {
  const { data, error } = await supabase
    .from('part_orders')
    .select('*')
    .eq('component_id', componentId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data.map(dbPartOrderToLocal)
}

/** All ACTIVE (non-archived, non-fully-received) orders earmarked to a
 *  given assembly_part — used to compute "promised" the same way
 *  fetchActiveJobForPart does for fabrication. A part can have more than
 *  one active order (see schema note), so this returns an array, not a
 *  single row like fetchActiveJobForPart. */
export async function fetchActiveOrdersForPart(assemblyPartId) {
  const { data, error } = await supabase
    .from('part_orders')
    .select('*')
    .eq('assembly_part_id', assemblyPartId)
    .neq('status', 'archived')
    .neq('status', 'received')
  if (error) throw error
  return data.map(dbPartOrderToLocal)
}

/** Bulk version of the above — one query instead of N, for rendering an
 *  assembly's whole parts table without a per-row round trip. Returns a
 *  map keyed by assembly_part_id → array of active orders (never a
 *  single order, since — unlike fetchActiveJobsForParts — more than one
 *  can be active on the same part at once). */
export async function fetchActiveOrdersForParts(assemblyPartIds) {
  if (!assemblyPartIds || !assemblyPartIds.length) return {}
  const { data, error } = await supabase
    .from('part_orders')
    .select('*')
    .in('assembly_part_id', assemblyPartIds)
    .neq('status', 'archived')
    .neq('status', 'received')
  if (error) throw error
  const map = {}
  for (const row of data) {
    const order = dbPartOrderToLocal(row)
    if (!map[order.assemblyPartId]) map[order.assemblyPartId] = []
    map[order.assemblyPartId].push(order)
  }
  return map
}

/**
 * Creates a new order line in 'cart' status. `assemblyPartId` is
 * optional (null = pure restock, not earmarked to any assembly) — this
 * is the inversion from createFabricationJob, where the assembly-part
 * link is mandatory.
 */
export async function createPartOrder({ componentId, assemblyPartId, quantityOrdered, vendor, cost, notes, genId }) {
  const { data, error } = await supabase
    .from('part_orders')
    .insert({
      id:                genId(),
      component_id:      componentId,
      assembly_part_id:  assemblyPartId || null,
      quantity_ordered:  quantityOrdered,
      vendor:            vendor || null,
      cost:              cost ?? null,
      notes:             notes || '',
      status:            'cart',
    })
    .select()
    .single()
  if (error) throw error
  return dbPartOrderToLocal(data)
}

/** Only a 'cart' order can have its quantity/vendor/cost/notes/assembly
 *  link edited — once placed, the commitment is frozen (mirrors
 *  updateQueuedJobQuantity's status-gating; enforced here at the query
 *  layer, same as fabrication_jobs, not as a DB constraint). */
export async function updateCartOrder(orderId, { quantityOrdered, assemblyPartId, vendor, cost, notes }) {
  const patch = {}
  if (quantityOrdered !== undefined) patch.quantity_ordered = quantityOrdered
  if (assemblyPartId !== undefined)  patch.assembly_part_id = assemblyPartId || null
  if (vendor !== undefined)          patch.vendor = vendor || null
  if (cost !== undefined)            patch.cost = cost ?? null
  if (notes !== undefined)           patch.notes = notes

  const { data, error } = await supabase
    .from('part_orders')
    .update(patch)
    .eq('id', orderId)
    .eq('status', 'cart')
    .select()
    .single()
  if (error) throw error
  return dbPartOrderToLocal(data)
}

/** Only a 'cart' order can be deleted outright — once placed, archive it
 *  instead (mirrors deleteQueuedFabricationJob). */
export async function deleteCartOrder(orderId) {
  const { data, error } = await supabase
    .from('part_orders')
    .delete()
    .eq('id', orderId)
    .eq('status', 'cart')
    .select()
  if (error) throw error
  if (!data.length) throw new Error('Only a cart order can be deleted — archive it instead.')
}

/** cart → ordered. Freezes quantity/assembly link (enforced by
 *  updateCartOrder's status gate above, not by this call). Sets
 *  ordered_at for a "placed on" readout. */
export async function placePartOrder(orderId) {
  const { data, error } = await supabase
    .from('part_orders')
    .update({ status: 'ordered', ordered_at: new Date().toISOString() })
    .eq('id', orderId)
    .eq('status', 'cart')
    .select()
  if (error) throw error
  if (!data.length) throw new Error('This order is no longer in cart — refresh and try again.')
  return dbPartOrderToLocal(data[0])
}

/**
 * The core Part Order → Inventory handoff. Records `quantity` newly
 * arrived units against an order via the record_received_units() RPC,
 * which atomically creates an inventory_instances row (status depends on
 * whether the order is assembly-earmarked — see schema.sql), and if it
 * IS earmarked, also bumps the linked assembly_part's quantity_collected
 * + linked_instance_ids. Mirrors recordMachinedUnits exactly. Returns the
 * updated order — the caller should also refetch the assembly_part (if
 * assemblyPartId was set) to refresh collected/promised in the UI, same
 * as the Fabricate flow does today.
 */
export async function recordReceivedUnits(orderId, quantity) {
  const { data, error } = await supabase.rpc('record_received_units', {
    p_order_id: orderId,
    p_quantity: quantity,
  })
  if (error) throw error
  return dbPartOrderToLocal(data)
}

/** received → archived. Terminal — archived orders are hidden from the
 *  active Part Orders view but never deleted (audit trail of what was
 *  ordered and received). Mirrors archiveFabricationJob. */
export async function archivePartOrder(orderId) {
  const { data, error } = await supabase
    .from('part_orders')
    .update({ status: 'archived' })
    .eq('id', orderId)
    .eq('status', 'received')
    .select()
    .single()
  if (error) throw error
  return dbPartOrderToLocal(data)
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

function dbBatchToLocal(row) {
  return {
    id:        row.id,
    name:      row.name,
    fabMethod: row.fab_method,
    notes:     row.notes ?? '',
    createdAt: row.created_at,
  }
}
function localBatchToDb(b) {
  return {
    id:         b.id,
    name:       b.name,
    fab_method: b.fabMethod,
    notes:      b.notes ?? '',
  }
}

function dbJobToLocal(row) {
  return {
    id:                row.id,
    batchId:           row.batch_id ?? null,
    assemblyPartId:    row.assembly_part_id,
    quantityRequested: row.quantity_requested ?? 1,
    quantityMachined:  row.quantity_machined ?? 0,
    status:            row.status ?? 'queued',
    claimedBy:         row.claimed_by ?? null,
    claimedAt:         row.claimed_at ?? null,
    notes:             row.notes ?? '',
    createdAt:         row.created_at,
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
    fabricationMetadata: row.fabrication_metadata ?? {},
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
    fabrication_metadata: p.fabricationMetadata ?? {},
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

/** All part_numbers × their vendor_listings, joined with vendor and
 *  component info — used by the "search all listings" picker when an
 *  assembly part has no part number of its own to auto-resolve. */
export async function fetchAllPartNumbersWithListings() {
  const [{ data: pns, error: pnErr }, { data: listings, error: lErr }, { data: vendorRows, error: vErr }, { data: compRows, error: cErr }] =
    await Promise.all([
      supabase.from('part_numbers').select('*'),
      supabase.from('vendor_listings').select('*'),
      supabase.from('vendors').select('*'),
      supabase.from('components').select('*'),
    ])
  if (pnErr) throw pnErr; if (lErr) throw lErr; if (vErr) throw vErr; if (cErr) throw cErr

  const pnById = Object.fromEntries((pns || []).map(p => [p.id, dbPartNumberToLocal(p)]))
  const vendorById = Object.fromEntries((vendorRows || []).map(v => [v.id, dbVendorToLocal(v)]))
  const compById = Object.fromEntries((compRows || []).map(c => [c.id, dbComponentToLocal(c)]))

  return (listings || []).map(row => {
    const listing = dbListingToLocal(row)
    const partNumber = pnById[listing.partNumberId]
    return {
      listing,
      partNumber,
      vendor: vendorById[listing.vendorId] || null,
      component: partNumber?.componentId ? compById[partNumber.componentId] || null : null,
    }
  }).filter(r => r.partNumber)
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

function dbVendorToLocal(row) {
  return { id: row.id, name: row.name, skuPattern: row.sku_pattern ?? null, createdAt: row.created_at }
}

export async function fetchVendors() {
  const { data, error } = await supabase.from('vendors').select('*').order('name')
  if (error) throw error
  return data.map(dbVendorToLocal)
}

/** Find-or-create by name (case-insensitive) — used by the inline
 *  "new vendor" step so retyping "mcmaster" doesn't fork a duplicate row. */
export async function findOrCreateVendor(name, genId) {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Vendor name is required')

  const { data: existing, error: findErr } = await supabase
    .from('vendors').select('*').ilike('name', trimmed).maybeSingle()
  if (findErr) throw findErr
  if (existing) return dbVendorToLocal(existing)

  const { data, error } = await supabase
    .from('vendors').insert({ id: genId(), name: trimmed }).select().single()
  if (error) throw error
  return dbVendorToLocal(data)
}

export async function deleteVendor(id) {
  const { error } = await supabase.from('vendors').delete().eq('id', id)
  if (error) throw error
}

function dbListingToLocal(row) {
  return {
    id:            row.id,
    partNumberId:  row.part_number_id,
    vendorId:      row.vendor_id,
    purchaseLink:  row.purchase_link ?? '',
    purchasePrice: row.purchase_price ?? null,
    isPreferred:   row.is_preferred ?? false,
    createdAt:     row.created_at,
  }
}

export async function fetchListingsForPartNumber(partNumberId) {
  const { data, error } = await supabase
    .from('vendor_listings').select('*').eq('part_number_id', partNumberId).order('is_preferred', { ascending: false })
  if (error) throw error
  return data.map(dbListingToLocal)
}

export async function upsertVendorListing(listing) {
  const { data, error } = await supabase
    .from('vendor_listings')
    .upsert({
      id:              listing.id,
      part_number_id:  listing.partNumberId,
      vendor_id:       listing.vendorId,
      purchase_link:   listing.purchaseLink || null,
      purchase_price:  listing.purchasePrice ?? null,
      is_preferred:    listing.isPreferred ?? false,
    })
    .select()
    .single()
  if (error) throw error
  return dbListingToLocal(data)
}

export async function deleteVendorListing(id) {
  const { error } = await supabase.from('vendor_listings').delete().eq('id', id)
  if (error) throw error
}

// ── Part Orders (carts + cart items) ────────────────────────

function dbCartToLocal(row) {
  return { id: row.id, name: row.name, vendorId: row.vendor_id ?? null, status: row.status ?? 'open', notes: row.notes ?? '', createdAt: row.created_at }
}
function localCartToDb(c) {
  return { id: c.id, name: c.name, vendor_id: c.vendorId ?? null, status: c.status ?? 'open', notes: c.notes ?? '' }
}

export async function fetchCarts() {
  const { data, error } = await supabase.from('carts').select('*').order('created_at', { ascending: false })
  if (error) throw error
  return data.map(dbCartToLocal)
}

export async function upsertCart(cart) {
  const { data, error } = await supabase.from('carts').upsert(localCartToDb(cart)).select().single()
  if (error) throw error
  return dbCartToLocal(data)
}

export async function deleteCart(id) {
  const { error } = await supabase.from('carts').delete().eq('id', id)
  if (error) throw error
}

/** Find-or-create the open cart for a vendor — this is what "which cart
 *  does this item land in" now resolves to, replacing the old
 *  assembly-keyed version entirely. */
export async function findOrCreateCartForVendor(vendorId, vendorName, genId) {
  const { data: existing, error: findErr } = await supabase
    .from('carts').select('*').eq('vendor_id', vendorId).eq('status', 'open').maybeSingle()
  if (findErr) throw findErr
  if (existing) return dbCartToLocal(existing)

  const { data, error } = await supabase
    .from('carts').insert({ id: genId(), name: `${vendorName} order`, vendor_id: vendorId, status: 'open' }).select().single()
  if (error) throw error
  return dbCartToLocal(data)
}

// ── Cart items ───────────────────────────────────────────────

function dbCartItemToLocal(row) {
  return {
    id:               row.id,
    cartId:           row.cart_id,
    vendorListingId:  row.vendor_listing_id ?? null,
    assemblyPartId:   row.assembly_part_id ?? null,
    nameOverride:     row.name_override ?? '',
    linkOverride:     row.link_override ?? '',
    priceOverride:    row.price_override ?? null,
    quantity:         row.quantity ?? 1,
    status:           row.status ?? 'pending',
    createdAt:        row.created_at,
  }
}

function localCartItemToDb(item) {
  return {
    id:                  item.id,
    cart_id:             item.cartId,
    vendor_listing_id:   item.vendorListingId ?? null,
    assembly_part_id:    item.assemblyPartId ?? null,
    name_override:       item.nameOverride || null,
    link_override:       item.linkOverride || null,
    price_override:      item.priceOverride ?? null,
    quantity:            item.quantity ?? 1,
    status:              item.status ?? 'pending',
  }
}

function dbPartOrderToLocal(row) {
  return {
    id:                row.id,
    componentId:       row.component_id,
    assemblyPartId:    row.assembly_part_id ?? null,
    quantityOrdered:   row.quantity_ordered ?? 1,
    quantityReceived:  row.quantity_received ?? 0,
    status:            row.status ?? 'cart',
    vendor:            row.vendor ?? '',
    cost:              row.cost ?? null,
    notes:             row.notes ?? '',
    orderedAt:         row.ordered_at ?? null,
    createdAt:         row.created_at,
  }
}

export async function fetchAllCartItems() {
  const { data, error } = await supabase.from('cart_items').select('*').order('created_at', { ascending: true })
  if (error) throw error
  return data.map(dbCartItemToLocal)
}

export async function upsertCartItem(item) {
  const { data, error } = await supabase.from('cart_items').upsert(localCartItemToDb(item)).select().single()
  if (error) throw error
  return dbCartItemToLocal(data)
}

export async function deleteCartItem(id) {
  const { error } = await supabase.from('cart_items').delete().eq('id', id)
  if (error) throw error
}

/** Resolves a cart item's display fields, preferring the linked listing
 *  (and its component) over manual overrides. `partNameFallback` is the
 *  assembly part's own name — used when no component is linked yet. */
export function resolveCartItemDisplay(item, listing, component, partNameFallback) {
  return {
    name:  component?.fallbackName || item.nameOverride || partNameFallback || 'Unnamed item',
    link:  listing?.purchaseLink || item.linkOverride || '',
    price: listing?.purchasePrice ?? item.priceOverride ?? null,
  }
}
