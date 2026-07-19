// api/_lib/detectors/spacer.js
//
// Detects spacers directly from B-rep geometry, the same way
// axial-shaft.js does — see AXIAL_SHAFT_DETECTION_ROADMAP.md and
// SPACER_AUTO_DETECTION_ROADMAP.md.
//
// v2 (this rewrite): a spacer is, geometrically, the simplest possible
// axial part — exactly ONE round or hex segment, with a concentric bore
// running through it (innerDiameter set). That's already exactly what
// reconstructAxialSegments() (axial-shaft.js) computes for us, so this
// detector is now a thin classifier on top of that shared reconstruction
// rather than its own fetch/parse pipeline:
//
//   1 segment, type round/hex, innerDiameter present  -> spacer, high/medium
//     confidence depending on axis quality (mirrors axial-shaft's rule).
//   anything else (0 or 2+ segments, no bore, unknown segment type, etc.)
//     -> needs_review, with a warning explaining what didn't match the
//     single-segment-with-bore shape.
//
// WHY THIS REPLACES THE OLD FeatureScript-SIGNATURE APPROACH
//
// The previous implementation worked entirely off the third-party Spacer
// FeatureScript's parameter list via GET .../features, plus a second
// POST .../featurescript eval call for every ROUND spacer (to resolve
// true ID) and every UP_TO_FACE spacer (to resolve true length). That
// meant:
//   - two Onshape round-trips per ambiguous spacer instead of one
//     bodydetails call shared with candidates in the same Part Studio,
//   - a hard dependency on the exact legacy parameter/feature-type
//     signature staying stable, with no fallback if it didn't match,
//   - UP_TO_FACE and ROUND spacers landing in 'needs_review' by
//     construction until eval succeeded -- eval failures (a bad
//     deterministicId, a response shape assumption that didn't hold, a
//     Part Studio with the origin edge since deleted/renamed) had no
//     recovery path and just sat unreviewed.
//
// Geometry doesn't care how the spacer was authored (this FeatureScript,
// a different one, or modeled by hand) and doesn't require a second eval
// round-trip -- the OD/ID/length are just the outer segment's
// diameter/innerDiameter/length, already resolved by the same sweep-line
// reconstruction axial-shaft.js uses. Every spacer candidate now costs
// exactly one bodydetails fetch per source Part Studio (shared across
// every candidate part in that studio, same as axial-shaft), with no
// eval step and no signature-matching brittleness.

import { reconstructAxialSegments } from './axial-shaft.js'

/** Cheap local prefilter over an already-parsed BOM row -- avoids firing
 *  any Onshape request for rows that obviously aren't spacer candidates.
 *  Unchanged from v1: name/part-number keyword match + COTS exclusion. */
export function candidateFilter(row) {
  if (!row.partName) return false
  const name = row.partName.toLowerCase()
  const partNumber = (row.partNumber || '').toLowerCase()
  if (!name.includes('spacer') && !partNumber.includes('spacer')) return false

  // COTS/standard-content parts are never something we auto-detect for
  // fabrication, regardless of name.
  if (row.raw?.isStandardContent) return false

  return true
}

/** Per the roadmap: a candidate whose source document differs from the
 *  imported assembly's own root document is treated as an
 *  outside/vendor spacer and excluded from auto-detection entirely. */
export function isFromRootDocument(row, rootDocumentId) {
  return !!row.raw?.documentId && row.raw.documentId === rootDocumentId
}

/**
 * Classifies a single body (from a bodydetails response) as a spacer or
 * not, using the shared axial-segment reconstruction. This is the whole
 * detection algorithm now -- no FeatureScript involvement at all.
 */
export function classifySpacerGeometry(body, opts = {}) {
  const reconstruction = reconstructAxialSegments(body, opts)
  const segments = reconstruction.dimensions.segments
  const warnings = [...reconstruction.warnings]

  if (reconstruction.axis?.confidence === 'pca-fallback') {
    warnings.push('Could not confirm a dominant cylindrical axis for this part -- confirm dimensions manually.')
  }

  if (segments.length !== 1) {
    warnings.push(`A spacer should reconstruct as a single round/hex segment with a bore -- found ${segments.length} segment(s).`)
    return { status: 'needs_review', confidence: 'low', spacerType: null, dimensions: null, warnings }
  }

  const seg = segments[0]

  if (seg.type !== 'round' && seg.type !== 'hex') {
    warnings.push(`Segment classified as "${seg.type}", not round or hex -- doesn't match a spacer's profile.`)
    return { status: 'needs_review', confidence: 'low', spacerType: null, dimensions: null, warnings }
  }

  if (seg.innerDiameter == null) {
    warnings.push('No concentric bore was detected through this part -- spacers are expected to be hollow.')
    return { status: 'needs_review', confidence: 'low', spacerType: seg.type === 'round' ? 'ROUND' : 'HEX', dimensions: null, warnings }
  }

  const spacerType = seg.type === 'round' ? 'ROUND' : 'HEX'
  const dimensions = {
    od:          { value: seg.type === 'round' ? seg.diameter : seg.acrossFlats, unit: 'in' },
    id:          spacerType === 'ROUND' ? { value: seg.innerDiameter, unit: 'in' } : null,
    acrossFlats: spacerType === 'HEX'   ? { value: seg.acrossFlats,   unit: 'in' } : null,
    length:      { value: seg.length, unit: 'in' },
  }

  // Confidence mirrors axial-shaft's rule: only "high" when the
  // reconstruction itself found no ambiguity and the axis came from a
  // real cylinder majority rather than the PCA fallback.
  const geometryClean = reconstruction.status === 'detected'
  const confidence = geometryClean ? reconstruction.confidence : 'medium'

  return {
    status: geometryClean ? 'detected' : 'needs_review',
    confidence,
    spacerType,
    dimensions,
    warnings,
  }
}

/**
 * Generic classifyGeometry entrypoint -- same shape as axial-shaft.js's
 * export of the same name, so the detection endpoint's
 * runBodyDetailsBasedDetection can call either detector identically.
 * `extra` fields are spread directly onto persisted fabrication_metadata.
 */
export function classifyGeometry(body, opts) {
  const result = classifySpacerGeometry(body, opts)
  return {
    status: result.status,
    confidence: result.confidence,
    warnings: result.warnings,
    extra: {
      spacerType: result.spacerType,
      dimensions: result.dimensions,
      fabricationDraft: result.status === 'detected'
        ? { method: null, quantityRequested: null, requiresConfirmation: true }
        : null,
    },
  }
}

export const spacerDetector = {
  kind: 'spacer',
  generatorId: null,        // geometry-driven -- no FeatureScript marker relied on
  dataSource: 'bodydetails', // tells the detection endpoint to use the bodydetails path
  candidateFilter,
  isFromRootDocument,
  classifyGeometry,
}
