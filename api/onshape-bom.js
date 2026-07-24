// api/onshape-bom.js — Vercel serverless function
//
// NEW IMPORT  { documentId, workspaceId, elementId, assemblyName, thumbnailUrl? }
// RE-IMPORT   { assemblyId, reimport: true }
//
// Subassemblies are written ONLY to `assembly_children` — never to
// `assemblies` — so they can never appear in "All assemblies" or be
// opened/edited/deleted like a top-level assembly. The BOM hierarchy is
// preserved by nesting: a subassembly's own children point back to IT
// (parent_child_id) rather than to the root assembly, and its own parts
// are owned via assembly_parts.assembly_child_id rather than assembly_id.

import { createClient } from '@supabase/supabase-js'
import {
  fetchBom, parseBomRows,
  resolveBomWithSubassemblies, fetchDocumentOwnerId,
  applyCors, genId, MAX_CHILD_DEPTH, MAX_ONSHAPE_CONCURRENCY,
  buildSourceKey, fabricationIdentityKey,
} from './_lib/onshape.js'

import { recordChangeServer, genCommitId } from './_lib/changeLog.js'

function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.')
  return createClient(url, key)
}

// ── Handler ───────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = req.body ?? {}
  try {
    const supabase = getSupabase()

    if (body.reimport && body.assemblyId) {
      const result = await reimportAssembly(supabase, body.assemblyId)
      return res.status(200).json({ success: true, ...result })
    }

    const { documentId, workspaceId, elementId, assemblyName, thumbnailUrl } = body
    if (!documentId || !workspaceId || !elementId) {
      return res.status(400).json({ error: 'documentId, workspaceId, and elementId are required.' })
    }

    const rootOwnerId = await fetchDocumentOwnerId(documentId)

    const result = await buildAssembly(supabase, {
      documentId, workspaceId, elementId,
      name: assemblyName || null,
      thumbnailUrl: thumbnailUrl || null,
      rootOwnerId,
    })
    return res.status(200).json({ success: true, ...result })

  } catch (err) {
    console.error('[onshape-bom]', err)
    if (/Onshape API 404/.test(err.message)) {
      return res.status(404).json({
        error: 'Onshape couldn\'t find or generate a BOM for this assembly. Open its BOM tab in Onshape once to initialize it, confirm you picked an Assembly (not a Part Studio), then try again.',
      })
    }
    return res.status(500).json({ error: err.message ?? 'Internal server error' })
  }
}

// ── buildAssembly ─────────────────────────────────────────────
// Creates the ROOT Partshelf assembly record (depth 0 only), then seeds it.
// Subassemblies discovered underneath it are written to assembly_children,
// never as their own `assemblies` rows.

async function buildAssembly(supabase, { documentId, workspaceId, elementId, name, thumbnailUrl, rootOwnerId }) {
  const assemblyId   = genId()
  const onshapeUrl   = `https://cad.onshape.com/documents/${documentId}/w/${workspaceId}/e/${elementId}`
  const assemblyName = name || `Onshape assembly — ${new Date().toLocaleDateString()}`

  const { error: asmErr } = await supabase.from('assemblies').insert({
    id:                   assemblyId,
    name:                 assemblyName,
    description:          `Linked from Onshape on ${new Date().toLocaleString()}`,
    onshape_url:          onshapeUrl,
    onshape_document_id:  documentId,
    onshape_workspace_id: workspaceId,
    onshape_element_id:   elementId,
    thumbnail_url:        thumbnailUrl || null,
    status:               'draft',
  })
  if (asmErr) throw new Error(`Assembly insert: ${asmErr.message}`)

  let partCount, childCount
  try {
    // One resolveCache shared across the ENTIRE import tree, root call
    // included — dedupes repeated subassembly instances (see
    // resolveBomWithSubassemblies's resolveCache param).
    const resolveCache = new Map()
    ;({ partCount, childCount } = await seedAssemblyContents(supabase, {
      documentId, workspaceId, elementId, depth: 0, rootOwnerId,
      partsOwner:    { assembly_id: assemblyId },
      childrenOwner: { parent_assembly_id: assemblyId },
      resolveCache,
    }))
  } catch (e) {
    // Don't leave an empty orphan assembly behind if the BOM fetch failed.
    await supabase.from('assemblies').delete().eq('id', assemblyId)
    throw e
  }

  const commitId = genCommitId()
  await recordChangeServer(supabase, {
    entityType: 'assembly', entityId: assemblyId, action: 'create',
    newValue: { id: assemblyId, name: assemblyName }, actorId: body.actorId || null, commitId,
  })

  return {
    assemblyId,
    partCount,
    childCount,
    onshapeUrl,
    message: `"${assemblyName}": ${partCount} part(s), ${childCount} subassembly(ies).`,
  }
}

// ── seedAssemblyContents ──────────────────────────────────────
// Writes parts + subassembly nodes owned by a single node (a root assembly
// OR a subassembly node), then recurses into each subassembly it finds.
//
// `partsOwner`    — { assembly_id } for a root assembly, or { assembly_child_id } for a subassembly node
// `childrenOwner` — { parent_assembly_id } for a root assembly, or { parent_child_id } for a subassembly node

async function seedAssemblyContents(supabase, {
  documentId, workspaceId, elementId, wvmType = 'w', depth, rootOwnerId,
  partsOwner, childrenOwner, progressByPartNumber = {}, resolveCache, fabricationMetadataByKey = {}
}) {
  let directParts   = []
  let subassemblies = []

  if (depth < MAX_CHILD_DEPTH) {
    // Category-header based resolver: classifies each row as a part or an
    // assembly, and — for assembly rows — as ours (recurse) vs. vendor/COTS
    // (logged as a part) by comparing document ids against the root document.
    const resolved = await resolveBomWithSubassemblies(documentId, workspaceId, elementId, wvmType, rootOwnerId, undefined, resolveCache)
    directParts   = resolved.directParts
    subassemblies = resolved.subassemblies
  } else {
    // At max depth: flat BOM only, every row becomes a direct part
    const bomData = await fetchBom(documentId, workspaceId, elementId, wvmType)
    directParts   = parseBomRows(bomData).parts
  }

  // ── Insert direct parts ───────────────────────────────────
  // Every part is inserted fresh at 0 collected / 'pending' — reimport no
  // longer tries to restore progress at insert time. Instead, once the
  // WHOLE tree has been rebuilt, reimportAssembly() does a single
  // source-key-based carry-over pass (see carryOverPromisesAfterReimport
  // below) that relinks each old part's actual linked_instance_ids,
  // quantity_collected, fabrication_jobs, and cart_items onto its
  // replacement — a strictly more accurate mechanism than the old
  // part-number-keyed quantity snapshot this replaces (that one could
  // only see root-level parts and collided on duplicate part numbers).
  if (directParts.length) {

    const rows = directParts.map(p => {
      const collected = progressByPartNumber[p.partNumber] ?? 0
      const status = collected >= p.quantity ? 'complete' : collected > 0 ? 'partial' : 'pending'
      const fabKey = fabricationIdentityKey(p.raw)
      const restoredMeta = fabKey && fabricationMetadataByKey[fabKey] ? reconcileRestoredMetadata(fabricationMetadataByKey[fabKey]) : {}

      return {
      id:                 genId(),
      ...partsOwner,
      part_name:          p.partName,
      part_number:        p.partNumber,
      quantity_needed:    p.quantity,
      quantity_collected: collected,
      status,
      source:             'onshape',
      notes:              '',
      onshape_reference:  p.raw,
      fabrication_metadata: restoredMeta,
      }
    })
    const { error: partsErr } = await supabase.from('assembly_parts').insert(rows)
    if (partsErr) throw new Error(`Parts insert: ${partsErr.message}`)
  }

  // Auto-create part_numbers stubs for every part carrying a vendor SKU —
  // component_id stays null until a user confirms the match via
  // linkInstanceToPart's backfill (src/db.js). Best-effort: failures here
  // shouldn't fail the whole import.
  for (const p of directParts) {
    if (!p.partNumber) continue
    try { await ensurePartNumberStubServer(supabase, p.partNumber, genId) }
    catch (e) { console.warn(`[onshape-bom] part_numbers stub failed for "${p.partNumber}": ${e.message}`) }
  }

  // ── Recursively build subassembly nodes (assembly_children only) ──
  // Siblings at this depth don't depend on each other, so resolve them
  // concurrently (capped) instead of one full round trip at a time — a
  // wide tree (e.g. 8 sibling subassemblies) now costs one "wave" of
  // parallel requests per depth level instead of 8 sequential ones.
  // resolveBomWithSubassemblies's own in-flight-promise caching (see
  // onshape.js) still protects against two of these siblings turning out
  // to reference the exact same underlying element.
  const childCount = await seedSubassembliesConcurrently(supabase, subassemblies, {
    depth, rootOwnerId, childrenOwner, resolveCache, fabricationMetadataByKey,
  })

  return { partCount: directParts.length, childCount }
}


/**
 * Inserts each subassembly's assembly_children row and recurses into its
 * contents, running up to MAX_ONSHAPE_CONCURRENCY of these sibling
 * branches in flight at once. A simple worker-pool pattern rather than a
 * flat Promise.all(...) so a subassembly with 20 siblings doesn't fire 20
 * simultaneous requests at Onshape — onshapeGet's own 429 backoff is a
 * safety net, not a substitute for capping fan-out at the source.
 */
async function seedSubassembliesConcurrently(supabase, subassemblies, { depth, rootOwnerId, childrenOwner, resolveCache }) {
  let childCount = 0
  let cursor = 0

  async function worker() {
    while (cursor < subassemblies.length) {
      const sub = subassemblies[cursor++]
      const childId = genId()
      const { error: childErr } = await supabase.from('assembly_children').insert({
        id:                   childId,
        ...childrenOwner,
        name:                 sub.partName,
        onshape_document_id:  sub.resolvedDocumentId,
        onshape_workspace_id: sub.resolvedWorkspaceId,
        onshape_wvm_type:     sub.resolvedWvmType || 'w',
        onshape_element_id:   sub.resolvedElementId,
        quantity:             sub.quantity,
      })
      if (childErr) throw new Error(`assembly_children insert: ${childErr.message}`)
      childCount++

      // Recurse into the subassembly's own contents — nested under IT, not
      // under the root assembly, so the hierarchy stays intact. Crucially,
      // pass along its actual branch type (workspace/version/microversion) —
      // mirrored/released/frozen references are commonly 'v', not 'w'.
      await seedAssemblyContents(supabase, {
        documentId:  sub.resolvedDocumentId,
        workspaceId: sub.resolvedWorkspaceId,
        wvmType:     sub.resolvedWvmType || 'w',
        elementId:   sub.resolvedElementId,
        depth:       depth + 1,
        rootOwnerId,
        partsOwner:    { assembly_child_id: childId },
        childrenOwner: { parent_child_id: childId },
        progressByPartNumber: {},
        resolveCache,
        fabricationMetadataByKey,
      })
    }
  }

  const workerCount = Math.min(MAX_ONSHAPE_CONCURRENCY, subassemblies.length)
  await Promise.all(Array.from({ length: workerCount }, worker))

  return childCount
}
// ── walkAssemblyPartsTree ────────────────────────────────────────
// Shared by reimport and (in designer.js's delete flow) assembly
// deletion: walks the FULL tree under a root assembly — its own
// assembly_parts, plus every nested assembly_children's assembly_parts,
// recursively — and returns the full row set. Selecting every column
// reimport needs (id, onshape_reference, linked_instance_ids,
// quantity_collected) means both callers can share one tree-walk
// instead of each re-implementing the recursive assembly_children
// traversal (three copies of this walk already existed independently
// before this change — src/db.js's fetchAllLinkedInstanceIdsForAssembly,
// this file's old releaseAllLinkedInstances, and
// onshape-detect-fabrication.js's fetchWholeTreeParts).
async function walkAssemblyPartsTree(supabase, assemblyId) {
  const allParts = []

  const { data: rootParts, error: rootErr } = await supabase
    .from('assembly_parts')
    .select('id, part_name, part_number, onshape_reference, linked_instance_ids, quantity_collected, quantity_needed')
    .eq('assembly_id', assemblyId)
  if (rootErr) throw rootErr
  allParts.push(...(rootParts ?? []))

  const { data: directChildren, error: childErr } = await supabase
    .from('assembly_children')
    .select('id')
    .eq('parent_assembly_id', assemblyId)
  if (childErr) throw childErr

  const queue = (directChildren ?? []).map(c => c.id)
  while (queue.length) {
    const childId = queue.pop()

    const { data: childParts, error: cpErr } = await supabase
      .from('assembly_parts')
      .select('id, part_name, part_number, onshape_reference, linked_instance_ids, quantity_collected, quantity_needed')
      .eq('assembly_child_id', childId)
    if (cpErr) throw cpErr
    allParts.push(...(childParts ?? []))

    const { data: grandchildren, error: gcErr } = await supabase
      .from('assembly_children')
      .select('id')
      .eq('parent_child_id', childId)
    if (gcErr) throw gcErr
    queue.push(...(grandchildren ?? []).map(c => c.id))
  }

  return allParts
}

function computePartStatus(collected, needed) {
  return collected >= needed ? 'complete' : collected > 0 ? 'partial' : 'pending'
}

// ── reimportAssembly ──────────────────────────────────────────
// Rebuilds in place under the original assemblyId — no new record
// created. Every assembly_parts row gets a brand-new id on every
// reimport (nothing about a part's PK survives), so anything that used
// to point at the OLD rows — linked inventory instances, fabrication
// jobs, cart items — has to be explicitly relinked onto the new rows
// via buildSourceKey(), the one identity that DOES survive across two
// independent imports of the same underlying Onshape geometry.
//
// Deliberately does NOT release inventory on reimport anymore (that was
// the old behavior, and it was wrong — reimporting is not the same
// event as deleting the assembly). Release only happens for parts that
// genuinely no longer exist in the new BOM at all; everything else
// carries its real links forward. Assembly-level release-on-delete
// lives in designer.js's deleteCurrentAssembly instead.
//
// If quantity_needed shrinks on reimport (e.g. 6 → 5) and the part's
// promised+collected total now exceeds it, this is deliberately left as
// an over-count for a human to notice and resolve manually (unlink an
// instance, cancel a job, remove a cart item) — see the "quantity
// decrease reconciliation" design discussion. No promise source is ever
// auto-trimmed by this function.

async function reimportAssembly(supabase, assemblyId) {
  const { data: asm, error: fetchErr } = await supabase
    .from('assemblies').select('*').eq('id', assemblyId).single()
  if (fetchErr || !asm) throw new Error('Assembly not found.')
  if (!asm.onshape_element_id) throw new Error('Assembly is not linked to Onshape.')

  // ── 1. Snapshot the OLD tree before anything is wiped ──────────
  const oldParts = await walkAssemblyPartsTree(supabase, assemblyId)
  const oldPartIds = oldParts.map(p => p.id)
  const oldSourceKeyById = Object.fromEntries(
    oldParts.map(p => [p.id, buildSourceKey(p.onshape_reference)])
  )

  const { data: oldJobs, error: jobsFetchErr } = oldPartIds.length
    ? await supabase.from('fabrication_jobs').select('*').in('assembly_part_id', oldPartIds)
    : { data: [], error: null }
  if (jobsFetchErr) throw jobsFetchErr

  const { data: oldCartItems, error: cartFetchErr } = oldPartIds.length
    ? await supabase.from('cart_items').select('id, assembly_part_id').in('assembly_part_id', oldPartIds)
    : { data: [], error: null }
  if (cartFetchErr) throw cartFetchErr

  // ── 2. Wipe + reseed ─────────────────────────────────────────
  // fabrication_jobs cascade-deletes with their assembly_part (FK is
  // ON DELETE CASCADE); cart_items instead get their assembly_part_id
  // set to null (FK is ON DELETE SET NULL, so they survive as
  // unearmarked general-restock items) — both are captured above
  // BEFORE this point specifically so they can be reconstituted/
  // relinked after reseeding, not lost to the cascade.

  const fabricationMetadataByKey = await fetchWholeTreeFabricationMetadata(supabase, assemblyId)

  await releaseAllLinkedInstances(supabase, assemblyId)

  await supabase.from('assembly_parts').delete().eq('assembly_id', assemblyId)
  await supabase.from('assembly_children').delete().eq('parent_assembly_id', assemblyId)

  const rootOwnerId = await fetchDocumentOwnerId(asm.onshape_document_id)
  const resolveCache = new Map()
  const { partCount, childCount } = await seedAssemblyContents(supabase, {
    documentId:  asm.onshape_document_id,
    workspaceId: asm.onshape_workspace_id,
    elementId:   asm.onshape_element_id,
    depth:       0,
    rootOwnerId,
    partsOwner:    { assembly_id: assemblyId },
    childrenOwner: { parent_assembly_id: assemblyId },
    resolveCache,
    fabricationMetadataByKey,
  })

  await supabase.from('assemblies').update({ status: 'draft' }).eq('id', assemblyId)

  // ── 3. Build the NEW tree's source-key index ────────────────
  const newParts = await walkAssemblyPartsTree(supabase, assemblyId)
  const newBySourceKey = new Map()
  for (const p of newParts) {
    const key = buildSourceKey(p.onshape_reference)
    if (!key) continue
    if (newBySourceKey.has(key)) {
      // Shouldn't normally happen — Onshape itself aggregates identical
      // part instances into one BOM row with a quantity, so two distinct
      // NEW rows sharing a source key would mean Onshape's own dedup
      // didn't apply the way we expect. Keep the first match and warn
      // rather than silently overwriting or throwing.
      console.warn(`[onshape-bom] Duplicate source key on reimport (${key}) — keeping the first match.`)
      continue
    }
    newBySourceKey.set(key, p)
  }

  const summary = await carryOverPromisesAfterReimport(supabase, {
    oldParts, oldSourceKeyById, oldJobs: oldJobs ?? [], oldCartItems: oldCartItems ?? [],
    newBySourceKey,
  })

  await logReimportChanges(supabase, { assemblyId, oldParts, newParts, actorId: body.actorId || null })

  const parts = [
    `Re-imported: ${partCount} part(s), ${childCount} subassembly(ies).`,
    `${summary.relinkedInventoryCount} part(s) kept their existing inventory links.`,
    summary.relinkedJobsCount ? `${summary.relinkedJobsCount} fabrication job(s) carried forward${summary.geometryChangedJobCount ? ` (${summary.geometryChangedJobCount} flagged for review — geometry changed since)` : ''}.` : null,
    summary.relinkedCartItemsCount ? `${summary.relinkedCartItemsCount} cart item(s) stayed earmarked to their part.` : null,
    summary.lostPartsWithLinksCount ? `${summary.lostPartsWithLinksCount} part(s) no longer in the BOM had their reserved inventory released back to available.` : null,
    summary.lostJobsCount ? `${summary.lostJobsCount} fabrication job(s) could not be carried forward — their part no longer exists in this BOM.` : null,
  ].filter(Boolean).join(' ')

  return {
    assemblyId,
    partCount,
    childCount,
    ...summary,
    message: parts,
  }
}

// ── carryOverPromisesAfterReimport ──────────────────────────────
// The actual relink pass, run once the new tree fully exists. For every
// OLD part, resolves whether a NEW part shares its source key:
//
//   match found    → inventory links + quantity_collected carry over
//                     as-is (the real link IS the truth now, replacing
//                     the old part-number-keyed quantity snapshot);
//                     fabrication jobs are re-created pointing at the
//                     new part (see relinkJob); cart items get
//                     re-earmarked to the new part id.
//   no match found → the part genuinely no longer exists in this BOM.
//                     Any inventory it had reserved is released back to
//                     available (this is the "a specific part vanished"
//                     case, distinct from "the whole assembly was
//                     deleted" — both end in release, for the same
//                     reason: nothing exists anymore for the reservation
//                     to describe). Its fabrication job(s) already
//                     cascade-deleted with the old row — nothing to
//                     insert, just counted for the summary. Its cart
//                     item(s) already had assembly_part_id set to null
//                     by the FK — same "un-earmark, don't destroy"
//                     treatment used on assembly deletion, and no
//                     explicit action is needed here since the DB
//                     already did it.
async function carryOverPromisesAfterReimport(supabase, { oldParts, oldSourceKeyById, oldJobs, oldCartItems, newBySourceKey }) {
  let relinkedInventoryCount = 0
  let lostPartsWithLinksCount = 0
  let relinkedJobsCount = 0
  let geometryChangedJobCount = 0
  let lostJobsCount = 0
  let relinkedCartItemsCount = 0

  const instancesToRelease = []
  // Guards the one-active-job-per-part rule across THIS reimport's
  // re-inserts specifically — see the duplicate-source-key note above
  // for why two old parts could theoretically collapse onto one new
  // part id (shouldn't happen, but re-inserting two active jobs onto
  // the same new part would violate fabrication_jobs_one_active_per_part
  // and abort the whole reimport, which is a worse outcome than
  // dropping the second one with a loud warning).
  const activeJobClaimedForNewPartId = new Set()

  for (const oldPart of oldParts) {
    const key = oldSourceKeyById[oldPart.id]
    const newPart = key ? newBySourceKey.get(key) : null

    if (!newPart) {
      if (oldPart.linked_instance_ids?.length) {
        instancesToRelease.push(...oldPart.linked_instance_ids)
        lostPartsWithLinksCount++
      }
      continue
    }

    // ── Inventory: carry the real link + count forward as-is ──
    if (oldPart.linked_instance_ids?.length || oldPart.quantity_collected > 0) {
      const { error } = await supabase
        .from('assembly_parts')
        .update({
          linked_instance_ids: oldPart.linked_instance_ids || [],
          quantity_collected:  oldPart.quantity_collected || 0,
          status:              computePartStatus(oldPart.quantity_collected || 0, newPart.quantity_needed),
        })
        .eq('id', newPart.id)
      if (error) console.warn(`[onshape-bom] Failed carrying inventory links onto ${newPart.id}: ${error.message}`)
      else relinkedInventoryCount++
    }
  }

  // ── Fabrication jobs: re-create against the new part id ────────
  // Every status (queued/committed/in_progress/complete/archived) is
  // carried forward if its part still exists — a completed or archived
  // job is historical fact (machining already happened) independent of
  // whether the geometry now differs, so it's never dropped just
  // because geometry changed. Only an ACTIVE job (queued/committed/
  // in_progress) gets geometry-checked, because that's the only case
  // where "does this job still describe the current part" is still an
  // open, actionable question.
  for (const job of oldJobs) {
    const oldPart = oldParts.find(p => p.id === job.assembly_part_id)
    const key = oldPart ? oldSourceKeyById[oldPart.id] : null
    const newPart = key ? newBySourceKey.get(key) : null

    if (!newPart) { lostJobsCount++; continue }

    const isActive = job.status !== 'complete' && job.status !== 'archived'
    if (isActive) {
      if (activeJobClaimedForNewPartId.has(newPart.id)) {
        console.warn(`[onshape-bom] Skipping duplicate active job for part ${newPart.id} on reimport — a source-key collision left two old parts mapping to one new part.`)
        lostJobsCount++
        continue
      }
      activeJobClaimedForNewPartId.add(newPart.id)
    }

    const { error: insErr } = await supabase.from('fabrication_jobs').insert({
      id:                 genId(),
      batch_id:           job.batch_id,
      assembly_part_id:   newPart.id,
      quantity_requested: job.quantity_requested,
      quantity_machined:  job.quantity_machined,
      status:             job.status,
      claimed_by:         job.claimed_by,
      claimed_at:         job.claimed_at,
      notes:              job.notes,
      created_at:         job.created_at,
    })
    if (insErr) {
      console.warn(`[onshape-bom] Failed relinking fabrication job onto ${newPart.id}: ${insErr.message}`)
      lostJobsCount++
      continue
    }
    relinkedJobsCount++

    // Geometry-changed signal: same source key, different microversion —
    // something in that Part Studio was edited since the job was
    // created. Conservative on purpose (this will false-positive on
    // edits unrelated to this specific part) — the job still relinks
    // (someone may already be physically machining it), but the new
    // part row is flagged so a human notices and can decide whether the
    // job needs re-confirming.
    if (isActive) {
      const oldMv = oldPart?.onshape_reference?.sourceElementMicroversionId
      const newMv = newPart.onshape_reference?.sourceElementMicroversionId
      if (oldMv && newMv && oldMv !== newMv) {
        geometryChangedJobCount++
        const { error: metaErr } = await supabase
          .from('assembly_parts')
          .update({
            fabrication_metadata: {
              autoDetected: false,
              status: 'needs_review',
              source: 'reimport-geometry-changed',
              warnings: [
                'A fabrication job was carried forward from before this reimport, but this part\u2019s ' +
                'geometry has changed in Onshape since (the source Part Studio\u2019s microversion differs). ' +
                'Confirm the job still matches the current geometry.',
              ],
            },
          })
          .eq('id', newPart.id)
        if (metaErr) console.warn(`[onshape-bom] Failed flagging geometry change on ${newPart.id}: ${metaErr.message}`)
      }
    }
  }

  // ── Cart items: re-earmark to the new part id ───────────────────
  // Any status is relinked if its part still exists — a 'received' or
  // 'ordered' cart item earmarked to a part that still exists should
  // keep pointing at it regardless of geometry, since the purchase
  // itself isn't affected by a dimension change the way a not-yet-cut
  // fabrication job is.
  for (const item of oldCartItems) {
    const oldPart = oldParts.find(p => p.id === item.assembly_part_id)
    const key = oldPart ? oldSourceKeyById[oldPart.id] : null
    const newPart = key ? newBySourceKey.get(key) : null
    if (!newPart) continue   // already un-earmarked to null by the FK — nothing to do

    const { error } = await supabase
      .from('cart_items')
      .update({ assembly_part_id: newPart.id })
      .eq('id', item.id)
    if (error) console.warn(`[onshape-bom] Failed relinking cart item ${item.id} onto ${newPart.id}: ${error.message}`)
    else relinkedCartItemsCount++
  }

  if (instancesToRelease.length) {
    const { error } = await supabase
      .from('inventory_instances')
      .update({ status: 'available', location: '' })
      .in('id', instancesToRelease)
    if (error) console.warn(`[onshape-bom] Failed releasing ${instancesToRelease.length} instance(s) for removed parts: ${error.message}`)
  }

  return {
    relinkedInventoryCount,
    lostPartsWithLinksCount,
    relinkedJobsCount,
    geometryChangedJobCount,
    lostJobsCount,
    relinkedCartItemsCount,
  }
}

async function ensurePartNumberStubServer(supabase, value, genId) {
  const trimmed = (value || '').trim()
  if (!trimmed) return
  const { data: existing } = await supabase.from('part_numbers').select('id').eq('value', trimmed).maybeSingle()
  if (existing) return
  await supabase.from('part_numbers').insert({ id: genId(), value: trimmed, component_id: null })
}

// ── fetchWholeTreeFabricationMetadata ───────────────────────────
// Walks the FULL tree under a root assembly (its own assembly_parts,
// plus every nested assembly_children's assembly_parts, recursively)
// and returns a map of fabricationIdentityKey -> fabrication_metadata,
// for every row that has both a usable identity key and non-empty
// metadata. Must run BEFORE the cascade delete wipes these rows.
async function fetchWholeTreeFabricationMetadata(supabase, assemblyId) {
  const map = {}

  function absorb(rows) {
    for (const row of rows) {
      const key = fabricationIdentityKey(row.onshape_reference)
      if (!key) continue
      if (!row.fabrication_metadata || !row.fabrication_metadata.kind) continue
      map[key] = row.fabrication_metadata
    }
  }

  const { data: rootParts } = await supabase
    .from('assembly_parts')
    .select('onshape_reference, fabrication_metadata')
    .eq('assembly_id', assemblyId)
  absorb(rootParts ?? [])

  const { data: directChildren } = await supabase
    .from('assembly_children')
    .select('id')
    .eq('parent_assembly_id', assemblyId)

  const childQueue = (directChildren ?? []).map(c => c.id)
  while (childQueue.length) {
    const childId = childQueue.pop()

    const { data: childParts } = await supabase
      .from('assembly_parts')
      .select('onshape_reference, fabrication_metadata')
      .eq('assembly_child_id', childId)
    absorb(childParts ?? [])

    const { data: grandchildren } = await supabase
      .from('assembly_children')
      .select('id')
      .eq('parent_child_id', childId)
    childQueue.push(...(grandchildren ?? []).map(c => c.id))
  }

  return map
}

// A row carried forward with status 'queued' or 'confirmed' implies an
// active fabrication_jobs row — but fabrication_jobs.assembly_part_id is
// `on delete cascade` (schema.sql), so the reimport's delete of
// assembly_parts has ALREADY destroyed that job by the time we're
// restoring metadata onto the new row. Carrying 'queued'/'confirmed'
// forward as-is would silently claim a job exists when it doesn't (and
// would also re-trigger the "queued rows are terminal, never rescanned"
// skip in onshape-detect-fabrication.js for a row nothing is actually
// tracking anymore). Downgrade back to 'detected' so it's reviewable
// again, and say why.
function reconcileRestoredMetadata(meta) {
  if (meta.status !== 'queued' && meta.status !== 'confirmed') return meta
  return {
    ...meta,
    status: 'detected',
    warnings: [
      ...(meta.warnings || []),
      'This part\'s fabrication job was lost on reimport (assembly parts are rebuilt from scratch) — please re-confirm and re-send to Fabricate.',
    ],
  }
}

// Logs one commit summarizing a reimport: the assembly's own part/child
// counts before → after, plus one 'delete' row for every part that
// genuinely dropped out of the BOM (no source-key match in the new
// tree) and one 'create' row for every part that's genuinely new (no
// source-key match in the old tree). Parts that carried over as-is
// (same source key, same or changed quantity_collected) are NOT
// re-logged as updates here — carryOverPromisesAfterReimport's job is
// to make the new row match the old, so nothing about them changed
// that's worth a diff entry; only real gains/losses are commit-worthy.
async function logReimportChanges(supabase, { assemblyId, oldParts, newParts, actorId }) {
  const commitId = genCommitId()

  const oldKeys = new Set(oldParts.map(p => buildSourceKey(p.onshape_reference)).filter(Boolean))
  const newKeys = new Set(newParts.map(p => buildSourceKey(p.onshape_reference)).filter(Boolean))

  await recordChangeServer(supabase, {
    entityType: 'assembly', entityId: assemblyId, action: 'update',
    field: 'reimport', oldValue: { partCount: oldParts.length }, newValue: { partCount: newParts.length },
    actorId, commitId,
  })

  for (const p of oldParts) {
    const key = buildSourceKey(p.onshape_reference)
    if (key && newKeys.has(key)) continue   // survived — not a delete
    await recordChangeServer(supabase, {
      entityType: 'assembly_part', entityId: p.id, action: 'delete',
      oldValue: p, actorId, commitId,
      causedByEntityType: 'assembly', causedByEntityId: assemblyId,
    })
  }

  for (const p of newParts) {
    const key = buildSourceKey(p.onshape_reference)
    if (key && oldKeys.has(key)) continue   // carried over — not a fresh create
    await recordChangeServer(supabase, {
      entityType: 'assembly_part', entityId: p.id, action: 'create',
      newValue: p, actorId, commitId,
      causedByEntityType: 'assembly', causedByEntityId: assemblyId,
    })
  }
}