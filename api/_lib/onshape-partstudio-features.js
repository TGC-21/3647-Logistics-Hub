// api/_lib/onshape-partstudio-features.js
//
// Thin wrapper around GET /partstudios/d/{did}/{wvm}/{wvmid}/e/{eid}/features,
// used by the fabrication-detection endpoint to inspect FeatureScript
// parameters on candidate generated parts (see
// SPACER_AUTO_DETECTION_ROADMAP.md). Kept in its own file rather than
// bloated into onshape.js since it's only used by detection, not the
// core BOM-import path.

import { onshapeGet } from './onshape.js'

/**
 * Fetches the full feature list for a Part Studio. `wvmType` must match
 * the branch type of the element being inspected ('w' | 'v' | 'm') — same
 * caveat as fetchBom: mirrored/released/frozen references are often 'v'.
 *
 * Response shape (BTFeatureListResponse): { features: [ { featureId,
 * featureType, name, parameters: [ { parameterId, expression?, value?,
 * enumName?, ... } ], ... } ] }
 */
export async function fetchPartStudioFeatures(documentId, wvmType, workspaceId, elementId) {
  const path = `/partstudios/d/${documentId}/${wvmType}/${workspaceId}/e/${elementId}/features` +
    `?rollbackBarIndex=-1&includeGeometryIds=true&noSketchGeometry=false`
  return onshapeGet(path)
}

/** Builds the same dedupe/grouping key the roadmap specifies — one fetch
 *  per unique source Part Studio no matter how many BOM rows reference it. */
export function partStudioCacheKey(documentId, wvmType, workspaceId, elementId, fullConfiguration) {
  return `${documentId}::${wvmType}::${workspaceId}::${elementId}::${fullConfiguration || ''}`
}
