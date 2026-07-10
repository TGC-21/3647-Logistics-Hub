// api/_lib/fabrication-detectors.js
//
// Generic detector registry. The importer/detection endpoint only knows
// that a detector has a candidateFilter (cheap BOM-row prefilter) and an
// inspectPartStudioFeatures (fed one already-fetched feature list, returns
// matches) — it never needs spacer-specific knowledge directly.

import { spacerDetector } from './detectors/spacer.js'

export const DETECTORS = [spacerDetector]

/** Rows this detector's cheap prefilter thinks are worth an Onshape
 *  features fetch, restricted to rows sourced from the assembly's own
 *  root document (vendor/COTS rows are never auto-detected). */
export function candidateRowsForDetector(detector, rows, rootDocumentId) {
  return rows.filter(row =>
    detector.candidateFilter(row) && detector.isFromRootDocument(row, rootDocumentId)
  )
}
