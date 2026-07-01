// api/onshape-bom-preview.js — Vercel serverless function
// Returns a parsed, hierarchical BOM for preview without writing to Supabase.
// The UI uses this to show the user exactly what will be imported — parts at
// the top level, plus subassemblies with their own part lists — before commit.
//
// GET /api/onshape-bom-preview?documentId=...&workspaceId=...&elementId=...

import { fetchBomHierarchical, parseBomHierarchy, applyCors } from './_lib/onshape.js'

function countAll(node) {
  const direct = node.parts?.length ?? 0
  const fromChildren = (node.subassemblies ?? [])
    .reduce((sum, s) => sum + countAll(s.children ?? {}), 0)
  return direct + fromChildren
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const { documentId, workspaceId, elementId } = req.query
  if (!documentId || !workspaceId || !elementId) {
    return res.status(400).json({ error: 'documentId, workspaceId, and elementId are required.' })
  }

  try {
    const bomData = await fetchBomHierarchical(documentId, workspaceId, elementId)
    const tree    = parseBomHierarchy(bomData)

    const totalParts     = countAll(tree)
    const subassemblyCount = tree.subassemblies?.length ?? 0
    const directParts      = tree.parts?.length ?? 0

    const warning = totalParts === 0
      ? 'This assembly\'s BOM has no rows. The BOM may need to be generated in Onshape first (open the BOM tab in Onshape to trigger generation).'
      : null

    return res.status(200).json({
      parts:          tree.parts        ?? [],
      subassemblies:  tree.subassemblies ?? [],
      directParts,
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
