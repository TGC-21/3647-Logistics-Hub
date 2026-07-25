# Fixing plate detection's confirm overlay

## Root cause

`openFabDetectConfirmModal` in `designer.js` only branches on
`fabDetectKind === 'axial-shaft'` vs. everything else. Since `'plate'`
falls into the `else`, it runs `openSpacerConfirmFields()` and shows the
spacer markup (OD / ID-or-across-flats / Length / spacer-type /
candidate picker) — there's no plate-specific branch anywhere yet. This
patch adds one.

## 1. `index.html` — new plate fields block

Add this inside `#fab-detect-confirm-overlay`'s `.modal-body`, as a
sibling of `#fab-detect-spacer-fields` and `#fab-detect-segments-fields`
(both of which already exist there):

```html
<!-- Plate-kind fields (thickness + material only, per resolved scope) -->
<div id="fab-detect-plate-fields" style="display:none;flex-direction:column;gap:13px">
  <div class="field-row">
    <div class="field">
      <label>Thickness (in) <span class="required-star">*</span></label>
      <input type="number" step="any" id="fab-detect-plate-field-thickness" placeholder="e.g. 0.25">
    </div>
    <div class="field">
      <label>Confidence</label>
      <div id="fab-detect-plate-confidence" style="padding:7px 0"></div>
    </div>
  </div>

  <div class="field">
    <label>Material <span class="required-star">*</span></label>
    <select id="fab-detect-plate-field-material">
      <option value="">— Select —</option>
      <option value="Aluminum">Aluminum</option>
      <option value="Polycarbonate">Polycarbonate</option>
      <option value="Acrylic">Acrylic</option>
      <option value="Steel">Steel</option>
      <option value="Other">Other</option>
    </select>
  </div>
</div>
```

No candidate picker (plate detection doesn't produce ambiguous
candidateMatches the way spacer's legacy multi-feature case did) and no
length/width fields — resolved scope is thickness + material only for
the confirm step, even though `dimensions.footprint` is captured in
`fabrication_metadata` for reference/future use.

## 2. `designer.js` — category constants (near `SPACER_REQUIRED_KEYS_CONFIG`)

```js
const PLATE_CATEGORY_NAME = 'Plate'
const PLATE_REQUIRED_KEYS_CONFIG = [
  { key: 'Material',  type: 'enum', options: ['Aluminum', 'Polycarbonate', 'Acrylic', 'Steel', 'Other'] },
  { key: 'Thickness', type: 'quantity', defaultUnit: 'in' },
]

async function ensurePlateCategory() {
  const cats = await fetchCategories()
  let cat = cats.find(c => c.name === PLATE_CATEGORY_NAME)
  if (cat) return cat
  cat = await upsertCategory({ id: genId(), name: PLATE_CATEGORY_NAME, requiredKeysConfig: PLATE_REQUIRED_KEYS_CONFIG })
  return cat
}
```

Resolved scope deliberately drops Length/Width from the *component*
identity (matches the earlier decision that hole/footprint geometry
shouldn't factor into what makes two plates "the same" component) even
though the detector still measures a footprint for the confirm-modal
subtitle/context.

## 3. `designer.js` — dispatch in `openFabDetectConfirmModal`

Currently:

```js
if (fabDetectKind === 'axial-shaft') {
  spacerFields.style.display   = 'none'
  segmentsFields.style.display = 'flex'
  openAxialShaftConfirmFields(part, meta)
} else {
  spacerFields.style.display   = 'flex'
  segmentsFields.style.display = 'none'
  openSpacerConfirmFields(part, meta)
}
```

Replace with a real three-way dispatch (also grab the new plate fields
element near the top of the function, alongside `spacerFields`/
`segmentsFields`):

```js
const plateFields = document.getElementById('fab-detect-plate-fields')
if (!spacerFields || !segmentsFields || !plateFields) {
  console.error('[fab-detect] Missing confirm-overlay field block — hard-refresh / rebuild likely needed.')
  return
}

spacerFields.style.display   = 'none'
segmentsFields.style.display = 'none'
plateFields.style.display    = 'none'

if (fabDetectKind === 'axial-shaft') {
  segmentsFields.style.display = 'flex'
  openAxialShaftConfirmFields(part, meta)
} else if (fabDetectKind === 'plate') {
  plateFields.style.display = 'flex'
  openPlateConfirmFields(part, meta)
} else {
  spacerFields.style.display = 'flex'
  openSpacerConfirmFields(part, meta)
}
```

Also update the ignore-button label block right below it to add a
plate-appropriate label:

```js
const ignoreBtn = document.getElementById('btn-fab-detect-ignore')
if (ignoreBtn) {
  ignoreBtn.innerHTML = fabDetectKind === 'axial-shaft'
    ? '<i class="ti ti-eye-off" aria-hidden="true"></i> Not a shaft'
    : fabDetectKind === 'plate'
      ? '<i class="ti ti-eye-off" aria-hidden="true"></i> Not a plate'
      : '<i class="ti ti-eye-off" aria-hidden="true"></i> Not a spacer'
}
```

## 4. `designer.js` — new `openPlateConfirmFields`

Add near `openSpacerConfirmFields`/`openAxialShaftConfirmFields`:

```js
/** Seeds the plate confirm fields from detected metadata — thickness
 *  and confidence only, per resolved scope. Material has no detected
 *  value (not derivable from geometry alone in v1), so it's always left
 *  for the user to pick. */
function openPlateConfirmFields(part, meta) {
  const dims = meta.dimensions || {}
  document.getElementById('fab-detect-plate-field-thickness').value = dims.thickness?.value ?? ''
  document.getElementById('fab-detect-plate-field-material').value = ''
  document.getElementById('fab-detect-plate-confidence').innerHTML =
    `<span class="part-badge part-badge--${meta.confidence === 'high' ? 'complete' : 'partial'}">${meta.confidence || 'unknown'}</span>`

  const gap = Math.max(1, part.quantityNeeded - (part.quantityCollected || 0))
  const qtyEl = document.getElementById('fab-detect-field-qty')
  if (qtyEl) { qtyEl.value = gap; qtyEl.max = gap }
}
```

Note this reuses the shared `#fab-detect-field-qty` input the spacer and
axial-shaft flows already populate — no new quantity field needed.

## 5. `designer.js` — dispatch in `confirmFabDetection`

Currently branches only on `fabDetectKind === 'axial-shaft'` before
falling through to the spacer confirm logic. Add a plate branch at the
top, mirroring the existing axial-shaft early-return:

```js
async function confirmFabDetection() {
  const part = currentFabDetectPart()
  if (!part) return

  if (fabDetectKind === 'axial-shaft') {
    await confirmAxialShaftDetection(part)
    return
  }

  if (fabDetectKind === 'plate') {
    await confirmPlateDetection(part)
    return
  }

  // ...existing spacer confirm logic, unchanged...
}
```

## 6. `designer.js` — new `confirmPlateDetection`

Add alongside `confirmAxialShaftDetection`:

```js
async function confirmPlateDetection(part) {
  const thickness = parseFloat(document.getElementById('fab-detect-plate-field-thickness').value)
  const material  = document.getElementById('fab-detect-plate-field-material').value
  const qty       = Math.max(1, parseInt(document.getElementById('fab-detect-field-qty').value, 10) || 1)

  if (!Number.isFinite(thickness) || thickness <= 0) { toastFn('Thickness is required'); return }
  if (!material) { toastFn('Material is required'); return }

  const meta = part.fabricationMetadata || {}
  const detectedThickness = meta.dimensions?.thickness?.value
  const overrides = {}
  if (detectedThickness !== thickness) {
    overrides.thickness = { value: thickness, unit: 'in', reason: 'User confirmation edit' }
  }

  const btn = document.getElementById('btn-confirm-fab-detect')
  btn.disabled = true; btn.textContent = 'Confirming…'

  try {
    const plateCat = await ensurePlateCategory()
    const attrs = {
      'Material':  material,
      'Thickness': String(thickness),
    }
    const component = await findOrCreateComponent({
      categoryId: plateCat.id,
      fields:     plateCat.requiredKeysConfig,
      attrs,
      fallback:   { name: part.partName, description: `Auto-detected ${material.toLowerCase()} plate`, image: null },
      genId,
    })

    const updatedMeta = {
      ...meta,
      status: 'queued',
      overrides: Object.keys(overrides).length ? overrides : (meta.overrides || null),
    }

    const savedPart = await upsertAssemblyPart({ ...part, componentId: component.id, fabricationMetadata: updatedMeta })

    const job = await createFabricationJob({
      assemblyPartId:    part.id,
      quantityRequested: qty,
      batchId:           null,
      genId,
    })
    registerNewJob(job)

    if (fabDetectIsChild) {
      const idx = currentChildParts.findIndex(p => p.id === part.id)
      if (idx > -1) currentChildParts[idx] = savedPart
      currentChildPartJobs[part.id] = job
      renderChildDetail()
    } else {
      const idx = currentParts.findIndex(p => p.id === part.id)
      if (idx > -1) currentParts[idx] = savedPart
      currentPartJobs[part.id] = job
      renderAssemblyDetail()
    }

    closeFabDetectConfirmModal()
    toastFn(`Confirmed "${part.partName}" — sent ${qty} to Fabricate`)
  } catch (e) {
    console.error(e)
    toastFn(e.message?.includes('duplicate') ? 'This part already has an active fabrication job.' : 'Error confirming plate')
  } finally {
    btn.disabled = false
    btn.innerHTML = '<i class="ti ti-check" aria-hidden="true"></i> Confirm &amp; send to Fabricate'
  }
}
```

Straight copy of `confirmFabDetection`'s spacer path's shape, minus the
candidate-picker/spacer-type logic that doesn't apply here.

## 7. `designer.js` — badge noun map

`fabDetectionBadgeHTML` already generalizes across `kind` via:

```js
const noun = meta.kind === 'axial-shaft' ? 'shaft' : 'spacer'
```

This needs a third branch:

```js
const noun = meta.kind === 'axial-shaft' ? 'shaft' : meta.kind === 'plate' ? 'plate' : 'spacer'
```

Otherwise a queued/ignored plate row's badge reads "Not a spacer" /
"Spacer detected" instead of the correct noun.

## Why this was worth doing as real patches, not just a note

The previous pass registered `plateDetector` and fixed the
classification-overwrite bug, but never actually gave `'plate'` its own
UI path — so every detected plate was structurally correct in the
database (`kind: 'plate'`, `dimensions: { thickness, footprint }`) but
the confirm modal had no idea how to render that shape and fell back to
spacer's fields, which expect `dimensions.od`/`dimensions.id`/
`dimensions.length` that don't exist on a plate's metadata at all —
hence the fields showing up blank/wrong rather than erroring outright.
