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
 * Throws on non-2xx, on timeout, or if the response is missing the
 * shape a caller can act on — never returns a malformed/partial result
 * silently.
 */

const sleep = ms => new Promise(r => setTimeout(r, ms))

const IMAGE_REQUEST = /\b(?:analy[sz]|look|see|view|identify|recognize|read|inspect|describe|what(?:'s| is) in|image|photo|picture)\b/i

async function messagesForModel(messages) {
  return Promise.all(messages.map(async message => {
    if (message.role !== 'user' || !Array.isArray(message.attachments) || !message.attachments.length) {
      return message
    }
    const refs = message.attachments.map(a => a.url).filter(Boolean)
    const referenceText = refs.length ? `\nAttached image reference(s): ${refs.join(', ')}` : ''
    if (!IMAGE_REQUEST.test(String(message.content || ''))) {
      const { attachments, ...textOnly } = message
      return { ...textOnly, content: `${message.content || ''}${referenceText}` }
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

export async function chatCompletion({ messages, tools = [], temperature = 0.3, timeoutMs = DEFAULT_TIMEOUT_MS, retries = 2 } = {}) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error('chatCompletion requires a non-empty messages array')
  }

  const { baseUrl, model } = getConfig()
  const modelMessages = await messagesForModel(messages)
  const body = {
    model, messages: modelMessages, temperature,
    ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
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
