// repositories/__tests__/FabricationJobRepository.test.js
//
// Convention: a repository test constructs the repository with a fake
// Supabase client (never a real one — see supabaseClient.js's
// resetSupabaseClientForTests for the alternative "reset the singleton"
// approach, not used here because constructor injection is already
// available and is simpler to reason about per-test), configures what
// { data, error } it should resolve to, calls the repository method,
// and asserts on (a) the returned local-shaped object and (b) that the
// right table/column was touched.
//
// What these tests are NOT for: exercising business rules ("can't
// record more than what's remaining"). That belongs in the SERVICE's
// tests (see services/__tests__/FabricationJobService.test.js), against
// fake repositories, not a fake Supabase client. Keeping that split — DB
// shape here, business rules there — is what stops a service refactor
// from breaking a pile of unrelated repository tests, and vice versa.

import { describe, it, expect } from 'vitest'
import { FabricationJobRepository } from '../FabricationJobRepository.js'
import { createFakeSupabase } from './testUtils/fakeSupabase.js'

describe('FabricationJobRepository', () => {
  it('findById maps a found row into the local camelCase shape', async () => {
    const supabase = createFakeSupabase({
      data: {
        id: 'job1', batch_id: null, assembly_part_id: 'part1',
        quantity_requested: 5, quantity_machined: 2, status: 'in_progress',
        claimed_by: 'Alex', claimed_at: '2026-01-01T00:00:00Z', notes: '',
        created_at: '2025-12-01T00:00:00Z',
      },
      error: null,
    })
    const repo = new FabricationJobRepository(supabase)

    const job = await repo.findById('job1')

    expect(job).toEqual({
      id: 'job1', batchId: null, assemblyPartId: 'part1',
      quantityRequested: 5, quantityMachined: 2, status: 'in_progress',
      claimedBy: 'Alex', claimedAt: '2026-01-01T00:00:00Z', notes: '',
      createdAt: '2025-12-01T00:00:00Z',
    })
    expect(supabase.calledWith({ table: 'fabrication_jobs', method: 'from' })).toBe(true)
    expect(supabase.calledWith({ table: 'fabrication_jobs', method: 'eq', args: ['id', 'job1'] })).toBe(true)
  })

  it('findById returns null when no row matches', async () => {
    const supabase = createFakeSupabase({ data: null, error: null })
    const repo = new FabricationJobRepository(supabase)

    expect(await repo.findById('missing')).toBeNull()
  })

  it('findActiveForPart excludes archived jobs at the query level', async () => {
    const supabase = createFakeSupabase({ data: null, error: null })
    const repo = new FabricationJobRepository(supabase)

    await repo.findActiveForPart('part1')

    expect(supabase.calledWith({ table: 'fabrication_jobs', method: 'neq', args: ['status', 'archived'] })).toBe(true)
  })

  it('deleteIfQueued returns true only when a row was actually deleted', async () => {
    const deletedSupabase = createFakeSupabase({ data: [{ id: 'job1' }], error: null })
    expect(await new FabricationJobRepository(deletedSupabase).deleteIfQueued('job1')).toBe(true)

    const noopSupabase = createFakeSupabase({ data: [], error: null })
    expect(await new FabricationJobRepository(noopSupabase).deleteIfQueued('job2')).toBe(false)
  })

  it('recordMachinedUnits calls the record_machined_units RPC, not a raw update', async () => {
    const supabase = createFakeSupabase({
      data: {
        id: 'job1', batch_id: null, assembly_part_id: 'part1',
        quantity_requested: 5, quantity_machined: 3, status: 'in_progress',
        claimed_by: null, claimed_at: null, notes: '', created_at: '2025-12-01T00:00:00Z',
      },
      error: null,
    })
    const repo = new FabricationJobRepository(supabase)

    const updated = await repo.recordMachinedUnits('job1', 1)

    expect(updated.quantityMachined).toBe(3)
    expect(supabase.calledWith({ table: null, method: 'rpc', args: ['record_machined_units', { p_job_id: 'job1', p_quantity: 1 }] })).toBe(true)
  })

  it('surfaces a Postgres error as a DatabaseError, not a raw supabase shape', async () => {
    const supabase = createFakeSupabase({ data: null, error: { message: 'connection reset' } })
    const repo = new FabricationJobRepository(supabase)

    await expect(repo.findById('job1')).rejects.toThrow('fabrication_jobs lookup failed: connection reset')
  })
})