// api/_lib/fabrication-detectors.js
//
// Generic detector registry. The importer/detection endpoint only knows
// that a detector has a candidateFilter (cheap BOM-row prefilter), an
// isFromRootDocument check, and a classifyGeometry(body, opts) function
// that turns an already-fetched bodydetails body into a
// { status, confidence, warnings, extra } result — it never needs
// spacer- or axial-shaft-specific knowledge directly. See
// SPACER_AUTO_DETECTION_ROADMAP.md and AXIAL_SHAFT_DETECTION_ROADMAP.md
// for each detector's own design.
//
// Both detectors currently read real B-rep geometry via
// partstudios/.../bodydetails — no FeatureScript parameter matching or
// evalFeatureScript involvement for either one. Order matters here:
// spacer is listed first because the detection endpoint gives it first
// crack at any row that could ambiguously match both detectors' name
// filters (e.g. a hex-profile spacer) — see detectAndPersist's
// `claimedBySpacer` set in onshape-detect-fabrication.js.

import { spacerDetector } from './detectors/spacer.js'
import { axialShaftDetector } from './detectors/axial-shaft.js'

export const DETECTORS = [spacerDetector, axialShaftDetector]

/** Rows this detector's cheap prefilter thinks are worth an Onshape
 *  geometry/feature fetch, restricted to rows sourced from the assembly's
 *  own root document (vendor/COTS rows are never auto-detected). */
export function candidateRowsForDetector(detector, rows, rootDocumentId) {
  return rows.filter(row =>
    detector.candidateFilter(row) && detector.isFromRootDocument(row, rootDocumentId)
  )
}
