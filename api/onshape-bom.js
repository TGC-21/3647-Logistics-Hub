// api/onshape-bom.js — Vercel serverless function
// Called once a document/assembly has been chosen via the Designer-mode
// Onshape picker (see api/onshape-documents.js, api/onshape-elements.js).
// Credentials live in Vercel environment variables (never exposed to the browser).

import { createClient } from '@supabase/supabase-js'
import { onshapeGet, fetchBom, parseBomRows, applyCors, genId } from './_lib/onshape.js'

// ── Handler ───────────────────────────────────────────────────
export default async function handler(req, res) {
  // Preflight
  if (req.method === 'OPTIONS') {
    applyCors(res)
    return res.status(204).end()
  }

  applyCors(res)

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const { documentId, workspaceId, elementId, assemblyName } = req.body ?? {}

  if (!documentId || !workspaceId) {
    return res.status(400).json({ error: 'documentId and workspaceId are required' })
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,   // server-side: use service key (bypasses RLS)
  )

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in Vercel environment variables.' })
  }

  try {
    // ── Step 1: resolve which element to use ──────────────────
    let eid = elementId

    if (!eid) {
      // No element specified — find the first Assembly element in the document
      const elements = await onshapeGet(
        `/documents/d/${documentId}/w/${workspaceId}/elements`
      )
      const assemblyEl = elements.find(e => e.elementType === 'ASSEMBLY')
      if (!assemblyEl) {
        return res.status(404).json({ error: 'No assembly element found in this Onshape document.' })
      }
      eid = assemblyEl.id
    }

    // ── Step 2: fetch and parse the BOM from Onshape ──────────
    const bomData = await fetchBom(documentId, workspaceId, eid)
    const { parts: parsedParts } = parseBomRows(bomData)

    // ── Step 3: create the Assembly record ────────────────────
    const assemblyId = genId()
    const onshapeUrl = `https://cad.onshape.com/documents/${documentId}/w/${workspaceId}/e/${eid}`

    const { error: asmErr } = await supabase
      .from('assemblies')
      .insert({
        id:                   assemblyId,
        name:                 assemblyName || `Onshape BOM — ${new Date().toLocaleDateString()}`,
        description:          `Imported from Onshape on ${new Date().toLocaleString()}`,
        onshape_url:          onshapeUrl,
        onshape_document_id:  documentId,
        onshape_workspace_id: workspaceId,
        status:               'draft',
      })

    if (asmErr) throw new Error(`Supabase assembly insert: ${asmErr.message}`)

    // ── Step 4: insert BOM rows as assembly_parts ─────────────
    const parts = parsedParts.map(p => ({
      id:                 genId(),
      assembly_id:        assemblyId,
      part_name:          p.partName,
      part_number:        p.partNumber,
      quantity_needed:    p.quantity,
      quantity_collected: 0,
      status:             'pending',
      source:             'onshape',
      notes:              '',
      onshape_reference:  p.raw,   // store raw row for future mapping
    }))

    if (parts.length) {
      const { error: partsErr } = await supabase.from('assembly_parts').insert(parts)
      if (partsErr) throw new Error(`Supabase parts insert: ${partsErr.message}`)
    }

    // ── Done ──────────────────────────────────────────────────
    return res.status(200).json({
      success:    true,
      assemblyId,
      partCount:  parts.length,
      onshapeUrl,
      message:    `Assembly created with ${parts.length} part${parts.length === 1 ? '' : 's'}.`,
    })

  } catch (err) {
    console.error('[onshape-bom]', err)
    return res.status(500).json({ error: err.message ?? 'Internal server error' })
  }
}
