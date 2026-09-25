/**
 * Proves every failure shape and every usage count the adapter hands the harness
 * survives the durable session log's lossless-JSON rule.
 *
 * The harness writes the adapter's `finish.reason.failure` straight into an
 * `llm/retry` session event, and that append rejects Error instances, non-finite
 * numbers and explicit `undefined` fields — a rejected append aborts the whole
 * turn instead of letting the harness back off and retry. This runs the real
 * adapter against a dead port (no upstream quota is spent) and checks the object
 * it actually yields.
 *
 * Run: node scripts/retry-safety-test.mjs
 */

// Must be set before the adapter module reads it.
process.env.OUR_FREE_MODEL_BASE = 'http://127.0.0.1:9'

const { FreeModelAdapter, ROUTE_MAIN, ROUTE_REGION } = await import('../src/adapter.js')

/**
 * Mirrors `snapshotJsonValue` from @deepseek-ai/dsh-util-values: a value survives
 * only if every leaf is a JSON primitive, a plain object or an array.
 */
function isLosslessJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (Array.isArray(value)) return value.every(item => isLosslessJson(item, seen))
  if (typeof value !== 'object' || value === undefined) return false
  if (seen.has(value)) return false
  seen.add(value)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(value).every(item => isLosslessJson(item, seen))
}

const CATALOG = [{
  id: 'test-model-free', name: 'Test Model', availability: 'available',
  vision: false, reasoning: true, contextWindow: 128000, maxOutput: 8192,
}]

const STATE = () => ({
  catalog: CATALOG,
  membership: { [ROUTE_MAIN]: ['test-model-free'], [ROUTE_REGION]: [] },
  settings: { enabled: true, defaultMaxTokens: 4096 },
  attributionUserAgent: 'test/1.0',
})

/** Run the real adapter and return the failure object it yields, if any. */
async function failureFor(state, options = {}) {
  const adapter = new FreeModelAdapter({ state, recordUsage: () => {}, warn: () => {} })
  for await (const chunk of adapter.stream({
    model: `${ROUTE_MAIN}/test-model-free`,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...options,
  })) {
    if (chunk.type === 'finish' && chunk.reason.kind === 'error') return chunk.reason.failure
  }
  return null
}

const cases = [
  ['transport failure (dead upstream port)', () => failureFor(STATE)],
  ['model not served on this egress', () => failureFor(
    () => ({ ...STATE(), membership: { [ROUTE_MAIN]: [], [ROUTE_REGION]: [] } }),
  )],
  ['plugin switched off mid-call', () => failureFor(
    () => ({ ...STATE(), settings: { ...STATE().settings, enabled: false } }),
  )],
  ['aborted signal', () => failureFor(STATE, { signal: AbortSignal.abort() })],
]

let failed = 0
for (const [name, run] of cases) {
  let failure
  try {
    failure = await run()
  } catch (error) {
    console.log(`FAIL  ${name}: stream threw instead of yielding a failure — ${error?.message ?? error}`)
    failed++
    continue
  }
  if (failure === null) {
    console.log(`FAIL  ${name}: no error finish produced`)
    failed++
    continue
  }
  const keys = Object.keys(failure).filter(key => failure[key] === undefined)
  const serializable = isLosslessJson(failure)
  const shaped = typeof failure.message === 'string' && failure.message.length > 0
    && typeof failure.code === 'string' && failure.code.length > 0
  if (serializable && shaped && keys.length === 0) {
    console.log(`ok    ${name}: ${failure.code}${failure.status ? ` (HTTP ${failure.status})` : ''}`)
  } else {
    console.log(`FAIL  ${name}: serializable=${serializable} shaped=${shaped} undefinedFields=[${keys}] ${JSON.stringify(failure)}`)
    failed++
  }
}

// The provider policy is consumed verbatim by the kernel's backoff scheduler,
// which reads these fields off the top level. A nested `backoff` makes the
// scheduled delay NaN, and the durable session log rejects NaN outright.
const policy = new FreeModelAdapter({ state: STATE, recordUsage: () => {}, warn: () => {} }).providerRetryPolicy()
const exponential = Math.min(policy.initialDelayMs * 2 ** 0, policy.maxDelayMs)
const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * 0.5
const firstDelay = Math.min(exponential * jitter, policy.maxDelayMs)
const policyShapeOk = isLosslessJson({ ...policy, retryableCodes: [...policy.retryableCodes] })
  && Number.isFinite(firstDelay) && firstDelay > 0
console.log(`${policyShapeOk ? 'ok   ' : 'FAIL '} retry policy schedules a finite delay: firstDelay=${Number.isFinite(firstDelay) ? Math.round(firstDelay) : 'NaN'}ms`)

// The same rule covers the usage event the harness appends after a turn, and the
// OpenAI `usage` object has no required details block: reading `cached_tokens`
// off an absent one made `inputTokens` NaN on every call from a gateway that
// omits the optional field.
const { mapUsage } = await import('../src/stream.js')
const bare = mapUsage({ prompt_tokens: 11, completion_tokens: 7 })
const usageOk = isLosslessJson(bare) && bare?.inputTokens === 11 && bare?.outputTokens === 7
  && bare.totalTokens === 18 && !('cacheReadTokens' in bare)
console.log(`${usageOk ? 'ok   ' : 'FAIL '} a usage object with no details block stays finite: ${JSON.stringify(bare)}`)

const cached = mapUsage({ prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 12 } })
const cachedOk = cached.inputTokens === 8 && cached.cacheReadTokens === 12 && cached.totalTokens === 25
console.log(`${cachedOk ? 'ok   ' : 'FAIL '} a cache hit is taken out of the disjoint input count: ${JSON.stringify(cached)}`)

const ok = failed === 0 && policyShapeOk && usageOk && cachedOk
console.log(ok
  ? `\nretry-safety: all ${cases.length} failure shapes are durable-log safe`
  : `\nretry-safety: ${failed + (policyShapeOk ? 0 : 1) + (usageOk ? 0 : 1) + (cachedOk ? 0 : 1)} failure(s)`)
process.exit(ok ? 0 : 1)
