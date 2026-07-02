// api/onshape-bom.js — Vercel serverless function
//
// Two modes (controlled by request body):
//
// NEW IMPORT  { documentId, workspaceId, elementId, assemblyName, thumbnailUrl? }
//   Creates a new Partshelf assembly record, then seeds it with parts and
//   child assemblies (recursively, up to MAX_CHILD_DEPTH).
//
// RE-IMPORT   { assemblyId, reimport: true }
//   Rebuilds an existing linked assembly in-place:
//   1. Saves quantity_collected keyed by part_number
//   2. Deletes all descendant assemblies + their parts
//   3. Deletes direct parts and child-links on the root assembly
//   4. Re-seeds the existing assembly record from Onshape (no new record created)
//   5. Restores saved progress on matching part_numbers
//
// The split between buildAssembly (creates a record) and seedAssemblyContents
// (populates an existing record) is intentional: reimport reuses the original
// assembly ID so nothing in the UI breaks after the rebuild.

import { createClient }           from '@supabase/supabase-js'
import {
  fetchBom,
  fetchBomHierarchical,
  parseBomRows,
  parseBomHierarchy,
  applyCors,
  genId,
  MAX_CHILD_DEPTH,
} from './_lib/onshape.js'

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

    const result = await buildAssembly(supabase, {
      documentId, workspaceId, elementId,
      name:         assemblyName || null,
      thumbnailUrl: thumbnailUrl || null,
      depth:        0,
    })

    return res.status(200).json({ success: true, ...result })

  } catch (err) {
    console.error('[onshape-bom]', err)
    return res.status(500).json({ error: err.message ?? 'Internal server error' })
  }
}

// ── buildAssembly ─────────────────────────────────────────────
// Creates a new assembly record in Supabase, then populates it.
// Used for: initial new-import, and for each child assembly during recursion.

async function buildAssembly(supabase, { documentId, workspaceId, elementId, name, depth, thumbnailUrl }) {
  const assemblyId = genId()
  const onshapeUrl = `https://cad.onshape.com/documents/${documentId}/w/${workspaceId}/e/${elementId}`
  const assemblyName = name || `Onshape assembly — ${new Date().toLocaleDateString()}`

  const { error: asmErr } = await supabase.from('assemblies').insert({
    id:                   assemblyId,
    name:                 assemblyName,
    description:          depth === 0
                            ? `Linked from Onshape on ${new Date().toLocaleString()}`
                            : 'Subassembly — linked from Onshape',
    onshape_url:          onshapeUrl,
    onshape_document_id:  documentId,
    onshape_workspace_id: workspaceId,
    onshape_element_id:   elementId,
    thumbnail_url:        depth === 0 ? (thumbnailUrl || null) : null,
    status:               'draft',
  })
  if (asmErr) throw new Error(`Assembly insert failed: ${asmErr.message}`)

  const { partCount, childCount } = await seedAssemblyContents(supabase, assemblyId, {
    documentId, workspaceId, elementId, depth,
    progressByPartNumber: {},
  })

  return {
    assemblyId,
    partCount,
    childCount,
    onshapeUrl,
    message: `Assembly "${assemblyName}" created with ${partCount} part(s) and ${childCount} subassembly link(s).`,
  }
}

// ── seedAssemblyContents ──────────────────────────────────────
// Fetches the BOM from Onshape and writes parts + child-assembly links
// into an EXISTING assembly record (identified by assemblyId).
//
// Used by: buildAssembly (fresh record) and reimportAssembly (existing record).
//
// Depth cap: at depth >= MAX_CHILD_DEPTH, uses a flat BOM so no further
// child assemblies are created regardless of nesting in Onshape.

async function seedAssemblyContents(supabase, assemblyId, {
  documentId, workspaceId, elementId, depth, progressByPartNumber = {},
}) {
  let directParts  = []
  let subassemblies = []

  if (depth < MAX_CHILD_DEPTH) {
    // Hierarchical fetch — subassemblies will be separated out
    const bomData = await fetchBomHierarchical(documentId, workspaceId, elementId)
    const tree = parseBomHierarchy(bomData)
    directParts   = tree.parts
    subassemblies = tree.subassemblies
  } else {
    // At max depth: flat fetch only, everything becomes a direct part
    const bomData = await fetchBom(documentId, workspaceId, elementId)
    const flat = parseBomRows(bomData)
    directParts = flat.parts
  }

  // ── Insert direct parts ────────────────────────────────────
  if (directParts.length) {
    const rows = directParts.map(p => {
      const collected = progressByPartNumber[p.partNumber] ?? 0
      const status    = collected >= p.quantity ? 'complete'
                      : collected > 0           ? 'partial'
                      :                           'pending'
      return {
        id:                 genId(),
        assembly_id:        assemblyId,
        part_name:          p.partName,
        part_number:        p.partNumber,
        quantity_needed:    p.quantity,
        quantity_collected: collected,
        status,
        source:             'onshape',
        notes:              '',
        onshape_reference:  p.raw,
      }
    })
    const { error: partsErr } = await supabase.from('assembly_parts').insert(rows)
    if (partsErr) throw new Error(`Parts insert failed: ${partsErr.message}`)
  }

  // ── Recursively build child assemblies ─────────────────────
  const childLinks = []

  for (const sub of subassemblies) {
    // Onshape sometimes omits workspaceId on inner rows — fall back to parent
    const childDocId  = sub.documentId  || documentId
    const childWsId   = sub.workspaceId || workspaceId
    const childElemId = sub.elementId

    if (!childElemId) {
      // No element reference — demote to a flat part with a note
      console.warn(`[onshape-bom] Subassembly "${sub.partName}" has no elementId — adding as part`)
      const { error } = await supabase.from('assembly_parts').insert({
        id:                 genId(),
        assembly_id:        assemblyId,
        part_name:          sub.partName,
        part_number:        sub.partNumber,
        quantity_needed:    sub.quantity,
        quantity_collected: 0,
        status:             'pending',
        source:             'onshape',
        notes:              '(subassembly — no element reference found)',
        onshape_reference:  sub.raw,
      })
      if (error) console.error('Demoted-part insert error:', error)
      continue
    }

    // Build child assembly (creates record + seeds its own contents)
    const childResult = await buildAssembly(supabase, {
      documentId:  childDocId,
      workspaceId: childWsId,
      elementId:   childElemId,
      name:        sub.partName,
      depth:       depth + 1,
      thumbnailUrl: null,
    })

    childLinks.push({
      id:                 genId(),
      parent_assembly_id: assemblyId,
      child_assembly_id:  childResult.assemblyId,
      quantity:           sub.quantity,
    })
  }

  if (childLinks.length) {
    const { error: linkErr } = await supabase.from('assembly_children').insert(childLinks)
    if (linkErr) throw new Error(`assembly_children insert failed: ${linkErr.message}`)
  }

  return { partCount: directParts.length, childCount: childLinks.length }
}

// ── reimportAssembly ──────────────────────────────────────────
// Rebuilds an existing linked assembly in-place.
// The original assembly record is NOT deleted or recreated — only its
// parts and child links are wiped and rebuilt, so the assembly ID stays
// the same and nothing in the UI references a stale ID.

async function reimportAssembly(supabase, assemblyId) {
  // 1. Load existing record to get Onshape coordinates
  const { data: asm, error: fetchErr } = await supabase
    .from('assemblies')
    .select('*')
    .eq('id', assemblyId)
    .single()
  if (fetchErr || !asm) throw new Error('Assembly not found.')
  if (!asm.onshape_element_id) {
    throw new Error('This assembly is not linked to Onshape — nothing to re-import.')
  }

  // 2. Save quantity_collected from direct parts, keyed by part_number
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

  // 3. Collect all descendant assembly IDs so we can delete them after
  //    unlinking (cascade handles their own parts and child-links)
  const descendantIds = await collectDescendantIds(supabase, assemblyId)

  // 4. Delete direct parts and child-links on the root assembly
  await supabase.from('assembly_parts').delete().eq('assembly_id', assemblyId)
  await supabase.from('assembly_children').delete().eq('parent_assembly_id', assemblyId)

  // 5. Delete descendant assembly records
  //    (cascade in schema drops their assembly_parts + assembly_children rows)
  if (descendantIds.length) {
    const { error: delErr } = await supabase
      .from('assemblies')
      .delete()
      .in('id', descendantIds)
    if (delErr) console.error('Descendant delete error:', delErr)
  }

  // 6. Re-seed the EXISTING assembly record from Onshape
  //    No new assembly record is created — seedAssemblyContents writes
  //    directly under the original assemblyId
  const { partCount, childCount } = await seedAssemblyContents(supabase, assemblyId, {
    documentId:          asm.onshape_document_id,
    workspaceId:         asm.onshape_workspace_id,
    elementId:           asm.onshape_element_id,
    depth:               0,
    progressByPartNumber,
  })

  // 7. Reset the assembly's status to 'draft' so it reflects the new state
  await supabase
    .from('assemblies')
    .update({ status: 'draft' })
    .eq('id', assemblyId)

  const restoredCount = Object.keys(progressByPartNumber).length
  return {
    assemblyId,
    partCount,
    childCount,
    restoredProgress: restoredCount,
    message: `Re-imported: ${partCount} direct part(s), ${childCount} subassembly link(s). Progress restored for ${restoredCount} part number(s).`,
  }
}

// ── Helpers ───────────────────────────────────────────────────

/** Recursively collect all descendant assembly IDs (children, grandchildren…) */
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
