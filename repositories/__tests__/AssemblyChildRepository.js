// repositories/__tests__/AssemblyRepository.test.js

import { describe, it, expect } from 'vitest'
import { AssemblyRepository } from '../AssemblyRepository.js'
import { createFakeSupabase } from '../../api/_lib/__tests__/testUtils/fakeSupabase.js'
import { NotFoundError } from '../errors.js'

describe('AssemblyRepository', () => {
  it('findById maps a found row into the local camelCase shape', async () => {
    const supabase = createFakeSupabase({
      data: {
        id: 'asm1', name: 'Drivetrain', description: '', onshape_url: 'https://x',
        onshape_document_id: 'doc1', onshape_workspace_id: 'ws1', onshape_element_id: 'el1',
        thumbnail_url: null, status: 'draft', created_at: '2025-12-01T00:00:00Z',
      },
      error: null,
    })
    const repo = new AssemblyRepository(supabase)
    const asm = await repo.findById('asm1')
    expect(asm.onshapeDocumentId).toBe('doc1')
    expect(asm.status).toBe('draft')
  })

  it('requireById throws NotFoundError when nothing matches', async () => {
    const supabase = createFakeSupabase({ data: null, error: null })
    const repo = new AssemblyRepository(supabase)
    await expect(repo.requireById('missing')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('insertRoot always writes status "draft" regardless of caller input', async () => {
    const supabase = createFakeSupabase({
      data: { id: 'asm1', name: 'X', description: '', onshape_url: '', onshape_document_id: 'd', onshape_workspace_id: 'w', onshape_element_id: 'e', thumbnail_url: null, status: 'draft', created_at: 'now' },
      error: null,
    })
    const repo = new AssemblyRepository(supabase)
    const asm = await repo.insertRoot({ id: 'asm1', name: 'X', onshapeDocumentId: 'd', onshapeWorkspaceId: 'w', onshapeElementId: 'e' })
    expect(asm.status).toBe('draft')
    expect(supabase.calledWith({ table: 'assemblies', method: 'insert' })).toBe(true)
  })
})
