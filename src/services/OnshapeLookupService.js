// Read-only Onshape discovery surface for the harness. This mirrors the
// browser's onshape-lookup route without involving req/res, so the same
// document -> assembly element -> import workflow is available to Clinker.

import { onshapeGet, resolveBomWithSubassemblies, fetchDocumentOwnerId } from '../../backend/_lib/onshape.js'
import { ValidationError } from '../repositories/errors.js'

export class OnshapeLookupService {
  constructor({
    onshapeGetFn = onshapeGet,
    resolveBom = resolveBomWithSubassemblies,
    fetchOwnerId = fetchDocumentOwnerId,
  } = {}) {
    this.onshapeGet = onshapeGetFn
    this.resolveBom = resolveBom
    this.fetchOwnerId = fetchOwnerId
  }

  async searchDocuments({ query = '', limit = 10 } = {}) {
    const safeLimit = Math.min(Math.max(Number.isInteger(limit) ? limit : 10, 1), 25)
    const params = new URLSearchParams({ limit: String(safeLimit), sortColumn: 'modifiedAt', sortOrder: 'desc' })
    if (String(query).trim()) params.set('q', String(query).trim())
    const data = await this.onshapeGet(`/documents?${params.toString()}`)
    return (data.items ?? []).map(doc => ({
      documentId: doc.id,
      name: doc.name,
      workspaceId: doc.defaultWorkspace?.id ?? null,
      owner: doc.owner?.name ?? null,
      modifiedAt: doc.modifiedAt ?? null,
    })).filter(document => document.workspaceId)
  }

  async listAssemblyElements({ documentId, workspaceId }) {
    if (!documentId || !workspaceId) throw new ValidationError('documentId and workspaceId are required')
    const elements = await this.onshapeGet(`/documents/d/${documentId}/w/${workspaceId}/elements`)
    return (elements ?? [])
      .filter(element => element.elementType === 'ASSEMBLY')
      .map(element => ({ documentId, workspaceId, elementId: element.id, name: element.name }))
  }

  /** A compact, read-only check before importing. The full BOM remains in
   * Onshape; Clinker only needs counts and a small sample to confirm that it
   * selected the intended assembly. */
  async previewAssembly({ documentId, workspaceId, elementId }) {
    if (!documentId || !workspaceId || !elementId) {
      throw new ValidationError('documentId, workspaceId, and elementId are required')
    }
    const ownerId = await this.fetchOwnerId(documentId)
    const { directParts, subassemblies } = await this.resolveBom(documentId, workspaceId, elementId, 'w', ownerId)
    const summarize = row => ({ partName: row.partName, partNumber: row.partNumber || '', quantity: row.quantity })
    return {
      directPartCount: directParts.length,
      subassemblyCount: subassemblies.length,
      sampleParts: directParts.slice(0, 20).map(summarize),
      sampleSubassemblies: subassemblies.slice(0, 20).map(summarize),
      truncated: directParts.length > 20 || subassemblies.length > 20,
    }
  }
}
