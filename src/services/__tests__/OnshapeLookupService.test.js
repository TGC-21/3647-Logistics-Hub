import { describe, expect, it, vi } from 'vitest'
import { OnshapeLookupService } from '../OnshapeLookupService.js'

describe('OnshapeLookupService', () => {
  it('returns compact document discovery data', async () => {
    const get = vi.fn(async () => ({ items: [{ id: 'doc1', name: 'Robot', modifiedAt: 'now', defaultWorkspace: { id: 'ws1' }, owner: { name: 'Team' } }] }))
    const service = new OnshapeLookupService({ onshapeGetFn: get })
    await expect(service.searchDocuments({ query: 'robot' })).resolves.toEqual([{ documentId: 'doc1', name: 'Robot', workspaceId: 'ws1', owner: 'Team', modifiedAt: 'now' }])
    expect(get).toHaveBeenCalledWith(expect.stringContaining('q=robot'))
  })

  it('returns only Assembly elements', async () => {
    const service = new OnshapeLookupService({ onshapeGetFn: async () => [{ id: 'e1', name: 'Drive', elementType: 'ASSEMBLY' }, { id: 'e2', name: 'Parts', elementType: 'PARTSTUDIO' }] })
    await expect(service.listAssemblyElements({ documentId: 'doc1', workspaceId: 'ws1' })).resolves.toEqual([{ documentId: 'doc1', workspaceId: 'ws1', elementId: 'e1', name: 'Drive' }])
  })
})
