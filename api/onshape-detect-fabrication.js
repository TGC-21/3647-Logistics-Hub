// api/onshape-detect-fabrication.js — Vercel serverless function
//
// Button-triggered fabrication-candidate detection (see
// SPACER_AUTO_DETECTION_ROADMAP.md and
// AXIAL_SHAFT_DETECTION_ROADMAP.md). Deliberately NOT run automatically
// during import/reimport — the user clicks "Detect fabrication
// candidates" on an assembly, and this walks its part tree, groups
// candidate rows by source Part Studio, fetches each Part Studio's
// geometry/features exactly once, and writes results onto assembly_parts.
// fabrication_metadata. No fabrication_jobs are created here — that only
// happens when the user confirms a detected row in the UI.
//
// Two detectors are registered (see fabrication-detectors.js), each
// tagged with a `dataSource`:
//   'features'    — spacer: FeatureScript parameters via .../features,
//                    with evalFeatureScript for geometry parameters can't
//                    express (see runFeatureBasedDetection)
//   'bodydetails' — axial-shaft: real B-rep geometry via
//                    .../bodydetails, no FeatureScript parameters at all
//                    (see runBodyDetailsBasedDetection)
// The per-detector candidate/ignored-row bookkeeping is shared; only the
// "how do we get dimensions for a candidate" step branches.
//
// POST /api/onshape-detect-fabrication  { assemblyId }

import { createClient } from '@supabase/supabase-js'
import { applyCors, MAX_ONSHAPE_CONCURRENCY } from './_lib/onshape.js'
import { fetchPartStudioFeatures, partStudioCacheKey, evalFeatureScript, extractEvalNumber } from './_lib/onshape-partstudio-features.js'
import { fetchBodyDetails, bodyDetailsCacheKey, findBodyByPartId } from './_lib/onshape-bodydetails.js'
import { reconstructAxialSegments } from './_lib/detectors/axial-shaft.js'
import { DETECTORS, candidateRowsForDetector } from './_lib/fabrication-detectors.js'

function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.')
  return createClient(url, key)
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { applyCors(res); return res.status(204).end() }
  applyCors(res)
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const { assemblyId } = req.body ?? {}
  if (!assemblyId) return res.status(400).json({ error: 'assemblyId is required.' })

  try {
    const supabase = getSupabase()

    const { data: assembly, error: asmErr } = await supabase
      .from('assemblies').select('*').eq('id', assemblyId).single()
    if (asmErr || !assembly) return res.status(404).json({ error: 'Assembly not found.' })
    if (!assembly.onshape_document_id) {
      return res.status(400).json({ error: 'Assembly is not linked to Onshape.' })
    }

    const { rows, skippedCount } = await fetchWholeTreeParts(supabase, assemblyId)

    const result = await detectAndPersist(supabase, {
      rows,
      rootDocumentId: assembly.onshape_document_id,
    })

    const message = skippedCount
      ? `${result.message} (${skippedCount} already-confirmed row(s) skipped.)`
      : result.message

    return res.status(200).json({ success: true, skippedCount, ...result, message })

  } catch (err) {
    console.error('[onshape-detect-fabrication]', err)
    return res.status(500).json({ error: err.message ?? 'Internal server error' })
  }
}

// ── Walk the whole assembly_parts tree (root + every nested subassembly) ──
// Mirrors fetchAllLinkedInstanceIdsForAssembly's traversal in src/db.js.
// Rows already in a TERMINAL detection state are excluded here — they
// won't change unless the underlying Onshape feature does, so re-fetching
// their source Part Studio and re-running evalFeatureScript/bodydetails on
// every repeat click of "Detect fabrication candidates" (including
// reimports) would be pure wasted API calls.
const TERMINAL_DETECTION_STATUSES = ['confirmed', 'queued', 'ignored']

async function fetchWholeTreeParts(supabase, assemblyId) {
  const allParts = []

  const { data: rootParts, error: rootErr } = await supabase
    .from('assembly_parts')
    .select('id, part_name, part_number, onshape_reference, fabrication_metadata')
    .eq('assembly_id', assemblyId)
  if (rootErr) throw rootErr
  allParts.push(...rootParts)

  const { data: directChildren, error: childErr } = await supabase
    .from('assembly_children')
    .select('id')
    .eq('parent_assembly_id', assemblyId)
  if (childErr) throw childErr

  const queue = (directChildren || []).map(c => c.id)
  while (queue.length) {
    const childId = queue.pop()

    const { data: childParts, error: cpErr } = await supabase
      .from('assembly_parts')
      .select('id, part_name, part_number, onshape_reference, fabrication_metadata')
      .eq('assembly_child_id', childId)
    if (cpErr) throw cpErr
    allParts.push(...childParts)

    const { data: grandchildren, error: gcErr } = await supabase
      .from('assembly_children')
      .select('id')
      .eq('parent_child_id', childId)
    if (gcErr) throw gcErr
    queue.push(...(grandchildren || []).map(c => c.id))
  }

  const eligible = allParts.filter(row =>
    !TERMINAL_DETECTION_STATUSES.includes(row.fabrication_metadata?.status)
  )
  const skippedCount = allParts.length - eligible.length

  return {
    rows: eligible.map(row => ({
      id:          row.id,
      partName:    row.part_name,
      partNumber:  row.part_number,
      raw:         row.onshape_reference || {},
    })),
    skippedCount,
  }
}

// ── Group candidates by source Part Studio, dispatch by dataSource ────
async function detectAndPersist(supabase, { rows, rootDocumentId }) {
  let candidateCount = 0
  let detectedCount  = 0
  let needsReviewCount = 0
  let ignoredCount = 0
  const warnings = []

  // Rows whose name matches BOTH spacer's and axial-shaft's keyword filter
  // (e.g. a hex-profile spacer) are structurally ambiguous by name alone.
  // Resolve with ONE cheap features-list fetch per overlapping Part Studio
  // (never bodydetails) before axial-shaft's expensive geometry pass runs.
  const excludeFromAxialShaft = await resolveSpacerAxialOverlap(rows, rootDocumentId)

  for (const detector of DETECTORS) {
    let candidates = candidateRowsForDetector(detector, rows, rootDocumentId)
    if (detector.kind === 'axial-shaft') candidates = candidates.filter(r => !excludeFromAxialShaft.has(r.id))
    candidateCount += candidates.length

    // Rows filtered out by candidateFilter/isFromRootDocument but whose
    // name still mentions the detector's kind get marked 'ignored' so the
    // UI can distinguish "we looked and it's not ours" from "never
    // considered". Cheap and just a name-substring check. Shared across
    // both dataSource kinds — this logic doesn't care how dimensions get
    // resolved, only whether the row was in-scope at all.
    const ignoredRows = rows.filter(r =>
      !candidates.includes(r) &&
      detector.candidateFilter(r) &&
      !detector.isFromRootDocument(r, rootDocumentId)
    )
    for (const row of ignoredRows) {
      await writeMetadata(supabase, row.id, {
        autoDetected: true,
        kind: detector.kind,
        status: 'ignored',
        confidence: 'high',
        source: detector.dataSource === 'bodydetails' ? 'onshape-bodydetails' : 'onshape-featurescript',
        warnings: ['Source document differs from the imported assembly\'s root document — treated as vendor/COTS.'],
      })
      ignoredCount++
    }

    if (!candidates.length) continue

    const stats = detector.dataSource === 'bodydetails'
      ? await runBodyDetailsBasedDetection(supabase, detector, candidates)
      : await runFeatureBasedDetection(supabase, detector, candidates)

    detectedCount    += stats.detected
    needsReviewCount += stats.needsReview
    warnings.push(...stats.warnings)
  }

  return {
    candidateCount,
    detectedCount,
    needsReviewCount,
    ignoredCount,
    warnings,
    message: `Scanned ${candidateCount} candidate part(s): ${detectedCount} detected, ${needsReviewCount} need review, ${ignoredCount} ignored.`,
  }
}

// ── Spacer / axial-shaft candidate overlap resolution ──────────────
// Both detectors' candidateFilter are independent keyword tests, and a
// real hex-profile spacer legitimately matches both ('spacer' AND 'hex').
// Left unresolved, whichever detector runs LAST in DETECTORS silently
// overwrites the other's fabrication_metadata. Since spacer's evidence
// (a FeatureScript parameter signature) is far cheaper to check than
// axial-shaft's (a bodydetails geometry fetch), resolve the overlap with
// spacer's check FIRST and only let axial-shaft spend a bodydetails call
// on rows spacer didn't claim.
async function resolveSpacerAxialOverlap(rows, rootDocumentId) {
  const spacerDet = DETECTORS.find(d => d.kind === 'spacer')
  const axialDet  = DETECTORS.find(d => d.kind === 'axial-shaft')
  if (!spacerDet || !axialDet) return new Set()

  const axialIds = new Set(candidateRowsForDetector(axialDet, rows, rootDocumentId).map(r => r.id))
  const overlap = candidateRowsForDetector(spacerDet, rows, rootDocumentId).filter(r => axialIds.has(r.id))
  if (!overlap.length) return new Set()

  const groups = new Map()
  for (const row of overlap) {
    const src = row.raw
    const key = partStudioCacheKey(src.documentId, src.wvmType, src.wvmId, src.elementId, src.fullConfiguration)
    if (!groups.has(key)) groups.set(key, { documentId: src.documentId, wvmType: src.wvmType || 'w', wvmId: src.wvmId, elementId: src.elementId, rows: [] })
    groups.get(key).rows.push(row)
  }

  const confirmedSpacerIds = new Set()
  for (const group of groups.values()) {
    try {
      const featureList = await fetchPartStudioFeatures(group.documentId, group.wvmType, group.wvmId, group.elementId)
      if (spacerDet.inspectPartStudioFeatures(featureList).length > 0) {
        group.rows.forEach(r => confirmedSpacerIds.add(r.id))
      }
    } catch (e) {
      console.warn(`[onshape-detect-fabrication] overlap-resolution fetch failed for Part Studio ${group.elementId}: ${e.message}`)
    }
  }
  return confirmedSpacerIds
}

// ── 'features' dataSource: spacer ──────────────────────────────────
// Unchanged from the original single-detector implementation — only
// extracted into its own function so detectAndPersist can dispatch by
// dataSource instead of assuming every detector works this way.
async function runFeatureBasedDetection(supabase, detector, candidates) {
  let detected = 0
  let needsReview = 0
  const warnings = []

  // Group by source Part Studio key
  const groups = new Map()   // cacheKey -> { studioRef, rows: [] }
  for (const row of candidates) {
    const src = row.raw
    const key = partStudioCacheKey(src.documentId, src.wvmType, src.wvmId, src.elementId, src.fullConfiguration)
    if (!groups.has(key)) {
      groups.set(key, { documentId: src.documentId, wvmType: src.wvmType || 'w', wvmId: src.wvmId, elementId: src.elementId, rows: [] })
    }
    groups.get(key).rows.push(row)
  }

  // Fetch each unique Part Studio's features once, capped concurrency
  const groupEntries = [...groups.values()]
  let cursor = 0
  async function worker() {
    while (cursor < groupEntries.length) {
      const group = groupEntries[cursor++]
      let matches = []
      try {
        const featureList = await fetchPartStudioFeatures(group.documentId, group.wvmType, group.wvmId, group.elementId)
        matches = detector.inspectPartStudioFeatures(featureList)
      } catch (e) {
        console.warn(`[onshape-detect-fabrication] Feature fetch failed for Part Studio ${group.elementId}: ${e.message}`)
        warnings.push(`Could not inspect Part Studio ${group.elementId}: ${e.message}`)
      }

      // Resolve any match that needs real geometry (ROUND id / UP_TO_FACE
      // length) via evalFeatureScript — one call per feature, run after
      // the cheap parameter-only pass above so a fetch failure there
      // doesn't block eval, and vice versa.
      if (detector.applyEvalResult) {
        matches = await Promise.all(matches.map(async m => {
          if (!m.evalRequest) return m
          try {
            const evalRes = await evalFeatureScript(
              group.documentId, group.wvmType, group.wvmId, group.elementId,
              m.evalRequest.script, m.evalRequest.queries
            )
            const radius = m.evalRequest.needsId ? extractEvalNumber(evalRes, 'radius') : null
            const length = m.evalRequest.needsLength ? extractEvalNumber(evalRes, 'length') : null
            const outcome = (m.evalRequest.needsId && radius === null) || (m.evalRequest.needsLength && length === null)
              ? { error: 'Could not locate expected value in eval response — response shape may differ from what was assumed.' }
              : { radius, length }
            return detector.applyEvalResult(m, outcome)
          } catch (e) {
            console.warn(`[onshape-detect-fabrication] evalFeatureScript failed for feature ${m.featureId}: ${e.message}`)
            return detector.applyEvalResult(m, { error: e.message })
          }
        }))
      }

      // Row-to-feature mapping: only confident when counts match 1:1.
      // Otherwise every row in this studio is flagged needs_review with
      // all candidate matches attached for manual selection — see
      // "Open Questions" in the spacer roadmap re: partId/partIdentity
      // mapping, which v1 does not attempt to resolve automatically.
      for (const row of group.rows) {
        if (!matches.length) {
          await writeMetadata(supabase, row.id, {
            autoDetected: true,
            kind: detector.kind,
            status: 'needs_review',
            confidence: 'low',
            source: 'onshape-featurescript',
            warnings: ['No spacer-signature feature found in this part\'s source Part Studio.'],
          })
          needsReview++
          continue
        }

        if (group.rows.length === 1 && matches.length === 1) {
          const m = matches[0]
          await writeMetadata(supabase, row.id, {
            autoDetected: true,
            kind: detector.kind,
            status: m.status,
            confidence: m.confidence,
            source: 'onshape-featurescript',
            generator: detector.generatorId,
            spacerType: m.spacerType,
            endType: m.endType,
            dimensions: m.dimensions,
            fabricationDraft: m.status === 'detected'
              ? { method: null, quantityRequested: null, requiresConfirmation: true }
              : null,
            onshape: { featureId: m.featureId, documentId: group.documentId, wvmType: group.wvmType, wvmId: group.wvmId, elementId: group.elementId },
            warnings: m.warnings,
          })
          if (m.status === 'detected') detected++
          else needsReview++
        } else {
          // Ambiguous mapping — persist spacerType/endType too, taken
          // from the first candidate, so the confirm UI's default guess
          // is at least this Part Studio's actual first match rather
          // than a hard-coded ROUND assumption.
          const first = matches[0] || {}
          await writeMetadata(supabase, row.id, {
            autoDetected: true,
            kind: detector.kind,
            status: 'needs_review',
            confidence: 'medium',
            source: 'onshape-featurescript',
            spacerType: first.spacerType ?? null,
            endType: first.endType ?? null,
            candidateMatches: matches,
            warnings: ['Multiple generated features and/or matching rows in this Part Studio — pick the correct match manually.'],
          })
          needsReview++
        }
      }
    }
  }

  const workerCount = Math.min(MAX_ONSHAPE_CONCURRENCY, groupEntries.length)
  await Promise.all(Array.from({ length: workerCount }, worker))

  return { detected, needsReview, warnings }
}

// ── 'bodydetails' dataSource: axial-shaft (Phase 3) ────────────────
// Groups candidates by source Part Studio (same convention as the
// features path), fetches bodydetails ONCE per Part Studio scoped to
// just that group's partIds, then runs reconstructAxialSegments (Phase 2,
// pure function) per part. No FeatureScript/eval involvement at all —
// this detector is 100% geometry-driven, per
// AXIAL_SHAFT_DETECTION_ROADMAP.md.
//
// unitScale is hard-coded to inches (1/0.0254), matching the same
// inches-in-a-metric-API-response assumption the spacer detector already
// makes throughout (its dimensions are stored with unit: 'in'). A
// mixed-unit document would need real handling — not attempted in v1,
// same scope line spacer.js draws for internalAdd's unit.
const UNIT_SCALE_METERS_TO_INCHES = 1 / 0.0254

async function runBodyDetailsBasedDetection(supabase, detector, candidates) {
  let detected = 0
  let needsReview = 0
  const warnings = []

  const groups = new Map()
  for (const row of candidates) {
    const src = row.raw
    const key = bodyDetailsCacheKey(src.documentId, src.wvmType || 'w', src.wvmId, src.elementId, src.fullConfiguration)
    if (!groups.has(key)) {
      groups.set(key, { documentId: src.documentId, wvmType: src.wvmType || 'w', wvmId: src.wvmId, elementId: src.elementId, rows: [] })
    }
    groups.get(key).rows.push(row)
  }

  const groupEntries = [...groups.values()]
  let cursor = 0
  async function worker() {
    while (cursor < groupEntries.length) {
      const group = groupEntries[cursor++]

      // partId identifies which body in the (possibly multi-part)
      // response belongs to which BOM row — same field the spacer
      // detector's "Open Questions" flags as unresolved for its own
      // partId/feature correlation, but here it's exactly what we need
      // and nothing more, since bodydetails keys bodies by id === partId
      // directly (no feature correlation required at all).
      const rowsWithPartId = group.rows.filter(r => r.raw.partId)
      const rowsMissingPartId = group.rows.filter(r => !r.raw.partId)

      for (const row of rowsMissingPartId) {
        await writeMetadata(supabase, row.id, {
          autoDetected: true,
          kind: detector.kind,
          status: 'needs_review',
          confidence: 'low',
          source: 'onshape-bodydetails',
          warnings: ['This BOM row has no recorded partId — cannot fetch its geometry.'],
        })
        needsReview++
      }

      if (!rowsWithPartId.length) continue

      const partIds = rowsWithPartId.map(r => r.raw.partId)
      let bodyDetailsResponse
      try {
        bodyDetailsResponse = await fetchBodyDetails(group.documentId, group.wvmType, group.wvmId, group.elementId, partIds)
      } catch (e) {
        console.warn(`[onshape-detect-fabrication] bodydetails fetch failed for Part Studio ${group.elementId}: ${e.message}`)
        warnings.push(`Could not fetch body details for Part Studio ${group.elementId}: ${e.message}`)
        for (const row of rowsWithPartId) {
          await writeMetadata(supabase, row.id, {
            autoDetected: true,
            kind: detector.kind,
            status: 'needs_review',
            confidence: 'low',
            source: 'onshape-bodydetails',
            warnings: [`Body details fetch failed: ${e.message}`],
          })
          needsReview++
        }
        continue
      }

      for (const row of rowsWithPartId) {
        const partId = row.raw.partId
        const body = findBodyByPartId(bodyDetailsResponse, partId)

        if (!body) {
          await writeMetadata(supabase, row.id, {
            autoDetected: true,
            kind: detector.kind,
            status: 'needs_review',
            confidence: 'low',
            source: 'onshape-bodydetails',
            warnings: ['Part not found in the body details response — it may have been deleted, renamed, or reconfigured since import.'],
          })
          needsReview++
          continue
        }

        let result
        try {
          result = reconstructAxialSegments(body, { unitScale: UNIT_SCALE_METERS_TO_INCHES })
        } catch (e) {
          console.warn(`[onshape-detect-fabrication] axial-shaft reconstruction failed for part ${partId}: ${e.message}`)
          await writeMetadata(supabase, row.id, {
            autoDetected: true,
            kind: detector.kind,
            status: 'needs_review',
            confidence: 'low',
            source: 'onshape-bodydetails',
            warnings: [`Geometry reconstruction failed: ${e.message}`],
          })
          needsReview++
          continue
        }

        await writeMetadata(supabase, row.id, {
          autoDetected: true,
          kind: detector.kind,
          status: result.status,
          confidence: result.confidence,
          source: 'onshape-bodydetails',
          generator: detector.generatorId,
          axis: result.axis,
          dimensions: result.dimensions,
          onshape: { documentId: group.documentId, wvmType: group.wvmType, wvmId: group.wvmId, elementId: group.elementId, partId },
          warnings: result.warnings,
        })

        if (result.status === 'detected') detected++
        else needsReview++
      }
    }
  }

  const workerCount = Math.min(MAX_ONSHAPE_CONCURRENCY, groupEntries.length)
  await Promise.all(Array.from({ length: workerCount }, worker))

  return { detected, needsReview, warnings }
}

async function writeMetadata(supabase, partId, metadata) {
  const { error } = await supabase
    .from('assembly_parts')
    .update({ fabrication_metadata: metadata })
    .eq('id', partId)
  if (error) console.warn(`[onshape-detect-fabrication] Failed writing metadata for part ${partId}: ${error.message}`)
}
