// api/onshape-detect-fabrication.js — Vercel serverless function
//
// Button-triggered fabrication-candidate detection (see
// SPACER_AUTO_DETECTION_ROADMAP.md, AXIAL_SHAFT_DETECTION_ROADMAP.md,
// and PLATE_DETECTION_ROADMAP.md). Deliberately NOT run automatically
// during import/reimport — the user clicks "Detect fabrication
// candidates" on an assembly, and this walks its part tree, groups
// candidate rows by source Part Studio, fetches each Part Studio's
// geometry exactly once, and writes results onto assembly_parts.
// fabrication_metadata. No fabrication_jobs are created here — that only
// happens when the user confirms a detected row in the UI.
//
// All three registered detectors (see fabrication-detectors.js) are
// 100% geometry-driven — spacer, axial-shaft, and plate each read real
// B-rep geometry via .../bodydetails and classify it with their own
// `classifyGeometry(body, opts)`, rather than touching FeatureScript
// parameters or the .../featurescript eval endpoint.
//
// Every detector shares ONE fetch/classify pipeline
// (runBodyDetailsBasedDetection): group candidates by source Part
// Studio, fetch bodydetails once per Part Studio (scoped to just that
// group's partIds), then hand each row's body to its detector's
// classifyGeometry(). The per-detector candidate/ignored-row bookkeeping
// is shared; only the classification step is detector-specific, and it's
// dispatched through a uniform interface rather than a dataSource switch.
//
// CLAIM ORDERING (see PLATE_DETECTION_ROADMAP.md): a part's name can
// legitimately contain more than one detector's keyword — e.g. a part
// named "Spacer Plate" matches both spacer's and plate's candidateFilter.
// DETECTORS' array order (spacer, axial-shaft, plate) is the single
// source of truth for priority. `claimedByEarlierDetector` tracks every
// row ANY earlier detector successfully classified as 'detected', and
// every later detector's candidate list is filtered against it BEFORE
// that detector runs — so a row spacer already detected never reaches
// plate's classifyGeometry at all, and therefore can never have its
// (correct) spacer fabrication_metadata overwritten by a worse/incorrect
// plate read of the same geometry. This generalizes what used to be a
// spacer-only special case (`claimedBySpacer`, checked only by
// axial-shaft) into a running set every detector in the list consults.
//
// POST /api/onshape-detect-fabrication  { assemblyId }

import { createClient } from '@supabase/supabase-js'
import { applyCors, MAX_ONSHAPE_CONCURRENCY } from './_lib/onshape.js'
import { fetchBodyDetails, bodyDetailsCacheKey, findBodyByPartId } from './_lib/onshape-bodydetails.js'
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
// won't change unless the underlying Onshape geometry does, so re-fetching
// their source Part Studio on every repeat click of "Detect fabrication
// candidates" (including reimports) would be pure wasted API calls.
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

// ── Group candidates by source Part Studio, dispatch to each detector ──
async function detectAndPersist(supabase, { rows, rootDocumentId }) {
  let candidateCount = 0
  let detectedCount  = 0
  let needsReviewCount = 0
  let ignoredCount = 0
  const warnings = []

  // Rows whose name matches more than one detector's keyword filter
  // (e.g. "Spacer Plate", a hex-profile spacer matching axial-shaft's
  // "hex" keyword) are structurally ambiguous by name alone. This set
  // tracks every row ANY earlier detector in DETECTORS' order has
  // already classified as 'detected' — every later detector's candidate
  // list is filtered against it before that detector's bodydetails pass
  // even runs, so a confirmed-good classification from an earlier
  // detector is never re-fetched, re-classified, or overwritten by a
  // later detector's (necessarily worse, since it wasn't the first
  // match) read of the same geometry. This replaces what used to be a
  // spacer-only special case checked only by axial-shaft.
  const claimedByEarlierDetector = new Set()

  for (const detector of DETECTORS) {
    let candidates = candidateRowsForDetector(detector, rows, rootDocumentId)
    candidates = candidates.filter(r => !claimedByEarlierDetector.has(r.id))
    candidateCount += candidates.length

    // Rows filtered out by candidateFilter/isFromRootDocument but whose
    // name still mentions the detector's kind get marked 'ignored' so the
    // UI can distinguish "we looked and it's not ours" from "never
    // considered". Cheap and just a name-substring check. Rows already
    // claimed by an earlier detector are deliberately excluded from this
    // ignored-marking too — they're not "ignored," they're already
    // correctly classified by someone else, and re-marking them here
    // would overwrite that correct metadata just as surely as running
    // the detector's geometry pass would.
    const ignoredRows = rows.filter(r =>
      !candidates.includes(r) &&
      !claimedByEarlierDetector.has(r.id) &&
      detector.candidateFilter(r) &&
      !detector.isFromRootDocument(r, rootDocumentId)
    )
    for (const row of ignoredRows) {
      await writeMetadata(supabase, row.id, {
        autoDetected: true,
        kind: detector.kind,
        status: 'ignored',
        confidence: 'high',
        source: 'onshape-bodydetails',
        warnings: ['Source document differs from the imported assembly\'s root document — treated as vendor/COTS.'],
      })
      ignoredCount++
    }

    if (!candidates.length) continue

    const stats = await runBodyDetailsBasedDetection(supabase, detector, candidates, {
      onRowClassified: (row, result) => {
        if (result.status === 'detected') claimedByEarlierDetector.add(row.id)
      },
    })

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

// ── Shared bodydetails pipeline for every geometry-driven detector ─────
// Groups candidates by source Part Studio (one bodydetails fetch per
// group, scoped to just that group's partIds), then hands each row's
// resolved body to `detector.classifyGeometry(body, opts)` — every
// registered detector implements this with the same
// { status, confidence, warnings, extra } return shape, so this function
// has no detector-specific branching for classification itself.
//
// A detector may also declare an optional async `postGeometryCheck`
// (currently only plate.js's sheet-metal exclusion) — run only for rows
// that already classified as 'detected', since it costs an extra
// Onshape call and there's no reason to pay it for a row headed to
// needs_review regardless.
//
// unitScale is hard-coded to inches (1/0.0254): Onshape's bodydetails
// response is always in meters, and every detector's dimensions are
// stored with unit: 'in'. A mixed-unit document would need real handling
// — not attempted in v1, same scope line the original spacer detector
// drew for internalAdd's unit.
const UNIT_SCALE_METERS_TO_INCHES = 1 / 0.0254

const postGeometryCheckCache = new Map()

function cachedPostGeometryCheck(documentId, wvmType, wvmId, elementId) {
  const key = `${documentId}::${wvmType}::${wvmId}::${elementId}`
  if (!postGeometryCheckCache.has(key)) {
    postGeometryCheckCache.set(key, detector.postGeometryCheck(documentId, wvmType, wvmId, elementId))
  }
  return postGeometryCheckCache.get(key)
}

async function runBodyDetailsBasedDetection(supabase, detector, candidates, { onRowClassified = () => {} } = {}) {
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
      // response belongs to which BOM row — bodydetails keys bodies by
      // id === partId directly, no feature correlation required.
      const rowsWithPartId = group.rows.filter(r => r.raw.partId)
      const rowsMissingPartId = group.rows.filter(r => !r.raw.partId)

      for (const row of rowsMissingPartId) {
        const meta = {
          autoDetected: true,
          kind: detector.kind,
          status: 'needs_review',
          confidence: 'low',
          source: 'onshape-bodydetails',
          warnings: ['This BOM row has no recorded partId — cannot fetch its geometry.'],
        }
        await writeMetadata(supabase, row.id, meta)
        onRowClassified(row, meta)
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
          const meta = {
            autoDetected: true,
            kind: detector.kind,
            status: 'needs_review',
            confidence: 'low',
            source: 'onshape-bodydetails',
            warnings: [`Body details fetch failed: ${e.message}`],
          }
          await writeMetadata(supabase, row.id, meta)
          onRowClassified(row, meta)
          needsReview++
        }
        continue
      }

      for (const row of rowsWithPartId) {
        const partId = row.raw.partId
        const body = findBodyByPartId(bodyDetailsResponse, partId)

        if (!body) {
          const meta = {
            autoDetected: true,
            kind: detector.kind,
            status: 'needs_review',
            confidence: 'low',
            source: 'onshape-bodydetails',
            warnings: ['Part not found in the body details response — it may have been deleted, renamed, or reconfigured since import.'],
          }
          await writeMetadata(supabase, row.id, meta)
          onRowClassified(row, meta)
          needsReview++
          continue
        }

        let result
        try {
          result = detector.classifyGeometry(body, { unitScale: UNIT_SCALE_METERS_TO_INCHES })
        } catch (e) {
          console.warn(`[onshape-detect-fabrication] ${detector.kind} classification failed for part ${partId}: ${e.message}`)
          const meta = {
            autoDetected: true,
            kind: detector.kind,
            status: 'needs_review',
            confidence: 'low',
            source: 'onshape-bodydetails',
            warnings: [`Geometry classification failed: ${e.message}`],
          }
          await writeMetadata(supabase, row.id, meta)
          onRowClassified(row, meta)
          needsReview++
          continue
        }

        // Optional post-geometry check (currently: plate.js's sheet-metal
        // exclusion) — only spent on rows that already read as 'detected',
        // and only ever downgrades toward review, never silently drops
        // or silently accepts.
        if (result.status === 'detected' && typeof detector.postGeometryCheck === 'function') {
          let notExcluded
          try {
            notExcluded = await cachedPostGeometryCheck(group.documentId, group.wvmType, group.wvmId, group.elementId)
          } catch (e) {
            console.warn(`[onshape-detect-fabrication] ${detector.kind} postGeometryCheck failed for part ${partId}: ${e.message}`)
            notExcluded = null
          }
          if (notExcluded === false) {
            result = {
              ...result,
              status: 'needs_review',
              warnings: [...result.warnings, 'Geometry matched, but this Part Studio appears to use a feature this detector excludes — please confirm manually.'],
            }
          } else if (notExcluded === null) {
            result = {
              ...result,
              status: 'needs_review',
              warnings: [...result.warnings, 'Could not confirm this part against an exclusion check — please confirm manually.'],
            }
          }
        }

        const meta = {
          autoDetected: true,
          kind: detector.kind,
          status: result.status,
          confidence: result.confidence,
          source: 'onshape-bodydetails',
          generator: detector.generatorId,
          onshape: { documentId: group.documentId, wvmType: group.wvmType, wvmId: group.wvmId, elementId: group.elementId, partId },
          warnings: result.warnings,
          ...result.extra,
        }
        await writeMetadata(supabase, row.id, meta)
        onRowClassified(row, result)

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
