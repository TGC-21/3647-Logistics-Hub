// backend/_lib/harnessPolicy.js
//
// The hardcoded severity map (Migration Plan / AGENTIC_HARNESS.md Phase
// 3, product decision: "a hardcoded table/map that links each level to
// certain functions the agent can call without confirmation"). Keyed by
// "ServiceName.methodName" — the same string a future tool registry
// would use to name a tool 1:1 against a service method (per
// MIGRATION_PLAN.md's Phase 4 framing).
//
// Not stored in the DB on purpose: severity is a property of the CODE
// (what a method does), not per-member configurable data — only the
// trust level threshold is per-member/config.
//
// MAX_TRUST_LEVEL is the developer-controlled ceiling from the product
// decision "trust level cannot exceed the hardcoded value" — raising it
// requires a deploy, not a settings screen.
export const MAX_TRUST_LEVEL = 1   // start conservative; raise deliberately as the harness proves out

export const SEVERITY = { READ: 'read', WRITE: 'write', DESTRUCTIVE: 'destructive' }

// Minimum effective trust level at which an action of a given severity
// auto-executes WITHOUT confirmation. Below this, the caller must go
// through the ConfirmationRequiredError -> pending_actions -> approve
// flow. Mirrors the hierarchy agreed in the design conversation:
//   0 - everything needs confirmation, including reads
//   1 - reads auto-execute; writes/destructive still need confirmation
//   2 - reads + writes auto-execute; destructive still needs confirmation
//   3 - everything auto-executes
const MIN_TRUST_FOR_SEVERITY = {
  [SEVERITY.READ]:        1,
  [SEVERITY.WRITE]:       2,
  [SEVERITY.DESTRUCTIVE]: 3,
}

// One entry per service method the harness is allowed to call at all —
// methods absent from this map are NOT callable by the harness, full
// stop, regardless of trust level (fail closed, not fail open).
//
// Refactor note: Partshelf was cut down to an inventory-only tracker
// (Designer/Fabricate/Part Orders/Agenda/Onshape import all moved to
// deprecated/ — see harnessServiceRegistry.js). Every action tied to
// those domains was removed from this map along with them; only
// Categories/Components/Inventory Instances remain.
export const ACTION_SEVERITY = {
  // Categories
  'CategoryService.getById':                  SEVERITY.READ,
  'CategoryService.list':                     SEVERITY.READ,
  'CategoryService.create':                   SEVERITY.WRITE,
  'CategoryService.update':                   SEVERITY.WRITE,
  'CategoryService.delete':                   SEVERITY.DESTRUCTIVE,

  // Components
  'ComponentService.listAll':                 SEVERITY.READ,
  'ComponentService.search':                  SEVERITY.READ,
  'ComponentService.findOrCreate':            SEVERITY.WRITE,
  'ComponentService.updateFallback':          SEVERITY.WRITE,
  'ComponentService.deleteIfOrphaned':        SEVERITY.DESTRUCTIVE,

  // Inventory Instances
  'InventoryInstanceService.listAll':               SEVERITY.READ,
  'InventoryInstanceService.listForComponent':      SEVERITY.READ,
  'InventoryInstanceService.listForComponents':     SEVERITY.READ,
  'InventoryInstanceService.getById':               SEVERITY.READ,
  'InventoryInstanceService.getByIds':              SEVERITY.READ,
  'InventoryInstanceService.createInstance':        SEVERITY.WRITE,
  'InventoryInstanceService.updateInstance':        SEVERITY.WRITE,
  'InventoryInstanceService.deleteInstance':        SEVERITY.DESTRUCTIVE,
  'InventoryInstanceService.bulkDeleteInstances':   SEVERITY.DESTRUCTIVE,
}

/** effectiveTrustLevel = min(member's own trust_level, MAX_TRUST_LEVEL) —
 *  per product decision, a member/admin can only ever lower their own
 *  ceiling, never exceed the developer-set maximum. */
export function effectiveTrustLevel(memberTrustLevel) {
  return Math.min(memberTrustLevel ?? 0, MAX_TRUST_LEVEL)
}

/** Returns true if an action of this name may auto-execute for a member
 *  at this trust level. Throws if the action isn't in the map at all —
 *  an unlisted action is never callable by the harness, confirmation or
 *  not (fail closed). */
export function canAutoExecute(actionName, memberTrustLevel) {
  const severity = ACTION_SEVERITY[actionName]
  if (!severity) {
    throw new Error(`"${actionName}" is not in the harness action policy map — not callable by the harness.`)
  }
  return effectiveTrustLevel(memberTrustLevel) >= MIN_TRUST_FOR_SEVERITY[severity]
}

export function severityOf(actionName) {
  const severity = ACTION_SEVERITY[actionName]
  if (!severity) {
    throw new Error(`"${actionName}" is not in the harness action policy map — not callable by the harness.`)
  }
  return severity
}
