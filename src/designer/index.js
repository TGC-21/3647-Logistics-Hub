// src/designer/index.js
//
// Public surface of the designer/* split. main.js and fabricate.js only
// ever imported a handful of names from the old monolithic designer.js —
// this file re-exports exactly those names so NEITHER of those callers
// needs to change. Internally it wires every submodule's registered
// context (see assemblyDetail.js's initDesignerWiring) and exposes one
// bindDesignerEvents() that just asks each submodule to bind its own
// static listeners, so there's still a single obvious place that "boots"
// all of Designer mode's event handling.

import {
  designerBoot,
  bootIsolatedAssembly, bootIsolatedChild,
  renderDesignerSidebar, renderDesignerContent,
  selectAssembly, refreshAndOpenAssembly,
  initDesignerWiring, bindAssemblyDetailEvents,
  getAssemblies,
} from './assemblyDetail.js'

import { setToast } from './state.js'
import { openAssemblyModal, bindAssemblyGridEvents } from './assemblyGrid.js'
import { openOnshapeModal, bindOnshapePickerEvents } from './onshapePicker.js'
import { openInventoryLinkModal, bindInventoryLinkEvents } from './inventoryLink.js'
import { bindPartsTableEvents } from './partsTable.js'
import { bindFabDetectionEvents } from './fabDetection.js'
import { bindBomImportEvents } from './bomImport.js'
import { bindFabricateFlowEvents } from './fabricateFlow.js'
import { bindPartOrdersCartEvents } from './partOrdersCart.js'

// ── Public API (unchanged surface for main.js / fabricate.js) ──────
export {
  designerBoot,
  setToast,
  renderDesignerSidebar,
  renderDesignerContent,
  openAssemblyModal,
  selectAssembly,
  openOnshapeModal,
  bootIsolatedAssembly,
  bootIsolatedChild,
  openInventoryLinkModal,
  refreshAndOpenAssembly,
  getAssemblies,
}

// initDesignerWiring() connects every submodule's registered context
// (see assemblyDetail.js) to shared root/child part state. It has no DOM
// dependency, so it's safe to run at module-load time rather than
// waiting for boot() — but it DOES need to run before any modal is
// opened, so bindDesignerEvents() (always called once at boot,
// alongside designerBoot()) is the natural place to guarantee it's run
// exactly once before the DOM listeners that could trigger those flows
// are wired up.
let wired = false

export function bindDesignerEvents() {
  if (!wired) { initDesignerWiring(); wired = true }

  bindAssemblyDetailEvents()
  bindAssemblyGridEvents()
  bindOnshapePickerEvents()
  bindInventoryLinkEvents()
  bindPartsTableEvents()
  bindFabDetectionEvents()
  bindBomImportEvents()
  bindFabricateFlowEvents()
  bindPartOrdersCartEvents()
}