// api/_lib/detectors/plate.js
//
// See PLATE_DETECTION_ROADMAP.md. Detects flat custom stock (aluminum /
// polycarbonate / acrylic plates) from B-rep geometry via
// partstudios/.../bodydetails — same data source and general technique
// as axial-shaft.js, applied to plane normals instead of a cylinder axis.
//
// Scope, per the roadmap's resolved decisions:
//   • Classification only — no per-hole dimensional schedule is ever
//     extracted or stored. Hole-shaped geometry (through-holes,
//     counterbores, countersinks) is recognized only so it doesn't
//     corrupt the dominant-plane-pair signal or get miscounted as a
//     second thickness offset.
//   • Multi-offset / stepped geometry (more than one distinct
//     thickness region) is explicitly out of scope for classification
//     and is tagged needs_review with a specific reason, not silently
//     rejected or force-classified.
//   • Sheet metal is out of scope. Since part naming doesn't reliably
//     flag it, exclusion needs a second signal — see
//     checkNotSheetMetal() at the bottom of this file, which is an
//     async Part-Studio-feature check the detection endpoint runs only
//     for candidates that already passed geometric classification (see
//     roadmap's "Sheet-Metal Exclusion" section for why this can't be
//     folded into the synchronous classifyGeometry() contract the other
//     detectors use).
//
// All incoming coordinates/radii/areas are in meters (and square
// meters for area) — Onshape's bodydetails native unit — same
// convention axial-shaft.js follows. unitScale converts linear
// dimensions for display; areas are only ever compared to each other
// (ratios), never surfaced, so they're never scaled.

import { fetchPartStudioFeatures } from '../onshape-partstudio-features.js'

// ── Vector helpers (mirrors axial-shaft.js) ────────────────────────
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
function isParallel(a, b, angleTol = 1e-4) { return norm(cross(a, b)) < angleTol }

const LENGTH_TOL_ABS_M = 0.0000127   // ~0.0005 in, matches axial-shaft.js
function lengthsMatch(a, b, tol = LENGTH_TOL_ABS_M) { return Math.abs(a - b) <= tol }
function relTol(mag) { return Math.max(LENGTH_TOL_ABS_M, mag * 0.001) }

// ── Configurable stock-thickness buckets ────────────────────────────
// Resolved as "configurable, not hard-coded inline" — this is the one
// place to edit to add/remove named stock sizes. Values in inches;
// converted internally via unitScale at comparison time.
export const STOCK_THICKNESSES_IN = [0.125, 0.1875, 0.25, 0.375, 0.5]

// Plate footprint must be at least this many times the thickness in its
// SMALLER in-plane dimension — the check that separates "plate" from
// "block" or "thick washer" (spacer-detector territory).
const MIN_FOOTPRINT_TO_THICKNESS_RATIO = 8

// Absolute area floor (m²) for a level to count toward the thickness
// span calculation — filters out counterbore/countersink shoulder rings
// regardless of how they compare proportionally to the top/bottom pair.
// Small and deliberately separate from DOMINANT_PAIR_FOOTPRINT_FRACTION.
const MIN_LEVEL_AREA_FOR_SPAN = 0.00002   // ~0.03 in² — a small washer-sized ring

// A candidate plane pair's combined area must be at least this fraction
// of the body's FOOTPRINT area (bounding-box length × width, derived
// from face box data already present in bodydetails — not a second API
// call) to count as "dominant." Deliberately normalized against
// footprint rather than total body surface area: a heavily pocketed or
// hole-riddled lightweighting plate can have dozens of hole/pocket wall
// faces whose cumulative area rivals or exceeds the top+bottom pair,
// even though those two faces are unambiguously the dominant PLANAR
// pair. Total-surface-area normalization scales with feature count and
// falsely rejects exactly this kind of legitimate, heavily-lightened
// plate; footprint normalization does not, since footprint is a
// property of the outline alone. 15% is a generous floor — even a
// plate mostly pocketed out for weight typically retains more solid
// material than that.
const DOMINANT_PAIR_FOOTPRINT_FRACTION = 0.15

// ── Step 1: find candidate plane-normal clusters, by area ───────────
function groupPlanesByNormal(body) {
  const planeFaces = (body.faces || []).filter(f => f.surface?.type === 'PLANE' && f.area > 0)
  const clusters = []   // [{ direction, faces: [] }]
  for (const face of planeFaces) {
    const dir = normalize(face.surface.normal)
    let cluster = clusters.find(c => isParallel(c.direction, dir))
    if (!cluster) { cluster = { direction: dir, faces: [] }; clusters.push(cluster) }
    cluster.faces.push(face)
  }
  return clusters
}

function totalFaceArea(body) {
  return (body.faces || []).reduce((s, f) => s + (f.area || 0), 0)
}

/** Projects a plane face's origin onto a normal direction — gives that
 *  face's "offset" along the axis, used to find distinct thickness
 *  regions and to measure the gap between the top/bottom pair. */
function planeOffset(face, normalDir) {
  return dot(face.surface.origin, normalDir)
}

/**
 * Within one normal-direction cluster, groups faces by offset along that
 * normal (distinct planar "levels"), then ranks levels by total area.
 * Returns levels sorted descending by area — the top 2 (if they clearly
 * dominate) are the plate's top/bottom faces; additional lower-ranked
 * levels are either counterbore/countersink-adjacent shoulders (small
 * area, tolerated) or evidence of a stepped/multi-offset part (large
 * area, disqualifying — see classifyPlate below).
 */
function groupLevelsByOffset(cluster) {
  const levels = []   // [{ offset, faces, area }]
  for (const face of cluster.faces) {
    const off = planeOffset(face, cluster.direction)
    let level = levels.find(l => lengthsMatch(l.offset, off, relTol(off)))
    if (!level) { level = { offset: off, faces: [], area: 0 }; levels.push(level) }
    level.faces.push(face)
    level.area += face.area
  }
  levels.sort((a, b) => b.area - a.area)
  return levels
}

// ── Step 2: hole-shaped face clusters (holes, counterbores, countersinks) ──
// Groups remaining CYLINDER/CONE faces whose axis is parallel to the
// plate normal into per-hole clusters by their in-plane (perpendicular
// to normal) position, then band-sweeps each cluster along the normal —
// same sweep-line technique axial-shaft.js uses along a shaft's length,
// applied here per-cluster instead of whole-body.

function perpendicularPosition(origin, normalOrigin, normalDir) {
  const v = sub(origin, normalOrigin)
  const along = dot(v, normalDir)
  return sub(v, scale(normalDir, along))   // component of v perpendicular to normal
}

function groupHoleClusters(holeFaces, normalOrigin, normalDir) {
  const clusters = []   // [{ faces: [] }]
  for (const face of holeFaces) {
    const pos = perpendicularPosition(face.surface.origin, normalOrigin, normalDir)
    let cluster = clusters.find(c => norm(sub(c.pos, pos)) < relTol(norm(pos)) * 50)
    if (!cluster) { cluster = { pos, faces: [] }; clusters.push(cluster) }
    cluster.faces.push(face)
  }
  return clusters
}

function faceAxialExtent(face, normalOrigin, normalDir) {
  const { minCorner, maxCorner } = face.box
  const corners = []
  for (const x of [minCorner.x, maxCorner.x]) {
    for (const y of [minCorner.y, maxCorner.y]) {
      for (const z of [minCorner.z, maxCorner.z]) corners.push({ x, y, z })
    }
  }
  const projections = corners.map(c => dot(sub(c, normalOrigin), normalDir))
  return [Math.min(...projections), Math.max(...projections)]
}

/**
 * Classifies one hole-shaped face cluster as a recognized shape
 * (through-hole, counterbore, or countersink) or 'unknown'. Per the
 * roadmap's resolved scope, no dimensions are returned — only whether
 * the shape is recognized, since a plate's identity never includes hole
 * geometry.
 */
function classifyHoleCluster(cluster, normalOrigin, normalDir) {
  const cylinders = cluster.faces.filter(f => f.surface.type === 'CYLINDER')
  const cones     = cluster.faces.filter(f => f.surface.type === 'CONE')

  if (cylinders.length + cones.length === 0) return 'unknown'

  // Simple through-hole: exactly one constant-radius cylinder, no cones,
  // no radius change along the axis.
  if (cones.length === 0 && cylinders.length >= 1) {
    const radii = cylinders.map(c => c.surface.radius)
    const maxR = Math.max(...radii), minR = Math.min(...radii)

    if (lengthsMatch(maxR, minR, relTol(maxR))) return 'through-hole'

    // Two distinct radii, no cone → counterbore: a short wide band
    // adjacent to one dominant face, narrow band for the rest.
    if (cylinders.length === 2) {
      const [a, b] = cylinders
      const extA = faceAxialExtent(a, normalOrigin, normalDir)
      const extB = faceAxialExtent(b, normalOrigin, normalDir)
      const aIsWide = a.surface.radius > b.surface.radius
      const wideExt = aIsWide ? extA : extB
      const narrowExt = aIsWide ? extB : extA
      // Wide band's span should be shallow relative to the narrow
      // band's — a counterbore recess, not two full-depth bores.
      const wideSpan = wideExt[1] - wideExt[0]
      const narrowSpan = narrowExt[1] - narrowExt[0]
      if (wideSpan > 0 && narrowSpan > 0 && wideSpan < narrowSpan) return 'counterbore'
    }
    return 'unknown'
  }

  // Countersink: exactly one CONE (the tapered recess) plus at most one
  // constant-radius CYLINDER for the remaining through-bore depth.
  if (cones.length === 1 && cylinders.length <= 1) {
    if (cylinders.length === 0) return 'countersink'   // taper straight through — still recognized
    return 'countersink'
  }

  return 'unknown'
}

// ── Main classification ─────────────────────────────────────────────

/**
 * Reconstructs plate dimensions (or determines the body isn't a plate)
 * from a single body's bodydetails response. Returns
 * { status, confidence, warnings, dimensions, normal } — same envelope
 * shape spirit as axial-shaft.js's reconstructAxialSegments, but with a
 * far smaller `dimensions` payload per the roadmap's resolved scope.
 */
export function classifyPlateGeometry(body, { unitScale = 1 } = {}) {
  const warnings = []
  const totalArea = totalFaceArea(body)
  if (totalArea <= 0) {
    return { status: 'needs_review', confidence: 'low', dimensions: null, normal: null,
      warnings: ['No face area data available — cannot evaluate plate geometry.'] }
  }

  const clusters = groupPlanesByNormal(body)
  if (!clusters.length) {
    return { status: 'needs_review', confidence: 'low', dimensions: null, normal: null,
      warnings: ['No planar faces found — cannot evaluate plate geometry.'] }
  }

  // Try each normal-direction cluster (by total area, largest first) —
  // the winning cluster is whichever one actually produces a valid
  // dominant top/bottom pair, not just whichever has the most raw area,
  // since a wide flat outline face on a non-plate part could otherwise
  // out-rank the real candidate.
  clusters.sort((a, b) => b.faces.reduce((s, f) => s + f.area, 0) - a.faces.reduce((s, f) => s + f.area, 0))

  for (const cluster of clusters) {
    const levels = groupLevelsByOffset(cluster)
    if (levels.length < 2) continue

    const [top, bottom] = levels
    const pairArea = top.area + bottom.area
    const normalOrigin = top.faces[0].surface.origin

    // Footprint computed up front — needed for the dominant-pair gate
    // itself now, not just for the final reported dimensions. Free:
    // derived from face.box corners already present in bodydetails, no
    // second API call (and no need for the separate /boundingboxes
    // endpoint — see DOMINANT_PAIR_FOOTPRINT_FRACTION's comment above).
    const footprint = planarFootprint(top.faces, normalOrigin, cluster.direction)
    const footprintArea = footprint.length * footprint.width

    if (footprintArea <= 0 || pairArea / footprintArea < DOMINANT_PAIR_FOOTPRINT_FRACTION) continue

    // Thickness is the GREATEST distance between any two parallel planes
    // in this normal cluster, not just the top/bottom-by-area pair —
    // this is what lets stepped plates, counterbores, and countersinks
    // report a correct thickness instead of being disqualified. A
    // counterbore/countersink shoulder or a step face both show up as
    // just another level in this same cluster; the true plate thickness
    // is always the outermost span, regardless of which individual level
    // happens to carry the most face area.
    //
    // Tiny levels (a counterbore/countersink shoulder ring, for example)
    // are filtered out of this span calculation by an absolute area
    // floor, not a fraction of the top pair's area — a large-diameter
    // counterbore near full plate size would otherwise pass a
    // relative threshold and wrongly extend the measured thickness.
    // MIN_LEVEL_AREA_FOR_SPAN is intentionally small and separate from
    // DOMINANT_PAIR_FOOTPRINT_FRACTION, which only governs whether a normal
    // cluster reads as a plate at all.
    const significantLevels = levels.filter(l => l.area > MIN_LEVEL_AREA_FOR_SPAN)
    const offsets = significantLevels.map(l => l.offset)
    const maxOffset = Math.max(...offsets)
    const minOffset = Math.min(...offsets)

    if (significantLevels.length > 2) {
      warnings.push(`Found ${significantLevels.length} distinct thickness-relevant plane offsets (steps, counterbores, or countersinks) — thickness taken as the greatest span; confirm manually.`)
    }

    const thickness = Math.abs(maxOffset - minOffset) * unitScale

    // minFootprintDim reuses the footprint already computed above for
    // the dominant-pair gate — not recomputed here.
    const minFootprintDim = Math.min(footprint.length, footprint.width) * unitScale

    if (thickness <= 0 || minFootprintDim / thickness < MIN_FOOTPRINT_TO_THICKNESS_RATIO) {
      continue   // doesn't read as sheet stock — try the next cluster, if any
    }

    // Hole tolerance pass — doesn't gate detection unless something is
    // genuinely unrecognized.
    const holeFaces = (body.faces || []).filter(f =>
      (f.surface?.type === 'CYLINDER' && isParallel(normalize(f.surface.axis), cluster.direction)) ||
      (f.surface?.type === 'CONE' && f.surface.axis && isParallel(normalize(f.surface.axis), cluster.direction))
    )
    const holeClusters = groupHoleClusters(holeFaces, normalOrigin, cluster.direction)
    let unrecognizedHoles = 0
    for (const hc of holeClusters) {
      const kind = classifyHoleCluster(hc, normalOrigin, cluster.direction)
      if (kind === 'unknown') unrecognizedHoles++
    }
    if (unrecognizedHoles) {
      warnings.push(`${unrecognizedHoles} hole-shaped feature(s) didn't match a recognized through-hole/counterbore/countersink pattern.`)
    }

    const matchedStock = STOCK_THICKNESSES_IN.find(t => lengthsMatch(thickness, t, relTol(t)))
    const dimensions = {
      thickness: { value: thickness, unit: 'in' },
      footprint: {
        length: { value: footprint.length * unitScale, unit: 'in' },
        width:  { value: footprint.width * unitScale, unit: 'in' },
      },
    }

    const status = unrecognizedHoles > 0 ? 'needs_review' : 'detected'
    const multiLevel = significantLevels.length > 2
    let confidence = 'medium'
    if (status === 'detected' && matchedStock && !multiLevel) confidence = 'high'
    if (status === 'detected' && (!matchedStock || multiLevel)) confidence = 'medium'
    if (status === 'needs_review') confidence = 'low'

    return {
      status,
      confidence,
      dimensions,
      normal: { direction: cluster.direction, confidence: 'plane-majority' },
      warnings,
    }
  }

  return {
    status: 'needs_review',
    confidence: 'low',
    dimensions: null,
    normal: null,
    warnings: ['Could not find a dominant pair of large parallel planes — doesn\'t read as flat plate stock.'],
  }
}

/** Coarse in-plane bounding box of a set of coplanar faces, in the two
 *  directions perpendicular to the normal. Not a true outline trace. */
function planarFootprint(faces, normalOrigin, normalDir) {
  // Build an arbitrary orthonormal basis (u, v) perpendicular to normalDir.
  const arbitrary = Math.abs(normalDir.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 }
  const u = normalize(cross(normalDir, arbitrary))
  const v = cross(normalDir, u)

  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
  for (const face of faces) {
    const { minCorner, maxCorner } = face.box
    for (const x of [minCorner.x, maxCorner.x]) {
      for (const y of [minCorner.y, maxCorner.y]) {
        for (const z of [minCorner.z, maxCorner.z]) {
          const p = sub({ x, y, z }, normalOrigin)
          const pu = dot(p, u), pv = dot(p, v)
          minU = Math.min(minU, pu); maxU = Math.max(maxU, pu)
          minV = Math.min(minV, pv); maxV = Math.max(maxV, pv)
        }
      }
    }
  }
  return { length: maxU - minU, width: maxV - minV }
}

// ── Candidate prefilter ──────────────────────────────────────────────
export function candidateFilter(row) {
  if (!row.partName) return false
  const name = row.partName.toLowerCase()
  const partNumber = (row.partNumber || '').toLowerCase()
  if (!name.includes('plate') && !partNumber.includes('plate')) return false
  if (row.raw?.isStandardContent) return false
  return true
}

export function isFromRootDocument(row, rootDocumentId) {
  return !!row.raw?.documentId && row.raw.documentId === rootDocumentId
}

/** Shared classifyGeometry entrypoint — same shape as spacer.js/
 *  axial-shaft.js's exports of the same name. */
export function classifyGeometry(body, opts) {
  const result = classifyPlateGeometry(body, opts)
  return {
    status: result.status,
    confidence: result.confidence,
    warnings: result.warnings,
    extra: { normal: result.normal, dimensions: result.dimensions },
  }
}

// ── Sheet-metal exclusion (async, post-geometry hook) ────────────────
//
// Resolved: naming conventions don't differentiate sheet-metal parts,
// so this has to be a real check, not a documentation note. Runs only
// for candidates that already classified as 'detected' or 'needs_review'
// geometrically — it's an extra Onshape call, so it's only paid for
// bodies that already look plate-shaped, mirroring how counterbore/
// countersink handling only costs extra work for genuine candidates.
//
// Approach: fetch the source Part Studio's feature list (same endpoint
// the spacer detector used to use for FeatureScript parameters — see
// onshape-partstudio-features.js) and look for a feature whose
// featureType/name indicates a sheet-metal conversion. This list of
// marker strings is a best-effort starting point — per the roadmap,
// it should be validated/extended against real fixture data (a
// confirmed sheet-metal part's actual features response) before being
// trusted as the sole signal.
const SHEET_METAL_FEATURE_MARKERS = [
  'sheetmetal', 'sheet_metal', 'flatten', 'converttosheetmetal', 'flatpattern',
]

/**
 * Returns true if the owning Part Studio appears to contain a
 * sheet-metal-related feature. Caller (the detection endpoint) should
 * downgrade an otherwise-'detected' plate candidate to 'needs_review'
 * (not silently drop it — a false positive here should still surface
 * for a human to confirm) when this returns true.
 */
export async function checkNotSheetMetal(documentId, wvmType, workspaceId, elementId) {
  try {
    const data = await fetchPartStudioFeatures(documentId, wvmType, workspaceId, elementId)
    const features = data?.features || []
    const hasSheetMetalFeature = features.some(f => {
      const type = (f.featureType || '').toLowerCase()
      const name = (f.name || '').toLowerCase()
      return SHEET_METAL_FEATURE_MARKERS.some(marker => type.includes(marker) || name.includes(marker))
    })
    return !hasSheetMetalFeature
  } catch (e) {
    console.warn(`[plate] Sheet-metal feature check failed for Part Studio ${elementId}: ${e.message}`)
    // Fail open toward review, not toward silent acceptance or silent
    // rejection — caller should treat a failed check as inconclusive.
    return null
  }
}

export const plateDetector = {
  kind: 'plate',
  generatorId: null,
  dataSource: 'bodydetails',
  candidateFilter,
  isFromRootDocument,
  classifyGeometry,
  // Optional hook the detection endpoint can call after a 'detected'
  // geometric classification, before persisting — not part of the
  // shared classifyGeometry(body, opts) contract since it needs its own
  // network call. See checkNotSheetMetal above.
  postGeometryCheck: checkNotSheetMetal,
}
