// api/onshape-elements.js — Vercel serverless function
// Phase 2 of the Partshelf-driven Onshape integration.
//
// Given a documentId + workspaceId (from the Phase 1 document picker),
// lists the Assembly elements inside that document. A document can also
// contain Part Studios, Drawings, etc — we filter down to ASSEMBLY only,
// since those are the only elements with a BOM.
//
// Read-only lookup, nothing written to Supabase.
//
// GET /api/onshape-elements?documentId=...&workspaceId=...

import { onshapeGet, applyCors } from './_lib/onshape.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    applyCors(res)
    return res.status(204).end()
  }

  applyCors(res)

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'GET only' })
  }

  const { documentId, workspaceId } = req.query

  if (!documentId || !workspaceId) {
    return res.status(400).json({ error: 'documentId and workspaceId query params are required' })
  }

  try {
    const elements = await onshapeGet(
      `/documents/d/${documentId}/w/${workspaceId}/elements`
    )

    const assemblies = (elements ?? [])
      .filter(el => el.elementType === 'ASSEMBLY')
      .map(el => ({
        id:          el.id,
        name:        el.name,
        documentId,
        workspaceId,
      }))

    return res.status(200).json({
      assemblies,
      count: assemblies.length,
    })

  } catch (err) {
    console.error('[onshape-elements]', err)

    // Onshape returns 404 for a bad/expired documentId+workspaceId pair —
    // surface that distinctly so the UI can prompt "pick a document again"
    // rather than showing a generic error.
    if (/Onshape API 404/.test(err.message)) {
      return res.status(404).json({ error: 'Document or workspace not found — it may have been deleted or moved.' })
    }

    return res.status(500).json({ error: err.message ?? 'Internal server error' })
  }
}
