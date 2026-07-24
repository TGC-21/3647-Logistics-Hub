// src/historyPanel.js
//
// Controls the #history-overlay markup (see history_panel.html). Two
// modes, same modal:
//   openHistoryModal(entityType, entityId, label)          — an entity's
//     own create/update/delete timeline, grouped by commit_id so a
//     multi-field save reads as one card, not N separate lines.
//   openCascadeHistoryModal(entityType, entityId, label)    — everything
//     that was deleted AS A RESULT of this entity being deleted (e.g.
//     an assembly's parts/subassemblies), via caused_by_entity_type/
//     caused_by_entity_id.
//
// Deliberately has no knowledge of assemblies/parts/components as
// concepts — it only knows entity_type strings and generic field/value
// pairs, same "state-agnostic module talking through a small surface"
// pattern the designer/* split already uses (partsTable.js,
// fabDetection.js, etc). Row templates just need a button with a
// data-history-* attribute; see the integration notes for the two
// call sites that need one added.

import { fetchEntityHistory, fetchCascadeChildren } from './changeLog.js'
import { fetchMemberById } from './members.js'

const ENTITY_LABELS = {
  assembly:          'Assembly',
  assembly_child:    'Subassembly',
  assembly_part:     'Part',
  inventory_instance:'Inventory item',
  component:         'Component',
  category:          'Category',
}

function entityLabel(type) { return ENTITY_LABELS[type] || type }

// Small in-memory cache so a modal with 10 commits from the same actor
// doesn't fire 10 identical member lookups.
const memberNameCache = new Map()
async function resolveActorName(actorId) {
  if (!actorId) return 'Unknown'
  if (memberNameCache.has(actorId)) return memberNameCache.get(actorId)
  try {
    const member = await fetchMemberById(actorId)
    const name = member ? member.name : `(deleted member ${actorId})`
    memberNameCache.set(actorId, name)
    return name
  } catch (e) {
    return actorId
  }
}

function formatValue(v) {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'object') {
    // Keep object/array diffs short in the modal — full JSON for a
    // segment list or a whole snapshotted row would be unreadable inline.
    const str = JSON.stringify(v)
    return str.length > 80 ? str.slice(0, 77) + '…' : str
  }
  return String(v)
}

function formatTimestamp(iso) {
  const d = new Date(iso)
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/** Groups flat change_log rows by commit_id, preserving the order
 *  commits first appear in the (already newest-first) input list. */
function groupByCommit(rows) {
  const order = []
  const byCommit = new Map()
  for (const row of rows) {
    if (!byCommit.has(row.commit_id)) {
      byCommit.set(row.commit_id, [])
      order.push(row.commit_id)
    }
    byCommit.get(row.commit_id).push(row)
  }
  return order.map(commitId => byCommit.get(commitId))
}

function actionBadgeHTML(action) {
  const map = {
    create: ['part-badge--complete', 'Created'],
    update: ['part-badge--partial',  'Updated'],
    delete: ['part-badge--pending',  'Deleted'],
  }
  const [cls, label] = map[action] || ['part-badge--pending', action]
  return `<span class="part-badge ${cls}">${label}</span>`
}

async function commitCardHTML(commitRows) {
  const first = commitRows[0]
  const actorName = await resolveActorName(first.actor_id)
  const when = formatTimestamp(first.created_at)

  const bodyHTML = first.action === 'update'
    ? commitRows.map(r => `
        <div style="display:flex;justify-content:space-between;gap:10px;padding:4px 0;font-size:12px">
          <span style="color:var(--color-text-secondary);flex-shrink:0">${r.field}</span>
          <span style="text-align:right;min-width:0">
            <span style="color:var(--color-text-tertiary);text-decoration:line-through">${formatValue(r.old_value)}</span>
            <i class="ti ti-arrow-right" style="font-size:10px;margin:0 3px;color:var(--color-text-tertiary)" aria-hidden="true"></i>
            <span style="color:var(--color-text-primary)">${formatValue(r.new_value)}</span>
          </span>
        </div>`).join('')
    : `<div style="font-size:12px;color:var(--color-text-secondary)">
        ${entityLabel(first.entity_type)} ${first.action === 'create' ? 'record created' : 'record removed'}
       </div>`

  return `<div class="cat-manage-row" style="flex-direction:column;align-items:stretch;gap:6px">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div style="display:flex;align-items:center;gap:7px">
        ${actionBadgeHTML(first.action)}
        <span style="font-size:12px;font-weight:500">${actorName}</span>
      </div>
      <span style="font-size:11px;color:var(--color-text-tertiary)">${when}</span>
    </div>
    ${bodyHTML}
  </div>`
}

async function renderCommitList(rows, emptyMessage) {
  const body = document.getElementById('history-modal-body')
  if (!rows.length) {
    body.innerHTML = `<div class="empty" style="padding:24px 0">
      <i class="ti ti-history-off" aria-hidden="true"></i>
      <div class="empty-title">${emptyMessage}</div>
    </div>`
    return
  }
  const groups = groupByCommit(rows)
  const cards = await Promise.all(groups.map(commitCardHTML))
  body.innerHTML = `<div style="display:flex;flex-direction:column;gap:8px">${cards.join('')}</div>`
}

/** An entity's own history — its create, every update, and its delete
 *  if it's gone. Does NOT include rows caused by it (see below). */
export async function openHistoryModal(entityType, entityId, label) {
  document.getElementById('history-modal-title').textContent = 'History'
  document.getElementById('history-modal-subtitle').textContent = `${entityLabel(entityType)}${label ? ': ' + label : ''}`
  document.getElementById('history-overlay').style.display = 'flex'
  document.getElementById('history-modal-body').innerHTML =
    `<div class="onshape-state"><i class="ti ti-loader-2 spin" aria-hidden="true"></i><div class="onshape-state-title">Loading…</div></div>`

  try {
    const rows = await fetchEntityHistory(entityType, entityId)
    await renderCommitList(rows, 'No history recorded yet')
  } catch (e) {
    console.error(e)
    document.getElementById('history-modal-body').innerHTML =
      `<div class="empty"><i class="ti ti-alert-circle" aria-hidden="true"></i><div class="empty-title">Error loading history</div></div>`
  }
}

/** Everything cascade-deleted as a result of this entity being deleted —
 *  e.g. an assembly's parts/subassemblies. Only meaningful to call right
 *  after (or any time after) that entity's own delete — for a still-live
 *  entity this will simply come back empty. */
export async function openCascadeHistoryModal(entityType, entityId, label) {
  document.getElementById('history-modal-title').textContent = 'Deleted with this item'
  document.getElementById('history-modal-subtitle').textContent = `${entityLabel(entityType)}${label ? ': ' + label : ''}`
  document.getElementById('history-overlay').style.display = 'flex'
  document.getElementById('history-modal-body').innerHTML =
    `<div class="onshape-state"><i class="ti ti-loader-2 spin" aria-hidden="true"></i><div class="onshape-state-title">Loading…</div></div>`

  try {
    const rows = await fetchCascadeChildren(entityType, entityId)
    await renderCommitList(rows, 'Nothing was cascade-deleted with this item')
  } catch (e) {
    console.error(e)
    document.getElementById('history-modal-body').innerHTML =
      `<div class="empty"><i class="ti ti-alert-circle" aria-hidden="true"></i><div class="empty-title">Error loading history</div></div>`
  }
}

function closeHistoryModal() {
  document.getElementById('history-overlay').style.display = 'none'
}

/** Call once at app startup, same convention as every other
 *  bind*Events() in the codebase. */
export function bindHistoryPanelEvents() {
  document.getElementById('btn-close-history').addEventListener('click', closeHistoryModal)
  document.getElementById('btn-close-history-2').addEventListener('click', closeHistoryModal)
  document.getElementById('history-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeHistoryModal()
  })
}