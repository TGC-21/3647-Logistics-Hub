// api/onshape-documents.js — Vercel serverless function
// Phase 1 of the Partshelf-driven Onshape integration.
//
// Lists (or searches) Onshape documents visible to the account that owns
// ONSHAPE_ACCESS_KEY / ONSHAPE_SECRET_KEY. Called by the Designer-mode
// "Connect Onshape" document picker — this is a read-only lookup, nothing
// is written to Supabase here.
//
// GET /api/onshape-documents?q=drivetrain&limit=20

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

  const q     = (req.query.q || '').trim()
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50)

  try {
    // Onshape's /documents endpoint supports free-text search via `q`,
    // and always returns each doc's default workspace — which Phase 2
    // (element listing) needs, so we pass it straight through.
    const params = new URLSearchParams({
      limit:    String(limit),
      sortColumn: 'modifiedAt',
      sortOrder:  'desc',
    })
    if (q) params.set('q', q)

    const data = await onshapeGet(`/documents?${params.toString()}`)

    const documents = (data.items ?? []).map(doc => ({
      id:           doc.id,
      name:         doc.name,
      modifiedAt:   doc.modifiedAt,
      thumbnailUrl: doc.thumbnail?.href ?? null,
      workspaceId:  doc.defaultWorkspace?.id ?? null,
      owner:        doc.owner?.name ?? null,
    })).filter(d => d.workspaceId) // skip anything without a usable workspace

    return res.status(200).json({ documents, query: q || null })

  } catch (err) {
    console.error('[onshape-documents]', err)
    return res.status(500).json({ error: err.message ?? 'Internal server error' })
  }
}
