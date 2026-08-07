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

/** The full tool array for a chat-completions request — everything the
 *  harness is allowed to call, translated wholesale. This is what
 *  conversationLoop.js passes as `tools` to llmClient.chatCompletion(). */
export function buildToolSchema({ actionNames = null } = {}) {
  const allowed = actionNames ? new Set(actionNames) : null
  return HARNESS_TOOLS.filter(tool => !allowed || allowed.has(tool.actionName)).map(toOpenAiTool)
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

  if (!name) {
    throw new Error('Malformed tool_call from LLM — missing function.name')
  }

  let args
  try {
    args = rawArgs ? JSON.parse(rawArgs) : {}
  } catch (e) {
    throw new Error(`LLM produced invalid JSON arguments for tool "${name}": ${e.message}`)
  }

  return { toolName: name, args, toolCallId: toolCall.id }
}
