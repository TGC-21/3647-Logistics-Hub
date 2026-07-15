// api/_lib/detectors/axial-shaft.js
//
// Phase 2 of AXIAL_SHAFT_DETECTION_ROADMAP.md: reconstructs an ordered
// list of axial segments (round / hex / square) from a single body's
// bodydetails response — the "candidateFilter" prefilter and Onshape
// fetching live elsewhere (Phase 1: onshape-bodydetails.js; Phase 3: the
// detector registry wiring). This file is a pure function over data
// already in hand, same separation spacer.js keeps between
// inspectPartStudioFeatures (pure) and the detection endpoint (I/O).
//
// Scope, per AXIAL_SHAFT_DETECTION_ROADMAP.md:
//   • No taper/cone detection — real lathe parts in this project never
//     model conical transitions. Any band that doesn't resolve to a
//     clean round/hex/square classification is reported as 'unknown'
//     rather than guessed at.
//   • Corner-fillet cylinders (small radius, bridging two PLANEs or a
//     PLANE and the main round cylinder) are folded into the adjacent
//     segment as a `filletRadius` callout, never reported as their own
//     segment.
//   • All incoming coordinates/radii are in meters (Onshape's internal
//     unit) — this module works entirely in meters; unit conversion for
//     display is the caller's job.

// ── Vector helpers (plain {x,y,z} objects, as bodydetails returns) ────

function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z } }
function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z }
function cross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
}
function norm(a) { return Math.sqrt(dot(a, a)) }
function scale(a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s } }
function normalize(a) {
  const n = norm(a)
  return n > 1e-12 ? scale(a, 1 / n) : { x: 0, y: 0, z: 0 }
}

/** True if two (already-normalized) directions are parallel, ignoring sign. */
function isParallel(a, b, angleTol = 1e-4) {
  return norm(cross(a, b)) < angleTol
}

// ── Tolerances ──────────────────────────────────────────────────────
// "Just enough to avoid noise" per the roadmap, not machinist tolerance.
// Expressed as functions of the relevant magnitude so they scale sanely
// across a tiny dowel pin and a long shaft alike.

const LENGTH_TOL_ABS_M = 0.0000127        // ~0.0005 in, in meters
function lengthsMatch(a, b, tolFn = LENGTH_TOL_ABS_M) {
  const tol = typeof tolFn === 'function' ? tolFn(Math.max(Math.abs(a), Math.abs(b))) : tolFn
  return Math.abs(a - b) <= tol
}
function relTol(mag) { return Math.max(LENGTH_TOL_ABS_M, mag * 0.001) }

// ── Step 1: determine the dominant axis ────────────────────────────
//
// Groups CYLINDER faces by (sign-agnostic) axis direction. The group with
// the greatest total face count wins — for hex stock the fillet/round
// cylinders vastly outnumber any incidental cylindrical face on a
// non-dominant axis, so a simple count is a robust enough proxy without
// needing face-area weighting. Falls back to PCA over vertex positions
// if no cylinder faces exist at all (shouldn't happen for hex stock, but
// keeps the function from crashing on unexpected input).

function resolveDominantAxis(body) {
  const cylinderFaces = (body.faces || []).filter(f => f.surface?.type === 'CYLINDER')

  if (!cylinderFaces.length) {
    return { direction: pcaAxis(body), origin: centroidOfVertices(body), confidence: 'pca-fallback' }
  }

  const clusters = []   // [{ direction, origin, faces: [] }]
  for (const face of cylinderFaces) {
    const dir = normalize(face.surface.axis)
    let cluster = clusters.find(c => isParallel(c.direction, dir))
    if (!cluster) {
      cluster = { direction: dir, origin: face.surface.origin, faces: [] }
      clusters.push(cluster)
    }
    cluster.faces.push(face)
  }

  clusters.sort((a, b) => b.faces.length - a.faces.length)
  const winner = clusters[0]

  return {
    direction: winner.direction,
    origin: winner.origin,
    confidence: clusters.length === 1 ? 'cylinder-majority' : 'cylinder-plurality',
  }
}

function centroidOfVertices(body) {
  const verts = body.vertices || []
  if (!verts.length) return { x: 0, y: 0, z: 0 }
  const sum = verts.reduce((acc, v) => ({
    x: acc.x + v.point.x, y: acc.y + v.point.y, z: acc.z + v.point.z,
  }), { x: 0, y: 0, z: 0 })
  return scale(sum, 1 / verts.length)
}

/** Crude PCA fallback: picks the axis of greatest vertex spread. Only
 *  used when a body has no CYLINDER faces to vote with directly — not
 *  expected to run for real hex-stock input, but keeps this function
 *  total rather than partial. */
function pcaAxis(body) {
  const verts = (body.vertices || []).map(v => v.point)
  if (verts.length < 2) return { x: 0, y: 1, z: 0 }
  const c = centroidOfVertices(body)
  let best = { x: 0, y: 1, z: 0 }
  let bestSpread = -1
  for (const v of verts) {
    const d = sub(v, c)
    const spread = dot(d, d)
    if (spread > bestSpread) { bestSpread = spread; best = d }
  }
  return normalize(best)
}

// ── Step 2: project every face's bounding box onto the axis ───────

function projectPointOntoAxis(point, axisOrigin, axisDir) {
  return dot(sub(point, axisOrigin), axisDir)
}

/** Returns [min, max] — the face's extent along the axis, from its box's
 *  8 corners (cheap and sufficient; we don't need the exact silhouette,
 *  only where along the shaft this face is "active"). */
function faceAxialExtent(face, axisOrigin, axisDir) {
  const { minCorner, maxCorner } = face.box
  const corners = []
  for (const x of [minCorner.x, maxCorner.x]) {
    for (const y of [minCorner.y, maxCorner.y]) {
      for (const z of [minCorner.z, maxCorner.z]) {
        corners.push({ x, y, z })
      }
    }
  }
  const projections = corners.map(c => projectPointOntoAxis(c, axisOrigin, axisDir))
  return [Math.min(...projections), Math.max(...projections)]
}

// ── Perpendicular distance from a point to the axis line ──────────
function distanceFromAxis(point, axisOrigin, axisDir) {
  const v = sub(point, axisOrigin)
  const alongAxis = dot(v, axisDir)
  const closest = { x: axisOrigin.x + axisDir.x * alongAxis, y: axisOrigin.y + axisDir.y * alongAxis, z: axisOrigin.z + axisDir.z * alongAxis }
  return norm(sub(point, closest))
}

// ── Step 3: sweep-line band boundaries ─────────────────────────────

function buildBands(facesWithExtent) {
  const boundaries = []
  for (const { extent } of facesWithExtent) boundaries.push(extent[0], extent[1])
  boundaries.sort((a, b) => a - b)

  const unique = []
  for (const b of boundaries) {
    if (!unique.length || !lengthsMatch(b, unique[unique.length - 1], relTol)) unique.push(b)
  }

  const bands = []
  for (let i = 0; i < unique.length - 1; i++) {
    const start = unique[i], end = unique[i + 1]
    if (end - start <= relTol(end)) continue   // degenerate sliver — not a real segment
    bands.push({ start, end, mid: (start + end) / 2, length: end - start })
  }
  return bands
}

function activeFacesForBand(facesWithExtent, band) {
  return facesWithExtent.filter(({ extent }) =>
    extent[0] - relTol(band.mid) <= band.mid && band.mid <= extent[1] + relTol(band.mid)
  )
}

/** True if a set of same-role cylinder faces (e.g. all corner-relief, or
 *  all bore) disagree on radius beyond tolerance. A hex's corner relief
 *  legitimately produces one face per corner, all sharing one radius by
 *  construction — that's not disagreement. */
function radiiDisagree(cylFaces) {
  if (cylFaces.length <= 1) return false
  const radii = cylFaces.map(c => c.face.surface.radius)
  const max = Math.max(...radii), min = Math.min(...radii)
  return !lengthsMatch(max, min, relTol)
}

// ── Step 4: classify one band from its active faces ────────────────

function classifyBand(activeFaces, axisOrigin, axisDir) {
  const cylinders = activeFaces.filter(f => f.face.surface.type === 'CYLINDER')
  const planes    = activeFaces.filter(f => f.face.surface.type === 'PLANE')
  const other     = activeFaces.filter(f => f.face.surface.type !== 'CYLINDER' && f.face.surface.type !== 'PLANE')

  const warnings = []
  if (other.length) {
    warnings.push(`Unrecognized surface type(s) (${[...new Set(other.map(f => f.face.surface.type))].join(', ')}) in this band — treating as unknown.`)
    return { type: 'unknown', warnings }
  }

  // ── Round: one outer cylinder, optionally a concentric internal bore ──
  //
  // A second active cylinder here is NOT automatically a fillet — per the
  // Shaft Generator FeatureScript, a hollow shaft's centerHole is its own
  // concentric cylinder spanning nearly the whole part, radius smaller
  // than the outer OD. Any additional active cylinder with meaningfully
  // SMALLER radius than the outer one is a bore; anything else (comparable
  // or larger radius) is unexpected for a round band and gets flagged
  // rather than silently mislabeled.
  if (planes.length === 0 && cylinders.length >= 1) {
    const sorted = [...cylinders].sort((a, b) => b.face.surface.radius - a.face.surface.radius)
    const outer = sorted[0]
    const rest  = sorted.slice(1)
    const boreCandidates = rest.filter(c => c.face.surface.radius < outer.face.surface.radius * (1 - 0.02))
    const unexplained = rest.filter(c => c.face.surface.radius >= outer.face.surface.radius * (1 - 0.02))

    if (unexplained.length) {
      warnings.push('Extra active cylinder(s) in a round band with radius comparable to the outer OD — not classified as a bore.')
    }
    // A round band's bore is one cylindrical face by construction — flag
    // it only if candidates genuinely disagree on radius, not merely if
    // more than one face happens to be present.
    if (radiiDisagree(boreCandidates)) {
      warnings.push('Multiple concentric cylinders with disagreeing radii found in a round band — using the smallest as the bore; verify manually.')
    }
    const bore = boreCandidates.length
      ? boreCandidates.reduce((min, c) => c.face.surface.radius < min.face.surface.radius ? c : min)
      : null

    return {
      type: 'round',
      diameter: outer.face.surface.radius * 2,
      innerDiameter: bore ? bore.face.surface.radius * 2 : null,
      warnings,
    }
  }

  // ── Hex: >=3 flats, plus optionally a corner-relief cylinder and/or a
  //     concentric bore. Distinguished by comparing each cylinder's radius
  //     to the flats' apothem: per the Shaft Generator FeatureScript, the
  //     "Thunderhex" corner-rounding cut is ONE concentric cylinder with
  //     radius LARGER than the apothem (it relieves material further out
  //     than the flats, capping the corners) — localized to the hex
  //     length. centerHole, if present, is radius SMALLER than the
  //     apothem and spans nearly the whole part. A cylinder radius is
  //     never both at once, so this split is unambiguous. ──
  if (planes.length >= 3 && cylinders.length >= 1) {
    const apothems = planes.map(p => distanceFromAxis(p.face.surface.origin, axisOrigin, axisDir))
    const avgApothem = apothems.reduce((a, b) => a + b, 0) / apothems.length
    const spread = Math.max(...apothems) - Math.min(...apothems)
    if (spread > relTol(avgApothem) * 3) {
      warnings.push('Active flats in this band are not equidistant from the axis — hex classification is uncertain.')
    }

    const cornerCyls = cylinders.filter(c => c.face.surface.radius > avgApothem * (1 + 0.02))
    const boreCyls    = cylinders.filter(c => c.face.surface.radius < avgApothem * (1 - 0.02))
    const unexplained = cylinders.length - cornerCyls.length - boreCyls.length
    if (unexplained > 0) {
      warnings.push('Active cylinder(s) with radius approximately equal to the apothem — neither corner relief nor bore, left unclassified.')
    }
    // A hex has one corner-relief FACE per corner (e.g. 6), all sharing the
    // same radius by construction — that's expected, not ambiguous. Only
    // warn when the radii genuinely disagree (a real modeling anomaly).
    if (radiiDisagree(cornerCyls)) {
      warnings.push('Corner-relief cylinders in this hex band have inconsistent radii — using the largest; verify manually.')
    }
    if (radiiDisagree(boreCyls)) {
      warnings.push('Concentric bore cylinders in this hex band have inconsistent radii — using the smallest; verify manually.')
    }

    const corner = cornerCyls.length
      ? cornerCyls.reduce((max, c) => c.face.surface.radius > max.face.surface.radius ? c : max)
      : null
    const bore = boreCyls.length
      ? boreCyls.reduce((min, c) => c.face.surface.radius < min.face.surface.radius ? c : min)
      : null

    return {
      type: 'hex',
      acrossFlats: avgApothem * 2,
      filletRadius: corner ? corner.face.surface.radius : null,
      innerDiameter: bore ? bore.face.surface.radius * 2 : null,
      flatCount: planes.length,
      warnings,
    }
  }

  // ── Square/prism: flats only, no cylinder ──
  if (planes.length >= 3 && cylinders.length === 0) {
    const apothems = planes.map(p => distanceFromAxis(p.face.surface.origin, axisOrigin, axisDir))
    const avgApothem = apothems.reduce((a, b) => a + b, 0) / apothems.length
    return { type: planes.length === 4 ? 'square' : 'prism', width: avgApothem * 2, flatCount: planes.length, warnings }
  }

  warnings.push(`Ambiguous band (${cylinders.length} cylinder face(s), ${planes.length} plane face(s) active) — could not classify.`)
  return { type: 'unknown', warnings }
}

// ── Step 5: merge adjacent bands of matching classification ────────

function boreMatches(a, b) {
  const aBore = a.innerDiameter ?? null
  const bBore = b.innerDiameter ?? null
  if (aBore === null && bBore === null) return true
  if (aBore === null || bBore === null) return false
  return lengthsMatch(aBore, bBore, relTol)
}

function segmentsRoughlyMatch(a, b) {
  if (a.type !== b.type) return false
  if (a.type === 'round')  return lengthsMatch(a.diameter, b.diameter, relTol) && boreMatches(a, b)
  if (a.type === 'hex')    return lengthsMatch(a.acrossFlats, b.acrossFlats, relTol) && boreMatches(a, b)
  if (a.type === 'square' || a.type === 'prism') return lengthsMatch(a.width, b.width, relTol)
  if (a.type === 'unknown') return true   // compress consecutive unknown bands into one review item
  return false
}

function mergeBands(classifiedBands) {
  const merged = []
  for (const band of classifiedBands) {
    const prev = merged[merged.length - 1]
    if (prev && segmentsRoughlyMatch(prev, band)) {
      prev.length += band.length
      prev.warnings = [...new Set([...prev.warnings, ...band.warnings])]
    } else {
      merged.push({ ...band })
    }
  }
  return merged
}

// ── Candidate prefilter (Phase 3) ──────────────────────────────────
//
// Cheap, name-based prefilter — same spirit as spacer.js's
// candidateFilter, avoiding an Onshape bodydetails call for rows that
// obviously aren't axial-shaft candidates. Real dimensional/geometric
// confirmation only happens after a bodydetails fetch (Phase 1) and
// reconstructAxialSegments (above) — this is purely a request-saving
// gate, not a classification.

const NAME_KEYWORDS = ['hex', 'shaft', 'rod']

export function candidateFilter(row) {
  if (!row.partName) return false
  const name = row.partName.toLowerCase()
  const partNumber = (row.partNumber || '').toLowerCase()
  if (!NAME_KEYWORDS.some(k => name.includes(k) || partNumber.includes(k))) return false

  // COTS/standard-content parts are never auto-detected for fabrication,
  // regardless of name — same rule as spacer.
  if (row.raw?.isStandardContent) return false

  return true
}

/** Per the roadmap: a candidate whose source document differs from the
 *  imported assembly's own root document is an outside/vendor part and
 *  excluded from auto-detection entirely — identical rule to spacer's. */
export function isFromRootDocument(row, rootDocumentId) {
  return !!row.raw?.documentId && row.raw.documentId === rootDocumentId
}

export const axialShaftDetector = {
  kind: 'axial-shaft',
  generatorId: null,      // geometry-driven detection, no FeatureScript marker relied on
  dataSource: 'bodydetails',   // tells the detection endpoint which fetch strategy to use
  candidateFilter,
  isFromRootDocument,
}

/**
 * Reconstructs the ordered axial segment list for one body from a
 * bodydetails response. Returns a { axis, dimensions, status, confidence,
 * warnings } shape ready to drop into fabrication_metadata (kind:
 * 'axial-shaft'), per AXIAL_SHAFT_DETECTION_ROADMAP.md's data shape.
 *
 * `unitScale` converts the response's native meters into whatever unit
 * the caller wants segment dimensions reported in (e.g. 1/0.0254 for
 * inches) — defaults to 1 (meters), so callers doing their own
 * conversion downstream can just pass the raw output through.
 */
export function reconstructAxialSegments(body, { unitScale = 1 } = {}) {
  const faces = body.faces || []
  const axis = resolveDominantAxis(body)

  const facesWithExtent = faces
    .filter(f => f.surface?.type === 'CYLINDER' || f.surface?.type === 'PLANE')
    .map(face => ({ face, extent: faceAxialExtent(face, axis.origin, axis.direction) }))

  if (!facesWithExtent.length) {
    return {
      axis: null,
      dimensions: { totalLength: 0, segments: [] },
      status: 'needs_review',
      confidence: 'low',
      warnings: ['No PLANE or CYLINDER faces found — cannot reconstruct an axial profile.'],
    }
  }

  const bands = buildBands(facesWithExtent)

  let segIndex = 0
  const classifiedBands = bands.map(band => {
    const active = activeFacesForBand(facesWithExtent, band)
    const classified = classifyBand(active, axis.origin, axis.direction)
    return { ...classified, length: band.length }
  })

  const merged = mergeBands(classifiedBands)

  const segments = merged.map(seg => {
    const out = {
      id: `seg-${segIndex++}`,
      type: seg.type,
      length: seg.length * unitScale,
    }
    if (seg.type === 'round') {
      out.diameter = seg.diameter * unitScale
      if (seg.innerDiameter != null) out.innerDiameter = seg.innerDiameter * unitScale
    } else if (seg.type === 'hex') {
      out.acrossFlats = seg.acrossFlats * unitScale
      if (seg.filletRadius != null) out.filletRadius = seg.filletRadius * unitScale
      if (seg.innerDiameter != null) out.innerDiameter = seg.innerDiameter * unitScale
    } else if (seg.type === 'square' || seg.type === 'prism') {
      out.width = seg.width * unitScale
    }
    return out
  })

  const totalLength = segments.reduce((s, seg) => s + seg.length, 0)
  const warnings = [...new Set(merged.flatMap(s => s.warnings || []))]
  const hasUnknown = segments.some(s => s.type === 'unknown')

  // Common vendor OD confidence bump (roadmap Use Case 1) — checked
  // against the widest 'round'/'hex' segment as a rough proxy for OD.
  const commonSizesM = [0.375, 0.5].map(inches => inches * 0.0254)
  const maxOd = Math.max(0, ...segments.map(s => s.diameter ?? s.acrossFlats ?? 0))
  const matchesCommonSize = commonSizesM.some(s => lengthsMatch(maxOd, s, relTol))

  let confidence = 'medium'
  if (axis.confidence === 'cylinder-majority' && !hasUnknown) confidence = 'high'
  if (axis.confidence === 'pca-fallback') confidence = 'low'
  if (confidence === 'high' && matchesCommonSize) confidence = 'high'   // no-op, kept for clarity/extension

  const status = hasUnknown || axis.confidence === 'pca-fallback' ? 'needs_review' : 'detected'

  return {
    axis: { origin: axis.origin, direction: axis.direction, confidence: axis.confidence },
    dimensions: { totalLength, segments },
    status,
    confidence,
    warnings,
  }
}
