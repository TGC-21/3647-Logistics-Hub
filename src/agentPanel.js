// Member-facing agent panel. This is intentionally a thin UI client: the
// conversation loop, persistence, and confirmation replay all remain on the
// Hono backend.

import { getCurrentMemberId } from './members.js'
import { fetchPendingActions, resolvePendingAction } from './services/harnessApi.js'

let conversationId = null
let pendingActions = []
let conversationEpoch = 0

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char])
}

async function request(url, options) {
  const res = await fetch(url, options)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Agent request failed')
  return data
}

function updateBadge() {
  const badge = document.getElementById('pending-actions-badge')
  if (!badge) return
  badge.textContent = String(pendingActions.length)
  badge.style.display = pendingActions.length ? 'inline-flex' : 'none'
}

function renderConfirmations() {
  const container = document.getElementById('agent-confirmations')
  if (!pendingActions.length) { container.innerHTML = ''; return }
  container.innerHTML = pendingActions.map(item => `
    <article class="agent-confirmation" data-pending-action="${escapeHtml(item.id)}">
      <div class="agent-confirmation-heading"><i class="ti ti-alert-triangle" aria-hidden="true"></i><strong>Approval needed</strong></div>
      <p>Clinker wants to <strong>${escapeHtml(item.actionName)}</strong>${item.reason ? `: ${escapeHtml(item.reason)}` : '.'}</p>
      <div class="agent-confirmation-actions"><button class="btn btn-sm" data-agent-deny="${escapeHtml(item.id)}">Deny</button><button class="btn btn-primary btn-sm" data-agent-approve="${escapeHtml(item.id)}">Approve</button></div>
    </article>`).join('')
  container.querySelectorAll('[data-agent-approve]').forEach(button => button.addEventListener('click', () => decide(button.dataset.agentApprove, 'approved')))
  container.querySelectorAll('[data-agent-deny]').forEach(button => button.addEventListener('click', () => decide(button.dataset.agentDeny, 'denied')))
}

function appendInline(target, text) {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let lastIndex = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > lastIndex) target.append(document.createTextNode(text.slice(lastIndex, match.index)))
    const token = match[0]
    const el = document.createElement(token.startsWith('**') ? 'strong' : 'code')
    el.textContent = token.startsWith('**') ? token.slice(2, -2) : token.slice(1, -1)
    target.append(el)
    lastIndex = match.index + token.length
  }
  if (lastIndex < text.length) target.append(document.createTextNode(text.slice(lastIndex)))
}

function tableCells(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())
}

function isTableDivider(line) { return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line) }

// Deliberately small, DOM-based Markdown renderer. It recognizes the answer
// patterns Clinker is asked to produce and never interpolates model output as
// HTML, so a model reply cannot inject markup into the page.
function renderMarkdown(content) {
  const root = document.createElement('div')
  root.className = 'agent-markdown'
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n')
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) { index++; continue }

    const heading = line.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      const el = document.createElement(`h${heading[1].length + 2}`)
      appendInline(el, heading[2]); root.append(el); index++; continue
    }

    if (line.includes('|') && isTableDivider(lines[index + 1] || '')) {
      const wrap = document.createElement('div'); wrap.className = 'agent-table-wrap'
      const table = document.createElement('table'); const thead = document.createElement('thead'); const row = document.createElement('tr')
      tableCells(line).forEach(cell => { const th = document.createElement('th'); appendInline(th, cell); row.append(th) })
      thead.append(row); table.append(thead); index += 2
      const tbody = document.createElement('tbody')
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        const tr = document.createElement('tr')
        tableCells(lines[index]).forEach(cell => { const td = document.createElement('td'); appendInline(td, cell); tr.append(td) })
        tbody.append(tr); index++
      }
      table.append(tbody); wrap.append(table); root.append(wrap); continue
    }

    if (/^[-*]\s+/.test(line)) {
      const list = document.createElement('ul')
      while (index < lines.length && /^[-*]\s+/.test(lines[index])) {
        const item = document.createElement('li'); appendInline(item, lines[index].replace(/^[-*]\s+/, '')); list.append(item); index++
      }
      root.append(list); continue
    }

    const paragraph = []
    while (index < lines.length && lines[index].trim() && !/^#{1,3}\s+/.test(lines[index]) && !/^[-*]\s+/.test(lines[index]) && !(lines[index].includes('|') && isTableDivider(lines[index + 1] || ''))) paragraph.push(lines[index++])
    const p = document.createElement('p'); appendInline(p, paragraph.join(' ')); root.append(p)
  }
  return root
}

function appendMessage(role, content) {
  const thread = document.getElementById('agent-thread')
  thread.querySelector('.agent-welcome')?.remove()
  const message = document.createElement('div')
  message.className = `agent-message agent-message--${role}`
  if (role === 'assistant') message.append(renderMarkdown(content))
  else message.textContent = content
  thread.appendChild(message)
  thread.scrollTop = thread.scrollHeight
}

function renderWelcome() {
  const thread = document.getElementById('agent-thread')
  thread.innerHTML = '<div class="agent-welcome"><i class="ti ti-sparkles" aria-hidden="true"></i><div><strong>What can I help with?</strong><p>Ask Clinker to find, organize, or update your Partshelf workspace.</p></div></div>'
}

/**
 * Starts a client-side chat from a known blank state. A conversation is not
 * created on the server until the member sends its first message. Incrementing
 * the epoch means a late response from an abandoned/in-flight chat cannot
 * attach its conversation id or reply to the newly-created chat.
 */
function startNewChat({ focus = false } = {}) {
  conversationEpoch++
  conversationId = null
  renderWelcome()
  const input = document.getElementById('agent-message')
  input.value = ''
  setBusy(false)
  if (focus) input.focus()
}

function setBusy(busy) {
  const input = document.getElementById('agent-message')
  const send = document.getElementById('btn-send-agent-message')
  input.disabled = busy
  send.disabled = busy
  send.innerHTML = busy ? '<i class="ti ti-loader-2 spin" aria-hidden="true"></i>' : '<i class="ti ti-arrow-up" aria-hidden="true"></i><span>Send</span>'
}

async function refreshPendingActions() {
  const memberId = getCurrentMemberId()
  pendingActions = memberId ? await fetchPendingActions(memberId) : []
  updateBadge()
  renderConfirmations()
}

function topicFor(conversation) {
  const firstUserMessage = conversation.messages?.find(message => message.role === 'user')?.content
  return firstUserMessage || 'Untitled conversation'
}

async function refreshHistory() {
  const memberId = getCurrentMemberId()
  const list = document.getElementById('agent-history-list')
  if (!memberId) { list.innerHTML = ''; return [] }
  try {
    const { conversations } = await request(`/api/agent-chat?memberId=${encodeURIComponent(memberId)}`)
    list.innerHTML = conversations.length ? conversations.map(conversation => `
      <button class="agent-history-item" data-agent-history="${escapeHtml(conversation.id)}" title="View saved conversation">
        <i class="ti ti-message-circle" aria-hidden="true"></i><span>${escapeHtml(topicFor(conversation))}</span>
      </button>`).join('') : '<div class="agent-history-empty">No previous topics yet</div>'
    list.querySelectorAll('[data-agent-history]').forEach(button => button.addEventListener('click', () => {
      const conversation = conversations.find(item => item.id === button.dataset.agentHistory)
      showHistory(conversation)
    }))
    return conversations
  } catch (error) {
    console.error('[agent-panel] history', error)
    list.innerHTML = '<div class="agent-history-empty">Could not load previous topics</div>'
    return []
  }
}

function showHistory(conversation) {
  if (!conversation) return
  // Viewing a saved conversation is a deliberate resume action. Cancel any
  // in-flight UI request first so its late response cannot overwrite this
  // selected thread, then retain the selected id for the next POST.
  conversationEpoch++
  conversationId = conversation.id
  const thread = document.getElementById('agent-thread')
  thread.innerHTML = '<div class="agent-history-notice">Continuing this saved conversation. Choose New chat to start a separate topic.</div>'
  for (const message of conversation.messages || []) {
    if ((message.role === 'user' || message.role === 'assistant') && message.content) appendMessage(message.role, message.content)
  }
  setBusy(false)
}

async function sendMessage(event) {
  event.preventDefault()
  const input = document.getElementById('agent-message')
  const message = input.value.trim()
  const memberId = getCurrentMemberId()
  if (!message || !memberId) return
  appendMessage('user', message)
  input.value = ''
  setBusy(true)
  const requestEpoch = conversationEpoch
  try {
    const result = await request('/api/agent-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberId, message, conversationId }) })
    // The member selected New chat (or the page initialized a fresh chat)
    // while this request was still running. Let the server finish and retain
    // its audit history, but never revive that prior conversation in this UI.
    if (requestEpoch !== conversationEpoch) return
    conversationId = result.conversationId
    appendMessage('assistant', result.reply || result.message || 'I’ve paused here until you decide on the requested action.')
    await Promise.all([refreshPendingActions(), refreshHistory()])
  } catch (error) {
    if (requestEpoch !== conversationEpoch) return
    appendMessage('assistant', `I couldn’t complete that: ${error.message}`)
    refreshPendingActions().catch( (error) => {
	console.log(error.message)
    })
  } finally {
    if (requestEpoch === conversationEpoch) setBusy(false)
  }
}

async function decide(pendingActionId, decision) {
  try {
    const result = await resolvePendingAction({ pendingActionId, decision, resolvedBy: getCurrentMemberId() })
    pendingActions = pendingActions.filter(item => item.id !== pendingActionId)
    updateBadge(); renderConfirmations()
    const conversations = await refreshHistory()
    if (result.turn?.conversationId) {
      const resumedConversation = conversations.find(conversation => conversation.id === result.turn.conversationId)
      if (resumedConversation) {
        // An approval resumes the conversation that created the pending
        // action, even after a reload/new chat. Switch to that persisted
        // thread rather than appending its reply onto an unrelated one.
        showHistory(resumedConversation)
      } else {
        // Keep the relationship correct even if the history list is stale
        // or has reached its display limit.
        conversationId = result.turn.conversationId
        if (result.turn.reply) appendMessage('assistant', result.turn.reply)
      }
    }
    if (result.turnError) appendMessage('assistant', `The decision was saved, but I couldn’t continue: ${result.turnError}`)
  } catch (error) { appendMessage('assistant', `I couldn’t save that decision: ${error.message}`) }
}

export function bindAgentPanelEvents() {
  const panel = document.getElementById('agent-panel')
  const open = () => { panel.classList.add('open'); panel.setAttribute('aria-hidden', 'false'); document.getElementById('btn-open-agent-panel').setAttribute('aria-expanded', 'true'); refreshPendingActions().catch(console.error); refreshHistory() }
  const close = () => { panel.classList.remove('open'); panel.setAttribute('aria-hidden', 'true'); document.getElementById('btn-open-agent-panel').setAttribute('aria-expanded', 'false') }
  document.getElementById('btn-open-agent-panel').addEventListener('click', () => panel.classList.contains('open') ? close() : open())
  document.getElementById('btn-close-agent-panel').addEventListener('click', close)
  document.getElementById('btn-new-agent-chat').addEventListener('click', () => startNewChat({ focus: true }))
  document.getElementById('agent-composer').addEventListener('submit', sendMessage)
  // Reloading never resumes a server conversation. Use the exact same path
  // as the visible New chat button so the lifecycle stays explicit.
  startNewChat()
  refreshPendingActions().catch(error => console.error('[agent-panel] pending actions', error))
}
