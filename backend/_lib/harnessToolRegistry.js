// backend/_lib/harnessToolRegistry.js
//
// The execution surface the harness process actually calls: list tools
// (for the LLM's function-calling payload) and execute one by name.
// Routes through the existing HarnessGateway — trust-level/confirmation
// enforcement is unchanged, this file only adds tool discovery + a
// lightweight schema check ahead of the gateway call.

import { HARNESS_TOOLS } from './harnessTools.js'
import { resolveAction } from './harnessServiceRegistry.js'
import { HarnessGateway } from '../../src/services/HarnessGateway.js'
import { getSupabase } from '../../src/repositories/supabaseClient.js'
import { ValidationError, NotFoundError } from '../../src/repositories/errors.js'

/** Returns the tool list exactly as an LLM function-calling payload
 *  expects — name/description/parameters only, never `execute` or any
 *  service reference. Safe to serialize directly into a prompt. */
export function listTools() {
  return HARNESS_TOOLS.map(({ name, description, parameters, severity }) => ({
    name, description, parameters, severity,
  }))
}

export function getTool(name) {
  return HARNESS_TOOLS.find(t => t.name === name) || null
}

// ── Minimal JSON-Schema-ish validation ────────────────────────────────
// Deliberately basic (required-field presence + primitive type check) —
// matches the simplicity of the hand-written/auto schemas above. Swap
// for ajv if schemas grow real nesting/enum validation needs.
function validateArgs(schema, args) {
  const errors = []
  const props = schema?.properties || {}
  for (const key of schema?.required || []) {
    if (args?.[key] === undefined || args?.[key] === null || args?.[key] === '') {
      errors.push(`missing required field "${key}"`)
    }
  }
  for (const [key, val] of Object.entries(args || {})) {
    const expected = props[key]?.type
    if (!expected || val === undefined || val === null) continue
    const actual = Array.isArray(val) ? 'array' : typeof val
    if (expected === 'integer' && (actual !== 'number' || !Number.isInteger(val))) {
      errors.push(`field "${key}" must be an integer`)
    } else if (expected !== 'integer' && expected !== actual && !(expected === 'number' && actual === 'number')) {
      errors.push(`field "${key}" must be of type ${expected}`)
    }
  }
  return errors
}

async function fetchMemberTrust(memberId) {
  const { data, error } = await getSupabase().from('members').select('trust_level').eq('id', memberId).maybeSingle()
  if (error) throw error
  if (!data) throw new NotFoundError(`Member ${memberId} not found`)
  return data.trust_level ?? 0
}

/**
 * Executes one tool by name on behalf of a member. Throws ValidationError
 * for an unknown tool or malformed args, ConfirmationRequiredError if the
 * action needs a human decision first (propagated unchanged from
 * HarnessGateway — same shape the caller already handles), or whatever
 * the underlying service throws otherwise.
 */
export async function executeTool(name, args, { memberId, isAgent = true, reason = null } = {}) {
  const tool = getTool(name)
  if (!tool) throw new ValidationError(`Unknown tool "${name}"`)

  const errors = validateArgs(tool.parameters, args)
  if (errors.length) throw new ValidationError(`Invalid arguments for "${name}": ${errors.join('; ')}`)

  const resolved = resolveAction(tool.actionName)
  if (!resolved) throw new ValidationError(`Tool "${name}" has no resolvable service action`)

  const memberTrustLevel = await fetchMemberTrust(memberId)
  const gateway = new HarnessGateway()

  return gateway.invoke({
    actionName: tool.actionName,
    serviceInstance: resolved.serviceInstance,
    methodName: resolved.methodName,
    args, memberId, memberTrustLevel, isAgent, reason,
  })
}