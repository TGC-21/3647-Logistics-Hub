// backend/_lib/__tests__/harnessToolCoverage.test.js
//
// Drift guard for the exact bug class that shipped
// DetectionService.detectFabricationCandidates with no harness tool:
// a service method that exists and works, but was never added to
// ACTION_SEVERITY, so the LLM has no way to call it and instead
// improvises with whatever read-only tools ARE registered — silently
// producing a plausible-looking wrong answer instead of a loud failure.
//
// This does NOT assert every public method SHOULD be a tool (some are
// deliberately internal — see EXCLUDED below); it only flags methods
// that look like real public actions and are missing, so a human can
// make the "should this be a tool?" call explicitly instead of it
// happening by omission.

import { describe, it, expect } from 'vitest'
import { ACTION_SEVERITY } from '../harnessPolicy.js'

import { AssemblyPartService } from '../../../src/services/AssemblyPartService.js'
import { AssemblyService } from '../../../src/services/AssemblyService.js'
import { OnshapeImportService } from '../../../src/services/OnshapeImportService.js'
import { OnshapeReimportService } from '../../../src/services/OnshapeReimportService.js'
import { OnshapeLookupService } from '../../../src/services/OnshapeLookupService.js'
import { InventoryReservationService } from '../../../src/services/InventoryReservationService.js'
import { FabricationJobService } from '../../../src/services/FabricationJobService.js'
import { FabricationDetectionService } from '../../../src/services/FabricationDetectionService.js'
import { CartService } from '../../../src/services/CartService.js'
import { CategoryService } from '../../../src/services/CategoryService.js'
import { ComponentService } from '../../../src/services/ComponentService.js'
import { AgendaService } from '../../../src/services/AgendaService.js'
import { InventoryInstanceService } from '../../../src/services/InventoryInstanceService.js'
import { DetectionService } from '../../../src/services/DetectionService.js'

// Mirrors harnessServiceRegistry.js's registry() key -> class mapping.
// Kept as a separate literal (not imported from the registry itself) so
// this test still catches "a service was added to the registry but this
// list was never updated" as its own drift, not just method-level drift.
const REGISTERED_SERVICES = {
  AssemblyPartService, AssemblyService, OnshapeImportService, OnshapeReimportService,
  OnshapeLookupService, InventoryReservationService, FabricationJobService,
  FabricationDetectionService, CartService, CategoryService, ComponentService,
  AgendaService, InventoryInstanceService, DetectionService,
}

// Methods that are real, public, and callable, but intentionally NOT
// harness actions — either because they're a private helper despite not
// having a #-prefixed name, an internal composition step another public
// method already wraps, or a bulk/dangerous operation deliberately kept
// UI-only. Each entry needs a reason so this list can't silently grow
// into "everything we forgot," the same failure mode this test exists
// to catch in ACTION_SEVERITY itself.
const KNOWN_NON_ACTIONS = {
  'InventoryReservationService.releaseAll':        'internal bulk-release step composed by AssemblyService.deleteAssemblyWithCascade — not a standalone action',
  'InventoryReservationService._ensureBulkInstance': 'private find-or-create helper for quickCollect',
  'OnshapeImportService.seedAssemblyContents':      'internal tree-walk step composed by importAssembly/OnshapeReimportService, not called standalone',
  'OnshapeImportService.seedSubassembliesConcurrently': 'internal tree-walk step, same as seedAssemblyContents',
  'OnshapeReimportService.carryOverPromises':       'internal step of reimportAssembly, not called standalone',
  'OnshapeReimportService.logReimportChanges':      'internal step of reimportAssembly, not called standalone',
  'CategoryService.validateAttributesForCategory':  'validation helper, not a mutating or listing action',
  'DetectionService._fetchWholeTreeParts':          'internal step of detectFabricationCandidates',
  'DetectionService._detectAndPersist':             'internal step of detectFabricationCandidates',
  'DetectionService._runBodyDetailsBasedDetection':  'internal step of detectFabricationCandidates',
  'AssemblyPartService.recomputeStatus':      'internal status-derivation step composed by createPart/updatePart/updateQuantityNeeded/InventoryReservationService — never called standalone by a caller with a reason to invoke it directly',
  'FabricationDetectionService._ensureCategory': 'private find-or-create helper for confirmDetection',
  'CartService.ensurePartNumberStub':          'internal stub-creation step of the cart-linking flow (partOrdersCart.js) — not a standalone action a request would target',
  'CategoryService._validateConfig':           'private validation helper for create/update',
  'InventoryInstanceService._resolveCategoryId': 'private "Uncategorized" fallback helper for createInstance/updateInstance',
}

function publicMethodNames(ServiceClass) {
  return Object.getOwnPropertyNames(ServiceClass.prototype)
    .filter(name => name !== 'constructor')
    .filter(name => typeof ServiceClass.prototype[name] === 'function')
}

describe('harness tool coverage', () => {
  it('every public service method is either a registered action or an explicitly-justified exclusion', () => {
    const missing = []

    for (const [serviceName, ServiceClass] of Object.entries(REGISTERED_SERVICES)) {
      for (const methodName of publicMethodNames(ServiceClass)) {
        const actionName = `${serviceName}.${methodName}`
        if (ACTION_SEVERITY[actionName]) continue
        if (KNOWN_NON_ACTIONS[actionName]) continue
        missing.push(actionName)
      }
    }

    if (missing.length) {
      throw new Error(
        `The following service methods are callable but not registered as harness actions, ` +
        `and have no exclusion reason in KNOWN_NON_ACTIONS:\n  ${missing.join('\n  ')}\n\n` +
        `For each: either add it to ACTION_SEVERITY (backend/_lib/harnessPolicy.js) and give it ` +
        `a schema in harnessTools.js, or add it to KNOWN_NON_ACTIONS here with a reason.`
      )
    }
  })

  it('every ACTION_SEVERITY entry names a real method on a registered service', () => {
    const bogus = []
    for (const actionName of Object.keys(ACTION_SEVERITY)) {
      const [serviceName, methodName] = actionName.split('.')
      const ServiceClass = REGISTERED_SERVICES[serviceName]
      if (!ServiceClass || typeof ServiceClass.prototype[methodName] !== 'function') {
        bogus.push(actionName)
      }
    }
    expect(bogus).toEqual([])
  })
})