/**
 * Our Free Model — plugin entry (Host half).
 *
 * Wiring: one adapter instance, two provider routes (usable now / region-limited
 * on this egress), a live-catalog + availability-probe loop behind them, the
 * browser-facing JSON API the settings page reads, and the OpenAI-compatible
 * forward listener.
 *
 * Every harness facility is reached through `ctx` and declared in `inject`, so a
 * composition that omits one degrades that feature rather than failing the
 * plugin: no web server means no in-app dashboard, no timer means no background
 * re-probe, no attachments means image blocks fall back to the text projection
 * the runtime already performs.
 *
 * @module index.js
 */

import path from 'node:path'
import fs from 'node:fs'
import { FreeModelAdapter, ROUTE_LABELS, ROUTE_MAIN, ROUTE_REGION } from './src/adapter.js'
import { JsonStore, SETTINGS_INITIAL, STATS_INITIAL, STATS_VERSION, DATA_DIR_NAME, MIN_DECODE_MS, decodeWindow, migrateStats, pruneDays, recordUsage, resolveDshHome } from './src/store.js'
import { buildCatalog, parseListing, parseRouterCapabilities, parseRouterRegistry, UPSTREAM_MODELS_URL } from './src/catalog.js'
import { STATE, detectEgress, fetchUpstreamIds, probeCatalog } from './src/probe.js'
import { generateKey, startForwardServer } from './src/forward.js'
import { CODE, UpstreamError } from './src/http.js'
import { applyFingerprint, baseModelId, endpointFor, mintRequestId, sessionForConversation, wireFor } from './src/upstream.js'
import { budgetFor, DEFAULT_LEVEL } from './src/effort.js'
import { toChatMessages, toToolDefs } from './src/messages.js'
import { windowTokens } from './src/stream.js'

export const name = 'our-free-model'

/**
 * `llm` is what the plugin exists for; `webServer` carries the settings page's
 * data routes; `timer` carries the availability re-probe loop. Cordis withholds
 * any service a plugin does not name here, so this list has to match the direct
 * property accesses in `apply`. Optional collaborators (attachments) are reached
 * through `ctx.get()` instead, so their absence degrades one feature rather than
 * blocking activation.
 */
export const inject = ['llm', 'webServer', 'timer']

/** Published tables of the upstream router project, used as a capability overlay. */
const ROUTER_RAW_BASE = 'https://raw.githubusercontent.com/decolua/9router/main/open-sse'

/** Static fallback catalog, so a cold start with no network still lists models. */
const FALLBACK_CATALOG = buildCatalog([
  'mimo-v2.6-flash-free', 'mimo-v2.5-free', 'ling-3.0-flash-fin-free',
  'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free', 'space-bunny-free',
  'muse-spark-1.3-contributor-free', 'muse-spark-1.2-contributor-free',
])

/** Where the plugin's own announcement copy lives; bump it to re-announce. */
export const ANNOUNCEMENT_VERSION = '2026-09-24.1'

/**
 * Resolve the harness attribution User-Agent.
 *
 * Imported lazily because the plugin must not pin a kernel version: the package
 * is supplied by whichever installation resolves the bundle, and if a composition
 * cannot supply it a literal keeps attribution present, which is what the adapter
 * contract requires.
 */
async function resolveAttributionUserAgent(logger) {
  try {
    const module = await import('@deepseek-ai/dsh-llm')
    const headers = typeof module.attributionHeaders === 'function' ? module.attributionHeaders() : undefined
    const agent = headers?.['user-agent'] ?? headers?.['User-Agent']
    if (typeof agent === 'string' && agent !== '') return agent
  } catch (error) {
    logger?.debug?.(`our-free-model: attribution module unavailable (${error?.message ?? error})`)
  }
  return 'deepseek-harness/0.1.7 (+https://github.com/deepseek-ai/deepseek-harness)'
}

export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const home = resolveDshHome()
  const dataDir = path.join(home, DATA_DIR_NAME)
  fs.mkdirSync(dataDir, { recursive: true })

  const settings = new JsonStore(path.join(dataDir, 'settings.json'), SETTINGS_INITIAL)
  const stats = new JsonStore(path.join(dataDir, 'stats.json'), STATS_INITIAL)
  const availability = new JsonStore(path.join(dataDir, 'availability.json'), { version: 1, at: 0, egress: null, results: {} })
  const catalogStore = new JsonStore(path.join(dataDir, 'catalog.json'), { version: 1, at: 0, entries: FALLBACK_CATALOG.map(entry => entry.id) })

  if (stats.get().version !== STATS_VERSION) stats.edit(migrateStats)

  let catalog = materializeCatalog(catalogStore.get().entries ?? [])
  let attributionUserAgent = 'deepseek-harness'
  let egress = availability.get().egress ?? null
  let forward = null
  let forwardError = ''

  /** The immutable snapshot every adapter call binds to. */
  const state = () => ({
    catalog,
    membership: computeMembership(catalog, availability.get(), settings.get()),
    settings: settings.get(),
    attributionUserAgent,
  })

  /** A turn refused for geography means the egress moved; re-classify promptly. */
  let reprobeTimer
  function scheduleReprobe() {
    if (reprobeTimer !== undefined) return
    reprobeTimer = setTimeout(() => {
      reprobeTimer = undefined
      void refreshAvailability().catch(() => {})
    }, 4000)
    reprobeTimer.unref?.()
  }

  const adapter = new FreeModelAdapter({
    state,
    resolveImage: imageResolver(ctx, logger),
    recordUsage: record => {
      recordUsage(stats, record)
      stats.edit(state => pruneDays(state, 120))
    },
    warn: message => logger.warn?.(message) ?? logger.log?.(message),
    onRegionBlocked: () => scheduleReprobe(),
  })

  // ── registration ────────────────────────────────────────────────────────────
  const routes = () => Object.keys(computeMembership(catalog, availability.get(), settings.get()))
  const registration = ctx.llm.registerAdapter([ROUTE_MAIN, ROUTE_REGION], adapter)
  ctx.llm.registerConfigurableProviders?.([
    { provider: ROUTE_MAIN, displayName: ROUTE_LABELS[ROUTE_MAIN], settingsNs: ctx.fiber?.entry?.options?.id ?? name, settingsPath: [] },
  ])

  // Advertise a probe endpoint for the in-app "detect models" button.
  ctx.llm.registerModelDiscovery?.(ctx.fiber?.entry?.options?.id ?? name, async () => {
    await refreshCatalog({ probe: true })
    return catalog.map(entry => ({
      id: entry.id,
      name: entry.name,
      contextWindow: entry.contextWindow,
      maxTokens: entry.maxOutput,
      inputModalities: entry.vision ? ['text', 'image'] : ['text'],
    }))
  })

  ctx.on?.('loader/volatile-update', () => {
    registration.replace(routes())
  })

  // ── catalog + availability ──────────────────────────────────────────────────
  async function refreshCatalog({ probe = true } = {}) {
    let ids = []
    try {
      ids = parseListing(await fetchListing())
    } catch (error) {
      logger.warn?.(`our-free-model: model listing refresh failed (${error?.message ?? error}); keeping the cached catalog`)
    }
    // The router project's published tables fill in what the gateway's flat id
    // list omits, and name models this build has never seen. Both fetches are
    // fail-open: this is an enhancement, and the plugin works without it.
    const [overlay, registryRows] = await Promise.all([fetchRouterOverlay(logger), fetchRouterRegistry(logger)])
    const merged = [...ids, ...registryRows.map(row => row.id)]
    if (merged.length > 0) {
      catalog = buildCatalog(merged, overlay)
      catalogStore.update({ at: Date.now(), entries: catalog.map(entry => entry.id) })
      catalogStore.flush()
      settings.update({ routerSyncedAt: Date.now(), catalogSyncedAt: Date.now() })
    } else {
      catalog = materializeCatalog(catalogStore.get().entries ?? [])
    }
    if (probe) await refreshAvailability()
    emitTopology()
    return catalog
  }

  /**
   * Pull the upstream router project's capability table.
   * @returns {Promise<Record<string, object>>} capacities keyed by model id, empty on any failure
   */
  async function fetchRouterOverlay() {
    const source = await fetchText(`${ROUTER_RAW_BASE}/providers/capabilities.js`)
    return source === '' ? {} : parseRouterCapabilities(source)
  }

  /**
   * Pull the router project's free-tier registry rows.
   * @returns {Promise<Array<{id:string,name?:string}>>}
   */
  async function fetchRouterRegistry() {
    const source = await fetchText(`${ROUTER_RAW_BASE}/providers/registry/opencode.js`)
    return source === '' ? [] : parseRouterRegistry(source)
  }

  async function fetchText(url) {
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout?.(15000) })
      return response.ok ? await response.text() : ''
    } catch {
      return ''
    }
  }

  async function fetchListing() {
    // Read straight from the listing path rather than the probe helper: a listing
    // needs no session identity, and a failure should be a plain throw.
    const response = await fetch(UPSTREAM_MODELS_URL, {
      redirect: 'error',
      headers: {
        'authorization': 'Bearer public',
        'user-agent': `${attributionUserAgent} opencode/1.18.31`,
        'x-opencode-client': 'desktop',
        'x-opencode-session': sessionForConversation('catalog:our-free-model'),
        'x-opencode-request': mintRequestId(),
        'x-opencode-project': 'global',
        'accept': 'application/json',
      },
      signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined,
    })
    if (!response.ok) throw new UpstreamError(`listing HTTP ${response.status}`, CODE.server, { status: response.status })
    return await response.json()
  }

  async function refreshAvailability() {
    const results = await probeCatalog(catalog, { attributionUserAgent }, (id, result) => {
      availability.edit(state => ({ ...state, results: { ...state.results, [id]: { state: result.state, ...result.detail === undefined ? {} : { detail: result.detail }, ...result.ttftMs === undefined ? {} : { ttftMs: result.ttftMs }, latencyMs: result.latencyMs, at: Date.now() } } }))
    }, 2)
    availability.update({ at: Date.now(), egress })
    availability.flush()
    emitTopology()
    return results
  }


  async function watchEgress() {
    const seen = await detectEgress()
    if (seen === undefined) return
    const previous = availability.get().egress
    const changed = previous === null || previous === undefined
      || previous.ip !== seen.ip || (seen.country !== undefined && previous.country !== seen.country)
    egress = seen
    if (changed) {
      availability.update({ egress: seen })
      availability.flush()
      logger.info?.(`our-free-model: egress changed to ${seen.ip}${seen.country ? ` (${seen.country})` : ''}; re-probing availability`)
      await refreshAvailability()
    }
  }

  // ── forward listener ────────────────────────────────────────────────────────
  async function syncForward() {
    const desired = settings.get().forward ?? {}
    const wanted = desired.enabled === true
    if (forward === null && !wanted) return
    if (forward !== null) {
      const closing = forward
      forward = null
      await closing.close().catch(() => {})
    }
    if (!wanted) {
      forwardError = ''
      return
    }
    try {
      forward = await startForwardServer({
        config: () => {
          const current = settings.get().forward ?? {}
          return { host: current.host || '127.0.0.1', port: current.port ?? 0, enabled: current.enabled === true, key: forwardKey() }
        },
        complete: (request, onChunk) => runForwarded(request, onChunk),
        modelRows: () => publicModelRows(),
        log: message => logger.warn?.(`our-free-model forward: ${message}`),
      })
      forwardError = ''
      settings.update({ forward: { ...desired, port: forward.port, host: desired.host || '127.0.0.1' } })
      settings.flush()
    } catch (error) {
      forwardError = String(error?.message ?? error)
      logger.warn?.(`our-free-model: forward listener could not start (${forwardError})`)
    }
  }

  function forwardKey() {
    const current = settings.get()
    if (typeof current.forwardKey === 'string' && current.forwardKey !== '') return current.forwardKey
    const minted = generateKey()
    settings.update({ forwardKey: minted })
    settings.flush()
    return minted
  }

  /**
   * Run one forwarded OpenAI request through the adapter.
   *
   * The caller's spelling is translated into harness messages, and the resulting
   * chunk stream is handed straight back to the caller's callback while an
   * outcome summary accumulates for the non-streaming path.
   */
  async function runForwarded(request, onChunk) {
    const entry = catalog.find(candidate => candidate.id === request.model)
    if (entry === undefined) throw new UpstreamError(`unknown model "${request.model}"`, CODE.server)
    const openAi = request.openAi ?? {}
    const messages = fromOpenAiMessages(openAi, request.responses === true)
    const tools = toToolDefs((openAi.tools ?? []).map(normalizeTool).filter(Boolean), request.responses === true ? 'flat' : 'chat')
    const handler = typeof onChunk === 'function' ? onChunk : () => {}
    const outcome = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }

    const options = {
      provider: ROUTE_MAIN,
      model: entry.id,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      ...typeof openAi.temperature === 'number' ? { temperature: openAi.temperature } : {},
      ...typeof openAi.max_tokens === 'number' ? { maxTokens: openAi.max_tokens } : {},
      ...typeof openAi.reasoning_effort === 'string' ? { reasoningEffort: openAi.reasoning_effort } : {},
      sessionId: `forward:${String(openAi.user ?? openAi.conversation ?? 'shared')}`,
    }

    for await (const chunk of adapter.stream(options, entry, state())) {
      handler(chunk)
      foldForwardOutcome(outcome, chunk)
    }
    return outcome
  }

  function publicModelRows() {
    const membership = new Set(state().membership[ROUTE_MAIN] ?? [])
    if (settings.get().exposeRegionModels === true) for (const id of state().membership[ROUTE_REGION] ?? []) membership.add(id)
    return catalog
      .filter(entry => membership.has(entry.id))
      .map(entry => ({
        id: entry.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'our-free-model',
        ...entry.contextWindow === undefined ? {} : { context_window: entry.contextWindow },
      }))
  }

  // ── browser-facing API ──────────────────────────────────────────────────────
  const api = createApiRoutes({
    settings, stats, availability, catalog: () => catalog, state,
    refreshCatalog, refreshAvailability, syncForward,
    forwardInfo: () => ({ running: forward !== null, port: forward?.port ?? 0, error: forwardError, egress }),
    rotateKey: () => {
      const minted = generateKey()
      settings.update({ forwardKey: minted })
      settings.flush()
      return minted
    },
    testModel: async (id, effort) => {
      const entry = catalog.find(candidate => candidate.id === id)
      if (entry === undefined) throw new UpstreamError(`unknown model "${id}"`, CODE.server)
      const started = Date.now()
      let firstFrame
      let sawReasoning = false
      let text = ''
      let usage
      for await (const chunk of adapter.stream({
        provider: ROUTE_MAIN,
        model: entry.id,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        reasoningEffort: effort === undefined || effort === '' ? DEFAULT_LEVEL : effort,
        sessionId: `bench:${entry.id}:${effort ?? DEFAULT_LEVEL}`,
      }, entry, state())) {
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
          if (firstFrame === undefined) firstFrame = Date.now()
          if (chunk.type === 'reasoning-delta') sawReasoning = true
          if (chunk.type === 'text-delta') text += chunk.text
        }
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish' && chunk.reason.kind !== 'stop' && chunk.reason.kind !== 'tool-calls') {
          throw new UpstreamError(chunk.reason.failure?.message ?? chunk.reason.kind, chunk.reason.failure?.code ?? CODE.server)
        }
      }
      const ms = Date.now() - started
      // Same rule as the recorded calls: the rate divides only by a window that
      // actually covers the tokens in its numerator.
      const measured = decodeWindow(firstFrame === undefined ? 0 : ms - firstFrame, windowTokens(usage, sawReasoning), true)
      return {
        model: entry.id, effort: effort ?? DEFAULT_LEVEL, ok: true,
        totalMs: ms,
        ttftMs: firstFrame === undefined ? ms : firstFrame - started,
        outputTokens: usage?.outputTokens ?? 0,
        reasoningTokens: usage?.reasoningTokens ?? 0,
        tokensPerSecond: measured.tps,
        sample: text.slice(0, 60),
      }
    },
    logger,
  })

  if (typeof ctx.webServer?.register === 'function') {
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/api/our-free-model', handler: api }), 'our-free-model: api routes')
  } else {
    logger.warn?.('our-free-model: no web server in this composition; the settings page will have no data source')
  }

  // ── boot + background loop ──────────────────────────────────────────────────
  ctx.effect(() => () => {
    settings.dispose(); stats.dispose(); availability.dispose(); catalogStore.dispose()
  }, 'our-free-model: stores')

  ctx.effect(() => () => {
    void forward?.close().catch(() => {})
  }, 'our-free-model: forward listener')

  ctx.effect(() => () => { registration() }, 'our-free-model: adapter routes')

  ctx.effect(() => {
    void (async () => {
      attributionUserAgent = await resolveAttributionUserAgent(logger)
      await refreshCatalog({ probe: true })
      await syncForward()
      emitTopology()
    })().catch(error => logger.warn?.(`our-free-model: startup refresh failed (${error?.message ?? error})`))
  }, 'our-free-model: boot refresh')

  const interval = settings.get().probeIntervalMinutes ?? 15
  if (typeof ctx.interval === 'function') {
    ctx.effect(() => ctx.interval(() => {
      void (async () => {
        await watchEgress()
        await refreshCatalog({ probe: true })
      })().catch(error => logger.warn?.(`our-free-model: periodic refresh failed (${error?.message ?? error})`))
    }, Math.max(60, interval) * 60_000), 'our-free-model: probe loop')
    ctx.effect(() => ctx.interval(() => {
      void watchEgress().catch(() => {})
    }, 120_000), 'our-free-model: egress watch')
  }

  function emitTopology() {
    try { ctx.emit?.('llm/adapters-updated') } catch { /* no listener surface */ }
    registration.replace(routes())
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** Which route advertises which model, given the last probe. */
function computeMembership(catalog, availabilitySnapshot, settings) {
  const results = availabilitySnapshot?.results ?? {}
  const expose = settings?.exposeRegionModels !== false
  const main = []
  const region = []
  for (const entry of catalog) {
    const result = results[entry.id]
    if (result === undefined) {
      // Never probed: keep it reachable so a cold start is not silently empty.
      main.push(entry.id)
      continue
    }
    if (result.state === STATE.available) { main.push(entry.id); continue }
    if (result.state === STATE.regionBlocked && expose) { region.push(entry.id); continue }
    if (result.state === STATE.throttled) { main.push(entry.id); continue }
  }
  const membership = {}
  if (main.length > 0) membership[ROUTE_MAIN] = main
  if (region.length > 0) membership[ROUTE_REGION] = region
  return membership
}

function materializeCatalog(ids) {
  const rebuilt = buildCatalog(ids)
  return rebuilt.length > 0 ? rebuilt : FALLBACK_CATALOG
}

/**
 * Resolve an image attachment into a data URL the provider can accept.
 *
 * The attachment service exposes a host path, not bytes; reading it here keeps the
 * plugin free of a second credential path. An unresolvable image is reported as a
 * warning and dropped — the runtime has already text-projected files, and a
 * text-only model never sees an image block in the first place.
 */
function imageResolver(ctx, logger) {
  const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
  if (attachments === undefined || typeof attachments.imageHostPath !== 'function') return undefined
  const cache = new Map()
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024
  return ref => {
    const id = String(ref?.attachmentId ?? '')
    if (id === '') return undefined
    const cached = cache.get(id)
    if (cached !== undefined) return cached
    try {
      const hostPath = attachments.imageHostPath(ref)
      if (typeof hostPath !== 'string' || hostPath === '') return undefined
      const size = fs.statSync(hostPath).size
      if (size > MAX_IMAGE_BYTES) { logger.warn?.(`our-free-model: image ${id} is ${size} bytes, above the ${MAX_IMAGE_BYTES} send limit`); return undefined }
      const media = typeof ref.mediaType === 'string' ? ref.mediaType : 'image/png'
      const url = `data:${media};base64,${fs.readFileSync(hostPath).toString('base64')}`
      if (cache.size > 48) cache.clear()
      cache.set(id, url)
      return url
    } catch (error) {
      logger.warn?.(`our-free-model: could not read image ${id} (${error?.message ?? error})`)
      return undefined
    }
  }
}

/** OpenAI request messages -> harness messages, for the forward listener. */
function fromOpenAiMessages(body, isResponses) {
  const out = []
  const rows = isResponses
    ? normaliseResponsesInput(body.input)
    : (Array.isArray(body.messages) ? body.messages : [])
  for (const row of rows) {
    const role = row.role ?? 'user'
    const content = []
    if (typeof row.content === 'string') {
      if (row.content !== '') content.push({ type: 'text', text: row.content })
    } else if (Array.isArray(row.content)) {
      for (const part of row.content) {
        if (typeof part === 'string') { if (part !== '') content.push({ type: 'text', text: part }); continue }
        const text = part?.text ?? part?.input_text ?? part?.output_text
        if (typeof text === 'string' && text !== '') content.push({ type: 'text', text })
        const image = part?.image_url?.url ?? part?.image_url
        if (typeof image === 'string' && image !== '') {
          content.push({ type: 'image', attachment: { attachmentId: `url:${image.slice(0, 64)}`, mediaType: 'image/png', bytes: 0, width: 0, height: 0, url: image } })
        }
      }
    }
    if (role === 'tool') {
      out.push({ role: 'tool', content: [{ type: 'text', text: typeof row.content === 'string' ? row.content : JSON.stringify(row.content ?? '') }], toolCallId: row.tool_call_id ?? '', source: { kind: 'tool', callId: row.tool_call_id ?? '' } })
      continue
    }
    if (role === 'assistant' && Array.isArray(row.tool_calls)) {
      for (const call of row.tool_calls) {
        content.push({ type: 'tool-call', id: call.id ?? '', name: call.function?.name ?? '', arguments: call.function?.arguments ?? '{}' })
      }
    }
    if (content.length === 0) continue
    out.push({
      role: role === 'developer' ? 'developer' : role === 'system' ? 'system' : role === 'assistant' ? 'assistant' : 'user',
      content,
      ...role === 'assistant' ? { source: { kind: 'model' } } : {},
    })
  }
  return out
}

function normaliseResponsesInput(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }]
  if (!Array.isArray(input)) return []
  return input.map(row => {
    if (typeof row === 'string') return { role: 'user', content: row }
    if (row.type === 'function_call') return { role: 'assistant', content: [], tool_calls: [{ id: row.call_id, function: { name: row.name, arguments: row.arguments } }] }
    if (row.type === 'function_call_output') return { role: 'tool', content: String(row.output ?? ''), tool_call_id: row.call_id }
    return row
  })
}

function normalizeTool(tool) {
  const name = tool?.name ?? tool?.function?.name
  if (typeof name !== 'string' || name.trim() === '') return null
  const parameters = tool?.parameters ?? tool?.function?.parameters ?? { type: 'object', properties: {} }
  return { name, description: String(tool?.description ?? tool?.function?.description ?? ''), parameters }
}

function foldForwardOutcome(outcome, chunk) {
  switch (chunk.type) {
    case 'text-delta': outcome.text += chunk.text; break
    case 'tool-call-delta': {
      let call = outcome.toolCalls.find(candidate => candidate.slot === chunk.index)
      if (call === undefined) { call = { slot: chunk.index, id: chunk.id ?? '', name: chunk.name ?? '', arguments: chunk.argumentsDelta ?? '' }; outcome.toolCalls.push(call) }
      else call.arguments += chunk.argumentsDelta ?? ''
      if (chunk.name) call.name = chunk.name
      if (chunk.id) call.id = chunk.id
      break
    }
    case 'block-end':
      if (chunk.block?.type === 'tool-call') {
        const existing = outcome.toolCalls.find(candidate => candidate.id === chunk.block.id)
        if (existing === undefined) outcome.toolCalls.push({ slot: chunk.index, id: chunk.block.id, name: chunk.block.name, arguments: chunk.block.arguments })
      }
      break
    case 'usage': outcome.usage = chunk.usage; break
    case 'finish':
      if (chunk.reason?.kind === 'max-tokens') outcome.truncated = true
      if (chunk.reason?.kind === 'error') outcome.error = chunk.reason.failure?.message
      break
    default: break
  }
  return outcome
}

/**
 * The settings page's HTTP surface.
 *
 * Same-origin, session-scoped, and readable only by whoever already has the app's
 * own port — so it deliberately carries no secret values: the forward key is
 * exposed only through its own explicit action, and only ever to the local page
 * that asks for it.
 */
function createApiRoutes(deps) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/^\/api\/our-free-model/, '').replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()
    const send = (status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    }
    try {
      if (method === 'GET' && path === '/summary') {
        return send(200, buildSummary(deps))
      }
      if (method === 'GET' && path === '/stats') {
        return send(200, buildStats(deps.stats.get(), deps.catalog()))
      }
      if (method === 'GET' && path === '/announcement') {
        return send(200, { version: ANNOUNCEMENT_VERSION, acknowledged: deps.settings.get().announcementAck === ANNOUNCEMENT_VERSION })
      }
      if (method === 'POST' && path === '/announcement/ack') {
        deps.settings.update({ announcementAck: String(url.searchParams.get('version') ?? ANNOUNCEMENT_VERSION) })
        deps.settings.flush()
        return send(200, { ok: true })
      }
      if (method === 'POST' && path === '/settings') {
        const patch = await readJson(req)
        const current = deps.settings.get()
        const next = { ...current, ...pick(patch, ['enabled', 'exposeRegionModels', 'probeIntervalMinutes', 'defaultMaxTokens', 'announcementAck']) }
        if (patch.forward !== undefined) next.forward = { ...(current.forward ?? {}), ...pick(patch.forward, ['enabled', 'host', 'port']) }
        deps.settings.update(next)
        deps.settings.flush()
        await deps.syncForward()
        if (patch.probeIntervalMinutes !== undefined) {
          // The interval lives in a fiber effect; the next boot picks the new
          // value up, so surface that rather than pretending it hot-applied.
          deps.logger.info?.('our-free-model: probe interval change applies on the next load')
        }
        return send(200, { ok: true, settings: publicSettings(deps.settings.get(), deps.forwardInfo()) })
      }
      if (method === 'POST' && path === '/refresh') {
        await deps.refreshCatalog({ probe: true })
        return send(200, { ok: true, ...buildSummary(deps) })
      }
      if (method === 'POST' && path === '/reprobe') {
        await deps.refreshAvailability()
        return send(200, { ok: true, ...buildSummary(deps) })
      }
      if (method === 'GET' && path === '/forward/key') {
        return send(200, { key: deps.settings.get().forwardKey ?? '' })
      }
      if (method === 'POST' && path === '/forward/rotate') {
        return send(200, { key: deps.rotateKey() })
      }
      if (method === 'POST' && path === '/bench') {
        const body = await readJson(req)
        const result = await deps.testModel(String(body.model ?? ''), body.effort === undefined ? undefined : String(body.effort))
        return send(200, result)
      }
      return send(404, { error: 'not found' })
    } catch (error) {
      return send(500, { error: String(error?.message ?? error) })
    }
  }
}

function pick(source, keys) {
  const out = {}
  for (const key of keys) if (source?.[key] !== undefined) out[key] = source[key]
  return out
}

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return {} }
}

function publicSettings(settings, forwardInfo) {
  return {
    enabled: settings.enabled !== false,
    exposeRegionModels: settings.exposeRegionModels !== false,
    probeIntervalMinutes: settings.probeIntervalMinutes ?? 15,
    defaultMaxTokens: settings.defaultMaxTokens ?? 32768,
    announcementAck: settings.announcementAck ?? '',
    forward: { ...(settings.forward ?? {}), running: forwardInfo.running, actualPort: forwardInfo.port, error: forwardInfo.error },
  }
}

function buildSummary(deps) {
  const state = deps.state()
  const snapshot = deps.availability.get()
  const forwardInfo = deps.forwardInfo()
  return {
    catalog: state.catalog.map(entry => ({
      ...entry,
      availability: snapshot.results?.[entry.id]?.state ?? STATE.unknown,
      detail: snapshot.results?.[entry.id]?.detail ?? '',
      probedAt: snapshot.results?.[entry.id]?.at ?? 0,
      ttftMs: snapshot.results?.[entry.id]?.ttftMs,
      latencyMs: snapshot.results?.[entry.id]?.latencyMs,
      route: (state.membership[ROUTE_MAIN] ?? []).includes(entry.id) ? ROUTE_MAIN
        : (state.membership[ROUTE_REGION] ?? []).includes(entry.id) ? ROUTE_REGION : null,
    })),
    settings: publicSettings(deps.settings.get(), forwardInfo),
    egress: forwardInfo.egress ?? snapshot.egress ?? null,
    probedAt: snapshot.at ?? 0,
    announcementVersion: ANNOUNCEMENT_VERSION,
  }
}

export function buildStats(stats, catalog) {
  const days = stats.days ?? {}
  const series = Object.keys(days).sort().map(day => ({
    day,
    total: days[day].total ?? 0,
    models: Object.entries(days[day].models ?? {}).map(([model, value]) => ({ model, ...value })),
  }))
  const totals = {}
  for (const entry of series) for (const row of entry.models) {
    const previous = totals[row.model] ?? {
      model: row.model, input: 0, output: 0, reasoning: 0, calls: 0, failed: 0,
      ttftMs: 0, ttftSamples: 0, decodeMs: 0, decodeTokens: 0,
    }
    totals[row.model] = {
      ...previous,
      input: previous.input + row.input,
      output: previous.output + row.output,
      reasoning: previous.reasoning + row.reasoning,
      calls: previous.calls + row.calls,
      failed: previous.failed + row.failed,
      ttftMs: previous.ttftMs + (row.ttftMs ?? 0),
      ttftSamples: previous.ttftSamples + (row.ttftSamples ?? 0),
      decodeMs: previous.decodeMs + (row.decodeMs ?? 0),
      decodeTokens: previous.decodeTokens + (row.decodeTokens ?? 0),
    }
  }
  const named = Object.values(totals).map(row => ({
    ...row,
    name: catalog.find(entry => entry.id === row.model)?.name ?? row.model,
    // A rate over too few measurable calls is a rounding error with a unit on it.
    tps: row.decodeMs >= MIN_DECODE_MS ? Math.round(row.decodeTokens / (row.decodeMs / 1000)) : null,
    avgTtftMs: row.ttftSamples > 0 ? Math.round(row.ttftMs / row.ttftSamples) : null,
  }))
  return {
    requests: stats.requests ?? 0,
    days: series,
    models: named,
    samples: (stats.samples ?? []).slice(-200),
    grand: {
      input: named.reduce((sum, row) => sum + row.input, 0),
      output: named.reduce((sum, row) => sum + row.output, 0),
      reasoning: named.reduce((sum, row) => sum + row.reasoning, 0),
      calls: named.reduce((sum, row) => sum + row.calls, 0),
      failed: named.reduce((sum, row) => sum + row.failed, 0),
    },
  }
}

