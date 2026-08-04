// backend/routes/onshape-lookup.js — converted from api/onshape-lookup.js
// Combines documents/elements/bom-preview lookups into one route, same
// as the original — each branch is otherwise unchanged.
//
// GET /api/onshape-lookup?action=documents&q=...&limit=...
// GET /api/onshape-lookup?action=elements&documentId=...&workspaceId=...
// GET /api/onshape-lookup?action=bom-preview&documentId=...&workspaceId=...&elementId=...

import { Hono } from 'hono'
import { onshapeGet, resolveBomWithSubassemblies, fetchDocumentOwnerId } from '../../api/_lib/onshape.js'

const onshapeLookup = new Hono()

async function handleDocuments(c) {
  const q = (c.req.query('q') || '').trim()
  const limit = Math.min(parseInt(c.req.query('limit'), 10) || 20, 50)
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
    return c.json({ documents, query: q || null })
  } catch (err) {
    console.error('[onshape-lookup:documents]', err)
    return c.json({ error: err.message ?? 'Internal server error' }, 500)
  }
}

async function handleElements(c) {
  const documentId = c.req.query('documentId')
  const workspaceId = c.req.query('workspaceId')
  if (!documentId || !workspaceId) {
    return c.json({ error: 'documentId and workspaceId query params are required' }, 400)
  }
  try {
    const elements = await onshapeGet(`/documents/d/${documentId}/w/${workspaceId}/elements`)
    const assemblies = (elements ?? [])
      .filter(el => el.elementType === 'ASSEMBLY')
      .map(el => ({ id: el.id, name: el.name, documentId, workspaceId }))
    return c.json({ assemblies, count: assemblies.length })
  } catch (err) {
    console.error('[onshape-lookup:elements]', err)
    if (/Onshape API 404/.test(err.message)) {
      return c.json({ error: 'Document or workspace not found — it may have been deleted or moved.' }, 404)
    }
    return c.json({ error: err.message ?? 'Internal server error' }, 500)
  }
}

async function handleBomPreview(c) {
  const documentId = c.req.query('documentId')
  const workspaceId = c.req.query('workspaceId')
  const elementId = c.req.query('elementId')
  if (!documentId || !workspaceId || !elementId) {
    return c.json({ error: 'documentId, workspaceId, and elementId are required.' }, 400)
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
    return c.json({
      parts: directParts, subassemblies: subassemblyPreview,
      directParts: totalParts, subassemblyCount, totalParts, warning,
    })
  } catch (err) {
    console.error('[onshape-lookup:bom-preview]', err)
    if (/Onshape API 404/.test(err.message)) {
      return c.json({ error: 'Assembly not found — it may have been deleted or moved.' }, 404)
    }
    return c.json({ error: err.message ?? 'Internal server error' }, 500)
  }
}

onshapeLookup.get('/', async (c) => {
  switch (c.req.query('action')) {
    case 'documents':   return handleDocuments(c)
    case 'elements':    return handleElements(c)
    case 'bom-preview': return handleBomPreview(c)
    default:
      return c.json({ error: `Unknown action "${c.req.query('action')}" — expected one of: documents, elements, bom-preview.` }, 400)
  }
})

export default onshapeLookup