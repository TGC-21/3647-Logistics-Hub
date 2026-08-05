// src/pendingActions.js
//
// Confirm/deny inbox for harness actions paused by ConfirmationRequiredError
// (see AGENTIC_HARNESS.md Phase 3). Mirrors historyPanel.js's shape: a
// state-agnostic module owning one overlay, no knowledge of assemblies/
// parts/etc. — just pending_actions rows and two buttons per row.

import { fetchPendingActions, resolvePendingAction } from './services/harnessApi.js'
import { getCurrentMemberId } from './members.js'

let items = []

const SEVERITY_LABEL = {
  read: ['ti-eye', 'Read'],
  write: ['ti-pencil', 'Write'],
  destructive: ['ti-alert-triangle', 'Destructive'],
}

/** Call after boot and whenever you want the badge count refreshed
 *  (e.g. polling, or after any harness-invoke call surfaces a fresh
 *  confirmationRequired response). */
export async function refreshPendingActions() {
  const memberId = getCurrentMemberId()
  if (!memberId) { items = []; return items }
  items = await fetchPendingActions(memberId)
  updateBadge()
  return items
}

function updateBadge() {
  const badge = document.getElementById('pending-actions-badge')
  if (!badge) return
  badge.textContent = String(items.length)
  badge.style.display = items.length ? 'inline-flex' : 'none'
}

export function openPendingActionsModal() {
  renderList()
  document.getElementById('pending-actions-overlay').style.display = 'flex'
}
function closePendingActionsModal() {
  document.getElementById('pending-actions-overlay').style.display = 'none'
}

function renderList() {
  const body = document.getElementById('pending-actions-body')
  if (!items.length) {
    body.innerHTML = `<div class="empty" style="padding:24px 0">
      <i class="ti ti-checklist" aria-hidden="true"></i>
      <div class="empty-title">Nothing waiting on you</div>
    </div>`
    return
  }

  body.innerHTML = items.map(rowHTML).join('')
  body.querySelectorAll('[data-approve]').forEach(btn =>
    btn.addEventListener('click', () => handleDecision(btn.dataset.approve, 'approved'))
  )
  body.querySelectorAll('[data-deny]').forEach(btn =>
    btn.addEventListener('click', () => handleDecision(btn.dataset.deny, 'denied'))
  )
}

function rowHTML(item) {
  const [icon, label] = SEVERITY_LABEL[item.severity] || ['ti-help-circle', item.severity]
  return `<div class="cat-manage-row" style="flex-direction:column;align-items:stretch;gap:8px" data-pending-row="${item.id}">
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div style="display:flex;align-items:center;gap:7px">
        <span class="part-badge part-badge--${item.severity === 'destructive' ? 'pending' : 'partial'}">
          <i class="ti ${icon}" aria-hidden="true"></i> ${label}
        </span>
        <span style="font-size:13px;font-weight:500">${item.actionName}</span>
      </div>
      <span style="font-size:11px;color:var(--color-text-tertiary)">${new Date(item.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
    </div>
    ${item.reason ? `<div style="font-size:12px;color:var(--color-text-secondary)">${item.reason}</div>` : ''}
    <details style="font-size:11px;color:var(--color-text-tertiary)">
      <summary style="cursor:pointer">Details</summary>
      <pre style="white-space:pre-wrap;word-break:break-word;margin-top:4px">${JSON.stringify(item.actionArgs, null, 2)}</pre>
    </details>
    <div style="display:flex;gap:7px;justify-content:flex-end">
      <button class="btn btn-danger btn-sm" data-deny="${item.id}"><i class="ti ti-x" aria-hidden="true"></i> Deny</button>
      <button class="btn btn-primary btn-sm" data-approve="${item.id}"><i class="ti ti-check" aria-hidden="true"></i> Approve</button>
    </div>
  </div>`
}

async function handleDecision(pendingActionId, decision) {
  try {
    await resolvePendingAction({ pendingActionId, decision, resolvedBy: getCurrentMemberId() })
    items = items.filter(i => i.id !== pendingActionId)
    updateBadge()
    renderList()
  } catch (e) {
    console.error(e)
    alert(e.message || 'Error resolving action')
  }
}

export function bindPendingActionsEvents() {
  document.getElementById('btn-open-pending-actions').addEventListener('click', openPendingActionsModal)
  document.getElementById('btn-close-pending-actions').addEventListener('click', closePendingActionsModal)
  document.getElementById('pending-actions-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closePendingActionsModal()
  })
}