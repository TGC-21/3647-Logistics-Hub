// api/_lib/harnessTools.js
//
// Tool definitions for the agent harness's function-calling payload —
// one tool per ACTION_SEVERITY entry (1:1 with service methods, per
// product decision). Each tool's `severity` is DERIVED from
// harnessPolicy.js at load time, never hand-duplicated, so the two maps
// can't drift apart.
//
// Schemas are hand-written for actions with non-trivial shapes (nested
// objects, enums, structural data) and auto-generated for simple ones
// (a handful of scalar fields). auto() below is intentionally dumb —
// it infers "required string" for everything and lets hand-written
// entries override anything that needs real typing.

import { ACTION_SEVERITY } from './harnessPolicy.js'

// ── Auto-generation helper for simple actions ────────────────────────
// Produces a flat object schema: every listed field is a required
// string unless suffixed '?' (optional) or given an explicit type via
// `types`. Good enough for id/name/note-shaped params; anything with
// real structure should be hand-written instead (see HAND_WRITTEN below).
function auto(fields, { types = {}, optional = [] } = {}) {
  const properties = {}
  const required = []
  for (const f of fields) {
    properties[f] = { type: types[f] || 'string' }
    if (!optional.includes(f)) required.push(f)
  }
  return { type: 'object', properties, required }
}

// ── Hand-written descriptions + schemas for non-trivial actions ──────
const HAND_WRITTEN = {
  'AssemblyPartService.createPart': {
    description: 'Manually adds a new part requirement to a root assembly or a subassembly node (exactly one of assemblyId/assemblyChildId).',
    parameters: {
      type: 'object',
      properties: {
        assemblyId: { type: 'string', description: 'Root assembly id — mutually exclusive with assemblyChildId.' },
        assemblyChildId: { type: 'string', description: 'Subassembly node id — mutually exclusive with assemblyId.' },
        partName: { type: 'string' },
        partNumber: { type: 'string' },
        quantityNeeded: { type: 'integer', minimum: 1 },
        notes: { type: 'string' },
      },
      required: ['partName', 'quantityNeeded'],
    },
  },
  'AssemblyPartService.updatePart': {
    description: "Edits an existing part's name/number/quantity/notes. Does not touch inventory links or fabrication metadata.",
    parameters: auto(['partId', 'partName', 'partNumber', 'notes'], { optional: ['partNumber', 'notes'], types: {} }),
  },
  'AssemblyService.createAssembly': {
    description: 'Creates a brand-new assembly with no Onshape link.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        onshapeUrl: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'active', 'complete'] },
      },
      required: ['name'],
    },
  },
  'AssemblyService.updateAssembly': {
    description: 'Edits an assembly\'s name/description/onshapeUrl/status. All fields except assemblyId are optional — only changed fields are logged.',
    parameters: {
      type: 'object',
      properties: {
        assemblyId: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        onshapeUrl: { type: 'string' },
        status: { type: 'string', enum: ['draft', 'active', 'complete'] },
      },
      required: ['assemblyId'],
    },
  },
  'AssemblyService.deleteAssemblyWithCascade': {
    description: 'Permanently deletes a root assembly and its entire tree (subassemblies, parts, releases any reserved inventory). Cannot be undone.',
    parameters: { type: 'object', properties: { assemblyId: { type: 'string' } }, required: ['assemblyId'] },
  },
  'OnshapeImportService.importAssembly': {
    description: 'Creates a new assembly by importing a BOM tree from an Onshape assembly element.',
    parameters: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        workspaceId: { type: 'string' },
        elementId: { type: 'string' },
        name: { type: 'string', description: 'Optional — defaults to a generated name if omitted.' },
      },
      required: ['documentId', 'workspaceId', 'elementId'],
    },
  },
  'OnshapeReimportService.reimportAssembly': {
    description: 'Re-syncs an assembly\'s BOM tree from Onshape. Wipes and rebuilds parts/subassemblies; carries over inventory links, fabrication jobs, and cart earmarks by matching Onshape part identity where possible, but any that no longer match are lost. Cannot be undone.',
    parameters: { type: 'object', properties: { assemblyId: { type: 'string' } }, required: ['assemblyId'] },
  },
  'InventoryReservationService.reserve': {
    description: 'Reserves (forks) units of an inventory instance to satisfy an assembly part\'s remaining need.',
    parameters: {
      type: 'object',
      properties: {
        assemblyPartId: { type: 'string' },
        instanceId: { type: 'string' },
        componentId: { type: 'string' },
        quantity: { type: 'integer', minimum: 1 },
        location: { type: 'string' },
        sourcePartNumber: { type: 'string' },
      },
      required: ['assemblyPartId', 'instanceId', 'quantity'],
    },
  },
  'InventoryReservationService.unreserve': {
    description: 'Releases a previously reserved inventory instance back to available for one assembly part.',
    parameters: {
      type: 'object',
      properties: {
        assemblyPartId: { type: 'string' },
        instanceId: { type: 'string' },
        unlinkedQuantity: { type: 'integer', minimum: 1 },
      },
      required: ['assemblyPartId', 'instanceId'],
    },
  },
  'FabricationJobService.createJob': {
    description: 'Creates a fabrication job promising to machine a quantity of units for one assembly part. A part may have at most one active job.',
    parameters: {
      type: 'object',
      properties: {
        assemblyPartId: { type: 'string' },
        quantityRequested: { type: 'integer', minimum: 1 },
        batchId: { type: 'string' },
      },
      required: ['assemblyPartId', 'quantityRequested'],
    },
  },
  'FabricationJobService.recordMachinedUnits': {
    description: 'Records newly finished machined units against a job, creating inventory and advancing the job\'s progress.',
    parameters: {
      type: 'object',
      properties: { jobId: { type: 'string' }, quantity: { type: 'integer', minimum: 1 } },
      required: ['jobId', 'quantity'],
    },
  },
  'FabricationJobService.deleteQueuedJob': {
    description: 'Deletes an unclaimed (queued) fabrication job. If the job originated from auto-detection, its part is reopened for re-scanning.',
    parameters: { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
  },
  'FabricationDetectionService.confirmDetection': {
    description: 'Confirms an auto-detected fabrication candidate (spacer, axial-shaft, or plate), resolving/creating its component and creating a fabrication job.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['spacer', 'axial-shaft', 'plate'] },
        partId: { type: 'string' },
        attrs: { type: 'object', description: 'Category-specific attribute map, e.g. { "OD": "0.375", "Spacer Type": "ROUND" } for spacer, { "Material": "Aluminum", "Thickness": "0.25" } for plate.' },
        quantityRequested: { type: 'integer', minimum: 1 },
        overrides: { type: 'object', description: 'Optional — user-edited values that differ from the detected geometry, keyed by field.' },
      },
      required: ['kind', 'partId', 'attrs', 'quantityRequested'],
    },
  },
  'FabricationDetectionService.ignoreDetection': {
    description: 'Marks an auto-detected fabrication candidate as "not actually this kind" — no component or job created.',
    parameters: { type: 'object', properties: { partId: { type: 'string' } }, required: ['partId'] },
  },
  'CartService.createCartItem': {
    description: 'Adds a new item to a vendor cart.',
    parameters: {
      type: 'object',
      properties: {
        cartId: { type: 'string' },
        vendorListingId: { type: 'string' },
        assemblyPartId: { type: 'string' },
        nameOverride: { type: 'string' },
        linkOverride: { type: 'string' },
        priceOverride: { type: 'number' },
        quantity: { type: 'integer', minimum: 1 },
      },
      required: ['cartId', 'quantity'],
    },
  },
  'CartService.advanceItemStatus': {
    description: 'Advances a cart item one step forward: pending -> ordered -> received. Cannot be reversed or skipped.',
    parameters: { type: 'object', properties: { itemId: { type: 'string' } }, required: ['itemId'] },
  },
  'CartService.deleteItem': {
    description: 'Deletes a cart item. Refuses if the item has already been received (completed purchase).',
    parameters: { type: 'object', properties: { itemId: { type: 'string' } }, required: ['itemId'] },
  },
  'CategoryService.create': {
    description: 'Creates a new component category with a set of typed required characteristics. Rejects a duplicate name.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        requiredKeysConfig: {
          type: 'array',
          description: 'e.g. [{ "key": "OD", "type": "quantity", "defaultUnit": "in" }, { "key": "Material", "type": "enum", "options": ["Aluminum","Steel"] }]',
          items: { type: 'object' },
        },
      },
      required: ['name'],
    },
  },
  'CategoryService.update': {
    description: 'Renames a category and/or replaces its required characteristics list.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' }, requiredKeysConfig: { type: 'array', items: { type: 'object' } } },
      required: ['id', 'name'],
    },
  },
  'CategoryService.delete': {
    description: 'Deletes a category. Its components are un-categorized, not deleted.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  'ComponentService.findOrCreate': {
    description: 'Finds an existing component matching a category + attribute signature, or creates a new one.',
    parameters: {
      type: 'object',
      properties: {
        categoryId: { type: 'string' },
        attrs: { type: 'object', description: 'Flat { key: value } map matching the category\'s required characteristics.' },
        fallback: { type: 'object', description: 'Optional { name, description, image } used only if a new component is created.' },
      },
      required: ['categoryId', 'attrs'],
    },
  },
  'ComponentService.updateFallback': {
    description: "Edits a component's shared fallback display name/description/image.",
    parameters: {
      type: 'object',
      properties: { componentId: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, image: { type: 'string' } },
      required: ['componentId'],
    },
  },
  'ComponentService.deleteIfOrphaned': {
    description: 'Deletes a component only if it has zero remaining inventory instances.',
    parameters: {
      type: 'object',
      properties: { componentId: { type: 'string' }, instanceCount: { type: 'integer', minimum: 0 } },
      required: ['componentId', 'instanceCount'],
    },
  },
  'AgendaService.createTask': {
    description: 'Creates a new agenda task.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        deadline: { type: 'string', description: 'ISO 8601 timestamp, optional.' },
        startDate: { type: 'string', description: 'ISO 8601 timestamp, optional — defaults to immediate.' },
        status: { type: 'string', enum: ['not_started', 'in_progress', 'complete', 'archived'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        assignerId: { type: 'string' },
        executors: { type: 'array', items: { type: 'string' }, description: 'Member ids who committed to this task.' },
      },
      required: ['title'],
    },
  },
  'AgendaService.updateTask': {
    description: 'Edits any subset of a task\'s fields. If status is included, completedAt is recomputed automatically.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        title: { type: 'string' }, description: { type: 'string' },
        deadline: { type: 'string' }, startDate: { type: 'string' },
        status: { type: 'string', enum: ['not_started', 'in_progress', 'complete', 'archived'] },
        priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        executors: { type: 'array', items: { type: 'string' } },
      },
      required: ['taskId'],
    },
  },
  'AgendaService.addTaskLink': {
    description: 'Links a task to an existing entity elsewhere in the app.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        entityType: { type: 'string', enum: ['assembly', 'assembly_part', 'inventory_instance', 'fabrication_job', 'cart_item'] },
        entityId: { type: 'string' },
      },
      required: ['taskId', 'entityType', 'entityId'],
    },
  },
}

// ── Simple auto-generated actions (id-shaped, no real structure) ─────
const AUTO_SPEC = {
  'AssemblyPartService.getById': ['partId'],
  'AssemblyPartService.listForAssembly': ['assemblyId'],
  'AssemblyPartService.listForChild': ['assemblyChildId'],
  'AssemblyPartService.updateQuantityNeeded': ['partId', { field: 'quantityNeeded', type: 'integer' }],
  'AssemblyPartService.linkComponent': ['partId', 'componentId'],
  'AssemblyPartService.deletePart': ['partId'],
  'AgendaService.setTaskStatus': ['taskId', { field: 'status', type: 'string' }],
  'AgendaService.duplicateTask': ['taskId'],
  'AgendaService.deleteTask': ['taskId'],
  'AgendaService.removeTaskLink': ['linkId'],
}

function autoFromSpec(fieldSpecs) {
  const properties = {}
  const required = []
  for (const spec of fieldSpecs) {
    const field = typeof spec === 'string' ? spec : spec.field
    const type = typeof spec === 'string' ? 'string' : spec.type
    properties[field] = { type }
    required.push(field)
  }
  return { type: 'object', properties, required }
}

// ── Assemble the registry ─────────────────────────────────────────────
const DESCRIPTIONS = {
  'AssemblyPartService.getById': 'Fetches one assembly part by id.',
  'AssemblyPartService.listForAssembly': "Lists a root assembly's direct parts.",
  'AssemblyPartService.listForChild': "Lists a subassembly node's direct parts.",
  'AssemblyPartService.updateQuantityNeeded': "Changes an assembly part's required quantity.",
  'AssemblyPartService.linkComponent': 'Links an assembly part to an already-resolved catalog component.',
  'AssemblyPartService.deletePart': 'Deletes an assembly part, releasing any reserved inventory first.',
  'AgendaService.setTaskStatus': 'Changes a task\'s status (completedAt is derived automatically).',
  'AgendaService.duplicateTask': 'Copies a task\'s content into a new not_started task.',
  'AgendaService.deleteTask': 'Deletes a task and its links.',
  'AgendaService.removeTaskLink': 'Removes one link from a task.',
}

export const HARNESS_TOOLS = Object.entries(ACTION_SEVERITY).map(([actionName, severity]) => {
  const [serviceClass, methodName] = actionName.split('.')
  const hand = HAND_WRITTEN[actionName]
  const autoFields = AUTO_SPEC[actionName]

  if (!hand && !autoFields) {
    throw new Error(`harnessTools.js: no schema (hand-written or auto) defined for action "${actionName}" — every ACTION_SEVERITY entry needs one.`)
  }

  return {
    name: actionName.replace('.', '_').replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase(),
    actionName,
    description: hand?.description || DESCRIPTIONS[actionName] || `${methodName} on ${serviceClass}.`,
    parameters: hand?.parameters || autoFromSpec(autoFields),
    severity,
  }
})

// Drift guard: every tool's severity must still match harnessPolicy.js
// (defends against ACTION_SEVERITY being edited without re-running this
// file's derivation — should be structurally impossible given the
// Object.entries() above, but cheap to assert explicitly).
for (const tool of HARNESS_TOOLS) {
  if (ACTION_SEVERITY[tool.actionName] !== tool.severity) {
    throw new Error(`harnessTools.js: severity mismatch for "${tool.actionName}"`)
  }
}