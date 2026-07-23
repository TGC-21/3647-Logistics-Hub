// src/autocomplete.js
//
// Lightweight ghost-text + dropdown autocomplete for free-text inputs
// backed by a list of existing values (e.g. every location string
// already used across inventory_instances). Case-insensitive matching
// throughout — a user typing "c1 bin" should match a stored "C1 Bin"
// without the mismatched casing ever fighting them mid-keystroke.
//
// Two independent affordances:
//   - Ghost text: only shown when the typed value is a case-insensitive
//     PREFIX of some candidate. Renders the remainder of that candidate
//     dimmed after the cursor. Accept with Tab or → at end-of-input.
//   - Dropdown: shown once the user has typed something (never on empty
//     focus — a few dozen locations is still too many to dump on someone
//     who hasn't expressed intent yet). Case-insensitive substring match,
//     prefix matches ranked first. Click (or arrow keys + Enter) to
//     accept.
//
// Accepting EITHER affordance replaces the input's value with the
// candidate's own canonical stored casing — we never try to "fix" what
// the user typed while they're still typing it, only on accept.
//
// Usage:
//   attachAutocomplete(inputEl, {
//     getCandidates: () => [...set of existing strings],
//     wrapperEl: inputEl.closest('.field'),   // must be position:relative
//   })

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function attachAutocomplete(input, { getCandidates, wrapperEl, maxResults = 8 }) {
  if (!input || !wrapperEl) return

  // Ensure the wrapper can host absolutely-positioned children.
  const computedPosition = getComputedStyle(wrapperEl).position
  if (computedPosition === 'static') wrapperEl.style.position = 'relative'

  let ghostEl = wrapperEl.querySelector(':scope > .autocomplete-ghost')
  if (!ghostEl) {
    ghostEl = document.createElement('div')
    ghostEl.className = 'autocomplete-ghost'
    ghostEl.setAttribute('aria-hidden', 'true')
    wrapperEl.appendChild(ghostEl)
  }

  let dropdownEl = wrapperEl.querySelector(':scope > .autocomplete-dropdown')
  if (!dropdownEl) {
    dropdownEl = document.createElement('div')
    dropdownEl.className = 'autocomplete-dropdown'
    wrapperEl.appendChild(dropdownEl)
  }

  let activeMatches = []
  let ghostSuggestion = null
  let highlightedIdx = -1

  function computeMatches(query) {
    const q = query.trim().toLowerCase()
    if (!q) return []
    // Dedupe candidates case-insensitively, keeping the first-seen casing
    // as canonical — avoids showing "C1 Bin" and "c1 bin" as two options.
    const seen = new Map()
    for (const c of getCandidates() || []) {
      if (!c) continue
      const key = c.toLowerCase()
      if (!seen.has(key)) seen.set(key, c)
    }
    const candidates = [...seen.values()]

    const prefixMatches = candidates.filter(c => c.toLowerCase().startsWith(q))
    const substringMatches = candidates.filter(c =>
      !c.toLowerCase().startsWith(q) && c.toLowerCase().includes(q)
    )
    return [...prefixMatches, ...substringMatches]
      .filter(c => c.toLowerCase() !== q)   // don't suggest an exact match of itself
      .slice(0, maxResults)
  }

  function renderGhost(val) {
    if (ghostSuggestion && val) {
      ghostEl.innerHTML =
        `<span style="visibility:hidden">${escapeHtml(val)}</span>` +
        `<span class="autocomplete-ghost-tail">${escapeHtml(ghostSuggestion.slice(val.length))}</span>`
      ghostEl.style.display = 'block'
    } else {
      ghostEl.style.display = 'none'
    }
  }

  function renderDropdown() {
    if (!activeMatches.length) {
      dropdownEl.style.display = 'none'
      dropdownEl.innerHTML = ''
      return
    }
    dropdownEl.innerHTML = activeMatches.map((m, i) =>
      `<div class="autocomplete-option${i === highlightedIdx ? ' active' : ''}" data-idx="${i}">${escapeHtml(m)}</div>`
    ).join('')
    dropdownEl.style.display = 'block'

    dropdownEl.querySelectorAll('.autocomplete-option').forEach(el => {
      el.addEventListener('mousedown', e => {
        e.preventDefault()   // keep focus on input; fires before blur
        accept(activeMatches[parseInt(el.dataset.idx, 10)])
      })
    })
  }

  function refresh() {
    const val = input.value
    activeMatches = computeMatches(val)
    highlightedIdx = -1
    ghostSuggestion = val.trim()
      ? (activeMatches.find(c => c.toLowerCase().startsWith(val.trim().toLowerCase())) || null)
      : null

    const focused = document.activeElement === input
    renderGhost(focused ? val : '')
    if (!focused) { dropdownEl.style.display = 'none'; return }
    renderDropdown()
  }

  function accept(value) {
    input.value = value
    activeMatches = []
    ghostSuggestion = null
    highlightedIdx = -1
    ghostEl.style.display = 'none'
    dropdownEl.style.display = 'none'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
  }

  function moveHighlight(delta) {
    if (!activeMatches.length) return
    highlightedIdx = (highlightedIdx + delta + activeMatches.length) % activeMatches.length
    renderDropdown()
  }

  input.addEventListener('input', refresh)
  input.addEventListener('focus', refresh)
  input.addEventListener('blur', () => {
    // Delay so a dropdown-option mousedown can fire before we hide it.
    setTimeout(() => {
      ghostEl.style.display = 'none'
      dropdownEl.style.display = 'none'
    }, 120)
  })

  input.addEventListener('keydown', e => {
    if (dropdownEl.style.display === 'block' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      moveHighlight(e.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (e.key === 'Enter' && highlightedIdx > -1 && activeMatches[highlightedIdx]) {
      e.preventDefault()
      accept(activeMatches[highlightedIdx])
      return
    }
    if ((e.key === 'Tab' || e.key === 'ArrowRight') && ghostSuggestion &&
        input.selectionStart === input.value.length &&
        input.selectionStart === input.selectionEnd) {
      e.preventDefault()
      accept(ghostSuggestion)
      return
    }
    if (e.key === 'Escape') {
      ghostEl.style.display = 'none'
      dropdownEl.style.display = 'none'
      highlightedIdx = -1
    }
  })

  // Exposed in case a caller wants to force-refresh after candidates
  // change underneath it (e.g. items reloaded) without the user typing.
  return { refresh }
}