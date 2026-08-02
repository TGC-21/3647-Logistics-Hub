import { describe, it, expect } from 'vitest'
import { resolvePartIntent, badgesForPart, INTENT_PRIORITY } from '../partIntent.js'

// ── Fixtures — same 9 shapes validated in parts-card-prototype-v2.html,
//    ported from { part, job, orders } grouped together the way the
//    prototype's PARTS array had them, into the { part, job, orders }
//    triple resolvePartIntent/badgesForPart actually take. ────────────

const fixtures = {
  queuedJob: {
    part: {
      id: 'p1', partName: 'O200 Pivot Plate', componentId: 'c1',
      quantityNeeded: 4, quantityCollected: 0,
      fabricationMetadata: { autoDetected: true, kind: 'plate', status: 'queued' },
    },
    job: { status: 'queued', quantityRequested: 3, quantityMachined: 0 },
    orders: [],
  },
  highConfidenceDetection: {
    part: {
      id: 'p2', partName: 'O201 Gear Shaft', componentId: null,
      quantityNeeded: 2, quantityCollected: 0,
      fabricationMetadata: { autoDetected: true, kind: 'axial-shaft', status: 'detected', confidence: 'high' },
    },
    job: null, orders: [],
  },
  plainUndetected: {
    part: {
      id: 'p3', partName: '18T Spur Gear', componentId: 'c3',
      quantityNeeded: 2, quantityCollected: 0,
      fabricationMetadata: {},
    },
    job: null, orders: [],
  },
  needsReview: {
    part: {
      id: 'p4', partName: 'O204 End Cap', componentId: 'c4',
      quantityNeeded: 6, quantityCollected: 2,
      fabricationMetadata: { autoDetected: true, kind: 'plate', status: 'needs_review', confidence: 'medium' },
    },
    job: null, orders: [],
  },
  complete: {
    part: {
      id: 'p5', partName: '1/4-20 x 1" SHCS', componentId: 'c5',
      quantityNeeded: 12, quantityCollected: 12,
      fabricationMetadata: {},
    },
    job: null, orders: [],
  },
  inProgressJob: {
    part: {
      id: 'p6', partName: 'O207 Standoff Spacer', componentId: 'c6',
      quantityNeeded: 4, quantityCollected: 1,
      fabricationMetadata: { autoDetected: true, kind: 'spacer', status: 'queued' },
    },
    job: { status: 'in_progress', quantityRequested: 3, quantityMachined: 1 },
    orders: [],
  },
  ignored: {
    part: {
      id: 'p7', partName: 'Legacy Riser Plate', componentId: null,
      quantityNeeded: 1, quantityCollected: 0,
      fabricationMetadata: { autoDetected: true, kind: 'plate', status: 'ignored' },
    },
    job: null, orders: [],
  },
  pendingCartOrder: {
    part: {
      id: 'p8', partName: 'NEMA 17 Stepper Motor', componentId: null,
      quantityNeeded: 2, quantityCollected: 0,
      fabricationMetadata: {},
    },
    job: null, orders: [{ status: 'pending', quantity: 2 }],
  },
  resolvedMatch: {
    part: {
      id: 'p9', partName: 'Bearing 608ZZ', componentId: 'c9',
      quantityNeeded: 8, quantityCollected: 0,
      fabricationMetadata: {},
    },
    job: null, orders: [],
  },
}

describe('resolvePartIntent', () => {
  it('reviewCandidate wins outright, even if the part could otherwise promise more', () => {
    const { main } = resolvePartIntent(fixtures.highConfidenceDetection.part, fixtures.highConfidenceDetection)
    expect(main).toEqual(['reviewCandidate'])
  })

  it('needs_review is just as actionable as detected', () => {
    const { main } = resolvePartIntent(fixtures.needsReview.part, fixtures.needsReview)
    expect(main[0]).toBe('reviewCandidate')
  })

  it('an active (non-terminal) job suppresses all main actions, even with gap remaining', () => {
    const { main } = resolvePartIntent(fixtures.queuedJob.part, fixtures.queuedJob)
    expect(main).toEqual([])
  })

  it('an in-progress job suppresses main actions the same way a queued one does', () => {
    const { main } = resolvePartIntent(fixtures.inProgressJob.part, fixtures.inProgressJob)
    expect(main).toEqual([])
  })

  it('a pending (non-received) cart order counts as already promised', () => {
    const { main } = resolvePartIntent(fixtures.pendingCartOrder.part, fixtures.pendingCartOrder)
    expect(main).toEqual([])
  })

  it('fully collected + nothing promised -> no main actions', () => {
    const { main } = resolvePartIntent(fixtures.complete.part, fixtures.complete)
    expect(main).toEqual([])
  })

  it('an ignored detection with no component falls through to findInventory, not collectResolved', () => {
    const { main } = resolvePartIntent(fixtures.ignored.part, fixtures.ignored)
    expect(main).toEqual(['findInventory', 'sendToFabricate', 'addToCart'])
  })

  it('Phase 0 default (no availability data passed): a real component still resolves to findInventory, never collectResolved', () => {
    const { main } = resolvePartIntent(fixtures.plainUndetected.part, fixtures.plainUndetected)
    expect(main).toEqual(['findInventory', 'sendToFabricate', 'addToCart'])
    expect(main).not.toContain('collectResolved')
  })

  it('once availability data is supplied (Phase 3), a fully-covered component resolves to collectResolved first', () => {
    const availabilityByComponentId = { c9: { totalAvailable: 8, locationCount: 1 } }
    const { main } = resolvePartIntent(fixtures.resolvedMatch.part, { ...fixtures.resolvedMatch, availabilityByComponentId })
    expect(main).toEqual(['collectResolved', 'sendToFabricate', 'addToCart'])
  })

  it('availability data that falls short of remaining need still falls through to findInventory', () => {
    const availabilityByComponentId = { c9: { totalAvailable: 3, locationCount: 1 } }   // need 8, only 3 on hand
    const { main } = resolvePartIntent(fixtures.resolvedMatch.part, { ...fixtures.resolvedMatch, availabilityByComponentId })
    expect(main).toEqual(['findInventory', 'sendToFabricate', 'addToCart'])
  })

  it('aux is fixed and status-invariant across every fixture', () => {
    for (const { part, job, orders } of Object.values(fixtures)) {
      const { aux } = resolvePartIntent(part, { job, orders })
      expect(aux).toEqual(['edit', 'history', 'delete'])
    }
  })

  it('INTENT_PRIORITY names exactly the 5 action kinds resolvePartIntent can emit', () => {
    expect(INTENT_PRIORITY).toEqual(['reviewCandidate', 'collectResolved', 'findInventory', 'sendToFabricate', 'addToCart'])
  })

  it('tolerates missing job/orders/availability entirely (defaults apply)', () => {
    expect(() => resolvePartIntent(fixtures.plainUndetected.part)).not.toThrow()
    const { main } = resolvePartIntent(fixtures.plainUndetected.part)
    expect(main).toEqual(['findInventory', 'sendToFabricate', 'addToCart'])
  })
})

describe('badgesForPart', () => {
  it('never emits a confirmed badge — that status is never actually written by FabricationDetectionService', () => {
    const part = { fabricationMetadata: { autoDetected: true, kind: 'spacer', status: 'confirmed' }, quantityNeeded: 2, quantityCollected: 0 }
    const badges = badgesForPart(part)
    expect(badges.some(b => b.key.includes('confirmed'))).toBe(false)
    // No recognized detection status -> falls through to the pending/partial/complete fallback instead of silently emitting nothing.
    expect(badges).toEqual([{ key: 'status-pending', label: 'Pending', className: 'badge--muted', icon: 'ti-circle-dashed' }])
  })

  it('composes a detection badge and a job badge together (queued detection + in-progress job)', () => {
    const badges = badgesForPart(fixtures.inProgressJob.part, fixtures.inProgressJob.job, fixtures.inProgressJob.orders)
    expect(badges.map(b => b.label)).toEqual(['In fab queue', 'Machining 1/3'])
  })

  it('shows an "In cart" badge for a pending order with no detection metadata', () => {
    const badges = badgesForPart(fixtures.pendingCartOrder.part, fixtures.pendingCartOrder.job, fixtures.pendingCartOrder.orders)
    expect(badges).toEqual([{ key: 'cart-pending', label: 'In cart', className: 'badge--muted', icon: 'ti-truck-delivery' }])
  })

  it('falls back to a pending/partial/complete status badge when nothing else applies', () => {
    expect(badgesForPart(fixtures.complete.part).map(b => b.label)).toEqual(['Complete'])
    expect(badgesForPart(fixtures.needsReview.part.componentId ? { ...fixtures.needsReview.part, fabricationMetadata: {} } : fixtures.needsReview.part).map(b => b.label)).toEqual(['Partial'])
    expect(badgesForPart(fixtures.plainUndetected.part).map(b => b.label)).toEqual(['Pending'])
  })

  it('detected/needs_review/queued/ignored/failed all still produce a badge (map wasn\'t accidentally gutted alongside dropping confirmed)', () => {
    for (const status of ['detected', 'needs_review', 'queued', 'ignored', 'failed']) {
      const part = { fabricationMetadata: { autoDetected: true, kind: 'plate', status }, quantityNeeded: 1, quantityCollected: 0 }
      const badges = badgesForPart(part)
      expect(badges).toHaveLength(1)
      expect(badges[0].key).toBe(`detection-${status}`)
    }
  })
})