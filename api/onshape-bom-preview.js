// api/onshape-bom-preview.js — Vercel serverless function
// Phase 3 of the Partshelf-driven Onshape integration.
//
// Given a documentId + workspaceId + elementId (an assembly chosen via the
// Phase 2 picker), fetches and parses its BOM — but does NOT write to
// Supabase. This lets the Designer-mode UI show the user exactly what
// will be imported before they commit, catching wrong-assembly mistakes
// early.
//
// Shares its parsing logic with api/onshape-bom.js (via _lib/onshape.js)
// so the preview and the actual import always agree on what a row means.
//
// GET /api/onshape-bom-preview?documentId=...&workspaceId=...&elementId=...

import { fetchBom, parseBomRows, applyCors } from './_lib/onshape.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res)
    return res.status(204).end()
  }

  applyCors(res)

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' })
  }

  const { documentId, workspaceId, elementId } = req.query

  if (!documentId || !workspaceId || !elementId) {
    return res.status(400).json({ error: 'documentId, workspaceId, and elementId query params are required' })
  }

  try {
    const bomData = await fetchBom(documentId, workspaceId, elementId)
    const { headers, parts } = parseBomRows(bomData)

    if (!parts.length) {
      return res.status(200).json({
        headers,
        parts: [],
        partCount: 0,
        warning: 'This assembly\'s BOM has no rows. It may be empty, or the BOM table may need to be generated in Onshape first.',
      })
    }

    return res.status(200).json({
      headers,
      parts,
      partCount: parts.length,
    })

  } catch (err) {
    console.error('[onshape-bom-preview]', err)

    if (/Onshape API 404/.test(err.message)) {
      return res.status(404).json({ error: 'Assembly not found — it may have been deleted or moved.' })
    }

    return res.status(500).json({ error: err.message ?? 'Internal server error' })
  }
}
