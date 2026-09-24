/**
 * Model catalog for the free lane.
 *
 * Three sources, deliberately layered so no single one can break the plugin:
 *
 * 1. the upstream listing itself (`/zen/v1/models`) — the authoritative set of
 *    ids the gateway will currently name;
 * 2. a vetted local capability table (context window / vision / reasoning),
 *    because the upstream listing discloses an id and nothing else;
 * 3. an optional refresh of the upstream router project's published tables, so a
 *    newly discovered model's capacities can arrive without a plugin release.
 *
 * Layer 3 is fail-open by construction: it is parsed by tolerant extraction, and
 * any shape drift simply yields no overlay rather than an error.
 *
 * @module src/catalog.js
 */

import { baseModelId, isResponsesModel } from './upstream.js'

export const UPSTREAM_MODELS_URL = 'https://opencode.ai/zen/v1/models'

/** Ids that are free-tier without carrying the `-free` suffix. */
const ALWAYS_FREE = new Set(['union-alpha', 'space-bunny-free'])

/**
 * Local capability baseline. `contextWindow`/`maxOutput` are the provider's
 * published capacities; `vision` is what this lane actually accepted under a
 * direct image-input probe, not what a model card claims.
 */
export const CAPABILITIES = [
  { match: /^mimo.*v2\.6/, vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072, canDisableThinking: false },
  { match: /^mimo.*v2\.5/, vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072, canDisableThinking: false },
  { match: /^mimo/, vision: true, reasoning: true, contextWindow: 262144, maxOutput: 131072 },
  { match: /^muse.?spark/, vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072 },
  { match: /^nemotron/, vision: false, reasoning: true, contextWindow: 128000, maxOutput: 32768 },
  { match: /^ling/, vision: false, reasoning: true, contextWindow: 128000, maxOutput: 32768 },
  { match: /^space.?bunny/, vision: true, reasoning: true, contextWindow: 262144, maxOutput: 65536 },
  { match: /^union/, vision: true, reasoning: false, contextWindow: 262144, maxOutput: 131072 },
  { match: /^deepseek/, vision: false, reasoning: true, contextWindow: 128000, maxOutput: 64000 },
  { match: /^jev/, vision: false, reasoning: false, contextWindow: 32768, maxOutput: 4096 },
]

/** Human-facing display names, so a raw upstream id never reaches the picker. */
const DISPLAY_NAMES = {
  'mimo-v2.6-flash-free': 'MiMo V2.6 Flash',
  'mimo-v2.5-free': 'MiMo V2.5',
  'muse-spark-1.3-contributor-free': 'Muse Spark 1.3',
  'muse-spark-1.2-contributor-free': 'Muse Spark 1.2',
  'nemotron-3-ultra-free': 'Nemotron 3 Ultra',
  'nemotron-3.5-lightning-free': 'Nemotron 3.5 Lightning',
  'ling-3.0-flash-fin-free': 'Ling 3.0 Flash Fin',
  'space-bunny-free': 'Space Bunny',
  'union-alpha': 'Union Alpha',
  'deepseek-v4-flash-free': 'DeepSeek V4 Flash',
  'jev-1.13-free': 'Jev 1.13',
}

/** Ids whose regional availability is known to be egress-dependent. */
const REGION_SENSITIVE = [/^muse.?spark/]

/**
 * Is this id on the免密 lane? The gateway's listing mixes paid and free ids;
 * only these answer without a per-user key.
 */
export function isFreeLane(modelId) {
  const base = baseModelId(modelId)
  if (ALWAYS_FREE.has(base)) return true
  return /(?:^|[-_])free(?:$|[-_.])/.test(base)
}

/** Look up the baseline capacities for one model id. */
export function capabilitiesFor(modelId) {
  const base = baseModelId(modelId)
  for (const entry of CAPABILITIES) if (entry.match.test(base)) return entry
  return { vision: false, reasoning: true, contextWindow: 131072, maxOutput: 32768 }
}

export function isRegionSensitive(modelId) {
  const base = baseModelId(modelId)
  return REGION_SENSITIVE.some(pattern => pattern.test(base))
}

/** Title-case a bare upstream id into something a picker can show. */
export function displayModelName(modelId) {
  const base = baseModelId(modelId)
  const known = DISPLAY_NAMES[base]
  if (known !== undefined) return known
  const words = base
    .replace(/[-_.]+/g, ' ')
    .replace(/(\d)\s+/g, '$1 ')
    .trim()
    .split(' ')
    .map(word => (/^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
  return words
}

/**
 * Merge the upstream listing with the capability overlay.
 *
 * @param {string[]} ids - raw upstream model ids
 * @param {Record<string, object>} [overlay] - router-published capacities by id
 * @returns {Array<object>} catalog entries in listing order
 */
export function buildCatalog(ids, overlay = {}) {
  const seen = new Set()
  const entries = []
  for (const raw of ids) {
    const id = String(raw ?? '').trim()
    if (id === '' || !isFreeLane(id)) continue
    const base = baseModelId(id)
    if (seen.has(base)) continue
    seen.add(base)
    const caps = capabilitiesFor(base)
    const extra = overlay[base] ?? {}
    entries.push({
      id: base,
      name: displayModelName(base),
      wire: isResponsesModel(base) ? 'responses' : 'chat',
      vision: extra.vision === true || caps.vision === true,
      reasoning: extra.reasoning !== false && caps.reasoning !== false,
      contextWindow: number(extra.contextWindow) ?? number(caps.contextWindow) ?? 131072,
      maxOutput: number(extra.maxOutput) ?? number(caps.maxOutput) ?? 32768,
      canDisableThinking: caps.canDisableThinking !== false,
      regionSensitive: isRegionSensitive(base),
    })
  }
  return entries
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
}

/** Parse the gateway's `{"data":[{"id":…}]}` listing. */
export function parseListing(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload) ? payload : []
  return rows.map(row => (typeof row === 'string' ? row : row?.id)).filter(id => typeof id === 'string' && id !== '')
}

/**
 * Pull the published router project's capability tables and lift the numeric
 * capacities out of them.
 *
 * Deliberately tolerant: it reads `"some-id": { … contextWindow: 123 … }` pairs
 * and `{ pattern: "*", caps: { … } }` rows by key, ignores everything it does
 * not recognise, and yields an empty overlay on any problem. Callers treat the
 * result as a bonus, never a dependency.
 */
export function parseRouterCapabilities(source) {
  const overlay = {}
  if (typeof source !== 'string' || source.length === 0) return overlay
  const entry = /\\"?([a-z0-9][a-z0-9._:/-]{2,60})\\"?\s*:\s*\{([^{}]{0,400})\}/g
  let match
  while ((match = entry.exec(source)) !== null) {
    const id = match[1]
    const body = match[2]
    if (!isFreeLane(id) && !/^[a-z0-9.-]+$/.test(id)) continue
    const caps = readCaps(body)
    if (caps === undefined) continue
    const merged = overlay[id] ?? {}
    overlay[id] = { ...merged, ...caps }
  }
  return overlay
}

function readCaps(body) {
  const context = /\bcontextWindow\s*:\s*(\d{3,9})/.exec(body)?.[1]
  const output = /\bmaxOutput\s*:\s*(\d{2,9})/.exec(body)?.[1]
  const vision = /\bvision\s*:\s*(true|false)/.exec(body)?.[1]
  const reasoning = /\breasoning\s*:\s*(true|false)/.exec(body)?.[1]
  if (context === undefined && output === undefined && vision === undefined && reasoning === undefined) return undefined
  const out = {}
  if (context !== undefined) out.contextWindow = Number(context)
  if (output !== undefined) out.maxOutput = Number(output)
  if (vision !== undefined) out.vision = vision === 'true'
  if (reasoning !== undefined) out.reasoning = reasoning === 'true'
  return out
}

/** Extract `{id, name}` rows from the router project's provider registry file. */
export function parseRouterRegistry(source) {
  const rows = []
  if (typeof source !== 'string' || source.length === 0) return rows
  const entry = /\{\s*id\s*:\s*"([^"]{2,80})"(?:\s*,\s*name\s*:\s*"([^"]{1,80})")?/g
  let match
  while ((match = entry.exec(source)) !== null) {
    if (!isFreeLane(match[1])) continue
    rows.push({ id: match[1], name: match[2] })
  }
  return rows
}
