// api/onshape-lookup.js — Vercel serverless function
// Combines onshape-documents.js, onshape-elements.js, and
// onshape-bom-preview.js into one function to stay under Vercel's
// per-project serverless function limit. Each branch is a verbatim
// copy of the original handler's body — no behavior changes.
//
// GET /api/onshape-lookup?action=documents&q=...&limit=...
// GET /api/onshape-lookup?action=elements&documentId=...&workspaceId=...
// GET /api/onshape-lookup?action=bom-preview&documentId=...&workspaceId=...&elementId=...

import { onshapeGet, resolveBomWithSubassemblies, fetchDocumentOwnerId, applyCors } from './_lib/onshape.js'

async function handleDocuments(req, res) {
  const q     = (req.query.q || '').trim()
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50)
  try {
    const params = new URLSearchParams({ limit: String(limit), sortColumn: 'modifiedAt', sortOrder: 'desc' })
    if (q) params.set('q', q)
    const data = await onshapeGet(`/documents?${params.toString()}`)
    const documents = (data.items ?? []).map(doc => ({
      id: doc.id, name: doc.name, modifiedAt: doc.modifiedAt,
      thumbnailUrl: doc.thumbnail?.href ?? null,
      workspaceId: doc.defaultWorkspace?.id ?? null,
      owner: doc.owner?.name ?? null,
    })).filter(d => d.workspaceId)
    return res.status(200).json({ documents, query: q || null })
  } catch (err) {
    console.error('[onshape-lookup:documents]', err)
    return res.status(500).json({ error: err.message ?? 'Internal server error' })
  }
}

async function handleElements(req, res) {
  const { documentId, workspaceId } = req.query
  if (!documentId || !workspaceId) {
    return res.status(400).json({ error: 'documentId and workspaceId query params are required' })
  }
  try {
    const elements = await onshapeGet(`/documents/d/${documentId}/w/${workspaceId}/elements`)
    const assemblies = (elements ?? [])
      .filter(el => el.elementType === 'ASSEMBLY')
      .map(el => ({ id: el.id, name: el.name, documentId, workspaceId }))
    return res.status(200).json({ assemblies, count: assemblies.length })
  } catch (err) {
    console.error('[onshape-lookup:elements]', err)
    if (/Onshape API 404/.test(err.message)) {
      return res.status(404).json({ error: 'Document or workspace not found — it may have been deleted or moved.' })
    }
    return res.status(500).json({ error: err.message ?? 'Internal server error' })
  }
}

async function handleBomPreview(req, res) {
  const { documentId, workspaceId, elementId } = req.query
  if (!documentId || !workspaceId || !elementId) {
    return res.status(400).json({ error: 'documentId, workspaceId, and elementId are required.' })
  }
  try {
    const rootOwnerId = await fetchDocumentOwnerId(documentId)
    const { directParts, subassemblies } = await resolveBomWithSubassemblies(
      documentId, workspaceId, elementId, 'w', rootOwnerId
    )
    const totalParts = directParts.length
    const subassemblyCount = subassemblies.length
    const warning = (totalParts === 0 && subassemblyCount === 0)
      ? 'This assembly\'s BOM has no rows. Open the BOM tab in Onshape to trigger generation, then try again.'
      : null
    const subassemblyPreview = subassemblies.map(s => ({
      partName: s.partName, partNumber: s.partNumber, quantity: s.quantity,
    }))
    return res.status(200).json({
      parts: directParts, subassemblies: subassemblyPreview,
      directParts: totalParts, subassemblyCount, totalParts, warning,
    })
  } catch (err) {
    console.error('[onshape-lookup:bom-preview]', err)
    if (/Onshape API 404/.test(err.message)) {
      return res.status(404).json({ error: 'Assembly not found — it may have been deleted or moved.' })
    }
    return res.status(500).json({ error: err.message ?? 'Internal server error' })
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  switch (req.query.action) {
    case 'documents':   return handleDocuments(req, res)
    case 'elements':    return handleElements(req, res)
    case 'bom-preview': return handleBomPreview(req, res)
    default:
      return res.status(400).json({ error: `Unknown action "${req.query.action}" — expected one of: documents, elements, bom-preview.` })
  }
}