// repositories/__tests__/TaskRepository.test.js

import { describe, it, expect } from 'vitest'
import { TaskRepository } from '../TaskRepository.js'
import { createFakeSupabase } from '../../api/_lib/__tests__/testUtils/fakeSupabase.js'
import { NotFoundError } from '../errors.js'

describe('TaskRepository', () => {
  it('findById maps a found row into the local camelCase shape', async () => {
    const supabase = createFakeSupabase({
      data: {
        id: 'task1', title: 'Machine shafts', description: '', deadline: null,
        status: 'in_progress', priority: 'high', assigner_id: 'member1', executors: ['member2'],
        start_date: null, created_at: '2025-12-01T00:00:00Z', completed_at: null,
      },
      error: null,
    })
    const repo = new TaskRepository(supabase)
    const task = await repo.findById('task1')
    expect(task).toEqual({
      id: 'task1', title: 'Machine shafts', description: '', deadline: null,
      status: 'in_progress', priority: 'high', assignerId: 'member1', executors: ['member2'],
      startDate: null, createdAt: '2025-12-01T00:00:00Z', completedAt: null,
    })
  })

  it('requireById throws NotFoundError when nothing matches', async () => {
    const supabase = createFakeSupabase({ data: null, error: null })
    const repo = new TaskRepository(supabase)
    await expect(repo.requireById('missing')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('update only writes the columns present in the patch', async () => {
    const supabase = createFakeSupabase({
      data: { id: 'task1', title: 'X', description: '', deadline: null, status: 'complete', priority: 'medium', assigner_id: null, executors: [], start_date: null, created_at: 'now', completed_at: '2026-01-01T00:00:00Z' },
      error: null,
    })
    const repo = new TaskRepository(supabase)
    const task = await repo.update('task1', { status: 'complete', completedAt: '2026-01-01T00:00:00Z' })
    expect(task.status).toBe('complete')
    expect(supabase.calledWith({ table: 'tasks', method: 'update' })).toBe(true)
  })
})
