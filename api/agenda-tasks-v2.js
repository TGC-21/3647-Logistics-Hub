// api/agenda-tasks-v2.js — Vercel serverless function
//
// Migration Plan Phase 1, item 9 ("Agenda"). Thin, action-dispatched
// route for AgendaService, same convention as every other "-v2" route
// in this migration pass. src/agenda.js keeps talking to Supabase
// directly with the anon key, unchanged — this route has no client
// caller yet; cutover is Phase 2 work.
//
// Gated behind the harness shared secret, same reasoning as every
// other route from this migration pass.
//
// POST /api/agenda-tasks-v2
//   { action: 'create',      title, description?, deadline?, startDate?, status?, priority?, assignerId?, executors? }
//   { action: 'update',      taskId, title?, description?, deadline?, startDate?, status?, priority?, executors? }
//   { action: 'setStatus',   taskId, status }
//   { action: 'duplicate',   taskId }
//   { action: 'delete',      taskId }
//   { action: 'addLink',     taskId, entityType, entityId }
//   { action: 'removeLink',  linkId }

import { applyCors } from './_lib/onshape.js'
import { assertHarnessToken } from './_lib/harnessAuth.js'
import { AgendaService } from '../src/services/AgendaService.js'
import { statusForError } from '../src/repositories/errors.js'

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const body = req.body ?? {}
  const service = new AgendaService()

  try {
    assertHarnessToken(req)

    switch (body.action) {
      case 'create': {
        const task = await service.createTask({
          title: body.title, description: body.description || '',
          deadline: body.deadline || null, startDate: body.startDate || null,
          status: body.status || 'not_started', priority: body.priority || 'medium',
          assignerId: body.assignerId || null, executors: body.executors || [],
        })
        return res.status(200).json({ success: true, task })
      }

      case 'update': {
        const task = await service.updateTask({
          taskId: body.taskId, title: body.title, description: body.description,
          deadline: body.deadline, startDate: body.startDate,
          status: body.status, priority: body.priority, executors: body.executors,
        })
        return res.status(200).json({ success: true, task })
      }

      case 'setStatus': {
        const task = await service.setTaskStatus({ taskId: body.taskId, status: body.status })
        return res.status(200).json({ success: true, task })
      }

      case 'duplicate': {
        const task = await service.duplicateTask({ taskId: body.taskId })
        return res.status(200).json({ success: true, task })
      }

      case 'delete': {
        const result = await service.deleteTask({ taskId: body.taskId })
        return res.status(200).json({ success: true, ...result })
      }

      case 'addLink': {
        const link = await service.addTaskLink({
          taskId: body.taskId, entityType: body.entityType, entityId: body.entityId,
        })
        return res.status(200).json({ success: true, link })
      }

      case 'removeLink': {
        const result = await service.removeTaskLink({ linkId: body.linkId })
        return res.status(200).json({ success: true, ...result })
      }

      default:
        return res.status(400).json({
          error: `Unknown action "${body.action}" — expected one of: create, update, setStatus, duplicate, delete, addLink, removeLink.`,
        })
    }
  } catch (err) {
    console.error('[agenda-tasks-v2]', err)
    return res.status(statusForError(err)).json({ error: err.message ?? 'Internal server error' })
  }
}
