// repositories/__tests__/AssemblyChildRepository.test.js
//
// findWholeTree recurses (pops a queue and re-queries per child), so
// the shared testUtils fake — which resolves every call to the SAME
// static fixture — can't exercise it safely: a fixture containing any
// rows would make the recursive "find grandchildren" query return the
// same rows forever, looping indefinitely. This file uses a small
// call-order-aware fake scoped to just this test instead.

import { describe, it, expect } from 'vitest'
import { AssemblyChildRepository } from '../AssemblyChildRepository.js'
import { createFakeSupabase } from '../../api/_lib/__tests__/testUtils/fakeSupabase.js'

/** Returns a different { data, error } for each successive `.eq(...)`
 *  call, in the order given — enough to script "one level of real
 *  children, then nothing further" without a full query-aware mock. */
function createScriptedSupabase(responses) {
  let call = 0
  const chain = {
    select: () => chain,
    eq: () => chain,
    then(resolve, reject) {
      const next = responses[Math.min(call, responses.length - 1)]
      call++
      return Promise.resolve(next).then(resolve, reject)
    },
  }
  return { from: () => chain }
}

describe('AssemblyChildRepository.findWholeTree', () => {
  it('walks one real level deep then stops once a level comes back empty', async () => {
    const supabase = createScriptedSupabase([
      { data: [{ id: 'child1', parent_assembly_id: 'asm1', parent_child_id: null, name: 'Gearbox', thumbnail_url: null, onshape_document_id: 'd', onshape_workspace_id: 'w', onshape_wvm_type: 'w', onshape_element_id: 'e', quantity: 2, created_at: 'now' }], error: null },
      { data: [], error: null },   // child1's own children — none
    ])
    const repo = new AssemblyChildRepository(supabase)

    const tree = await repo.findWholeTree('asm1')

    expect(tree).toHaveLength(1)
    expect(tree[0]).toEqual({
      id: 'child1', parentAssemblyId: 'asm1', parentChildId: null, name: 'Gearbox',
      thumbnail: null, onshapeDocumentId: 'd', onshapeWorkspaceId: 'w',
      onshapeWvmType: 'w', onshapeElementId: 'e', quantity: 2, createdAt: 'now',
    })
  })

  it('returns an empty array when the assembly has no children at all', async () => {
    const supabase = createScriptedSupabase([{ data: [], error: null }])
    const repo = new AssemblyChildRepository(supabase)
    expect(await repo.findWholeTree('asm1')).toEqual([])
  })
})

describe('AssemblyChildRepository.deleteDirectChildren', () => {
  it('deletes by parent_assembly_id', async () => {
    const supabase = createFakeSupabase({ data: null, error: null })
    const repo = new AssemblyChildRepository(supabase)
    await repo.deleteDirectChildren('asm1')
    expect(supabase.calledWith({ table: 'assembly_children', method: 'delete' })).toBe(true)
    expect(supabase.calledWith({ table: 'assembly_children', method: 'eq', args: ['parent_assembly_id', 'asm1'] })).toBe(true)
  })
})
