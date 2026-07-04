// api/onshape-bom-preview.js — Vercel serverless function
// Returns a parsed BOM for preview without writing anything to Supabase.
//
// GET /api/onshape-bom-preview?documentId=...&workspaceId=...&elementId=...

import { resolveBomWithSubassemblies, fetchDocumentOwnerId, applyCors } from './_lib/onshape.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const { documentId, workspaceId, elementId } = req.query
  if (!documentId || !workspaceId || !elementId) {
    return res.status(400).json({ error: 'documentId, workspaceId, and elementId are required.' })
  }

  try {
    const rootOwnerId = await fetchDocumentOwnerId(documentId)
    const { directParts, subassemblies } = await resolveBomWithSubassemblies(
      documentId, workspaceId, elementId, 'w', rootOwnerId
    )

    const totalParts      = directParts.length
    const subassemblyCount = subassemblies.length

    const warning = (totalParts === 0 && subassemblyCount === 0)
      ? 'This assembly\'s BOM has no rows. Open the BOM tab in Onshape to trigger generation, then try again.'
      : null

    // Shape the subassemblies for the picker preview UI
    const subassemblyPreview = subassemblies.map(s => ({
      partName:   s.partName,
      partNumber: s.partNumber,
      quantity:   s.quantity,
    }))

    return res.status(200).json({
      parts:            directParts,
      subassemblies:    subassemblyPreview,
      directParts:      totalParts,
      subassemblyCount,
      totalParts,
      warning,
    })

  } catch (err) {
    console.error('[onshape-bom-preview]', err)
    if (/Onshape API 404/.test(err.message)) {
      return res.status(404).json({ error: 'Assembly not found — it may have been deleted or moved.' })
    }
    return res.status(500).json({ error: err.message ?? 'Internal server error' })
  }
}
