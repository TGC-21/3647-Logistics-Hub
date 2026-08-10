// Selects the smallest useful tool family for a turn. Unknown/general
// requests deliberately retain the full registry rather than hiding a tool
// Clinker may need; narrowing only happens for clear domain signals.
//
// Phase 1 of dynamic context loading (see agent_dynamic_context.md /
// the harness roadmap conversation): this file is refactored into two
// layers so tool selection and context selection (domainContext.js)
// can share one domain-matching primitive without duplicating the
// regex table:
//
//   matchedDomainsForText(text)   -> Set<domainKey>, single string in
//   accumulatedDomains(messages)  -> Set<domainKey>, unions matches
//                                     across every user message in a
//                                     conversation (plus any domain
//                                     explicitly pulled in via an
//                                     expand_scope tool call/result —
//                                     wired in a later phase)
//
// Phase 2: selectToolActions() now consumes accumulatedDomains()
// instead of matching only the latest message — domains a conversation
// has touched stay available for the rest of that conversation, per
// product decision ("selected domains should accumulate"). The old
// single-turn behavior is preserved as matchedDomainsForText() +
// accumulatedDomains() themselves, both still exported and tested
// independently, so this switch-over is a small, auditable diff rather
// than a rewrite.
//
// Each DOMAIN_PATTERNS entry now also carries a `domain` key — the
// same string domainContext.js's DOMAIN_CONTEXT map uses — so the two
// files can never drift into naming the "same" domain two different
// ways. `services` (tool-selection) and having a domainContext.js
// entry (context-selection) are independent — a domain can have
// services with no authored context snippet yet, and vice versa (see
// domainContext.js's own doc comment on partial authoring).

import { HARNESS_TOOLS } from '../../backend/_lib/harnessTools.js'

const DOMAIN_PATTERNS = [
  {
    domain: 'fabrication',
    pattern: /\b(?:fabricat|machin|spacer|plate|shaft|cnc)/i,
    services: ['FabricationJobService', 'FabricationDetectionService', 'AssemblyPartService', 'AssemblyService', 'ComponentService', 'DetectionService'],
  },
  {
    domain: 'assemblies',
    pattern: /\b(?:assembl|subassembl|bom|onshape|part|import)/i,
    services: ['AssemblyService', 'AssemblyPartService', 'FabricationJobService', 'InventoryReservationService', 'OnshapeLookupService', 'OnshapeImportService', 'OnshapeReimportService'],
  },
  {
    domain: 'inventory',
    pattern: /\b(?:inventory|component|stock|bin|location|gear|pulley|buy|purchas|have|available|need)/i,
    services: ['ComponentService', 'InventoryInstanceService', 'CategoryService', 'AssemblyPartService', 'InventoryReservationService'],
  },
  {
    domain: 'cart',
    pattern: /\b(?:cart|order|vendor|purchas)/i,
    services: ['CartService', 'AssemblyPartService'],
  },
  {
    domain: 'agenda',
    pattern: /\b(?:agenda|task|todo|to-do|deadline)/i,
    services: ['AgendaService'],
  },
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

/** Pure regex match over one piece of text -> the set of domain keys
 *  whose pattern matched. No message-history knowledge, no fallback
 *  logic — callers (selectToolActions, accumulatedDomains) decide what
 *  an empty or multi-domain result means for their own purposes. */
export function matchedDomainsForText(text) {
  const matched = new Set()
  for (const rule of DOMAIN_PATTERNS) {
    if (rule.pattern.test(text || '')) matched.add(rule.domain)
  }
  return matched
}

/** Every domain key a tool call already made this conversation belongs
 *  to, so a follow-up turn doesn't lose access to tools it already
 *  demonstrably needed just because the latest message's keywords
 *  don't happen to match that domain again. Kept separate from keyword
 *  matching since a tool NAME match is a much stronger signal than a
 *  regex hit on prose. */
function domainsForInvokedTools(messages) {
  const invokedNames = new Set(messages.flatMap(m => (m.tool_calls || []).map(c => c.function?.name)))
  const domains = new Set()
  for (const rule of DOMAIN_PATTERNS) {
    const hasToolFromDomain = HARNESS_TOOLS.some(tool => rule.services.includes(tool.actionName.split('.')[0]) && invokedNames.has(tool.name))
    if (hasToolFromDomain) domains.add(rule.domain)
  }
  return domains
}

/**
 * Unions matchedDomainsForText() across every user message in a
 * conversation, plus every domain already touched via an actual tool
 * call — this is the "domains accumulate across a conversation"
 * primitive. Not yet consumed by selectToolActions() (see this file's
 * top doc comment) — exposed now so contextWindow.js and a later
 * accumulation-aware selectToolActions can both build on the same
 * function instead of two independent history scans.
 */
export function accumulatedDomains(messages) {
  const domains = new Set()
  for (const message of messages) {
    if (message.role !== 'user' || !message.content) continue
    for (const d of matchedDomainsForText(message.content)) domains.add(d)
  }
  for (const d of domainsForInvokedTools(messages)) domains.add(d)
  return domains
}

/** Domain keys currently in scope for this conversation. Zero matches
 *  across the whole history -> genuinely ambiguous, caller should fall
 *  back to "everything" (mirrors the old single-turn fallback, just
 *  conversation-wide now). Exposed standalone so selectToolActions and
 *  selectContextSnippets both derive from exactly the same set — a
 *  tool is never offered without its matching context, or vice versa. */
export function scopedDomains(messages) {
  return accumulatedDomains(messages)
}

export function selectToolActions(messages) {
  const domains = scopedDomains(messages)

  // No domain touched anywhere in the conversation yet -> genuinely
  // ambiguous, keep the full registry (same fallback the old single-
  // turn version used, now evaluated over full history instead of just
  // the latest message).
  if (!domains.size) return HARNESS_TOOLS.map(tool => tool.actionName)

  const services = new Set(DOMAIN_PATTERNS.filter(rule => domains.has(rule.domain)).flatMap(rule => rule.services))

  // Keep any tool already invoked anywhere in the conversation available
  // for a natural follow-up/retry even if its service isn't in the
  // accumulated domain set (covers the rare case a tool was reached via
  // expand_scope rather than a keyword match).
  const invokedNames = new Set(messages.flatMap(message => (message.tool_calls || []).map(call => call.function?.name)))

  return HARNESS_TOOLS
    .filter(tool =>
      services.has(tool.actionName.split('.')[0]) ||
      invokedNames.has(tool.name) ||
      ALWAYS_INCLUDED_ACTIONS.has(tool.actionName)
    )
    .map(tool => tool.actionName)
}

/** The tool name conversationLoop.js special-cases — not a real
 *  ServiceClass.method action, so it deliberately does not appear in
 *  HARNESS_TOOLS/ACTION_SEVERITY. Exported as a constant so
 *  conversationLoop.js and toolSchema.js never risk typo-diverging on
 *  the literal string. */
export const EXPAND_SCOPE_TOOL_NAME = 'expand_scope'

/** All domain keys a conversation has NOT yet touched — what
 *  expand_scope's own tool schema should offer as choices, and what a
 *  successful expand_scope call adds to scope. */
export function unscopedDomains(messages) {
  const scoped = scopedDomains(messages)
  return new Set(DOMAIN_PATTERNS.map(rule => rule.domain).filter(d => !scoped.has(d)))
}

export function allDomainKeys() {
  return DOMAIN_PATTERNS.map(rule => rule.domain)
}