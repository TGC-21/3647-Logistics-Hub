// services/__tests__/AgendaService.test.js
//
// Same convention as the rest of this migration pass: plain fake
// repositories, no Supabase. Focused on the one real business rule
// this service exists to centralize — how completedAt reacts to a
// status change — plus the validation AgendaService adds ahead of the
// DB's own CHECK constraints.

import { describe, it, expect, vi } from 'vitest'
import { AgendaService } from '../AgendaService.js'
import { ValidationError } from '../../repositories/errors.js'

function makeFakeRepos(overrides = {}) {
  const taskRepo = {
    requireById: vi.fn(async () => ({
      id: 'task1', title: 'Machine shafts', description: '', deadline: null,
      status: 'not_started', priority: 'medium', assignerId: null, executors: [],
      startDate: null, createdAt: 'now', completedAt: null,
    })),
    insert: vi.fn(async (payload) => ({ ...payload })),
    update: vi.fn(async (id, patch) => ({ id, ...patch })),
    delete: vi.fn(async () => {}),
    ...overrides.taskRepo,
  }
  const taskLinkRepo = {
    insert: vi.fn(async ({ id, taskId, entityType, entityId }) => ({ id, taskId, entityType, entityId, createdAt: 'now' })),
    delete: vi.fn(async () => true),
    ...overrides.taskLinkRepo,
  }
  return { taskRepo, taskLinkRepo }
}

describe('AgendaService.createTask', () => {
  it('rejects a blank title', async () => {
    const repos = makeFakeRepos()
    const service = new AgendaService(repos)
    await expect(service.createTask({ title: '   ' })).rejects.toBeInstanceOf(ValidationError)
    expect(repos.taskRepo.insert).not.toHaveBeenCalled()
  })

  it('rejects an invalid priority', async () => {
    const repos = makeFakeRepos()
    const service = new AgendaService(repos)
    await expect(service.createTask({ title: 'X', priority: 'urgent' })).rejects.toBeInstanceOf(ValidationError)
  })

  it('leaves completedAt null for a fresh not_started task', async () => {
    const repos = makeFakeRepos()
    const service = new AgendaService(repos)
    const task = await service.createTask({ title: 'Machine shafts' })
    expect(task.completedAt).toBeNull()
  })

  it('stamps completedAt when created directly as complete', async () => {
    const repos = makeFakeRepos()
    const service = new AgendaService(repos)
    const task = await service.createTask({ title: 'Machine shafts', status: 'complete' })
    expect(task.completedAt).not.toBeNull()
  })
})

describe('AgendaService.updateTask — completedAt/status coupling', () => {
  it('stamps completedAt when moving to complete for the first time', async () => {
    const repos = makeFakeRepos()
    const service = new AgendaService(repos)
    const task = await service.updateTask({ taskId: 'task1', status: 'complete' })
    expect(task.completedAt).not.toBeNull()
  })

  it('preserves the original completedAt when re-saving an already-complete task', async () => {
    const repos = makeFakeRepos({
      taskRepo: { requireById: vi.fn(async () => ({ id: 'task1', title: 'X', completedAt: '2026-01-01T00:00:00Z' })) },
    })
    const service = new AgendaService(repos)
    const task = await service.updateTask({ taskId: 'task1', status: 'complete', priority: 'high' })
    expect(task.completedAt).toBe('2026-01-01T00:00:00Z')
  })

  it('clears completedAt when reopening a completed task', async () => {
    const repos = makeFakeRepos({
      taskRepo: { requireById: vi.fn(async () => ({ id: 'task1', title: 'X', completedAt: '2026-01-01T00:00:00Z' })) },
    })
    const service = new AgendaService(repos)
    const task = await service.updateTask({ taskId: 'task1', status: 'not_started' })
    expect(task.completedAt).toBeNull()
  })

  it('preserves completedAt when archiving a previously-completed task', async () => {
    const repos = makeFakeRepos({
      taskRepo: { requireById: vi.fn(async () => ({ id: 'task1', title: 'X', completedAt: '2026-01-01T00:00:00Z' })) },
    })
    const service = new AgendaService(repos)
    const task = await service.updateTask({ taskId: 'task1', status: 'archived' })
    expect(task.completedAt).toBe('2026-01-01T00:00:00Z')
  })

  it('does not touch completedAt when status is not part of the update', async () => {
    const repos = makeFakeRepos()
    const service = new AgendaService(repos)
    await service.updateTask({ taskId: 'task1', description: 'new notes' })
    const patch = repos.taskRepo.update.mock.calls[0][1]
    expect(patch).not.toHaveProperty('completedAt')
    expect(patch).not.toHaveProperty('status')
  })

  it('rejects blanking out the title via update', async () => {
    const repos = makeFakeRepos()
    const service = new AgendaService(repos)
    await expect(service.updateTask({ taskId: 'task1', title: '   ' })).rejects.toBeInstanceOf(ValidationError)
  })
})

describe('AgendaService.duplicateTask', () => {
  it('resets status and completedAt and suffixes the title', async () => {
    const repos = makeFakeRepos({
      taskRepo: {
        requireById: vi.fn(async () => ({
          id: 'task1', title: 'Machine shafts', description: 'd', deadline: null,
          status: 'complete', priority: 'high', assignerId: 'member1', executors: ['member2'],
          startDate: null, completedAt: '2026-01-01T00:00:00Z',
        })),
        insert: vi.fn(async (payload) => payload),
      },
    })
    const service = new AgendaService(repos)
    const copy = await service.duplicateTask({ taskId: 'task1' })
    expect(copy.title).toBe('Machine shafts (copy)')
    expect(copy.status).toBe('not_started')
    expect(copy.completedAt).toBeNull()
    expect(copy.priority).toBe('high')
  })
})

describe('AgendaService.addTaskLink', () => {
  it('rejects an entityType outside the five recognized kinds', async () => {
    const repos = makeFakeRepos()
    const service = new AgendaService(repos)
    await expect(service.addTaskLink({ taskId: 'task1', entityType: 'random_table', entityId: 'x' }))
      .rejects.toBeInstanceOf(ValidationError)
    expect(repos.taskLinkRepo.insert).not.toHaveBeenCalled()
  })

  it('rejects a missing entityId', async () => {
    const repos = makeFakeRepos()
    const service = new AgendaService(repos)
    await expect(service.addTaskLink({ taskId: 'task1', entityType: 'fabrication_job', entityId: '' }))
      .rejects.toBeInstanceOf(ValidationError)
  })

  it('links a valid entity type', async () => {
    const repos = makeFakeRepos()
    const service = new AgendaService(repos)
    const link = await service.addTaskLink({ taskId: 'task1', entityType: 'fabrication_job', entityId: 'job1' })
    expect(link.entityType).toBe('fabrication_job')
  })
})

describe('AgendaService.removeTaskLink', () => {
  it('throws when nothing was actually deleted', async () => {
    const repos = makeFakeRepos({ taskLinkRepo: { delete: vi.fn(async () => false) } })
    const service = new AgendaService(repos)
    await expect(service.removeTaskLink({ linkId: 'missing' })).rejects.toBeInstanceOf(ValidationError)
  })
})
