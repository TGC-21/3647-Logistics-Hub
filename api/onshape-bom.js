// api/onshape-bom.js — Vercel serverless function
//
// NEW IMPORT  { documentId, workspaceId, elementId, assemblyName, thumbnailUrl? }
// RE-IMPORT   { assemblyId, reimport: true }

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
      depth: 0,
      rootOwnerId,
    })
    return res.status(200).json({ success: true, ...result })

  } catch (err) {
    console.error('[onshape-bom]', err)
    return res.status(500).json({ error: err.message ?? 'Internal server error' })
  }
}

// ── buildAssembly ─────────────────────────────────────────────
// Creates a new Partshelf assembly record, then seeds it.

async function buildAssembly(supabase, { documentId, workspaceId, elementId, name, depth, thumbnailUrl, rootOwnerId }) {
  const assemblyId   = genId()
  const onshapeUrl   = `https://cad.onshape.com/documents/${documentId}/w/${workspaceId}/e/${elementId}`
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
  if (asmErr) throw new Error(`Assembly insert: ${asmErr.message}`)

  const { partCount, childCount } = await seedAssemblyContents(supabase, assemblyId, {
    documentId, workspaceId, elementId, depth, rootOwnerId,
    progressByPartNumber: {},
  })

  return {
    assemblyId,
    partCount,
    childCount,
    onshapeUrl,
    message: `"${assemblyName}": ${partCount} part(s), ${childCount} subassembly link(s).`,
  }
}

// ── seedAssemblyContents ──────────────────────────────────────
// Writes parts and child-assembly links into an EXISTING assembly record.
// Used by buildAssembly (new) and reimportAssembly (existing record, same ID).

async function seedAssemblyContents(supabase, assemblyId, {
  documentId, workspaceId, elementId, depth, rootOwnerId, progressByPartNumber = {},
}) {
  let directParts   = []
  let subassemblies = []

  if (depth < MAX_CHILD_DEPTH) {
    // Category-header based resolver: classifies each row as a part or an
    // assembly, and — for assembly rows — as ours (recurse) vs. vendor/COTS
    // (logged as a part) by comparing owner ids against the root document.
    const resolved = await resolveBomWithSubassemblies(documentId, workspaceId, elementId, rootOwnerId)
    directParts   = resolved.directParts
    subassemblies = resolved.subassemblies
  } else {
    // At max depth: flat BOM only, every row becomes a direct part
    const bomData = await fetchBom(documentId, workspaceId, elementId)
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
    if (partsErr) throw new Error(`Parts insert: ${partsErr.message}`)
  }

  // ── Recursively build child assemblies ─────────────────────
  const childLinks = []

  for (const sub of subassemblies) {
    const childResult = await buildAssembly(supabase, {
      documentId:  sub.resolvedDocumentId,
      workspaceId: sub.resolvedWorkspaceId,
      elementId:   sub.resolvedElementId,
      name:        sub.partName,
      depth:       depth + 1,
      thumbnailUrl: null,
      rootOwnerId,
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
    if (linkErr) throw new Error(`assembly_children insert: ${linkErr.message}`)
  }

  return { partCount: directParts.length, childCount: childLinks.length }
}

// ── reimportAssembly ──────────────────────────────────────────
// Rebuilds in place under the original assemblyId — no new record created.

async function reimportAssembly(supabase, assemblyId) {
  const { data: asm, error: fetchErr } = await supabase
    .from('assemblies').select('*').eq('id', assemblyId).single()
  if (fetchErr || !asm) throw new Error('Assembly not found.')
  if (!asm.onshape_element_id) throw new Error('Assembly is not linked to Onshape.')

  // Save progress by part_number before wiping
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

  // Collect all descendant IDs before deleting
  const descendantIds = await collectDescendantIds(supabase, assemblyId)

  // Wipe direct parts and child links on the root
  await supabase.from('assembly_parts').delete().eq('assembly_id', assemblyId)
  await supabase.from('assembly_children').delete().eq('parent_assembly_id', assemblyId)

  // Delete all descendant assembly records (cascades their parts + links)
  if (descendantIds.length) {
    await supabase.from('assemblies').delete().in('id', descendantIds)
  }

  // Rebuild under the EXISTING assemblyId — no new assembly record
  const rootOwnerId = await fetchDocumentOwnerId(asm.onshape_document_id)
  const { partCount, childCount } = await seedAssemblyContents(supabase, assemblyId, {
    documentId:  asm.onshape_document_id,
    workspaceId: asm.onshape_workspace_id,
    elementId:   asm.onshape_element_id,
    depth:       0,
    rootOwnerId,
    progressByPartNumber,
  })

  await supabase.from('assemblies').update({ status: 'draft' }).eq('id', assemblyId)

  const restored = Object.keys(progressByPartNumber).length
  return {
    assemblyId,
    partCount,
    childCount,
    restoredProgress: restored,
    message: `Re-imported: ${partCount} part(s), ${childCount} subassembly link(s). Progress restored for ${restored} part number(s).`,
  }
}

async function collectDescendantIds(supabase, assemblyId, visited = new Set()) {
  if (visited.has(assemblyId)) return []
  visited.add(assemblyId)
  const { data: rows } = await supabase
    .from('assembly_children').select('child_assembly_id').eq('parent_assembly_id', assemblyId)
  const ids = []
  for (const row of rows ?? []) {
    ids.push(row.child_assembly_id)
    ids.push(...await collectDescendantIds(supabase, row.child_assembly_id, visited))
  }
  return ids
}
