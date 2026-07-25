# Wiring plate.js into onshape-detect-fabrication.js

Two localized changes to the existing endpoint — everything else
(fetchWholeTreeParts, writeMetadata, the group-by-Part-Studio fetch loop)
is unchanged.

## 1. Generalize the claim set

Today `detectAndPersist` only tracks `claimedBySpacer`, checked once by
axial-shaft. With three detectors and a resolved "spacer + axial-shaft
claim first, plate claims last" ordering, this becomes a running set any
later detector in `DETECTORS` consults:

```js
const claimedByEarlierDetector = new Set()

for (const detector of DETECTORS) {
  let candidates = candidateRowsForDetector(detector, rows, rootDocumentId)
  candidates = candidates.filter(r => !claimedByEarlierDetector.has(r.id))
  // ...existing candidateCount / ignoredRows logic unchanged...

  const stats = await runBodyDetailsBasedDetection(supabase, detector, candidates, {
    onRowClassified: (row, result) => {
      if (result.status === 'detected') claimedByEarlierDetector.add(row.id)
    },
  })
  // ...
}
```

This preserves today's spacer→axial-shaft behavior exactly (spacer still
runs first and still claims) while extending the same mechanism to
plate without a third hand-written special case — `DETECTORS` order
(`[spacerDetector, axialShaftDetector, plateDetector]`) is now the only
place claim priority is expressed.

## 2. Call plate's `postGeometryCheck` after a 'detected' classification

Inside `runBodyDetailsBasedDetection`, right after `classifyGeometry`
returns and before `writeMetadata` is called, add an optional
post-check hook for detectors that declare one:

```js
let result
try {
  result = detector.classifyGeometry(body, { unitScale: UNIT_SCALE_METERS_TO_INCHES })
} catch (e) { /* ...unchanged existing error handling... */ }

// New: optional async post-geometry check (currently only plate.js's
// sheet-metal exclusion). Only runs for rows that already classified as
// 'detected' — no reason to spend a second API call on a row headed to
// needs_review anyway.
if (result.status === 'detected' && typeof detector.postGeometryCheck === 'function') {
  const notExcluded = await detector.postGeometryCheck(
    group.documentId, group.wvmType, group.wvmId, group.elementId
  )
  if (notExcluded === false) {
    result = {
      ...result,
      status: 'needs_review',
      warnings: [...result.warnings, 'Geometry matched a plate, but this Part Studio appears to use a sheet-metal feature — please confirm manually.'],
    }
  } else if (notExcluded === null) {
    // Check failed/inconclusive — don't silently accept, don't silently
    // reject either; downgrade to review same as an explicit sheet-metal
    // match, but with a different warning so the two cases are
    // distinguishable in the UI/logs.
    result = {
      ...result,
      status: 'needs_review',
      warnings: [...result.warnings, 'Could not confirm this Part Studio isn\'t sheet metal — please confirm manually.'],
    }
  }
}

const meta = { /* ...unchanged... */ }
await writeMetadata(supabase, row.id, meta)
onRowClassified(row, result)

if (result.status === 'detected') detected++
else needsReview++
```

Note this call happens **once per candidate row**, not once per Part
Studio group — `postGeometryCheck` takes the row's own resolved
document/workspace/element ids (same ones already used for the
bodydetails fetch), so a Part Studio with multiple plate candidates will
currently issue one features-fetch per candidate rather than being
grouped/cached the way bodydetails itself is. Given `fetchPartStudioFeatures`
has no cache key infrastructure the way `bodyDetailsCacheKey` does for
bodydetails, this is worth a small in-request `Map` keyed by
`documentId::wvmType::wvmId::elementId` (fetch once, reuse for every
candidate row from that Part Studio) if a document is expected to
contain many plates — not required for correctness, just for request
economy, matching the spirit of the existing bodydetails grouping.

## Not yet wired: Plate category / component creation

`designer.js` currently defines `SPACER_CATEGORY_NAME` /
`SPACER_REQUIRED_KEYS_CONFIG` and `AXIAL_SHAFT_CATEGORY_NAME` /
`AXIAL_SHAFT_REQUIRED_KEYS_CONFIG`, plus `ensureSpacerCategory()` /
`ensureAxialShaftCategory()`, and a `fabDetectKind`-branched confirm
overlay. Phase 3 of PLATE_DETECTION_ROADMAP.md still needs:

```js
const PLATE_CATEGORY_NAME = 'Plate'
const PLATE_REQUIRED_KEYS_CONFIG = [
  { key: 'Material',  type: 'enum', options: ['Aluminum', 'Polycarbonate', 'Acrylic', 'Steel', 'Other'] },
  { key: 'Thickness', type: 'quantity', defaultUnit: 'in' },
  { key: 'Length',    type: 'quantity', defaultUnit: 'in' },
  { key: 'Width',     type: 'quantity', defaultUnit: 'in' },
]
```

plus `ensurePlateCategory()` mirroring the other two, a third branch in
`openFabDetectConfirmModal`/`confirmFabDetection` (`fabDetectKind ===
'plate'`) showing plain thickness/length/width/material fields (no
segment editor, no candidate picker — the simplest of the three confirm
flows), and adding `'plate'` to `fabDetectionBadgeHTML`'s noun map. This
is intentionally left out of this pass since it's pure UI wiring that
follows the existing spacer/axial-shaft pattern exactly, with no new
design decisions.
