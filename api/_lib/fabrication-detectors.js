// api/_lib/fabrication-detectors.js
//
// Generic detector registry. The importer/detection endpoint only knows
// that a detector has a candidateFilter (cheap BOM-row prefilter), an
// isFromRootDocument check, and a classifyGeometry(body, opts) function
// that turns an already-fetched bodydetails body into a
// { status, confidence, warnings, extra } result — it never needs
// spacer-, axial-shaft-, or plate-specific knowledge directly. See
// SPACER_AUTO_DETECTION_ROADMAP.md, AXIAL_SHAFT_DETECTION_ROADMAP.md,
// and PLATE_DETECTION_ROADMAP.md for each detector's own design.
//
// All three detectors currently read real B-rep geometry via
// partstudios/.../bodydetails — no FeatureScript parameter matching or
// evalFeatureScript involvement for classification itself (plate.js's
// optional sheet-metal check is the one exception — see
// postGeometryCheck below).
//
// Order matters here, per PLATE_DETECTION_ROADMAP.md's resolved claim
// priority: spacer and axial-shaft both get first crack at any row that
// could ambiguously match more than one detector's name filter (e.g. a
// hex-profile spacer, or a small thin part that could geometrically read
// as either a spacer or a plate) — see detectAndPersist's
// `claimedByEarlierDetector` set in onshape-detect-fabrication.js. Plate
// is registered last and only runs against rows no earlier detector
// claimed.

import { spacerDetector } from './detectors/spacer.js'
import { axialShaftDetector } from './detectors/axial-shaft.js'
import { plateDetector } from './detectors/plate.js'

export const DETECTORS = [spacerDetector, axialShaftDetector, plateDetector]

/** Rows this detector's cheap prefilter thinks are worth an Onshape
 *  geometry/feature fetch, restricted to rows sourced from the assembly's
 *  own root document (vendor/COTS rows are never auto-detected). */
export function candidateRowsForDetector(detector, rows, rootDocumentId) {
  return rows.filter(row =>
    detector.candidateFilter(row) && detector.isFromRootDocument(row, rootDocumentId)
  )
}
