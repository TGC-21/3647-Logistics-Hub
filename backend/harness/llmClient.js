// backend/harness/llmClient.js
//
// Thin client for the home PC's OpenAI-compatible inference server
// (llama.cpp's llama-server or Ollama, both expose POST
// /v1/chat/completions). Deliberately dumb: this file knows nothing
// about Partshelf's tools, conversations, or confirmation flow — it
// only knows how to send a chat-completions request and hand back the
// response, same "pure client, no business logic" discipline
// backend/_lib/onshape.js already follows for the Onshape API.
//
// Buildable/testable against a mocked fetch before the real inference
// server exists — see AGENTIC_HARNESS_PHASE3_EXECUTION.md's "Next
// step" section.

import { compactAssistantMessage } from './toolResultCompactor.js'
import { estimateRequestContext } from './contextWindow.js'

const DEFAULT_TIMEOUT_MS = 240_000   // local 14B inference can be slow — generous default, not Onshape's snappier timeout assumptions


function getConfig() {
  const baseUrl = process.env.LLM_BASE_URL
  const model   = process.env.LLM_MODEL || 'qwen3-14b-instruct'
  if (!baseUrl) {
    throw new Error('LLM_BASE_URL must be set (e.g. http://<wireguard-tunnel-ip>:8080/v1) — the home PC inference server\'s OpenAI-compatible base URL.')
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), model }
}

// How many streamed content chunks to hold back before forwarding
// anything to the caller's onToken(). A response is, in practice,
// either pure text OR a tool call — models don't typically interleave
// the two — but "in practice" isn't a guarantee, and the whole point of
// this feature is to never show the member something that turns out not
// to be the real answer. Holding back the first couple of chunks costs
// a few hundred ms of perceived latency but means a response that
// starts with a short text preamble and then pivots into a tool call
// has a real chance of never reaching onToken() at all, instead of
// flashing a half-sentence that's then silently discarded. It is NOT a
// hard guarantee — a tool call declared after several genuine content
// chunks have already streamed can still happen — see this file's
// module doc comment on chatCompletion() for the full trade-off.
const PREBUFFER_CHUNKS = 2

/**
 * Reads an SSE `text/event-stream` response body and reconstructs the
 * same `{ role: 'assistant', content, tool_calls? }` shape the
 * non-streaming path returns, while forwarding CONFIRMED plain-text
 * content to `onToken` as it arrives.
 *
 * Critical property: tool-call argument fragments (`delta.tool_calls`)
 * are NEVER forwarded to onToken — they're partial, invalid JSON at
 * every point except the very last chunk (e.g. `{"categ` then
 * `{"category`...), and showing that to a member would be exactly the
 * "gibberish" this feature must avoid. The moment any `tool_calls`
 * delta is seen, forwarding of THIS response's content is disabled for
 * the rest of the stream (see PREBUFFER_CHUNKS above for why a small
 * holdback also protects the common "short lead-in, then a tool call"
 * case). Content is still accumulated internally either way, since the
 * final returned message must be accurate regardless of what was shown
 * live.
 *
 * `onReasoningToken`, when provided, receives `delta.reasoning_content`
 * fragments (present on models — e.g. Qwen — that emit a separate
 * reasoning trace; simply never fires on models, like Gemma, that
 * don't). Reasoning text is inherently exploratory/non-final, so it is
 * always routed to its own callback, never merged into onToken's
 * stream — a caller wanting to show it should render it in a visually
 * distinct "thinking" region, never inside the answer bubble.
 */
async function consumeStream(res, { onToken, onReasoningToken }) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()   // stateful — decode(..., {stream:true}) below avoids splitting a multi-byte UTF-8 char across two chunks
  let buffer = ''
  let content = ''
  const toolCallsByIndex = new Map()
  let toolCallDetected = false
  let pendingContent = ''
  let chunkCount = 0
  let streamStarted = false

  const flushPending = () => {
    if (pendingContent && onToken) {
      onToken(pendingContent)
      pendingContent = ''
    }
  }

  const handleDelta = (delta) => {
    if (!delta) return
    if (Array.isArray(delta.tool_calls)) {
      toolCallDetected = true
      for (const fragment of delta.tool_calls) {
        const idx = fragment.index ?? 0
        const existing = toolCallsByIndex.get(idx) || { id: '', type: 'function', function: { name: '', arguments: '' } }
        if (fragment.id) existing.id = fragment.id
        if (fragment.type) existing.type = fragment.type
        if (fragment.function?.name) existing.function.name += fragment.function.name
        if (fragment.function?.arguments) existing.function.arguments += fragment.function.arguments
        toolCallsByIndex.set(idx, existing)
      }
    }
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
      onReasoningToken?.(delta.reasoning_content)
    }
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content
      if (!toolCallDetected && onToken) {
        chunkCount++
        if (!streamStarted) {
          pendingContent += delta.content
          if (chunkCount >= PREBUFFER_CHUNKS) { streamStarted = true; flushPending() }
        } else {
          onToken(delta.content)
        }
      }
    }
  }

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      for (const line of rawEvent.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let parsed
        try { parsed = JSON.parse(payload) } catch { continue }   // a malformed/partial SSE frame — skip it rather than abort the whole reply
        handleDelta(parsed?.choices?.[0]?.delta)
      }
    }
  }

  // A short reply that never reached PREBUFFER_CHUNKS (or one that
  // ended exactly on a boundary) still has unflushed pendingContent —
  // nothing streamed should ever be silently lost, only ever delayed.
  if (!toolCallDetected) flushPending()

  const message = { role: 'assistant', content }
  if (toolCallsByIndex.size) {
    message.tool_calls = [...toolCallsByIndex.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
  }
  return message
}


/**
 * Sends one chat-completions request. `messages` is the full OpenAI-
 * shaped history ([{ role, content, tool_calls?, tool_call_id? }, ...]);
 * `tools` is the OpenAI `tools` array (see toolSchema.js for the
 * translation from harnessToolRegistry.listTools()). Both passed through
 * verbatim — this function does no shaping of its own.
 *
 * Returns the first choice's message object as-is
 * ({ role: 'assistant', content, tool_calls? }) — the caller
 * (conversationLoop.js) decides what to do with tool_calls vs. plain
 * content, not this file.
 *
 * `onToken(text)`, when provided, switches this call into streaming
 * mode (`stream: true` on the request) and is invoked with confirmed
 * plain-text content fragments as they arrive — see consumeStream()'s
 * doc comment above for exactly what "confirmed" means and why a tool
 * call round never reaches it. `onReasoningToken(text)` is the separate
 * channel for a model's reasoning trace, if it emits one. Omitting
 * onToken uses the original non-streaming request/response path,
 * completely unchanged.
 *
 * Throws on non-2xx, on timeout, or if the response is missing the
 * shape a caller can act on — never returns a malformed/partial result
 * silently.
 */

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Every user message carrying an image attachment is sent as real
// multimodal content — no keyword gate. The previous IMAGE_REQUEST regex
// silently downgraded an attached image to a bare URL string whenever the
// member's wording didn't happen to match a fixed word list ("identify",
// "describe", "photo", etc.), which meant the model never actually saw
// the image on those turns and had to guess. "The member attached an
// image this turn" is sufficient justification on its own to pay the
// fetch+base64 cost — that's the whole signal we need.
async function messagesForModel(messages) {
  return Promise.all(messages.map(async message => {
    if (message.role !== 'user' || !Array.isArray(message.attachments) || !message.attachments.length) {
      return message
    }

    const content = [{ type: 'text', text: message.content || 'Analyze the attached image.' }]
    for (const attachment of message.attachments) {
      if (!attachment.url) continue
      const response = await fetch(attachment.url)
      if (!response.ok) throw new Error(`Could not fetch attached image (${response.status})`)
      const bytes = Buffer.from(await response.arrayBuffer()).toString('base64')
      const mimeType = attachment.mimeType || response.headers.get('content-type') || 'image/jpeg'
      content.push({ type: 'image_url', image_url: { url: `data:${mimeType};base64,${bytes}` } })
    }
    const { attachments, ...modelMessage } = message
    return { ...modelMessage, content }
  }))
}

export async function chatCompletion({ messages, tools = [], temperature = 0.3, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 2, onToken = null, onReasoningToken = null } = {}) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error('chatCompletion requires a non-empty messages array')
  }

  const { baseUrl, model } = getConfig()
  const modelMessages = await messagesForModel(messages)
  const streaming = typeof onToken === 'function'
  const body = {
    model, messages: modelMessages, temperature,
    ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
    ...(streaming ? { stream: true } : {}),

  }

  const context = estimateRequestContext({ messages: modelMessages, tools })
  console.info('[harness] LLM context estimate', {
    messageCount: messages.length, toolCount: tools.length,
    requestBytes: context.requestBytes, estimatedTokens: context.estimatedTokens,
  })

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let res
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (e) {
      clearTimeout(timer)
      // Network-level failure (connection refused, DNS, abort) — retryable
      // if we haven't exhausted attempts, since a locally-hosted inference
      // server is far more prone to transient hiccups (model still loading
      // a prior request, brief GPU contention) than a hosted API.
      const isTimeout = e.name === 'AbortError'
      if (attempt < retries) {
        const backoffMs = 500 * 2 ** attempt
        console.warn(`[harness] LLM request ${isTimeout ? 'timed out' : 'failed'} (attempt ${attempt + 1}/${retries + 1}) — retrying in ${backoffMs}ms: ${e.message}`)
        await sleep(backoffMs)
        continue
      }
      throw isTimeout
        ? new Error(`LLM request timed out after ${timeoutMs}ms (${retries + 1} attempts) — the inference server may be overloaded or unreachable.`)
        : new Error(`LLM request failed after ${retries + 1} attempts: ${e.message} — is the inference server running and reachable at ${baseUrl}?`)
    }
    clearTimeout(timer)

    if (res.ok) {
      if (streaming) {
        // A stream that fails partway through (connection drop,
        // malformed frame) is deliberately NOT retried — partial tokens
        // may already have reached the member, so silently retrying and
        // risking a duplicated/garbled reply is worse than a hard
        // failure the caller can surface and let the member re-ask.
        const message = await consumeStream(res, { onToken, onReasoningToken })
        return compactAssistantMessage(message)
      }
      const data = await res.json()
      const message = data?.choices?.[0]?.message
      if (!message) throw new Error('LLM response missing choices[0].message — unexpected response shape from inference server')
      return compactAssistantMessage(message)
    }

    // 5xx from the inference server is often transient (OOM recovery,
    // model swap) — retry those; 4xx (bad request shape) never will
    // succeed on retry, so fail immediately.
    if (res.status >= 500 && attempt < retries) {
      const backoffMs = 500 * 2 ** attempt
      console.warn(`[harness] LLM server returned ${res.status} (attempt ${attempt + 1}/${retries + 1}) — retrying in ${backoffMs}ms`)
      await sleep(backoffMs)
      continue
    }

    const text = await res.text().catch(() => '')
    throw new Error(`LLM server returned ${res.status}: ${text.slice(0, 400)}`)
  }
}

/** Cheap reachability check — for the "curl-test the inference server
 *  independently first" step in AGENTIC_HARNESS_PHASE3_EXECUTION.md,
 *  and useful as a startup sanity check for the loop itself. */
export async function pingLlm() {
  try {
    await chatCompletion({ messages: [{ role: 'user', content: 'ping' }], timeoutMs: 10_000 })
    return true
  } catch {
    return false
  }
}
