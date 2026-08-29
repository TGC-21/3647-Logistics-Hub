// backend/harness/toolSchema.js
//
// Pure translation: harnessToolRegistry.listTools()'s shape ->
// OpenAI's `tools` array format for chat-completions requests. No I/O,
// no side effects — same "pure function, unit-testable without a real
// server" discipline llmClient.js follows for the network half.
//
// listTools() already returns { name, description, parameters, severity }
// with parameters as a JSON Schema object — this file only needs to
// wrap each entry in OpenAI's { type: 'function', function: {...} }
// envelope and drop `severity` (an internal Partshelf concept the LLM
// has no use for and shouldn't see).

import { HARNESS_TOOLS } from '../../backend/_lib/harnessTools.js'
import { PROPOSE_INVENTORY_TOOL_SCHEMA, PROPOSE_INVENTORY_TOOL_NAME } from './inventoryProposalTool.js'


/** Converts one harnessToolRegistry tool descriptor into one OpenAI
 *  `tools` array entry. Exported standalone so a caller with an
 *  already-fetched tool list (or a filtered subset) doesn't need to
 *  re-derive it from listTools() every time. */
export function toOpenAiTool({ name, description, parameters }) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters,
    },
  }
}
// ── Sentinel-token sanitization ───────────────────────────────────────
// Locally-hosted models occasionally leak template/control artifacts —
// stray sequences like `<|"|>` or other `<|...|>`-shaped tokens — into
// otherwise syntactically valid tool-call JSON, most often wrapping a
// string value or object key (e.g. `<|"|>bore<|"|>` instead of `bore`).
// Because the surrounding JSON still parses, nothing in
// harnessToolRegistry's schema validation catches this (it only checks
// presence/type, not string content). This is a defensive net, not a
// fix for the underlying model/inference-server behavior — the real
// fix is on the model/grammar/stop-token side.
const SENTINEL_TOKEN_PATTERN = /<\|[^|<>]{0,40}\|>/g

function stripSentinelTokens(value) {
  return typeof value === 'string' ? value.replace(SENTINEL_TOKEN_PATTERN, '') : value
}

/** Recursively walks a parsed JSON value, stripping sentinel tokens out
 *  of every string — both values AND object keys, since the observed
 *  corruption wraps keys just as often as values (e.g. attribute names
 *  in an `attrs` map). Returns a new value; never mutates in place. */
function sanitizeParsedArgs(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeParsedArgs)
  }
  if (value && typeof value === 'object') {
    const result = {}
    for (const [key, v] of Object.entries(value)) {
      result[stripSentinelTokens(key)] = sanitizeParsedArgs(v)
    }
    return result
  }
  return stripSentinelTokens(value)
}

/**
 * Virtual, non-service-backed tools that are always offered regardless
 * of domain scoping (selectToolActions never filters these out, since
 * they have no ServiceClass.method actionName to match against). Same
 * treatment toolSelection.js's own doc comment describes for
 * expand_scope — propose_inventory_instance joins that category.
 */
const ALWAYS_INCLUDED_TOOLS = [PROPOSE_INVENTORY_TOOL_SCHEMA]

export function buildToolSchema({ actionNames = null } = {}) {
  const allowed = actionNames ? new Set(actionNames) : null
  const scoped = HARNESS_TOOLS
    .filter(tool => !allowed || allowed.has(tool.actionName))
    .map(toOpenAiTool)
  return [...scoped, ...ALWAYS_INCLUDED_TOOLS]
}

/** Parses an OpenAI tool_calls entry back into { toolName, args } for
 *  executeTool() — the LLM's function.arguments comes back as a JSON
 *  STRING per the OpenAI spec, not a parsed object, so this is the one
 *  place that has to defensively parse it and surface a clear error if
 *  the model emitted malformed JSON (a real failure mode for smaller
 *  local models, worth not letting propagate as a cryptic crash deeper
 *  in the loop). */
export function parseToolCall(toolCall) {
  const name = toolCall?.function?.name
  const rawArgs = toolCall?.function?.arguments
  if (!name) throw new Error('Malformed tool_call from LLM — missing function.name')
  let args
  try {
    const parsed = rawArgs ? JSON.parse(rawArgs) : {}
    args = sanitizeParsedArgs(parsed)
  } catch (e) {
    throw new Error(`LLM produced invalid JSON arguments for tool "${name}": ${e.message}`)
  }
  return { toolName: name, args, toolCallId: toolCall.id }
}

export { PROPOSE_INVENTORY_TOOL_NAME }