// api/onshape-bom.js — Vercel serverless function
//
// Two modes, controlled by the request body:
//
//   NEW IMPORT  { documentId, workspaceId, elementId, assemblyName, parentAssemblyId? }
//     Creates a new Partshelf assembly from an Onshape BOM, recursively
//     creating child assemblies for any subassemblies found (up to MAX_CHILD_DEPTH).
//
//   RE-IMPORT   { assemblyId, reimport: true }
//     Rebuilds an existing linked assembly from Onshape from scratch.
//     Saves quantity_collected by part_number before wiping, restores after rebuild.
//     All previously-created child assemblies are also deleted and rebuilt.

import { createClient }           from '@supabase/supabase-js'
import {
  onshapeGet,
  fetchBomHierarchical,
  parseBomHierarchy,
  applyCors,
  genId,
  MAX_CHILD_DEPTH,
} from './_lib/onshape.js'

// ── Supabase client ───────────────────────────────────────────

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

    const { documentId, workspaceId, elementId, assemblyName, parentAssemblyId } = body
    if (!documentId || !workspaceId || !elementId) {
      return res.status(400).json({ error: 'documentId, workspaceId, and elementId are required.' })
    }

    const result = await buildAssembly(supabase, {
      documentId, workspaceId, elementId,
      name:             assemblyName || null,
      parentAssemblyId: parentAssemblyId || null,
      depth:            0,
      thumbnailUrl:     body.thumbnailUrl || null,
    })

    return res.status(200).json({ success: true, ...result })

  } catch (err) {
    console.error('[onshape-bom]', err)
    return res.status(500).json({ error: err.message ?? 'Internal server error' })
  }
}

// ── Core: build one assembly (and its children recursively) ───

async function buildAssembly(supabase, {
  documentId, workspaceId, elementId,
  name, parentAssemblyId, depth, thumbnailUrl,
  progressByPartNumber = {},   // restored progress, only used at depth 0 during reimport
}) {
  // Fetch hierarchical BOM from Onshape
  const bomData  = await fetchBomHierarchical(documentId, workspaceId, elementId)
  const { parts: directParts, subassemblies } = parseBomHierarchy(bomData)

  const assemblyId = genId()
  const onshapeUrl = `https://cad.onshape.com/documents/${documentId}/w/${workspaceId}/e/${elementId}`

  // Derive a default name from the BOM metadata if not supplied
  const assemblyName = name || bomData.name || `Onshape assembly — ${new Date().toLocaleDateString()}`

  // ── Create the assembly record ─────────────────────────────
  const { error: asmErr } = await supabase.from('assemblies').insert({
    id:                   assemblyId,
    name:                 assemblyName,
    description:          depth === 0
                            ? `Linked from Onshape on ${new Date().toLocaleString()}`
                            : `Subassembly — linked from Onshape`,
    onshape_url:          onshapeUrl,
    onshape_document_id:  documentId,
    onshape_workspace_id: workspaceId,
    onshape_element_id:   elementId,
    thumbnail_url:        depth === 0 ? (thumbnailUrl || null) : null,
    status:               'draft',
  })
  if (asmErr) throw new Error(`Assembly insert failed: ${asmErr.message}`)

  // ── Insert direct parts ────────────────────────────────────
  if (directParts.length) {
    const rows = directParts.map(p => ({
      id:                 genId(),
      assembly_id:        assemblyId,
      part_name:          p.partName,
      part_number:        p.partNumber,
      quantity_needed:    p.quantity,
      // Restore collected progress if reimporting (matched by part_number)
      quantity_collected: progressByPartNumber[p.partNumber] ?? 0,
      status:             progressByPartNumber[p.partNumber] > 0
                            ? (progressByPartNumber[p.partNumber] >= p.quantity ? 'complete' : 'partial')
                            : 'pending',
      source:             'onshape',
      notes:              '',
      onshape_reference:  p.raw,
    }))
    const { error: partsErr } = await supabase.from('assembly_parts').insert(rows)
    if (partsErr) throw new Error(`Parts insert failed: ${partsErr.message}`)
  }

  // ── Recursively build subassemblies (up to MAX_CHILD_DEPTH) ──
  const childLinks = []

  for (const sub of subassemblies) {
    // Onshape sometimes omits workspaceId on inner rows — fall back to parent
    const childDocId  = sub.documentId  || documentId
    const childWsId   = sub.workspaceId || workspaceId
    const childElemId = sub.elementId

    if (!childElemId) {
      // No element reference — treat as a flat part instead
      console.warn(`[onshape-bom] Subassembly "${sub.partName}" has no elementId — adding as part`)
      await supabase.from('assembly_parts').insert({
        id:                 genId(),
        assembly_id:        assemblyId,
        part_name:          sub.partName,
        part_number:        sub.partNumber,
        quantity_needed:    sub.quantity,
        quantity_collected: 0,
        status:             'pending',
        source:             'onshape',
        notes:              '(subassembly — no element reference)',
        onshape_reference:  sub.raw,
      })
      continue
    }

    // Build the child assembly recursively (its own parts + its own children)
    const childResult = await buildAssembly(supabase, {
      documentId:  childDocId,
      workspaceId: childWsId,
      elementId:   childElemId,
      name:        sub.partName,
      parentAssemblyId: assemblyId,
      depth:       depth + 1,
    })

    childLinks.push({
      id:                genId(),
      parent_assembly_id: assemblyId,
      child_assembly_id:  childResult.assemblyId,
      quantity:           sub.quantity,
    })
  }

  // ── Insert assembly_children rows ──────────────────────────
  if (childLinks.length) {
    const { error: linkErr } = await supabase.from('assembly_children').insert(childLinks)
    if (linkErr) throw new Error(`assembly_children insert failed: ${linkErr.message}`)
  }

  return {
    assemblyId,
    partCount:      directParts.length,
    childCount:     childLinks.length,
    onshapeUrl,
    message: `Assembly "${assemblyName}" created with ${directParts.length} part(s) and ${childLinks.length} subassembly link(s).`,
  }
}

// ── Re-import: discard and rebuild, restoring progress ────────

async function reimportAssembly(supabase, assemblyId) {
  // 1. Load current assembly to get its Onshape coordinates
  const { data: asm, error: fetchErr } = await supabase
    .from('assemblies')
    .select('*')
    .eq('id', assemblyId)
    .single()
  if (fetchErr || !asm) throw new Error('Assembly not found.')
  if (!asm.onshape_element_id) throw new Error('This assembly is not linked to Onshape — nothing to re-import.')

  // 2. Save quantity_collected from current direct parts, keyed by part_number
  const { data: oldParts } = await supabase
    .from('assembly_parts')
    .select('part_number, quantity_collected')
    .eq('assembly_id', assemblyId)

  const progressByPartNumber = {}
  for (const p of oldParts ?? []) {
    if (p.part_number && p.quantity_collected > 0) {
      progressByPartNumber[p.part_number] = p.quantity_collected
    }
  }

  // 3. Find all previously-generated child assemblies to delete
  //    (traverse the tree to collect all descendant IDs)
  const descendantIds = await collectDescendantIds(supabase, assemblyId)

  // 4. Delete direct parts and child links for this assembly
  await supabase.from('assembly_parts').delete().eq('assembly_id', assemblyId)
  await supabase.from('assembly_children').delete().eq('parent_assembly_id', assemblyId)

  // 5. Delete descendant assemblies (cascades their own parts + child links)
  if (descendantIds.length) {
    await supabase.from('assemblies').delete().in('id', descendantIds)
  }

  // 6. Rebuild from Onshape, restoring collected progress
  const { data: doc } = await supabase
    .from('assemblies')
    .select('name, thumbnail_url')
    .eq('id', assemblyId)
    .single()

  // We rebuild children under the EXISTING assemblyId by calling buildAssembly
  // then rerouting their parent links back to the original ID.
  // Simpler: call buildAssembly to get a fresh tree, then swap the root ID.
  const freshResult = await buildAssembly(supabase, {
    documentId:  asm.onshape_document_id,
    workspaceId: asm.onshape_workspace_id,
    elementId:   asm.onshape_element_id,
    name:        asm.name,
    depth:       0,
    thumbnailUrl: asm.thumbnail_url,
    progressByPartNumber,
  })

  // buildAssembly creates a brand new assembly row. We want to keep the
  // original assemblyId so all existing UI references, bookmarks etc. remain
  // valid. Swap the new root ID → original ID.
  await swapAssemblyId(supabase, freshResult.assemblyId, assemblyId, asm)

  return {
    assemblyId,
    partCount:  freshResult.partCount,
    childCount: freshResult.childCount,
    restoredProgress: Object.keys(progressByPartNumber).length,
    message: `Re-imported. ${freshResult.partCount} part(s), ${freshResult.childCount} subassembly link(s). Progress restored for ${Object.keys(progressByPartNumber).length} part(s).`,
  }
}

/** Collect all descendant assembly IDs (children, grandchildren…) */
async function collectDescendantIds(supabase, assemblyId, visited = new Set()) {
  if (visited.has(assemblyId)) return []
  visited.add(assemblyId)

  const { data: rows } = await supabase
    .from('assembly_children')
    .select('child_assembly_id')
    .eq('parent_assembly_id', assemblyId)

  const ids = []
  for (const row of rows ?? []) {
    const childId = row.child_assembly_id
    ids.push(childId)
    const deeper = await collectDescendantIds(supabase, childId, visited)
    ids.push(...deeper)
  }
  return ids
}

/**
 * After buildAssembly creates a fresh root with a new UUID, swap it back
 * to the original assemblyId so existing references stay valid.
 */
async function swapAssemblyId(supabase, freshId, originalId, originalAsm) {
  // Update the fresh assembly row to carry the original ID and metadata
  // (name may have been edited by the user since the last import)
  await supabase.from('assemblies').update({
    id:          originalId,
    name:        originalAsm.name,
    description: originalAsm.description,
  }).eq('id', freshId)

  // Point all parts + child links that reference freshId → originalId
  await supabase.from('assembly_parts')
    .update({ assembly_id: originalId })
    .eq('assembly_id', freshId)

  await supabase.from('assembly_children')
    .update({ parent_assembly_id: originalId })
    .eq('parent_assembly_id', freshId)
}
