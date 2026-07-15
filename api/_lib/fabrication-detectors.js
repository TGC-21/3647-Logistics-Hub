// api/_lib/fabrication-detectors.js
//
// Generic detector registry. The importer/detection endpoint only knows
// that a detector has a candidateFilter (cheap BOM-row prefilter), an
// isFromRootDocument check, and a `dataSource` tag telling it which
// Onshape fetch strategy to use — it never needs spacer- or
// axial-shaft-specific knowledge directly. See
// SPACER_AUTO_DETECTION_ROADMAP.md and
// AXIAL_SHAFT_DETECTION_ROADMAP.md for each detector's own design.
//
// dataSource values in use:
//   'features'    — spacer: reads FeatureScript parameters via
//                    partstudios/.../features (+ evalFeatureScript for
//                    geometry evalFeatureScript can't get from params alone)
//   'bodydetails' — axial-shaft: reads real B-rep geometry via
//                    partstudios/.../bodydetails, no FeatureScript
//                    parameter matching at all

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
