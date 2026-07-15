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
