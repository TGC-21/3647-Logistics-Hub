// backend/routes/change-log.js — converted from api/change-log.js
//
// POST /api/change-log
//   { action: 'entityHistory',   entityType, entityId }
//   { action: 'commit',          commitId }
//   { action: 'cascadeChildren', causedByEntityType, causedByEntityId }
//   { action: 'recentActivity',  limit? }

import { Hono } from 'hono'
import { ChangeLogService } from '../../src/services/ChangeLogService.js'
import { statusForError } from '../../src/repositories/errors.js'

const changeLog = new Hono()

changeLog.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const service = new ChangeLogService()

  try {
    switch (body.action) {
      case 'entityHistory': {
        const rows = await service.fetchEntityHistory(body.entityType, body.entityId)
        return c.json({ success: true, rows })
      }
      case 'commit': {
        const rows = await service.fetchCommit(body.commitId)
        return c.json({ success: true, rows })
      }
      case 'cascadeChildren': {
        const rows = await service.fetchCascadeChildren(body.causedByEntityType, body.causedByEntityId)
        return c.json({ success: true, rows })
      }
      case 'recentActivity': {
        const rows = await service.fetchRecentActivity(body.limit || 50)
        return c.json({ success: true, rows })
      }
      default:
        return c.json({
          error: `Unknown action "${body.action}" — expected one of: entityHistory, commit, cascadeChildren, recentActivity.`,
        }, 400)
    }
  } catch (err) {
    console.error('[change-log]', err)
    return c.json({ error: err.message ?? 'Internal server error' }, statusForError(err))
  }
})

export default changeLog