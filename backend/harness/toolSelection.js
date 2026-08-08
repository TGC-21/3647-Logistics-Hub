// Selects the smallest useful tool family for a turn. Unknown/general
// requests deliberately retain the full registry rather than hiding a tool
// Clinker may need; narrowing only happens for clear domain signals.

import { HARNESS_TOOLS } from '../../backend/_lib/harnessTools.js'

const DOMAIN_PATTERNS = [
  { pattern: /\b(?:fabricat|machin|spacer|plate|shaft|cnc)/i, services: ['FabricationJobService', 'FabricationDetectionService', 'AssemblyPartService', 'AssemblyService', 'ComponentService', 'DetectionService'] },
  { pattern: /\b(?:assembl|subassembl|bom|onshape|part|import)/i, services: ['AssemblyService', 'AssemblyPartService', 'FabricationJobService', 'InventoryReservationService', 'OnshapeLookupService', 'OnshapeImportService', 'OnshapeReimportService'] },
  { pattern: /\b(?:inventory|component|stock|bin|location|gear|pulley|buy|purchas|have|available|need)/i, services: ['ComponentService', 'InventoryInstanceService', 'CategoryService', 'AssemblyPartService', 'InventoryReservationService'] },
  { pattern: /\b(?:cart|order|vendor|purchas)/i, services: ['CartService', 'AssemblyPartService'] },
  { pattern: /\b(?:agenda|task|todo|to-do|deadline)/i, services: ['AgendaService'] },
]

const ALWAYS_INCLUDED_ACTIONS = new Set([
  'AssemblyService.listAssemblies',
  'AssemblyPartService.search',
  'AssemblyPartService.checkAvailability',
  'ComponentService.search',
  'CategoryService.list',
])

function latestUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].content || ''
  return ''
}

export function selectToolActions(messages) {
  const text = latestUserText(messages)
  const matchedRules = DOMAIN_PATTERNS.filter(rule => rule.pattern.test(text))

  // Zero matches -> genuinely ambiguous, keep the full registry (unchanged
  // behavior). Two or more matches -> the task is legitimately
  // cross-domain, so narrowing would actively hurt; also keep the full
  // registry rather than trying to guess which combination is "enough."
  if (matchedRules.length !== 1) return HARNESS_TOOLS.map(tool => tool.actionName)

  const services = new Set(matchedRules[0].services)

  // Keep tools already invoked in this turn available for a natural
  // follow-up/retry even if their service wasn't selected by keywords.
  const invokedNames = new Set(messages.flatMap(message => (message.tool_calls || []).map(call => call.function?.name)))

  return HARNESS_TOOLS
    .filter(tool =>
      services.has(tool.actionName.split('.')[0]) ||
      invokedNames.has(tool.name) ||
      ALWAYS_INCLUDED_ACTIONS.has(tool.actionName)
    )
    .map(tool => tool.actionName)
}