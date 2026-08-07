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
export const ACTION_SEVERITY = {
  // Assembly Parts
  'AssemblyPartService.getById':              SEVERITY.READ,
  'AssemblyPartService.listForAssembly':      SEVERITY.READ,
  'AssemblyPartService.listForChild':         SEVERITY.READ,
  'AssemblyPartService.createPart':           SEVERITY.WRITE,
  'AssemblyPartService.updatePart':           SEVERITY.WRITE,
  'AssemblyPartService.updateQuantityNeeded': SEVERITY.WRITE,
  'AssemblyPartService.linkComponent':        SEVERITY.WRITE,
  'AssemblyPartService.deletePart':           SEVERITY.DESTRUCTIVE,

  // Assemblies
  'AssemblyService.createAssembly':           SEVERITY.WRITE,
  'AssemblyService.updateAssembly':           SEVERITY.WRITE,
  'AssemblyService.deleteAssemblyWithCascade': SEVERITY.DESTRUCTIVE,

  // Onshape import/reimport
  'OnshapeImportService.importAssembly':      SEVERITY.WRITE,
  'OnshapeReimportService.reimportAssembly':  SEVERITY.DESTRUCTIVE,   // can silently drop jobs/links — per product decision

  // Inventory reservation
  'InventoryReservationService.reserve':      SEVERITY.WRITE,
  'InventoryReservationService.unreserve':    SEVERITY.WRITE,

  // Fabrication jobs
  'FabricationJobService.createJob':          SEVERITY.WRITE,
  'FabricationJobService.recordMachinedUnits':SEVERITY.WRITE,
  'FabricationJobService.deleteQueuedJob':    SEVERITY.DESTRUCTIVE,

  // Fabrication detection confirm
  'FabricationDetectionService.confirmDetection': SEVERITY.WRITE,
  'FabricationDetectionService.ignoreDetection':  SEVERITY.WRITE,

  // Cart / Part Orders
  'CartService.createCartItem':               SEVERITY.WRITE,
  'CartService.advanceItemStatus':            SEVERITY.WRITE,
  'CartService.deleteItem':                   SEVERITY.DESTRUCTIVE,

  // Categories
  'CategoryService.create':                   SEVERITY.WRITE,
  'CategoryService.update':                   SEVERITY.WRITE,
  'CategoryService.delete':                   SEVERITY.DESTRUCTIVE,

  // Components
  'ComponentService.findOrCreate':            SEVERITY.WRITE,
  'ComponentService.updateFallback':          SEVERITY.WRITE,
  'ComponentService.deleteIfOrphaned':        SEVERITY.DESTRUCTIVE,

  // Agenda
  'AgendaService.createTask':                 SEVERITY.WRITE,
  'AgendaService.updateTask':                 SEVERITY.WRITE,
  'AgendaService.setTaskStatus':               SEVERITY.WRITE,
  'AgendaService.duplicateTask':               SEVERITY.WRITE,
  'AgendaService.addTaskLink':                 SEVERITY.WRITE,
  'AgendaService.deleteTask':                  SEVERITY.DESTRUCTIVE,
  'AgendaService.removeTaskLink':              SEVERITY.WRITE,


  // Categories (read)
  'CategoryService.list':                     SEVERITY.READ,

  // Components (read)
  'ComponentService.listAll':                 SEVERITY.READ,
  'ComponentService.search':                  SEVERITY.READ,
  // Inventory Instances (read)
  'InventoryInstanceService.listAll':         SEVERITY.READ,
  'InventoryInstanceService.listForComponent':SEVERITY.READ,
  'InventoryInstanceService.listForComponents':SEVERITY.READ,
  // Assemblies (read)
  'AssemblyService.listAssemblies':           SEVERITY.READ,

  // Fabrication Jobs (read)
  'FabricationJobService.listJobs':           SEVERITY.READ,

  // Cart / Part Orders (read)
  'CartService.listCarts':                    SEVERITY.READ,
  'CartService.listItemsForCart':              SEVERITY.READ,

  // Agenda (read)
  'AgendaService.listTasks':                   SEVERITY.READ,
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