// api/_lib/onshape-bodydetails.js
//
// Phase 1 of AXIAL_SHAFT_DETECTION_ROADMAP.md. Thin wrapper around
// GET /partstudios/d/{did}/{wvm}/{wvmid}/e/{eid}/bodydetails, used by the
// (future) axial-shaft detector to inspect real B-rep geometry — faces,
// edges, vertices, analytic surface descriptions (PLANE/CYLINDER/...) —
// rather than FeatureScript parameters. Kept in its own file rather than
// bloated into onshape.js since it's only used by detection, not the core
// BOM-import path (same convention as onshape-partstudio-features.js).
//
// Deliberately scoped to fetching + caching only. Axis reconstruction and
// segment classification are Phase 2 (a pure function operating on the
// response this file returns) — no geometry logic belongs here.

import { onshapeGet } from './onshape.js'

/**
 * Fetches body details (faces/edges/vertices with analytic surface
 * descriptions) for one or more parts in a Part Studio. `partIds` narrows
 * the response to just the candidate part(s) this call cares about —
 * important for request size, since a full Part Studio can contain many
 * parts and each body's face/edge/vertex list is itself non-trivial.
 *
 * `wvmType` must match the branch type of the element being inspected
 * ('w' | 'v' | 'm') — same caveat as fetchBom/fetchPartStudioFeatures:
 * mirrored/released/frozen references are often 'v'.
 *
 * Response shape (BTExportModelBodiesResponse): { bodies: [ { id,
 * type: 'SOLID' | ..., properties: { name, material, ... },
 * vertices: [ { id, point: {x,y,z} } ],
 * edges: [ ... ],
 * faces: [ { box: { minCorner, maxCorner }, area, surface: {
 *   type: 'PLANE', origin, normal
 * } | { type: 'CYLINDER', origin, axis, radius } | ... } ] } ] }
 *
 * Units on all point/vector/radius values are meters (Onshape's internal
 * unit), same as everywhere else geometry crosses this API — convert at
 * the point of measurement/display, not here.
 */
export async function fetchBodyDetails(documentId, wvmType, workspaceId, elementId, partIds) {
  const base = `/partstudios/d/${documentId}/${wvmType}/${workspaceId}/e/${elementId}/bodydetails`
  const query = (partIds || []).map(id => `partIds=${encodeURIComponent(id)}`).join('&')
  const path = query ? `${base}?${query}` : base
  return onshapeGet(path)
}

/** Builds the same dedupe/grouping key convention used elsewhere
 *  (partStudioCacheKey in onshape-partstudio-features.js) — one fetch per
 *  unique source Part Studio no matter how many BOM rows reference it.
 *  partIds is intentionally NOT part of the key: grouping happens one
 *  level up (by Part Studio), and multiple candidate partIds sharing a
 *  Part Studio should be requested together in a single bodydetails call
 *  rather than one call per part. */
export function bodyDetailsCacheKey(documentId, wvmType, workspaceId, elementId, fullConfiguration) {
  return `${documentId}::${wvmType}::${workspaceId}::${elementId}::${fullConfiguration || ''}`
}

/**
 * Given the response's `bodies` array, returns the single body matching a
 * given partId — bodydetails responses key bodies by `id`, which lines up
 * with the BOM row's onshape_reference.partId (same partId used to scope
 * the `partIds` request param). Returns null if not found (e.g. the part
 * was deleted/renamed between BOM import and detection running).
 */
export function findBodyByPartId(bodyDetailsResponse, partId) {
  const bodies = bodyDetailsResponse?.bodies || []
  return bodies.find(b => b.id === partId) || null
}
