// backend/routes/agenda-tasks-v2.js — converted from api/agenda-tasks-v2.js
//
// NOTE: the original file's header comment claimed this route was
// "Gated behind the harness shared secret" — but no such gate exists
// anywhere in its handler body, and backend/_lib/harnessAuth.js is never
// imported here. That comment was stale even on Vercel. This route
// runs with no auth gate, same as every other route in this file set —
// flag this to whoever owns Migration Plan Phase 3 (real auth) so the
// doc comment doesn't mislead the next person either.
//
// POST /api/agenda-tasks-v2
//   { action: 'create',      title, description?, deadline?, startDate?, status?, priority?, assignerId?, executors? }
//   { action: 'update',      taskId, title?, description?, deadline?, startDate?, status?, priority?, executors? }
//   { action: 'setStatus',   taskId, status }
//   { action: 'duplicate',   taskId }
//   { action: 'delete',      taskId }
//   { action: 'addLink',     taskId, entityType, entityId }
//   { action: 'removeLink',  linkId }

import { Hono } from 'hono'
import { AgendaService } from '../../src/services/AgendaService.js'
import { statusForError } from '../../src/repositories/errors.js'

const agendaTasksV2 = new Hono()

agendaTasksV2.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const service = new AgendaService()

  try {
    switch (body.action) {
      case 'create': {
        const task = await service.createTask({
          title: body.title, description: body.description || '',
          deadline: body.deadline || null, startDate: body.startDate || null,
          status: body.status || 'not_started', priority: body.priority || 'medium',
          assignerId: body.assignerId || null, executors: body.executors || [],
        })
        return c.json({ success: true, task })
      }
      case 'update': {
        const task = await service.updateTask({
          taskId: body.taskId, title: body.title, description: body.description,
          deadline: body.deadline, startDate: body.startDate,
          status: body.status, priority: body.priority, executors: body.executors,
        })
        return c.json({ success: true, task })
      }
      case 'setStatus': {
        const task = await service.setTaskStatus({ taskId: body.taskId, status: body.status })
        return c.json({ success: true, task })
      }
      case 'duplicate': {
        const task = await service.duplicateTask({ taskId: body.taskId })
        return c.json({ success: true, task })
      }
      case 'delete': {
        const result = await service.deleteTask({ taskId: body.taskId })
        return c.json({ success: true, ...result })
      }
      case 'addLink': {
        const link = await service.addTaskLink({ taskId: body.taskId, entityType: body.entityType, entityId: body.entityId })
        return c.json({ success: true, link })
      }
      case 'removeLink': {
        const result = await service.removeTaskLink({ linkId: body.linkId })
        return c.json({ success: true, ...result })
      }
      default:
        return c.json({
          error: `Unknown action "${body.action}" — expected one of: create, update, setStatus, duplicate, delete, addLink, removeLink.`,
        }, 400)
    }
  } catch (err) {
    console.error('[agenda-tasks-v2]', err)
    return c.json({ error: err.message ?? 'Internal server error' }, statusForError(err))
  }
})

export default agendaTasksV2