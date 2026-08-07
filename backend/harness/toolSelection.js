// Selects the smallest useful tool family for a turn. Unknown/general
// requests deliberately retain the full registry rather than hiding a tool
// Clinker may need; narrowing only happens for clear domain signals.

import { HARNESS_TOOLS } from '../../backend/_lib/harnessTools.js'

const DOMAIN_PATTERNS = [
  { pattern: /\b(?:fabricat|machin|spacer|plate|shaft|cnc)/i, services: ['FabricationJobService', 'FabricationDetectionService', 'AssemblyPartService', 'AssemblyService', 'ComponentService'] },
  { pattern: /\b(?:assembl|subassembl|bom|onshape|part)/i, services: ['AssemblyService', 'AssemblyPartService', 'FabricationJobService', 'InventoryReservationService'] },
  { pattern: /\b(?:inventory|component|stock|bin|location|gear|pulley)/i, services: ['ComponentService', 'InventoryInstanceService', 'CategoryService', 'AssemblyPartService', 'InventoryReservationService'] },
  { pattern: /\b(?:cart|order|vendor|purchas)/i, services: ['CartService', 'AssemblyPartService'] },
  { pattern: /\b(?:agenda|task|todo|to-do|deadline)/i, services: ['AgendaService'] },
]

function latestUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].content || ''
  return ''
}

export function selectToolActions(messages) {
  const text = latestUserText(messages)
  const services = new Set(DOMAIN_PATTERNS.filter(rule => rule.pattern.test(text)).flatMap(rule => rule.services))
  if (!services.size) return HARNESS_TOOLS.map(tool => tool.actionName)

  // Keep tools already invoked in this turn available for a natural
  // follow-up/retry even if their service was not selected by keywords.
  const invokedNames = new Set(messages.flatMap(message => (message.tool_calls || []).map(call => call.function?.name)))
  return HARNESS_TOOLS
    .filter(tool => services.has(tool.actionName.split('.')[0]) || invokedNames.has(tool.name))
    .map(tool => tool.actionName)
}
