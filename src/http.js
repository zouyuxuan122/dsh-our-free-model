/**
 * Outbound HTTP for the free lane: request posting, SSE line extraction, and the
 * classification of gateway failures into the harness's provider-neutral codes.
 *
 * The gateway reports a refusal as a JSON error envelope whose `type` is the
 * machine-readable discriminator. Three of them matter operationally and are
 * distinguished here because they need different handling:
 *
 * - `RegionError`  — the model exists but this egress country is excluded. Not a
 *   credential or capacity problem, and it clears the moment the user's egress
 *   changes, so it feeds the availability probe rather than a retry.
 * - `FreeUsageLimitError` / 429 — the per-session quota is spent; retrying with
 *   a fresh session makes it worse, which is why the session id is stable.
 * - `ModelError` / "Model is unavailable" — the pooled account no longer routes
 *   that id at all.
 *
 * @module src/http.js
 */

import { CLIENT_UA, UPSTREAM_BASE, gatewayHeaders, truncateSession } from './upstream.js'

/** Harness-neutral failure codes (packages/llm/llm/src/error.ts vocabulary). */
export const CODE = {
  region: 'REGION_BLOCKED',
  quota: 'RATE_LIMIT',
  credential: 'INVALID_CREDENTIAL',
  transport: 'TRANSPORT',
  timeout: 'TIMEOUT',
  server: 'SERVER',
  empty: 'EMPTY_RESPONSE',
  aborted: 'ABORTED',
}

export class UpstreamError extends Error {
  constructor(message, code, details = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.code = code
    Object.assign(this, details)
  }
}

/** Turn a gateway JSON error envelope into a classified failure. */
export function classifyFailure(status, payload, retryAfterMs) {
  const error = payload?.error ?? payload ?? {}
  const type = typeof error.type === 'string' ? error.type : ''
  const message = typeof error.message === 'string' ? error.message : `upstream HTTP ${status}`
  const flat = message.toLowerCase()
  if (type === 'RegionError' || /not available in your country|region/i.test(flat)) {
    return new UpstreamError(message, CODE.region, { status, type })
  }
  if (status === 429 || type === 'FreeUsageLimitError' || /usage limit|rate limit/i.test(flat)) {
    return new UpstreamError(message, CODE.quota, { status, type, providerRetryAfterMs: retryAfterMs })
  }
  if (status === 401 || status === 403) return new UpstreamError(message, CODE.credential, { status, type })
  if (type === 'ModelError' || /model is unavailable|not supported/.test(flat)) {
    return new UpstreamError(message, CODE.server, { status, type, unavailable: true })
  }
  return new UpstreamError(message, CODE.server, { status, type })
}

/** Parse `Retry-After` into milliseconds, when the header carries a number. */
function retryAfter(header) {
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds > 0 ? Math.trunc(seconds * 1000) : undefined
}

/**
 * POST one request and stream back decoded SSE `data:` payloads.
 *
 * @param {object} options
 * @param {string} options.path - gateway path
 * @param {object} options.body - JSON request body
 * @param {string} options.session - canonical upstream session id
 * @param {string} options.requestId - per-turn request id
 * @param {string} [options.attributionUserAgent] - harness User-Agent merged into the request
 * @param {AbortSignal} [options.signal]
 * @param {(payload: string) => void} options.onData - one `data:` payload, in order
 * @returns {Promise<{status:number, headers:Headers}>}
 */
/**
 * Compose the request User-Agent.
 *
 * Two independent requirements meet in one header: the harness mandates an
 * attribution User-Agent on every provider request, and the gateway identifies a
 * desktop client by an `opencode/<version>` token (>= 1.17). The gateway tests
 * with a search rather than an anchored match, so one value can satisfy both —
 * verified live against this lane.
 */
function userAgentWith(attribution) {
  if (typeof attribution !== 'string' || attribution === '') return CLIENT_UA
  return attribution.includes('opencode/') ? attribution : `${attribution} ${CLIENT_UA}`
}

export async function postStreamed({ path, body, session, requestId, attributionUserAgent, signal, onData, timeoutMs = 300000 }) {
  const headers = gatewayHeaders({ session: truncateSession(session), requestId, stream: true })
  headers['user-agent'] = userAgentWith(attributionUserAgent)
  let response
  try {
    response = await fetch(`${UPSTREAM_BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal })
  } catch (error) {
    if (error?.name === 'AbortError') throw new UpstreamError('request aborted', CODE.aborted)
    throw new UpstreamError(`our-free-model: upstream request failed: ${error?.message ?? error}`, CODE.transport)
  }

  const setRetry = retryAfter(response.headers.get('retry-after'))
  const contentType = String(response.headers.get('content-type') ?? '')
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let payload
    try { payload = JSON.parse(text) } catch { payload = { error: { message: text.slice(0, 300) || `HTTP ${response.status}` } } }
    throw classifyFailure(response.status, payload, setRetry)
  }
  if (response.body === null) throw new UpstreamError('our-free-model: upstream returned no body', CODE.empty)
  if (!contentType.includes('event-stream')) {
    const text = await response.text()
    let payload
    try { payload = JSON.parse(text) } catch { throw new UpstreamError(`our-free-model: unexpected non-SSE response: ${text.slice(0, 200)}`, CODE.server) }
    if (payload.error) throw classifyFailure(response.status, payload, setRetry)
    onData(JSON.stringify(payload))
    return { status: response.status, headers: response.headers }
  }

  await readSse(response.body, onData, signal, timeoutMs)
  return { status: response.status, headers: response.headers }
}

/** Split an SSE byte stream into `data:` payload strings; comment lines ignored. */
export async function readSse(stream, onData, signal, timeoutMs = 300000) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let deadline = Date.now() + timeoutMs
  const onAbort = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (Date.now() > deadline) throw new UpstreamError('our-free-model: upstream stream idle past its deadline', CODE.timeout)
      if (value !== undefined) buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        emit(line, onData)
        newline = buffer.indexOf('\n')
      }
      deadline = Date.now() + timeoutMs
    }
    emit(buffer, onData)
  } catch (error) {
    if (error instanceof UpstreamError) throw error
    if (signal?.aborted) throw new UpstreamError('request aborted', CODE.aborted)
    throw new UpstreamError(`our-free-model: stream read failed: ${error?.message ?? error}`, CODE.transport)
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock?.()
  }
}

function emit(line, onData) {
  const text = line.trim()
  if (text === '' || text.startsWith(':')) return
  if (text.startsWith('data:')) {
    const payload = text.slice(5).trim()
    if (payload === '' || payload === '[DONE]') return
    onData(payload)
  }
}

/** Fetch a small JSON document from the gateway with the fingerprint headers. */
export async function getJson(path, { session, requestId, attributionUserAgent, signal, timeoutMs = 15000 } = {}) {
  const headers = gatewayHeaders({ session: truncateSession(session ?? ''), requestId: requestId ?? '', stream: false, accept: 'application/json' })
  headers['user-agent'] = userAgentWith(attributionUserAgent)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  signal?.addEventListener('abort', () => controller.abort(), { once: true })
  try {
    const response = await fetch(`${UPSTREAM_BASE}${path}`, { headers, redirect: 'error', signal: controller.signal })
    const text = await response.text()
    let payload
    try { payload = JSON.parse(text) } catch { payload = { error: { message: text.slice(0, 200) } } }
    if (!response.ok) throw classifyFailure(response.status, payload)
    return payload
  } catch (error) {
    if (error instanceof UpstreamError) throw error
    if (error?.name === 'AbortError') throw new UpstreamError('our-free-model: upstream GET timed out', CODE.timeout)
    throw new UpstreamError(`our-free-model: upstream GET failed: ${error?.message ?? error}`, CODE.transport)
  } finally {
    clearTimeout(timer)
  }
}
