// backend/_lib/harnessTools.js
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
  'CategoryService.getById': {
    description: 'Fetches one category by id, including its full requiredKeysConfig (the typed attributes any component in this category must provide). Use before creating a component or inventory instance so attrs matches the category\'s expected fields.',
    parameters: { type: 'object', properties: { categoryId: { type: 'string' } }, required: ['categoryId'] },
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
  'CategoryService.list': {
    description: 'Lists every component category (e.g. Spacer, Plate, Bearings) along with each category\'s required characteristics. Use this to discover what categories exist before searching or creating components.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  'ComponentService.listAll': {
    description: 'Lists every component in the catalog — the deduplicated (category + attributes) identities inventory instances reference. Includes category name and attribute values for each, e.g. useful for finding "a 24T gear" by scanning names/attributes. Does not include physical location/quantity — use InventoryInstanceService.listForComponent for that, once you have a component id.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
    'ComponentService.search': {
    description: 'Free-text search over the component catalog by name, description, or attribute values (e.g. searching "24T" finds a gear whose tooth-count attribute is 24, without needing to know the exact category or attribute key). Use this INSTEAD OF ComponentService.listAll when looking for something specific by name/spec — much more direct than scanning the full catalog yourself.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },

  'InventoryInstanceService.listAll': {
    description: 'Lists every physical inventory instance (a pile of a component at one location, with quantity/status). Use ComponentService.listAll first to find a component id if searching by name/attributes.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  'InventoryInstanceService.listForComponent': {
    description: 'Lists every physical inventory instance (location + quantity) for one specific component id — use this once you know which component you\'re looking for, e.g. after finding it via ComponentService.listAll.',
    parameters: { type: 'object', properties: { componentId: { type: 'string' } }, required: ['componentId'] },
  },
  'InventoryInstanceService.listForComponents': {
    description: 'Lists physical inventory instances (location + quantity) across MULTIPLE component ids at once — use after ComponentService.search returns several matches, to get every match\'s locations in one call instead of one call per match.',
    parameters: {
      type: 'object',
      properties: { componentIds: { type: 'array', items: { type: 'string' } } },
      required: ['componentIds'],
    },
  },
  'InventoryInstanceService.getById': {
    description: 'Fetches one physical inventory instance by id.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  'InventoryInstanceService.createInstance': {
    description: 'Adds new physical stock to inventory — resolves (or creates) the component it belongs to from categoryId + attrs, then creates the instance at a location with a quantity. Use for "we received/have N more of X" requests.',
    parameters: {
      type: 'object',
      properties: {
        categoryId: { type: 'string', description: 'Omit to fall back to the "Uncategorized" category.' },
        attrs: { type: 'object', description: 'Flat { key: value } map matching the category\'s requiredKeysConfig — see CategoryService.getById.' },
        fallback: { type: 'object', description: 'Optional { name, description, image } used only if this creates a brand-new component.' },
        name: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string' },
        quantity: { type: 'integer', minimum: 0 },
        tags: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
      },
      required: ['name'],
    },
  },
    'InventoryInstanceService.updateInstance': {
    description: 'Edits an existing inventory instance\'s own fields, and re-resolves its component from the (possibly changed) categoryId/attrs — may re-parent it onto a different component.',
    parameters: {
      type: 'object',
      properties: {
        instanceId: { type: 'string' },
        categoryId: { type: 'string' },
        attrs: { type: 'object' },
        name: { type: 'string' },
        description: { type: 'string' },
        location: { type: 'string' },
        quantity: { type: 'integer', minimum: 0 },
        tags: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
      },
      required: ['instanceId', 'name'],
    },
  },
  'InventoryInstanceService.deleteInstance': {
    description: 'Deletes an inventory instance outright — first unreserving it from every assembly part currently linking it, then removing the row.',
    parameters: { type: 'object', properties: { instanceId: { type: 'string' } }, required: ['instanceId'] },
  },

}

// ── Simple auto-generated actions (id-shaped, no real structure) ─────
const AUTO_SPEC = {

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
