/**
 * Availability probing.
 *
 * The gateway does not disclose which models this egress may use: the model
 * listing is a flat id list, and exclusion only appears when a request is
 * refused with a `RegionError`. Availability is therefore established by asking,
 * with the smallest request that can produce a verdict.
 *
 * Egress is watched alongside it because the answer is a property of the
 * network path, not of the account: turning a VPN on changes which models exist
 * for the user, and the picker has to follow without a restart. The cheapest
 * reliable signal is the public address the gateway itself sees.
 *
 * @module src/probe.js
 */

import { applyFingerprint, endpointFor, mintRequestId, sessionForConversation, wireFor } from './upstream.js'
import { CODE, getJson, postStreamed } from './http.js'

/** Public-echo sources, tried in order; any one answering is enough. */
const ECHO_SOURCES = [
  { url: 'https://api.ipify.org?format=json', pick: payload => payload?.ip },
  { url: 'https://ipinfo.io/json', pick: payload => payload?.ip, extra: payload => payload?.country },
  { url: 'https://ipapi.co/json/', pick: payload => payload?.ip, extra: payload => payload?.country_code },
]

/** Verdicts the probe can return, and how each maps to picker membership. */
export const STATE = {
  available: 'available',
  regionBlocked: 'region-blocked',
  unavailable: 'unavailable',
  throttled: 'throttled',
  unknown: 'unknown',
}

const PING_PROMPT = 'ping'

/**
 * Ask the gateway for one model, once.
 *
 * @param {object} model - catalog entry
 * @param {object} options
 * @param {string} [options.attributionUserAgent]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{state:string, detail?:string, latencyMs:number, ttftMs?:number}>}
 */
export async function probeModel(model, { attributionUserAgent, signal, timeoutMs = 45000 } = {}) {
  const started = Date.now()
  const session = sessionForConversation('probe:our-free-model')
  const wire = wireFor(model.id)
  const body = buildPing(model.id, wire)
  applyFingerprint(body, wire === 'responses')

  let firstDelta
  try {
    await postStreamed({
      path: endpointFor(model.id),
      body,
      session,
      requestId: mintRequestId(),
      attributionUserAgent,
      signal,
      timeoutMs,
      onData: payload => {
        if (firstDelta !== undefined) return
        if (/"(delta|content|text|output_item)"|response\.(output_item|output_text|function_call)/.test(payload)) firstDelta = Date.now()
      },
    })
    return { state: STATE.available, latencyMs: Date.now() - started, ttftMs: firstDelta === undefined ? undefined : firstDelta - started }
  } catch (error) {
    return {
      state: stateOf(error),
      detail: typeof error?.message === 'string' ? error.message.slice(0, 200) : String(error),
      latencyMs: Date.now() - started,
    }
  }
}

function buildPing(modelId, wire) {
  if (wire === 'responses') {
    return {
      model: modelId,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: PING_PROMPT }] }],
      stream: true,
      store: false,
      max_output_tokens: 16,
    }
  }
  if (wire === 'messages') {
    return {
      model: modelId,
      messages: [{ role: 'user', content: PING_PROMPT }],
      stream: true,
      max_tokens: 16,
    }
  }
  return { model: modelId, messages: [{ role: 'user', content: PING_PROMPT }], stream: true, max_tokens: 16 }
}

function stateOf(error) {
  switch (error?.code) {
    case CODE.region: return STATE.regionBlocked
    case CODE.quota: return STATE.throttled
    default: break
  }
  if (error?.unavailable === true || /unavailable|not supported/i.test(String(error?.message))) return STATE.unavailable
  return STATE.unknown
}

/**
 * Resolve the public address the gateway will see, plus its country when an echo
 * discloses one. Fail-open: an absent answer simply means "no egress signal".
 */
export async function detectEgress({ signal, timeoutMs = 8000 } = {}) {
  for (const source of ECHO_SOURCES) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      timer.unref?.()
      signal?.addEventListener('abort', () => controller.abort(), { once: true })
      const response = await fetch(source.url, { signal: controller.signal, redirect: 'error', headers: { accept: 'application/json' } })
      clearTimeout(timer)
      if (!response.ok) continue
      const payload = await response.json()
      const ip = source.pick(payload)
      if (typeof ip !== 'string' || ip === '') continue
      const country = source.extra?.(payload)
      return { ip, ...country === undefined ? {} : { country: String(country) } }
    } catch {
      // try the next echo
    }
  }
  return undefined
}

/**
 * Refresh the model listing from the gateway.
 * @returns {Promise<string[]>} ids, in upstream order
 */
export async function fetchUpstreamIds({ attributionUserAgent, signal } = {}) {
  const payload = await getJson('/zen/v1/models', { session: sessionForConversation('catalog:our-free-model'), requestId: mintRequestId(), attributionUserAgent, signal })
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []
  return rows.map(row => (typeof row === 'string' ? row : row?.id)).filter(id => typeof id === 'string' && id !== '')
}

/**
 * Probe a whole catalog with a bounded fan-out.
 *
 * Concurrency stays low on purpose: this lane accounts quota per session and
 * answers 429 with growing retry-after, so a wide burst would throttle the very
 * user whose availability we are establishing.
 */
export async function probeCatalog(models, options = {}, onResult = () => {}, concurrency = 2) {
  const results = {}
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, models.length)) }, async () => {
    while (cursor < models.length) {
      const index = cursor++
      const model = models[index]
      const result = await probeModel(model, options)
      results[model.id] = result
      onResult(model.id, result)
    }
  })
  await Promise.all(workers)
  return results
}
