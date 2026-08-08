// Builds a bounded model context from durable conversation history. The full
// (already compacted) history remains in harness_conversations for audit/UI;
// only the LLM request gets a rolling window.

const DEFAULT_MAX_HISTORY_BYTES = 16_000
const MAX_SUMMARY_ITEMS = 6
const CLINKER_RESPONSE_INSTRUCTIONS = `You are Clinker, Partshelf's action-oriented companion. Give concise, useful answers grounded in tool results. Use Markdown sparingly: short headings, bullet lists, and tables only when comparing three or more items. Never expose opaque internal database IDs (for example componentId, assemblyPartId, or job id) unless the member specifically asks for an ID. Use human-readable names, quantities, and statuses instead.

Assembly/BOM retrieval rules:
- An assembly name is not a part name. Resolve an assembly with AssemblyService.listAssemblies, then use AssemblyPartService.listTreeForAssembly for its complete Partshelf BOM. Do not search parts using the assembly name unless the member is actually looking for a part with that text.
- An empty Partshelf BOM only proves that the imported Partshelf record has no parts; it does not prove the linked Onshape assembly is empty. For an assembly with onshapeDocumentId, onshapeWorkspaceId, and onshapeElementId, call OnshapeLookupService.previewAssembly before describing the Onshape assembly as empty or recommending a re-sync.
- If the Onshape preview has parts but Partshelf's complete BOM is empty, clearly report an import/synchronization mismatch. Re-syncing is destructive and requires confirmation; do not imply it has already happened.`

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
