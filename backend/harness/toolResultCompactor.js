// Keeps database-shaped tool output from consuming the LLM context window.
// This is a harness presentation boundary only: services and repositories
// retain their full records, while the model receives the small subset useful
// for deciding its next action.

const MAX_RESULT_BYTES = 6_000
const MAX_STRING_LENGTH = 500

// Large storage/audit/integration fields do not help the model select its
// next Partshelf action. Domain-specific query tools can expose one later if
// a real workflow needs it.
const OMITTED_KEYS = new Set([
  'onshapeReference', 'fullConfiguration', 'configuration',
  'thumbnail', 'thumbnailUrl', 'fallbackImage', 'image',
  'createdAt', 'updatedAt', 'claimedAt', 'sourceElementMicroversionId',
  'linkedInstanceIds',
])

function compactString(value) {
  return value.length <= MAX_STRING_LENGTH
    ? value
    : `${value.slice(0, MAX_STRING_LENGTH)}… [truncated]`
}

function compactFabricationMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return undefined
  const { kind, status, confidence, autoDetected } = metadata
  return Object.fromEntries(Object.entries({ kind, status, confidence, autoDetected })
    .filter(([, value]) => value !== undefined && value !== null))
}

function compactValue(value, key = '') {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string') return compactString(value)
  if (typeof value !== 'object') return value
  if (key === 'fabricationMetadata') return compactFabricationMetadata(value)
  if (Array.isArray(value)) return value.map(item => compactValue(item)).filter(item => item !== undefined)

  const result = {}
  for (const [childKey, childValue] of Object.entries(value)) {
    if (OMITTED_KEYS.has(childKey)) continue
    const compacted = compactValue(childValue, childKey)
    if (compacted === undefined) continue
    if (typeof compacted === 'object' && !Array.isArray(compacted) && Object.keys(compacted).length === 0) continue
    result[childKey] = compacted
  }
  return result
}

/**
 * Produces compact, JSON-safe model context from any successful tool result.
 * For overlarge lists it returns a clearly-marked envelope rather than
 * silently dropping records. The model can then refine its query instead of
 * assuming the partial list was exhaustive.
 */
export function compactToolResult(result, { maxBytes = MAX_RESULT_BYTES } = {}) {
  const compacted = compactValue(result)
  if (Buffer.byteLength(JSON.stringify(compacted)) <= maxBytes) return compacted

  if (Array.isArray(compacted)) {
    const items = []
    for (const item of compacted) {
      const candidate = [...items, item]
      const envelope = { items: candidate, totalItems: compacted.length, truncated: true }
      if (Buffer.byteLength(JSON.stringify(envelope)) > maxBytes) break
      items.push(item)
    }
    return { items, totalItems: compacted.length, truncated: true }
  }

  // Individual records should be small after field pruning. If one still is
  // large, do not emit an invalid/partial JSON string; give the model a clear
  // instruction to use a narrower tool instead.
  return { truncated: true, message: 'Tool result was too large for the agent context. Refine the query or use a more specific tool.' }
}

/** Normalizes a local OpenAI-compatible response before it enters durable
 * conversation history. In particular, Qwen/llama reasoning traces can be
 * very large but are not user-visible instructions or tool-call data. */
export function compactAssistantMessage(message) {
  const result = { role: 'assistant', content: message?.content ?? '' }
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length) result.tool_calls = message.tool_calls
  return result
}
