// services/DetectionService.js
//
// Migration Plan Phase 1, item 7 ("Fabrication detectors"). The three
// geometry classifiers under api/_lib/detectors/*.js (spacer,
// axial-shaft, plate) were already pure functions with no SQL — nothing
// about THEM needed to change. What this service extracts is the
// orchestration that used to live directly in
// api/onshape-detect-fabrication.js: walking a candidate's whole part
// tree, grouping candidates by source Part Studio so each one is
// fetched exactly once, running every registered detector in priority
// order with the claim-ordering rule (spacer/axial-shaft claim first,
// plate only runs on rows nothing else claimed — see
// PLATE_DETECTION_ROADMAP.md), and persisting each result. None of that
// orchestration touches Postgres directly anymore — it goes through
// AssemblyRepository / AssemblyPartRepository, same as every other
// service in this codebase.
//
// api/_lib/fabrication-detectors.js (the DETECTORS registry) and
// api/_lib/onshape-bodydetails.js (the bodydetails fetch/cache-key
// helpers) are reused as-is, same "pure external-API/algorithm layer,
// not a repository" reasoning OnshapeImportService already applies to
// api/_lib/onshape.js.
//
// No @supabase/supabase-js import, no req/res.

import { fetchBodyDetails, bodyDetailsCacheKey, findBodyByPartId } from '../../api/_lib/onshape-bodydetails.js'
import { DETECTORS, candidateRowsForDetector } from '../../api/_lib/fabrication-detectors.js'
import { MAX_ONSHAPE_CONCURRENCY } from '../../api/_lib/onshape.js'
import { AssemblyRepository } from '../repositories/AssemblyRepository.js'
import { AssemblyPartRepository } from '../repositories/AssemblyPartRepository.js'
import { ValidationError, NotFoundError } from '../repositories/errors.js'

// A row already in one of these fabrication_metadata.status values won't
// change unless the underlying Onshape geometry does, so re-scanning it
// on every repeat click of "Detect fabrication candidates" (including
// reimports) would be pure wasted API calls. Mirrors the original
// endpoint's TERMINAL_DETECTION_STATUSES exactly.
const TERMINAL_DETECTION_STATUSES = ['confirmed', 'queued', 'ignored']

// Onshape's bodydetails response is always in meters; every detector's
// dimensions are stored with unit: 'in'. Same constant the original
// endpoint used — a mixed-unit document isn't handled, same scope line
// the original spacer detector drew for internalAdd's unit.
const UNIT_SCALE_METERS_TO_INCHES = 1 / 0.0254

export class DetectionService {
  constructor({
    assemblyRepo     = new AssemblyRepository(),
    assemblyPartRepo = new AssemblyPartRepository(),
  } = {}) {
    this.assemblyRepo     = assemblyRepo
    this.assemblyPartRepo = assemblyPartRepo
  }

  /**
   * Runs every registered detector against one assembly's whole part
   * tree and persists results onto each row's fabrication_metadata. No
   * fabrication_jobs are created here — that only happens once a user
   * (or the harness, via FabricationDetectionService) confirms a
   * 'detected' row. Returns the same summary shape the original route
   * responded with, so a route wrapping this needs no translation.
   */
  async detectFabricationCandidates({ assemblyId }) {
    if (!assemblyId) throw new ValidationError('assemblyId is required')

    const assembly = await this.assemblyRepo.findById(assemblyId)
    if (!assembly) throw new NotFoundError('Assembly not found.')
    if (!assembly.onshapeDocumentId) {
      throw new ValidationError('Assembly is not linked to Onshape.')
    }

    const { rows, skippedCount } = await this._fetchWholeTreeParts(assemblyId)
    const result = await this._detectAndPersist({ rows, rootDocumentId: assembly.onshapeDocumentId })

    const message = skippedCount
      ? `${result.message} (${skippedCount} already-confirmed row(s) skipped.)`
      : result.message

    return { skippedCount, ...result, message }
  }

  // ── Whole-tree fetch, shaped for the detectors' candidateFilter ────
  async _fetchWholeTreeParts(assemblyId) {
    const allParts = await this.assemblyPartRepo.findTreeForAssembly(assemblyId)

    const eligible = allParts.filter(row => !TERMINAL_DETECTION_STATUSES.includes(row.fabricationMetadata?.status))
    const skippedCount = allParts.length - eligible.length

    return {
      rows: eligible.map(row => ({
        id:               row.id,
        partName:         row.partName,
        partNumber:       row.partNumber,
        raw:              row.onshapeReference || {},
        existingMetadata: row.fabricationMetadata || null,
      })),
      skippedCount,
    }
  }

  // ── Group candidates by source Part Studio, dispatch to each detector ──
  async _detectAndPersist({ rows, rootDocumentId }) {
    let candidateCount = 0
    let detectedCount  = 0
    let needsReviewCount = 0
    let ignoredCount = 0
    const warnings = []

    const claimedByEarlierDetector = new Set()

    // Detector priority as an index lookup — DETECTORS' array order
    // (spacer, axial-shaft, plate) is the single source of truth. Used
    // to check a row's PERSISTED classification from a prior run, not
    // just detectors that ran earlier in this same pass.
    const detectorRank = Object.fromEntries(DETECTORS.map((d, i) => [d.kind, i]))

    function claimedByHigherPriorityDetector(row, detector) {
      const existingKind = row.existingMetadata?.kind
      if (!existingKind || existingKind === detector.kind) return false
      const existingStatus = row.existingMetadata?.status
      if (existingStatus !== 'detected' && existingStatus !== 'confirmed' && existingStatus !== 'queued') return false
      const existingRank = detectorRank[existingKind]
      const thisRank     = detectorRank[detector.kind]
      return existingRank !== undefined && existingRank < thisRank
    }

    for (const detector of DETECTORS) {
      let candidates = candidateRowsForDetector(detector, rows, rootDocumentId)
      candidates = candidates.filter(r =>
        !claimedByEarlierDetector.has(r.id) && !claimedByHigherPriorityDetector(r, detector)
      )
      candidateCount += candidates.length

      const ignoredRows = rows.filter(r =>
        !candidates.includes(r) &&
        !claimedByEarlierDetector.has(r.id) &&
        !claimedByHigherPriorityDetector(r, detector) &&
        detector.candidateFilter(r) &&
        !detector.isFromRootDocument(r, rootDocumentId)
      )
      for (const row of ignoredRows) {
        await this.assemblyPartRepo.updateFabricationMetadata(row.id, {
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

      const stats = await this._runBodyDetailsBasedDetection(detector, candidates, {
        onRowClassified: (row, res) => {
          if (res.status === 'detected') claimedByEarlierDetector.add(row.id)
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

  // ── Shared bodydetails pipeline for every geometry-driven detector ──
  async _runBodyDetailsBasedDetection(detector, candidates, { onRowClassified = () => {} } = {}) {
    let detected = 0
    let needsReview = 0
    const warnings = []
    // Fresh per call, not module-level — a Part Studio's sheet-metal
    // exclusion result is only worth memoizing for the duration of ONE
    // detect run, not across unrelated requests sharing a warm lambda.
    const postGeometryCheckCache = new Map()

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
    const assemblyPartRepo = this.assemblyPartRepo
    let cursor = 0

    const worker = async () => {
      while (cursor < groupEntries.length) {
        const group = groupEntries[cursor++]

        const rowsWithPartId = group.rows.filter(r => r.raw.partId)
        const rowsMissingPartId = group.rows.filter(r => !r.raw.partId)

        for (const row of rowsMissingPartId) {
          const meta = {
            autoDetected: true, kind: detector.kind, status: 'needs_review', confidence: 'low',
            source: 'onshape-bodydetails',
            warnings: ['This BOM row has no recorded partId — cannot fetch its geometry.'],
          }
          await assemblyPartRepo.updateFabricationMetadata(row.id, meta)
          onRowClassified(row, meta)
          needsReview++
        }

        if (!rowsWithPartId.length) continue

        const partIds = rowsWithPartId.map(r => r.raw.partId)
        let bodyDetailsResponse
        try {
          bodyDetailsResponse = await fetchBodyDetails(group.documentId, group.wvmType, group.wvmId, group.elementId, partIds)
        } catch (e) {
          console.warn(`[DetectionService] bodydetails fetch failed for Part Studio ${group.elementId}: ${e.message}`)
          warnings.push(`Could not fetch body details for Part Studio ${group.elementId}: ${e.message}`)
          for (const row of rowsWithPartId) {
            const meta = {
              autoDetected: true, kind: detector.kind, status: 'needs_review', confidence: 'low',
              source: 'onshape-bodydetails', warnings: [`Body details fetch failed: ${e.message}`],
            }
            await assemblyPartRepo.updateFabricationMetadata(row.id, meta)
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
              autoDetected: true, kind: detector.kind, status: 'needs_review', confidence: 'low',
              source: 'onshape-bodydetails',
              warnings: ['Part not found in the body details response — it may have been deleted, renamed, or reconfigured since import.'],
            }
            await assemblyPartRepo.updateFabricationMetadata(row.id, meta)
            onRowClassified(row, meta)
            needsReview++
            continue
          }

          let result
          try {
            result = detector.classifyGeometry(body, { unitScale: UNIT_SCALE_METERS_TO_INCHES })
          } catch (e) {
            console.warn(`[DetectionService] ${detector.kind} classification failed for part ${partId}: ${e.message}`)
            const meta = {
              autoDetected: true, kind: detector.kind, status: 'needs_review', confidence: 'low',
              source: 'onshape-bodydetails', warnings: [`Geometry classification failed: ${e.message}`],
            }
            await assemblyPartRepo.updateFabricationMetadata(row.id, meta)
            onRowClassified(row, meta)
            needsReview++
            continue
          }

          // Optional post-geometry check (currently only plate.js's
          // sheet-metal exclusion) — only spent on rows that already
          // read as 'detected', and only ever downgrades toward review,
          // never silently drops or silently accepts.
          if (result.status === 'detected' && typeof detector.postGeometryCheck === 'function') {
            const cacheKey = `${detector.kind}::${group.documentId}::${group.wvmType}::${group.wvmId}::${group.elementId}`
            let notExcluded
            try {
              if (!postGeometryCheckCache.has(cacheKey)) {
                postGeometryCheckCache.set(cacheKey, detector.postGeometryCheck(group.documentId, group.wvmType, group.wvmId, group.elementId))
              }
              notExcluded = await postGeometryCheckCache.get(cacheKey)
            } catch (e) {
              console.warn(`[DetectionService] ${detector.kind} postGeometryCheck failed for part ${partId}: ${e.message}`)
              notExcluded = null
            }
            if (notExcluded === false) {
              result = {
                ...result, status: 'needs_review',
                warnings: [...result.warnings, 'Geometry matched, but this Part Studio appears to use a feature this detector excludes — please confirm manually.'],
              }
            } else if (notExcluded === null) {
              result = {
                ...result, status: 'needs_review',
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
          await assemblyPartRepo.updateFabricationMetadata(row.id, meta)
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
}
