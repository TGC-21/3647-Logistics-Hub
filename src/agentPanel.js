// Member-facing agent panel. This is intentionally a thin UI client: the
// conversation loop, persistence, and confirmation replay all remain on the
// Hono backend.

import { getCurrentMemberId } from './members.js'
import { uploadAgentImage } from './db.js'
import { fetchPendingActions, resolvePendingAction } from './services/harnessApi.js'
import { fetchCategories, createCategory } from './services/categoriesApi.js'
import { createInventoryInstance, updateInventoryInstance } from './services/componentsApi.js'
import { fetchInventoryInstances } from './db.js'
import { attachAutocomplete } from './autocomplete.js'

let conversationId = null
let pendingActions = []
let conversationEpoch = 0
let attachedImage = null
let categoryCache = null
let locationCache  = null

async function ensureCategories() {
  if (!categoryCache) categoryCache = await fetchCategories()
  return categoryCache
}

/** Distinct location strings already in use — same derivation main.js's
 *  distinctLocations() does off its in-memory items list, just fetched
 *  fresh here since agentPanel.js doesn't share main.js's module state. */
async function ensureLocations() {
  if (!locationCache) {
    const items = await fetchInventoryInstances()
    locationCache = [...new Set(items.map(it => it.location).filter(Boolean))]
  }
  return locationCache
}

/** Best-effort case-insensitive match of the model's free-text
 *  categoryName guess against real categories, so the select can
 *  preselect instead of defaulting to "Uncategorized" when the model
 *  actually got it right. */
function guessCategoryId(categoryName, categories) {
  if (!categoryName) return ''
  const normalize = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).map(token => token.endsWith('s') ? token.slice(0, -1) : token)
  const wanted = new Set(normalize(categoryName))
  let best = null
  let tied = false
  for (const category of categories) {
    const candidate = new Set(normalize(category.name))
    const overlap = [...wanted].filter(token => candidate.has(token)).length
    const score = overlap / Math.max(wanted.size, candidate.size)
    if (overlap && (!best || score > best.score)) { best = { category, score }; tied = false }
    else if (overlap && best && score === best.score) tied = true
  }
  return best?.score >= 0.5 && !tied ? best.category.id : ''
}

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
  // Two physical badges now (topbar desktop + mobile bottom tab) since
  // an element can only have one id — keep them mirrored rather than
  // picking one, so whichever surface is visible at a given viewport
  // width is always accurate.
  ;['pending-actions-badge', 'pending-actions-badge-mobile'].forEach(id => {
    const badge = document.getElementById(id)
    if (!badge) return
    badge.textContent = String(pendingActions.length)
    badge.style.display = pendingActions.length ? 'inline-flex' : 'none'
  })
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

async function renderInventoryProposal(proposal) {
  const thread = document.getElementById('agent-thread')
  const card = document.createElement('article')
  card.className = 'agent-proposal-card'
  thread.appendChild(card)
  card.innerHTML = `<div class="agent-proposal-heading"><i class="ti ti-loader-2 spin" aria-hidden="true"></i> Loading…</div>`

  const categories = await ensureCategories()
  const locations  = await ensureLocations()
  const preselectedCatId = categories.some(c => c.id === proposal.categoryId)
    ? proposal.categoryId
    : guessCategoryId(proposal.categoryName, categories)
  const initialCategory = categories.find(c => c.id === preselectedCatId) || null

  card.innerHTML = `
    <div class="agent-proposal-heading"><i class="ti ti-camera-plus" aria-hidden="true"></i><strong>Proposed inventory item</strong></div>
    ${proposal.attachmentUrl ? `<img class="agent-proposal-image" src="${escapeHtml(proposal.attachmentUrl)}" alt="Attached photo">` : ''}

    <div class="field"><label>Name</label><input type="text" data-proposal-field="name" value="${escapeHtml(proposal.name || '')}"></div>

    <div class="field">
      <label>Category</label>
      <select data-proposal-category></select>
      <div class="agent-proposal-new-cat" data-new-cat-row style="display:none">
        <input type="text" data-new-cat-name placeholder="New category name…">
        <button type="button" class="btn btn-sm" data-new-cat-cancel>Cancel</button>
        <button type="button" class="btn btn-primary btn-sm" data-new-cat-confirm>Create</button>
      </div>
      ${!preselectedCatId && proposal.categoryName ? `<div class="agent-proposal-hint">Clinker suggested "${escapeHtml(proposal.categoryName)}" — no exact match found, pick one or create it.</div>` : ''}
    </div>

    <div class="field"><label>Quantity</label><input type="number" min="0" data-proposal-field="quantity" value="${proposal.quantity ?? ''}"></div>
    <div class="field"><label>Location</label><input type="text" data-proposal-field="location" value="${escapeHtml(proposal.location || '')}" autocomplete="off"></div>
    <div class="field"><label>Notes</label><textarea data-proposal-field="notes">${escapeHtml(proposal.notes || '')}</textarea></div>

    <div class="field">
      <label>Characteristics</label>
      <div data-proposal-attrs></div>
    </div>

    ${proposal.reasoning ? `<p class="agent-proposal-reasoning"><i class="ti ti-info-circle" aria-hidden="true"></i> ${escapeHtml(proposal.reasoning)}</p>` : ''}
    <div class="agent-confirmation-actions">
      <button class="btn btn-sm" data-proposal-discard>Discard</button>
      <button class="btn btn-primary btn-sm" data-proposal-confirm>
        <i class="ti ti-check" aria-hidden="true"></i> Add to inventory
      </button>
    </div>`

  // ── Category select ──
  const catSelect = card.querySelector('[data-proposal-category]')
  populateCategorySelect(catSelect, categories, preselectedCatId)
  renderProposalAttrs(card, initialCategory, proposal.attrs || {})

  catSelect.addEventListener('change', () => {
    if (catSelect.value === '__new__') {
      card.querySelector('[data-new-cat-row]').style.display = 'flex'
      catSelect.value = preselectedCatId || ''
      card.querySelector('[data-new-cat-name]')?.focus()
      return
    }
    const cat = categories.find(c => c.id === catSelect.value) || null
    renderProposalAttrs(card, cat, proposal.attrs || {})
  })

  card.querySelector('[data-new-cat-cancel]').addEventListener('click', () => {
    card.querySelector('[data-new-cat-row]').style.display = 'none'
  })
  card.querySelector('[data-new-cat-confirm]').addEventListener('click', async () => {
    const nameInput = card.querySelector('[data-new-cat-name]')
    const name = nameInput.value.trim()
    if (!name) { nameInput.focus(); return }
    try {
      // No required-characteristics builder here — keep the in-chat
      // flow fast. A member who wants typed required fields on this
      // new category can add them afterward via Manage Categories,
      // same as any category created without them today.
      const saved = await createCategory({ name, requiredKeysConfig: [], actorId: getCurrentMemberId() })
      categoryCache = null   // invalidate so the next proposal card sees it too
      categories.push(saved)
      populateCategorySelect(catSelect, categories, saved.id)
      card.querySelector('[data-new-cat-row]').style.display = 'none'
      renderProposalAttrs(card, saved, proposal.attrs || {})
    } catch (error) {
      appendMessage('assistant', `Couldn't create that category: ${error.message}`)
    }
  })

  // ── Location autocomplete (reuses the same ghost-text + dropdown
  //    component the manual Add Component modal uses) ──
  const locInput = card.querySelector('[data-proposal-field="location"]')
  attachAutocomplete(locInput, {
    getCandidates: () => locations,
    wrapperEl: locInput.closest('.field'),
  })

  thread.scrollTop = thread.scrollHeight
  card.querySelector('[data-proposal-discard]').addEventListener('click', () => card.remove())
  card.querySelector('[data-proposal-confirm]').addEventListener('click', () => confirmProposal(card, proposal, categories))
}

function populateCategorySelect(select, categories, selectedId) {
  select.innerHTML = '<option value="">— Uncategorized —</option>' +
    categories.map(c => `<option value="${c.id}"${c.id === selectedId ? ' selected' : ''}>${escapeHtml(c.name)}</option>`).join('') +
    '<option value="__new__">+ New category…</option>'
}

/** Renders the characteristics rows for whichever category is currently
 *  selected: one row per that category's requiredKeysConfig entry
 *  (pre-filled from the model's attrs guess where the key matches),
 *  plus any of the model's OTHER attrs guesses as freeform extras below
 *  a divider — so a guess like "Pitch" isn't silently dropped just
 *  because the matched/created category doesn't define it as required. */
function renderProposalAttrs(card, category, modelAttrs) {
  const wrap = card.querySelector('[data-proposal-attrs]')
  const requiredConfig = category?.requiredKeysConfig || []
  const requiredKeys = new Set(requiredConfig.map(c => c.key))
  const extras = Object.entries(modelAttrs).filter(([k]) => !requiredKeys.has(k))

  wrap.innerHTML = `
    ${requiredConfig.map(cfg => `
      <div class="attr-row" data-required-attr-row data-config-key="${escapeHtml(cfg.key)}">
        <input type="text" value="${escapeHtml(cfg.key)}" readonly style="flex:1">
        <input type="text" data-required-attr-value value="${escapeHtml(modelAttrs[cfg.key] ?? '')}" style="flex:1.5" placeholder="${cfg.type === 'quantity' ? cfg.defaultUnit || 'value' : 'value'}">
      </div>`).join('')}
    ${!category ? `<div class="agent-proposal-hint">Pick a category above to see its required fields.</div>` : ''}
    ${extras.length ? `
      <div class="agent-proposal-extra-label">Additional (not required by this category)</div>
      ${extras.map(([k, v]) => `
        <div class="attr-row" data-extra-attr-row>
          <input type="text" data-extra-attr-key value="${escapeHtml(k)}" style="flex:1">
          <input type="text" data-extra-attr-value value="${escapeHtml(String(v))}" style="flex:1.5">
          <button type="button" class="btn-icon" data-remove-extra-attr aria-label="Remove characteristic"><i class="ti ti-x" aria-hidden="true"></i></button>
        </div>`).join('')}` : ''}
    <button type="button" class="btn btn-sm" data-add-extra-attr style="align-self:flex-start;margin-top:2px">
      <i class="ti ti-plus" aria-hidden="true"></i> Add characteristic
    </button>`

  wrap.querySelector('[data-add-extra-attr]').addEventListener('click', () => {
    const row = document.createElement('div')
    row.className = 'attr-row'
    row.dataset.extraAttrRow = '1'
    row.innerHTML = `<input type="text" data-extra-attr-key placeholder="Key" style="flex:1">
                      <input type="text" data-extra-attr-value placeholder="Value" style="flex:1.5">
                      <button type="button" class="btn-icon" data-remove-extra-attr aria-label="Remove characteristic"><i class="ti ti-x" aria-hidden="true"></i></button>`
    wrap.querySelector('[data-add-extra-attr]').before(row)
    row.querySelector('input').focus()
  })
  wrap.querySelectorAll('[data-remove-extra-attr]').forEach(button => button.addEventListener('click', () => button.closest('[data-extra-attr-row]')?.remove()))
}

async function confirmProposal(card, proposal, categories) {
  const val = sel => card.querySelector(sel)?.value?.trim() || ''
  const name = val('[data-proposal-field="name"]')
  if (!name) { card.querySelector('[data-proposal-field="name"]').focus(); return }

  const categoryId = card.querySelector('[data-proposal-category]').value || null

  const attrs = {}
  card.querySelectorAll('[data-required-attr-row]').forEach(row => {
    const key = row.dataset.configKey
    const value = row.querySelector('[data-required-attr-value]').value.trim()
    if (value) attrs[key] = value
  })
  card.querySelectorAll('[data-extra-attr-row]').forEach(row => {
    const key = row.querySelector('[data-extra-attr-key]')?.value.trim()
    const value = row.querySelector('[data-extra-attr-value]')?.value.trim() || ''
    if (key) attrs[key] = value
  })

  const confirmBtn = card.querySelector('[data-proposal-confirm]')
  confirmBtn.disabled = true
  confirmBtn.innerHTML = '<i class="ti ti-loader-2 spin" aria-hidden="true"></i>'

  try {
    const instance = await createInventoryInstance({
      categoryId,
      attrs,
      fallback: { name, description: '', image: proposal.attachmentUrl || null },
      name,
      description: '',
      image: proposal.attachmentUrl || null,
      location: val('[data-proposal-field="location"]'),
      quantity: parseInt(val('[data-proposal-field="quantity"]'), 10) || 0,
      tags: [],
      notes: val('[data-proposal-field="notes"]'),
      actorId: getCurrentMemberId(),
    })
    locationCache = null   // the new instance may have introduced a new location string
    card.remove()
    appendMessage('assistant', `Added "${instance.name}" to inventory${categoryId ? '' : ' (uncategorized)'}.`)
  } catch (error) {
    confirmBtn.disabled = false
    confirmBtn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i> Add to inventory'
    appendMessage('assistant', `Couldn't save that: ${error.message}`)
  }
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

/**
 * Renders one message bubble. `attachments` is the same shape stored on a
 * conversation's messages ([{ url, mimeType, name, path }]) and produced by
 * uploadAgentImage — any entry with a `url` is rendered as a thumbnail above
 * the text, click-to-expand in a new tab. Works for both freshly-sent
 * messages and messages replayed from history (see showHistory below),
 * since both paths ultimately pass the same attachments shape.
 */
function appendMessage(role, content, attachments = []) {
  const thread = document.getElementById('agent-thread')
  thread.querySelector('.agent-welcome')?.remove()
  const message = document.createElement('div')
  message.className = `agent-message agent-message--${role}`

  const images = (attachments || []).filter(a => a && a.url)
  if (images.length) {
    const imagesWrap = document.createElement('div')
    imagesWrap.className = 'agent-message-images'
    images.forEach(a => {
      const img = document.createElement('img')
      img.className = 'agent-message-image'
      img.src = a.url
      img.alt = a.name || 'Attached image'
      img.loading = 'lazy'
      img.title = 'Click to open full size'
      img.addEventListener('click', () => window.open(a.url, '_blank', 'noreferrer'))
      imagesWrap.appendChild(img)
    })
    message.appendChild(imagesWrap)
  }

  if (content) {
    if (role === 'assistant') {
      message.append(renderMarkdown(content))
    } else {
      const textEl = document.createElement('div')
      textEl.className = 'agent-message-text'
      textEl.textContent = content
      message.appendChild(textEl)
    }
  }

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
  attachedImage = null
  updateAttachmentLabel()
  clearAttachmentPreview()
  setBusy(false)
  if (focus) input.focus()
}

function updateAttachmentLabel() {
  const button = document.getElementById('btn-attach-agent-image')
  if (!button) return
  button.title = attachedImage ? `Attached: ${attachedImage.name}` : 'Attach image'
  button.classList.toggle('active', Boolean(attachedImage))
}

/** Small thumbnail + remove button shown above the composer once an image
 *  is picked, so the member can see/confirm what they're about to send
 *  before it's uploaded — mirrors most chat apps' attach-preview pattern. */
function renderAttachmentPreview() {
  let preview = document.getElementById('agent-attachment-preview')
  const composer = document.getElementById('agent-composer')
  if (!attachedImage) {
    preview?.remove()
    return
  }
  if (!preview) {
    preview = document.createElement('div')
    preview.id = 'agent-attachment-preview'
    preview.className = 'agent-attachment-preview'
    composer.parentElement.insertBefore(preview, composer)
  }
  const localUrl = attachedImage.previewUrl || (attachedImage.file ? URL.createObjectURL(attachedImage.file) : attachedImage.url)
  attachedImage.previewUrl = localUrl
  preview.innerHTML = `
    <img src="${localUrl}" alt="${escapeHtml(attachedImage.name || 'Attachment')}">
    <span class="agent-attachment-name">${escapeHtml(attachedImage.name || 'Attached image')}</span>
    <button type="button" class="btn-icon" id="btn-remove-agent-attachment" aria-label="Remove attachment"><i class="ti ti-x" aria-hidden="true"></i></button>`
  document.getElementById('btn-remove-agent-attachment').addEventListener('click', () => {
    attachedImage = null
    updateAttachmentLabel()
    clearAttachmentPreview()
  })
}

function clearAttachmentPreview() {
  document.getElementById('agent-attachment-preview')?.remove()
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
    if ((message.role === 'user' || message.role === 'assistant') && (message.content || message.attachments?.length)) {
      appendMessage(message.role, message.content, message.attachments)
    }
  }
  setBusy(false)
}

async function sendMessage(event) {
  event.preventDefault()
  const input = document.getElementById('agent-message')
  const message = input.value.trim()
  const memberId = getCurrentMemberId()
  if ((!message && !attachedImage) || !memberId) return
  let attachment = attachedImage
  if (attachment?.file) {
    setBusy(true)
    try { attachment = await uploadAgentImage(memberId, attachment.file) }
    catch (error) { appendMessage('assistant', `I couldn’t upload that image: ${error.message}`); setBusy(false); return }
  }
  const attachmentsForDisplay = attachment ? [attachment] : []
  appendMessage('user', message || (attachmentsForDisplay.length ? '' : 'Attached an image.'), attachmentsForDisplay)
  input.value = ''
  attachedImage = null
  updateAttachmentLabel()
  clearAttachmentPreview()
  setBusy(true)
  const requestEpoch = conversationEpoch
  try {
    const result = await request('/api/agent-chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberId, message, conversationId, attachments: attachmentsForDisplay }) })
    // The member selected New chat (or the page initialized a fresh chat)
    // while this request was still running. Let the server finish and retain
    // its audit history, but never revive that prior conversation in this UI.
    if (requestEpoch !== conversationEpoch) return
    conversationId = result.conversationId
    appendMessage('assistant', result.reply || result.message || 'I\'ve paused here until you decide on the requested action.')
    if (result.status === 'proposal' && result.proposal) renderInventoryProposal(result.proposal)
    await Promise.all([refreshPendingActions(), refreshHistory()])
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
        // conversationId = result.turn.conversationId
        // if (result.turn.reply) appendMessage('assistant', result.turn.reply)

                  // inside sendMessage(), replacing the plain appendMessage('assistant', ...) line:
        conversationId = result.conversationId
        appendMessage('assistant', result.reply || result.message || 'I\'ve paused here until you decide on the requested action.')
        if (result.status === 'proposal' && result.proposal) renderInventoryProposal(result.proposal)
        await Promise.all([refreshPendingActions(), refreshHistory()])
      }
    }
    if (result.turnError) appendMessage('assistant', `The decision was saved, but I couldn’t continue: ${result.turnError}`)
  } catch (error) { appendMessage('assistant', `I couldn’t save that decision: ${error.message}`) }
}

export function bindAgentPanelEvents() {
  const panel = document.getElementById('agent-panel')
  const toggleBtns = ['btn-open-agent-panel', 'tab-btn-clinker'].map(id => document.getElementById(id)).filter(Boolean)
  const open = () => {
    panel.classList.add('open')
    panel.setAttribute('aria-hidden', 'false')
    toggleBtns.forEach(btn => btn.setAttribute('aria-expanded', 'true'))
    document.getElementById('tab-btn-clinker')?.classList.add('active')
    document.getElementById('tab-btn-components')?.classList.remove('active')
    document.getElementById('tab-btn-categories')?.classList.remove('active')
    // Mobile-only view swap — see mobile.css's body.mobile-agent-open
    // rules. Harmless no-op class on desktop (nothing in desktop CSS
    // reads it), so this doesn't need a viewport check here.
    document.body.classList.add('mobile-agent-open')
    refreshPendingActions().catch(console.error)
    refreshHistory()
  }
  const close = () => {
    panel.classList.remove('open')
    panel.setAttribute('aria-hidden', 'true')
    toggleBtns.forEach(btn => btn.setAttribute('aria-expanded', 'false'))
    document.getElementById('tab-btn-clinker')?.classList.remove('active')
    document.body.classList.remove('mobile-agent-open')
    document.getElementById('tab-btn-components')?.classList.add('active')
  }

  document.getElementById('btn-open-agent-panel').addEventListener('click', () => panel.classList.contains('open') ? close() : open())
  document.getElementById('tab-btn-clinker')?.addEventListener('click', () => panel.classList.contains('open') ? close() : open())
  document.getElementById('btn-close-agent-panel').addEventListener('click', close)
  document.getElementById('btn-new-agent-chat').addEventListener('click', () => startNewChat({ focus: true }))
  document.getElementById('agent-composer').addEventListener('submit', sendMessage)
  const imageInput = document.getElementById('agent-image-input')
  document.getElementById('btn-attach-agent-image').addEventListener('click', () => imageInput.click())
  imageInput.addEventListener('change', () => {
    const file = imageInput.files?.[0]
    if (!file) return
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return
    if (file.size > 10 * 1024 * 1024) return
    attachedImage = { file, name: file.name }
    updateAttachmentLabel()
    renderAttachmentPreview()
    imageInput.value = ''
  })
  // Reloading never resumes a server conversation. Use the exact same path
  // as the visible New chat button so the lifecycle stays explicit.
  startNewChat()
  refreshPendingActions().catch(error => console.error('[agent-panel] pending actions', error))
}
