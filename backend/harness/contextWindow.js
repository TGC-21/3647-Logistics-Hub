// Builds a bounded model context from durable conversation history. The full
// (already compacted) history remains in harness_conversations for audit/UI;
// only the LLM request gets a rolling window.

const DEFAULT_MAX_HISTORY_BYTES = 16_000
const MAX_SUMMARY_ITEMS = 6
const CLINKER_RESPONSE_INSTRUCTIONS = `You are Clinker, Partshelf's action-oriented companion. Give concise, useful answers grounded in tool results.

Tool routing rules

Follow these rules before choosing a tool:

If the user asks for parts/items in a specific subassembly, first identify the parent assembly, then identify the matching child/subassembly, then use the tool that lists parts for that child.
"Parts in X" means the parts directly belonging to X unless the user explicitly asks for nested/recursive parts.
If you have a child/subassembly ID, prefer a child-specific parts tool over a whole-assembly, tree, search, or availability tool.
Do not use list_tree, list_whole_tree, search, or check_availability as substitutes for a direct child-parts listing tool when a child-parts tool is available.
An empty result from a broader or less-specific tool does NOT prove that an assembly has no parts.
Before concluding that an assembly has no parts, verify using the most specific parts-listing tool available.
Never use a search tool with an empty query.
When a tool returns an explicit truncated: true, report that the result is incomplete and use another tool call if the user asked for the complete result.
When a tool returns an empty result:
1. Do not immediately conclude that the requested data does not exist.
2. Check whether you used the correct entity scope (assembly vs child/subassembly).
3. Prefer a more specific tool that matches the user's wording.
4. Only conclude "none exist" after a tool specifically designed to answer that question returns an authoritative empty result.

ID semantics:
- assemblyId identifies an assembly.
- assemblyChildId identifies a specific child/subassembly instance inside an assembly.
- When the user names a subassembly, and list_children returns that subassembly,
  use the returned child's ID with child-specific tools.
  
General behavior

Give concise, useful answers grounded in tool results. Use Markdown sparingly: short headings, bullet lists, and tables only when comparing three or more items.

Never expose opaque internal database IDs unless the member specifically asks for an ID. Use human-readable names, quantities, and statuses instead.

If you are not confident you have enough information to answer correctly, make another tool call rather than guessing.

When an action needs to be applied to more than one item, prefer the bulk version of that tool over calling the single-item version repeatedly.`

function bytes(value) { return Buffer.byteLength(JSON.stringify(value)) }

function toolNames(message) {
  return (message.tool_calls || []).map(call => call.function?.name).filter(Boolean)
}

function latestUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') return i
  return 0
}

// An assistant tool-call message and all following tool messages are atomic.
// Keeping or dropping them together preserves the OpenAI tool-call protocol.
function chunksAfterUser(messages, userIndex) {
  const chunks = []
  let index = userIndex + 1
  while (index < messages.length) {
    const message = messages[index]
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const chunk = [message]
      index++
      while (index < messages.length && messages[index].role === 'tool') chunk.push(messages[index++])
      chunks.push(chunk)
      continue
    }
    chunks.push([message])
    index++
  }
  return chunks
}

function summaryFor(omittedMessages) {
  const userRequests = omittedMessages
    .filter(message => message.role === 'user' && message.content)
    .slice(-MAX_SUMMARY_ITEMS)
    .map(message => String(message.content).slice(0, 180))
  const calls = omittedMessages.flatMap(toolNames).slice(-MAX_SUMMARY_ITEMS)
  const parts = ['Earlier conversation details were compacted to protect the context window.']
  if (userRequests.length) parts.push(`Earlier requests: ${userRequests.join(' | ')}`)
  if (calls.length) parts.push(`Previously used tools: ${calls.join(', ')}`)
  parts.push('If an omitted result is needed, call a focused read tool again; do not assume omitted data.')
  return { role: 'system', content: parts.join('\n') }
}

/**
 * Keeps the latest user request plus as many complete recent tool rounds as
 * fit. Older durable history is represented by a concise server-generated
 * summary, never raw database JSON.
 */
export function buildContextWindow(messages, { maxHistoryBytes = DEFAULT_MAX_HISTORY_BYTES } = {}) {
  if (!Array.isArray(messages) || !messages.length) throw new Error('buildContextWindow requires conversation messages')

  const userIndex = latestUserIndex(messages)
  const userMessage = messages[userIndex]
  const chunks = chunksAfterUser(messages, userIndex)
  const selected = []
  let selectedBytes = bytes([userMessage])

  for (let i = chunks.length - 1; i >= 0; i--) {
    const candidateBytes = bytes(chunks[i])
    if (selectedBytes + candidateBytes > maxHistoryBytes && selected.length) break
    // Preserve at least the newest complete round even if it is unusually
    // large; tool-result compaction is the primary guard for that case.
    if (selectedBytes + candidateBytes > maxHistoryBytes && !selected.length) {
      selected.unshift(chunks[i])
      selectedBytes += candidateBytes
      break
    }
    selected.unshift(chunks[i])
    selectedBytes += candidateBytes
  }

  const selectedMessages = selected.flat()
  const firstSelectedIndex = selectedMessages.length
    ? messages.indexOf(selectedMessages[0])
    : messages.length
  const omitted = messages.slice(0, userIndex).concat(messages.slice(userIndex + 1, firstSelectedIndex))
  const trimmed = omitted.length > 0
  const systemContent = trimmed
  ? `${CLINKER_RESPONSE_INSTRUCTIONS}\n\n${summaryFor(omitted).content}`
  : CLINKER_RESPONSE_INSTRUCTIONS

  const contextMessages = [
    { role: 'system', content: systemContent },
    userMessage,
    ...selectedMessages,
  ]

  return {
    messages: contextMessages,
    trimmed,
    historyBytes: bytes(contextMessages),
    omittedMessageCount: omitted.length,
  }
}

export function estimateRequestContext({ messages, tools = [] }) {
  const requestBytes = bytes({ messages, tools })
  // An intentionally conservative heuristic for JSON-heavy prompts. Exact
  // tokenization is model-specific, but this gives operations a stable trend.
  return { requestBytes, estimatedTokens: Math.ceil(requestBytes / 3.5) }
}
