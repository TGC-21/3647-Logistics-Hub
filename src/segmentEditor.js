// src/segmentEditor.js
//
// Shared editable segment-list widget for 'segments'-typed characteristics
// (see AXIAL_SHAFT_DETECTION_ROADMAP.md's new component-typing decision).
// Renders into a container element and mutates the given `segments` array
// in place on every change — callers own the array reference and should
// read it directly (no separate "get value" call needed) after onChange
// fires, or at confirm/save time.
//
// Used by:
//   - src/main.js's buildRequiredAttrRow (generic Inventory Add/Edit
//     Component modal — full editing, for any category with a
//     'segments'-typed required characteristic)
//   - src/designer.js's Fabricate confirm overlay for axial-shaft
//     detections (full editing, seeded from detected geometry)
//
// Segment identity: each segment has a stable `id` (e.g. "seg-0" from
// detection, or "seg-user-..." for manually added ones) used for override
// addressing elsewhere — this widget never re-numbers by array index.

const SEGMENT_TYPES = ['round', 'hex', 'square', 'prism']

const DIM_FIELDS = {
  round:  [
    { key: 'diameter', label: 'Diameter' },
    { key: 'innerDiameter', label: 'ID (optional)', optional: true },
  ],
  hex: [
    { key: 'acrossFlats', label: 'Across flats' },
    { key: 'filletRadius', label: 'Corner radius (optional)', optional: true },
    { key: 'innerDiameter', label: 'ID (optional)', optional: true },
  ],
  square: [{ key: 'width', label: 'Width' }],
  prism:  [{ key: 'width', label: 'Width' }],
}

let idCounter = 0
function nextUserSegId() { return `seg-user-${Date.now().toString(36)}-${idCounter++}` }

/**
 * Renders an editable (or read-only) segment table into `container`.
 * `segments` is the working array (mutated in place). Call this again
 * after any external change to the array (e.g. loading a different
 * part's detection result) to re-render from scratch.
 *
 * options:
 *   editable — if false, renders a compact read-only summary instead
 *   unit     — display unit suffix (e.g. 'in', 'mm') — purely cosmetic,
 *              the widget never converts units itself
 *   onChange — called with the (mutated) segments array after any edit
 */
export function renderSegmentEditor(container, segments, { editable = true, unit = 'in', onChange = () => {} } = {}) {
  const totalLength = segments.reduce((s, seg) => s + (seg.length || 0), 0)

  container.innerHTML = `
    <div class="segment-editor-rows">
      ${segments.length
        ? segments.map((seg, idx) => segmentRowHTML(seg, idx, editable, unit)).join('')
        : `<div class="segment-editor-empty">No segments yet.</div>`}
    </div>
    <div class="segment-editor-footer">
      ${editable ? `<button type="button" class="btn btn-sm" data-seg-add><i class="ti ti-plus" aria-hidden="true"></i> Add segment</button>` : '<span></span>'}
      <span class="segment-editor-total">Total length: ${totalLength.toFixed(3)} ${unit}</span>
    </div>`

  if (!editable) return

  container.querySelectorAll('[data-seg-field]').forEach(el => {
    const evtName = el.tagName === 'SELECT' ? 'change' : 'input'
    el.addEventListener(evtName, () => {
      const idx   = parseInt(el.dataset.segIdx, 10)
      const field = el.dataset.segField

      if (field === 'type') {
        // Changing type resets type-specific dimension fields rather than
        // carrying over stale, now-meaningless values (e.g. a leftover
        // acrossFlats on a segment just switched to 'round').
        segments[idx] = { id: segments[idx].id, type: el.value, length: segments[idx].length || 0 }
      } else {
        const val = parseFloat(el.value)
        segments[idx][field] = el.value === '' ? null : (Number.isFinite(val) ? val : segments[idx][field])
      }

      onChange(segments)
      renderSegmentEditor(container, segments, { editable, unit, onChange })
    })
  })

  container.querySelectorAll('[data-seg-remove]').forEach(btn =>
    btn.addEventListener('click', () => {
      segments.splice(parseInt(btn.dataset.segRemove, 10), 1)
      onChange(segments)
      renderSegmentEditor(container, segments, { editable, unit, onChange })
    })
  )

  const addBtn = container.querySelector('[data-seg-add]')
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      segments.push({ id: nextUserSegId(), type: 'round', length: 0, diameter: 0, userAdded: true })
      onChange(segments)
      renderSegmentEditor(container, segments, { editable, unit, onChange })
    })
  }
}

/**
 * Phase 6 (AXIAL_SHAFT_DETECTION_ROADMAP.md): renders a length-proportional
 * stacked-profile SVG preview of a segment list — a sanity-check visual,
 * not a dimensioned drawing. Purely reads `segments`; never mutates it,
 * so it's safe to re-call on every edit alongside renderSegmentEditor.
 */
export function renderSegmentPreview(container, segments, { unit = 'in' } = {}) {
  if (!segments.length) { container.innerHTML = ''; return }

  const totalLength = segments.reduce((s, seg) => s + (seg.length || 0), 0) || 1
  const W = 480, H = 90, padX = 10
  const usableW = W - padX * 2

  // Widest primary dimension across all segments, for vertical scaling
  const maxDim = Math.max(1e-6, ...segments.map(primaryDim))
  const maxBarH = 56

  let x = padX
  const bars = segments.map((seg, i) => {
    const w = Math.max(2, (seg.length || 0) / totalLength * usableW)
    const dim = primaryDim(seg)
    const h = Math.max(10, (dim / maxDim) * maxBarH)
    const y = (H - h) / 2
    const fill = seg.type === 'round' ? 'var(--color-accent-light)'
      : seg.type === 'hex' ? 'var(--color-warning-light)'
      : seg.type === 'unknown' ? 'var(--color-danger-light)'
      : 'var(--color-background-secondary)'
    const stroke = seg.type === 'unknown' ? 'var(--color-danger)' : 'var(--color-border-primary)'
    const rect = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`
    const label = w > 26
      ? `<text x="${x + w / 2}" y="${H / 2 + 4}" font-size="9" text-anchor="middle" fill="var(--color-text-secondary)">${seg.type}</text>`
      : ''
    x += w
    return rect + label
  }).join('')

  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <line x1="${padX}" y1="${H / 2}" x2="${W - padX}" y2="${H / 2}" stroke="var(--color-border-secondary)" stroke-dasharray="2,2"/>
    ${bars}
  </svg>
  <div style="font-size:11px;color:var(--color-text-tertiary);text-align:right;margin-top:2px">
    ${totalLength.toFixed(3)} ${unit} total
  </div>`
}

function primaryDim(seg) {
  if (seg.type === 'round')  return seg.diameter ?? 0
  if (seg.type === 'hex')    return seg.acrossFlats ?? 0
  if (seg.type === 'square' || seg.type === 'prism') return seg.width ?? 0
  return Math.max(seg.diameter ?? 0, seg.acrossFlats ?? 0, seg.width ?? 0, 0.1)
}

function segmentRowHTML(seg, idx, editable, unit) {
  const type = seg.type && SEGMENT_TYPES.includes(seg.type) ? seg.type : 'round'
  const dims = DIM_FIELDS[type] || []

  if (!editable) {
    const dimText = dims
      .filter(d => seg[d.key] != null)
      .map(d => `${d.label.replace(' (optional)', '')} ${seg[d.key]}${unit}`)
      .join(', ')
    return `<div class="segment-row segment-row--readonly">
      <span class="segment-row-type">${type}</span>
      <span class="segment-row-summary">${seg.length ?? '?'}${unit} long${dimText ? ' · ' + dimText : ''}</span>
    </div>`
  }

  return `<div class="segment-row" data-seg-idx="${idx}">
    <select class="segment-type-select" data-seg-field="type" data-seg-idx="${idx}">
      ${SEGMENT_TYPES.map(t => `<option value="${t}"${t === type ? ' selected' : ''}>${t[0].toUpperCase()}${t.slice(1)}</option>`).join('')}
    </select>
    <input type="number" step="any" min="0" class="segment-dim-input" data-seg-field="length" data-seg-idx="${idx}" value="${seg.length ?? ''}" placeholder="Length">
    ${dims.map(d => `<input type="number" step="any" min="0" class="segment-dim-input${d.optional ? ' segment-dim-optional' : ''}" data-seg-field="${d.key}" data-seg-idx="${idx}" value="${seg[d.key] ?? ''}" placeholder="${d.label}">`).join('')}
    <button type="button" class="btn-icon" data-seg-remove="${idx}" aria-label="Remove segment">
      <i class="ti ti-trash" style="font-size:13px" aria-hidden="true"></i>
    </button>
  </div>`
}
