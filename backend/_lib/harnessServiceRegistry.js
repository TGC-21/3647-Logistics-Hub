// backend/_lib/harnessServiceRegistry.js
// Maps "ServiceClass.methodName" action names (harnessPolicy.js's keys)
// to actual instances, so the route doesn't need a giant switch. Lazily
// backend/_lib/harnessServiceRegistry.js
// Maps "ServiceClass.methodName" action names (harnessPolicy.js's keys)
// to actual instances, so the route doesn't need a giant switch. Lazily
// instantiated (each service already defaults its own repos).

// Refactor note: Partshelf was cut down to an inventory-only tracker.
// Every service tied to Designer/Fabricate/Part Orders/Agenda/Onshape
// import moved to deprecated/ — Clinker (the agent harness) now only
// resolves the inventory-relevant services below. See
// backend/_lib/harnessPolicy.js / harnessTools.js, trimmed to match.
import { CategoryService } from '../../src/services/CategoryService.js'
import { ComponentService } from '../../src/services/ComponentService.js'
import { InventoryInstanceService } from '../../src/services/InventoryInstanceService.js'

let instances = null
function registry() {
  if (instances) return instances
  instances = {
    CategoryService: new CategoryService(),
    ComponentService: new ComponentService(),
    InventoryInstanceService: new InventoryInstanceService(),
  }
  return instances
}

/** actionName = "ServiceClass.methodName" -> { serviceInstance, methodName } */
export function resolveAction(actionName) {
  const [serviceClass, methodName] = String(actionName).split('.')
  const serviceInstance = registry()[serviceClass]
  if (!serviceInstance || !methodName) return null
  return { serviceInstance, methodName }
}
