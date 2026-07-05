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
  applyCors, genId, MAX_CHILD_DEPTH,
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
    ;({ partCount, childCount } = await seedAssemblyContents(supabase, {
      documentId, workspaceId, elementId, depth: 0, rootOwnerId,
      partsOwner:    { assembly_id: assemblyId },
      childrenOwner: { parent_assembly_id: assemblyId },
      progressByPartNumber: {},
    }))
  } catch (e) {
    // Don't leave an empty orphan assembly behind if the BOM fetch failed.
    await supabase.from('assemblies').delete().eq('id', assemblyId)
    throw e
  }

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
  partsOwner, childrenOwner, progressByPartNumber = {},
}) {
  let directParts   = []
  let subassemblies = []

  if (depth < MAX_CHILD_DEPTH) {
    // Category-header based resolver: classifies each row as a part or an
    // assembly, and — for assembly rows — as ours (recurse) vs. vendor/COTS
    // (logged as a part) by comparing document ids against the root document.
    const resolved = await resolveBomWithSubassemblies(documentId, workspaceId, elementId, wvmType, rootOwnerId)
    directParts   = resolved.directParts
    subassemblies = resolved.subassemblies
  } else {
    // At max depth: flat BOM only, every row becomes a direct part
    const bomData = await fetchBom(documentId, workspaceId, elementId, wvmType)
    directParts   = parseBomRows(bomData).parts
  }

  // ── Insert direct parts ───────────────────────────────────
  if (directParts.length) {
    const rows = directParts.map(p => {
      const collected = progressByPartNumber[p.partNumber] ?? 0
      const status    = collected >= p.quantity ? 'complete'
                      : collected > 0           ? 'partial'
                      :                           'pending'
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
      }
    })
    const { error: partsErr } = await supabase.from('assembly_parts').insert(rows)
    if (partsErr) throw new Error(`Parts insert: ${partsErr.message}`)
  }

  // ── Recursively build subassembly nodes (assembly_children only) ──
  let childCount = 0

  for (const sub of subassemblies) {
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
    })
  }

  return { partCount: directParts.length, childCount }
}

// ── reimportAssembly ──────────────────────────────────────────
// Rebuilds in place under the original assemblyId — no new record created.
// Wiping the root's direct parts + top-level subassembly nodes is enough:
// cascading FKs (assembly_children.parent_child_id, assembly_parts.assembly_child_id)
// automatically clean up every nested descendant underneath them.

async function reimportAssembly(supabase, assemblyId) {
  const { data: asm, error: fetchErr } = await supabase
    .from('assemblies').select('*').eq('id', assemblyId).single()
  if (fetchErr || !asm) throw new Error('Assembly not found.')
  if (!asm.onshape_element_id) throw new Error('Assembly is not linked to Onshape.')

  // Save progress by part_number before wiping (root-level parts only)
  const { data: oldParts } = await supabase
    .from('assembly_parts')
    .select('part_number, quantity_collected, linked_instance_ids')
    .eq('assembly_id', assemblyId)

  const progressByPartNumber = {}
  for (const p of oldParts ?? []) {
    if (p.part_number && p.quantity_collected > 0) {
      progressByPartNumber[p.part_number] = p.quantity_collected
    }
  }

  // Release every linked inventory instance under this assembly tree back
  // to "available" BEFORE the cascade delete wipes the rows that reference
  // them — otherwise they're left stuck at status: 'in_assembly' forever
  // with nothing pointing back to them.
  await releaseAllLinkedInstances(supabase, assemblyId)


  await supabase.from('assembly_parts').delete().eq('assembly_id', assemblyId)
  await supabase.from('assembly_children').delete().eq('parent_assembly_id', assemblyId)

  // Rebuild under the EXISTING assemblyId — no new assembly record
  const rootOwnerId = await fetchDocumentOwnerId(asm.onshape_document_id)
  const { partCount, childCount } = await seedAssemblyContents(supabase, {
    documentId:  asm.onshape_document_id,
    workspaceId: asm.onshape_workspace_id,
    elementId:   asm.onshape_element_id,
    depth:       0,
    rootOwnerId,
    partsOwner:    { assembly_id: assemblyId },
    childrenOwner: { parent_assembly_id: assemblyId },
    progressByPartNumber,
  })

  await supabase.from('assemblies').update({ status: 'draft' }).eq('id', assemblyId)

  const restored = Object.keys(progressByPartNumber).length
  return {
    assemblyId,
    partCount,
    childCount,
    restoredProgress: restored,
    message: `Re-imported: ${partCount} part(s), ${childCount} subassembly(ies). Progress restored for ${restored} part number(s).`,
  }
}

// ── releaseAllLinkedInstances ──────────────────────────────────
// Walks the FULL tree under a root assembly (its own assembly_parts, plus
// every nested assembly_children's assembly_parts, recursively) and flips
// every linked inventory_instances row back to "available" with location
// cleared. Must run BEFORE any cascade delete of assembly_parts/children,
// since it depends on reading their linked_instance_ids first.

async function releaseAllLinkedInstances(supabase, assemblyId) {
  const allInstanceIds = []

  // Root-level parts
  const { data: rootParts } = await supabase
    .from('assembly_parts')
    .select('linked_instance_ids')
    .eq('assembly_id', assemblyId)
  for (const p of rootParts ?? []) {
    allInstanceIds.push(...(p.linked_instance_ids || []))
  }

  // Walk assembly_children recursively (direct  nested)
  const { data: directChildren } = await supabase
    .from('assembly_children')
    .select('id')
    .eq('parent_assembly_id', assemblyId)

  const childQueue = (directChildren ?? []).map(c => c.id)
  while (childQueue.length) {
    const childId = childQueue.pop()

    const { data: childParts } = await supabase
      .from('assembly_parts')
      .select('linked_instance_ids')
      .eq('assembly_child_id', childId)
    for (const p of childParts ?? []) {
      allInstanceIds.push(...(p.linked_instance_ids || []))
    }

    const { data: grandchildren } = await supabase
      .from('assembly_children')
      .select('id')
      .eq('parent_child_id', childId)
    childQueue.push(...(grandchildren ?? []).map(c => c.id))
  }

  if (!allInstanceIds.length) return

  const { error } = await supabase
    .from('inventory_instances')
    .update({ status: 'available', location: '' })
    .in('id', allInstanceIds)
  if (error) console.warn(`[onshape-bom] Failed releasing ${allInstanceIds.length} instance(s): ${error.message}`)
  else console.log(`[onshape-bom] Released ${allInstanceIds.length} inventory instance(s) back to available.`)
}
