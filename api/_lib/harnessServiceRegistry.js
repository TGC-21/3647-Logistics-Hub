// api/_lib/harnessServiceRegistry.js
// Maps "ServiceClass.methodName" action names (harnessPolicy.js's keys)
// to actual instances, so the route doesn't need a giant switch. Lazily
// instantiated (each service already defaults its own repos).

import { AssemblyPartService } from '../../src/services/AssemblyPartService.js'
import { AssemblyService } from '../../src/services/AssemblyService.js'
import { OnshapeImportService } from '../../src/services/OnshapeImportService.js'
import { OnshapeReimportService } from '../../src/services/OnshapeReimportService.js'
import { InventoryReservationService } from '../../src/services/InventoryReservationService.js'
import { FabricationJobService } from '../../src/services/FabricationJobService.js'
import { FabricationDetectionService } from '../../src/services/FabricationDetectionService.js'
import { CartService } from '../../src/services/CartService.js'
import { CategoryService } from '../../src/services/CategoryService.js'
import { ComponentService } from '../../src/services/ComponentService.js'
import { AgendaService } from '../../src/services/AgendaService.js'
import { InventoryInstanceService } from '../../src/services/InventoryInstanceService.js'

let instances = null
function registry() {
  if (instances) return instances
  instances = {
    AssemblyPartService: new AssemblyPartService(),
    AssemblyService: new AssemblyService(),
    OnshapeImportService: new OnshapeImportService(),
    OnshapeReimportService: new OnshapeReimportService(),
    InventoryReservationService: new InventoryReservationService(),
    FabricationJobService: new FabricationJobService(),
    FabricationDetectionService: new FabricationDetectionService(),
    CartService: new CartService(),
    CategoryService: new CategoryService(),
    ComponentService: new ComponentService(),
    AgendaService: new AgendaService(),
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