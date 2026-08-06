// backend/harness/llmClient.js
//
// Thin client for the home PC's OpenAI-compatible inference server
// (llama.cpp's llama-server or Ollama, both expose POST
// /v1/chat/completions). Deliberately dumb: this file knows nothing
// about Partshelf's tools, conversations, or confirmation flow — it
// only knows how to send a chat-completions request and hand back the
// response, same "pure client, no business logic" discipline
// api/_lib/onshape.js already follows for the Onshape API.
//
// Buildable/testable against a mocked fetch before the real inference
// server exists — see AGENTIC_HARNESS_PHASE3_EXECUTION.md's "Next
// step" section.

const DEFAULT_TIMEOUT_MS = 120_000   // local 14B inference can be slow — generous default, not Onshape's snappier timeout assumptions

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
export async function chatCompletion({ messages, tools = [], temperature = 0.3, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error('chatCompletion requires a non-empty messages array')
  }

  const { baseUrl, model } = getConfig()

  const body = {
    model,
    messages,
    temperature,
    ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
  }

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
    if (e.name === 'AbortError') {
      throw new Error(`LLM request timed out after ${timeoutMs}ms — the inference server may be overloaded or unreachable (check the WireGuard tunnel).`)
    }
    throw new Error(`LLM request failed: ${e.message} — is the inference server running and reachable at ${baseUrl}?`)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`LLM server returned ${res.status}: ${text.slice(0, 400)}`)
  }

  const data = await res.json()
  const message = data?.choices?.[0]?.message
  if (!message) {
    throw new Error('LLM response missing choices[0].message — unexpected response shape from inference server')
  }

  return message
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