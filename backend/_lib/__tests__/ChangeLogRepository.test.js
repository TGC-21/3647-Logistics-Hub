// repositories/__tests__/ChangeLogRepository.test.js

import { describe, it, expect, vi } from 'vitest'
import { ChangeLogRepository } from '../../../src/repositories/ChangeLogRepository.js'
import { createFakeSupabase } from './testUtils/fakeSupabase.js'

describe('ChangeLogRepository', () => {
  it('newCommitId returns a fresh string each call', () => {
    const repo = new ChangeLogRepository(createFakeSupabase())
    const a = repo.newCommitId()
    const b = repo.newCommitId()
    expect(typeof a).toBe('string')
    expect(a).not.toBe(b)
  })

  it('record() inserts a mapped row into change_log', async () => {
    const supabase = createFakeSupabase({ data: null, error: null })
    const repo = new ChangeLogRepository(supabase)

    await repo.record({
      entityType: 'fabrication_job', entityId: 'job1', action: 'create',
      newValue: { id: 'job1' }, actorId: 'member1', commitId: 'c_abc',
    })

    expect(supabase.calledWith({ table: 'change_log', method: 'from' })).toBe(true)
    expect(supabase.calledWith({ table: 'change_log', method: 'insert' })).toBe(true)
  })

  it('does not throw when the underlying insert fails (non-throwing by design)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const supabase = createFakeSupabase({ data: null, error: { message: 'insert failed' } })
    const repo = new ChangeLogRepository(supabase)

    await expect(repo.record({
      entityType: 'fabrication_job', entityId: 'job1', action: 'create',
      commitId: 'c_abc',
    })).resolves.toBeUndefined()

    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
