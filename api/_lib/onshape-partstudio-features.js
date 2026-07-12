// api/_lib/onshape-partstudio-features.js
//
// Thin wrapper around GET /partstudios/d/{did}/{wvm}/{wvmid}/e/{eid}/features,
// used by the fabrication-detection endpoint to inspect FeatureScript
// parameters on candidate generated parts (see
// SPACER_AUTO_DETECTION_ROADMAP.md). Kept in its own file rather than
// bloated into onshape.js since it's only used by detection, not the
// core BOM-import path.

import { onshapeGet, onshapePost } from './onshape.js'

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

// ── FeatureScript eval ─────────────────────────────────────────
//
// The plain features-list endpoint doesn't resolve a ROUND spacer's true
// ID (needs the picked origin edge's actual radius, evCurveDefinition) or
// an UP_TO_FACE spacer's true length (needs evDistance against the picked
// end face) — those are only knowable by asking Onshape to evaluate real
// geometry. We do NOT fork/modify the third-party Spacer FeatureScript;
// instead we submit a small script of our own that re-derives the same
// values the original script computes internally, fed the origin/endFace
// queries lifted directly out of the ALREADY-FETCHED feature parameters
// (see spacer.js's buildEvalRequest).
//
// POST /partstudios/d/{did}/{wvm}/{wvmid}/e/{eid}/featurescript
// Body: { script, queries } where `queries` is a MAP of key -> array of
// short deterministic-ID tokens (each picked entity's
// `.queries[0].deterministicIds[0]`, e.g. "JFB") — confirmed via live
// testing. The `queryString` field (the serialized `query=qCompressed(...)`
// blob) looks like the obvious candidate but does NOT work here: it
// consistently resolved to zero matches / CANNOT_RESOLVE_ENTITIES even
// against provably-present geometry, while the bare deterministicIds
// token resolved correctly. `queries` deserializes server-side as
// LinkedHashMap<String, List<String>>, so each value must be an array of
// plain strings, not nested objects.
export async function evalFeatureScript(documentId, wvmType, workspaceId, elementId, script, queries) {
  const path = `/partstudios/d/${documentId}/${wvmType}/${workspaceId}/e/${elementId}/featurescript`
  return onshapePost(path, { script, queries })
}

/**
 * The eval endpoint's response is a deeply-nested BTFSValue tree (map ->
 * entries -> key/value pairs, each value itself a tagged node) whose exact
 * shape isn't something we can verify without a live test call. Rather
 * than hard-code a specific nesting depth and risk silently returning
 * nothing the first time Onshape's serialization differs from what we
 * guessed, this walks the ENTIRE response recursively looking for a
 * { key: <name>, value: <number> } pair by name — works regardless of how
 * many wrapper layers (`message`, `value`, `typeTag`, etc.) surround it.
 */
export function extractEvalNumber(evalResponse, name) {
  let found = null

  function looksLikeKeyNode(node) {
    // BTFSValue map entries commonly serialize as either
    // { key: { ...value: name }, value: { ...value: number } } or a
    // flatter { key: name, value: number } — handle both.
    const key = typeof node?.key === 'string' ? node.key : node?.key?.value ?? node?.key?.message?.value
    return key === name
  }

  function numberFrom(node) {
    if (typeof node === 'number') return node
    if (typeof node?.value === 'number') return node.value
    if (typeof node?.value?.value === 'number') return node.value.value
    if (typeof node?.message?.value === 'number') return node.message.value
    return null
  }

  function walk(node) {
    if (found !== null || node === null || typeof node !== 'object') return

    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }

    if (looksLikeKeyNode(node)) {
      const n = numberFrom(node.value ?? node)
      if (n !== null) { found = n; return }
    }

    for (const v of Object.values(node)) walk(v)
  }

  walk(evalResponse)
  return found
}
