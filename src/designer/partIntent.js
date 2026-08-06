// src/designer/partIntent.js
//
// Phase 0 of PARTS_CARD_UI_ROADMAP.md. Single source of truth for "what
// should this part's card show" — the badge row and the up-to-2 face
// action buttons (plus the always-present aux menu) are both derived from
// resolvePartIntent()/badgesForPart() here, so a card, the bulk-select
// carousel, and (once Phase 4 lands) the "Work through parts" carousel can
// never disagree about a part's state.
//
// Deliberately reuses existing pure helpers rather than reforking them:
//   - totalPromisedQty / partCanPromiseMore   from state.js
//   - fabDetectActionable                      from fabDetection.js
//
// hasResolvedMatch() needs Phase 3's bulk availability lookup
// (InventoryInstanceRepository.findAvailableSummaryForComponents) to ever
// return true. Until that's wired in, callers simply won't have real
// entries in availabilityByComponentId, so it safely resolves false on its
// own — no explicit stub/flag needed.

import { totalPromisedQty, partCanPromiseMore } from './state.js'
import { fabDetectActionable } from './fabDetection.js'

export const INTENT_PRIORITY = [
  'reviewCandidate', 'collectResolved', 'quickCollect', 'findInventory',
  'sendToFabricate', 'addToCart',
]

function hasActiveJob(job) {
  return !!job && job.status !== 'archived' && job.status !== 'complete'
}

function alreadyPromised(job, orders) {
  return hasActiveJob(job) || orders.some(order => order.status !== 'received')
}

function remainingNeeded(part, job, orders) {
  return part.quantityNeeded - part.quantityCollected - totalPromisedQty(job, orders)
}

/** True only once Phase 3 populates availabilityByComponentId — before
 *  that, every lookup misses and this returns false, same effect as an
 *  explicit stub without needing one. */
function hasResolvedMatch(part, job, orders, availabilityByComponentId) {
  if (!part.componentId) return false
  const entry = availabilityByComponentId[part.componentId]
  return !!entry && entry.totalAvailable >= remainingNeeded(part, job, orders)
}

/**
 * Resolves one part's card-facing intent: `main` is the ordered list of
 * applicable actions (face buttons are `main.slice(0, 2)`, anything past
 * that goes in the "more actions" overflow — see PARTS_CARD_UI_ROADMAP.md
 * Phase 1), `aux` is the fixed, status-invariant set that's always
 * available regardless of state (edit/history/delete should never be
 * nullified by e.g. a pending detection review).
 */
export function resolvePartIntent(part, { job = null, orders = [], availabilityByComponentId = {} } = {}) {
  const main = []

  if (fabDetectActionable(part)) {
    main.push('reviewCandidate')
  } else if (!alreadyPromised(job, orders) && partCanPromiseMore(part, job, orders)) {
    main.push('quickCollect')
    if (part.componentId && hasResolvedMatch(part, job, orders, availabilityByComponentId)) {
      main.push('collectResolved')
    } else {
      main.push('findInventory')
    }
    main.push('sendToFabricate')
    main.push('addToCart')
  }
  return {
    main,
    aux: ['edit', 'history', 'delete'],
  }
}

// ── Badge descriptors ────────────────────────────────────────────────
// Returned as plain { key, label, className } objects, not HTML — the
// card renderer (Phase 1) owns turning these into markup, same
// separation state.js's other derived-data helpers already keep from
// rendering.

function kindToNoun(kind) {
  if (kind === 'axial-shaft') return 'shaft'
  if (kind === 'plate') return 'plate'
  return 'spacer'
}

// Mirrors fabDetectionBadgeHTML's status map in fabDetection.js, minus
// 'confirmed' — nothing in FabricationDetectionService ever writes that
// status (confirming a detection goes straight to 'queued'), so it's
// dropped here rather than carried forward as dead branches.
const DETECTION_BADGE_MAP = {
  detected:     ['badge--success', 'ti-cube-plus',     kindNoun => `${cap(kindNoun)} detected`],
  needs_review: ['badge--warning', 'ti-help-circle',   () => 'Needs review'],
  queued:       ['badge--accent',  'ti-tool',          () => 'In fab queue'],
  ignored:      ['badge--muted',   'ti-eye-off',        kindNoun => `Not a ${kindNoun}`],
  failed:       ['badge--warning', 'ti-alert-triangle',() => 'Detection failed'],
}
function cap(s) { return s[0].toUpperCase() + s.slice(1) }

function detectionBadgeFor(status, noun) {
  const entry = DETECTION_BADGE_MAP[status]
  if (!entry) return null
  const [className, icon, labelFn] = entry
  return { key: `detection-${status}`, label: labelFn(noun), className, icon }
}

// Mirrors fabJobBadgeHTML's status map in partsTable.js, so a card and
// the existing row badge never drift apart on job-status wording.
const JOB_BADGE_MAP = {
  queued:      ['badge--muted',   'ti-tool',     () => 'Queued for fab'],
  committed:   ['badge--warning', 'ti-hand-stop',job => `Claimed${job.claimedBy ? ' by ' + job.claimedBy : ''}`],
  in_progress: ['badge--warning', 'ti-loader-2', job => `Machining ${job.quantityMachined}/${job.quantityRequested}`],
  complete:    ['badge--success', 'ti-check',    () => 'Fab complete'],
}

function jobBadgeFor(job) {
  const entry = JOB_BADGE_MAP[job.status]
  if (!entry) return null
  const [className, icon, labelFn] = entry
  return { key: `job-${job.status}`, label: labelFn(job), className, icon }
}

function pendingStatusBadge(part) {
  const collected = part.quantityCollected || 0
  if (collected >= part.quantityNeeded) return { key: 'status-complete', label: 'Complete', className: 'badge--success', icon: 'ti-check' }
  if (collected > 0) return { key: 'status-partial', label: 'Partial', className: 'badge--warning', icon: 'ti-loader-2' }
  return { key: 'status-pending', label: 'Pending', className: 'badge--muted', icon: 'ti-circle-dashed' }
}

/** One badge list for a card (or a carousel step) — badges never
 *  computed twice with two different rule sets. */
export function badgesForPart(part, job = null, orders = []) {
  const badges = []
  const meta = part.fabricationMetadata || {}

  if (meta.autoDetected) {
    const badge = detectionBadgeFor(meta.status, kindToNoun(meta.kind))
    if (badge) badges.push(badge)
  }

  if (job) {
    const badge = jobBadgeFor(job)
    if (badge) badges.push(badge)
  }

  if (orders.some(order => order.status === 'pending')) {
    badges.push({ key: 'cart-pending', label: 'In cart', className: 'badge--muted', icon: 'ti-truck-delivery' })
  }

  if (!badges.length) badges.push(pendingStatusBadge(part))

  return badges
}