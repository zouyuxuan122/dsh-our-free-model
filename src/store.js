/**
 * Plugin-owned durable state: user settings, usage history, probe results, and
 * the forward proxy's key ring.
 *
 * Storage is a plain JSON file under the harness home rather than a harness
 * service on purpose. The settings seam changed shape between the two kernel
 * lines this plugin has to run on (the older one exposes a registrable
 * namespace, the newer one projects volatile plugin config), and the storage
 * domain needs composition rows a bare profile may not mount. A file the plugin
 * owns behaves identically on both, and usage history is high-cardinality
 * telemetry that does not belong in a configuration document anyway.
 *
 * Writes are coalesced and land through a temp file + rename, so a crash mid
 * write cannot leave a truncated store.
 *
 * @module src/store.js
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** Same resolution the harness home-paths helper uses: `$DSH_HOME` else `~/.dsh`. */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

export const DATA_DIR_NAME = 'our-free-model'

export class JsonStore {
  /**
   * @param {string} file - absolute path
   * @param {object} initial - value used when the file does not exist yet
   */
  constructor(file, initial) {
    this.file = file
    this.value = initial
    this.dirty = false
    this.timer = undefined
    this.load()
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.value = { ...this.value, ...parsed }
      }
    } catch {
      // absent or corrupt: keep the initial value; the next write replaces it
    }
  }

  get() {
    return this.value
  }

  /** Merge a patch in and schedule the write. Returns the new value. */
  update(patch) {
    this.value = { ...this.value, ...patch }
    this.schedule()
    return this.value
  }

  /** Mutate through a callback; used for read-modify-write on nested state. */
  edit(mutate) {
    const next = mutate(structuredClone(this.value))
    if (next !== undefined) this.value = next
    this.schedule()
    return this.value
  }

  schedule(delayMs = 800) {
    this.dirty = true
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, delayMs)
    // Telemetry must never hold the process open.
    this.timer.unref?.()
  }

  flush() {
    if (!this.dirty) return
    this.dirty = false
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const temp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(temp, JSON.stringify(this.value, undefined, 2), { mode: 0o600 })
      fs.renameSync(temp, this.file)
    } catch {
      // fail-soft: the next mutation retries, and nothing downstream depends on it
    }
  }

  dispose() {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    this.flush()
  }
}

/** `YYYY-MM-DD` in the machine's own calendar, which is what a heatmap needs. */
export function dayKey(at = Date.now()) {
  const date = new Date(at)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export const SETTINGS_INITIAL = {
  version: 1,
  /** Master switch: when off the routes stay registered but serve nothing. */
  enabled: true,
  /** Show region-limited models in the picker as soon as they answer. */
  exposeRegionModels: true,
  /** Minutes between background availability re-probes. */
  probeIntervalMinutes: 15,
  /** Serve the OpenAI-compatible forward listener for other local harnesses. */
  forward: { enabled: false, host: '127.0.0.1', port: 18899 },
  /** Cap a turn's output so a slow lane cannot run away. */
  defaultMaxTokens: 32768,
  /** Acknowledged announcement copy version. */
  announcementAck: '',
  /** Last full catalog refresh timestamp. */
  catalogSyncedAt: 0,
  /** Router-project overlay refresh timestamp. */
  routerSyncedAt: 0,
}

export const STATS_INITIAL = { version: 1, days: {}, models: {}, requests: 0, samples: [] }

/**
 * Accumulate one completed call into the store's day/model buckets and keep a
 * bounded ring of per-call latency samples for the speed charts.
 */
export function recordUsage(stats, record) {
  return stats.edit(state => {
    const day = dayKey(record.at)
    const days = { ...(state.days ?? {}) }
    const bucket = days[day] ?? { total: 0, models: {} }
    const perModel = { ...(bucket.models ?? {}) }
    const previous = perModel[record.model] ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0, calls: 0, failed: 0, ttftMs: 0, decodeMs: 0, decodeTokens: 0 }
    perModel[record.model] = {
      input: previous.input + record.input,
      output: previous.output + record.output,
      reasoning: previous.reasoning + record.reasoning,
      cacheRead: previous.cacheRead + record.cacheRead,
      calls: previous.calls + 1,
      failed: previous.failed + (record.ok ? 0 : 1),
      ttftMs: previous.ttftMs + (record.ttftMs ?? 0),
      decodeMs: previous.decodeMs + (record.decodeMs ?? 0),
      decodeTokens: previous.decodeTokens + (record.ok ? record.output : 0),
    }
    days[day] = { ...bucket, models: perModel, total: bucket.total + record.input + record.output }
    const models = { ...(state.models ?? {}) }
    const lifetime = models[record.model] ?? { input: 0, output: 0, calls: 0 }
    models[record.model] = {
      input: lifetime.input + record.input,
      output: lifetime.output + record.output,
      calls: lifetime.calls + 1,
    }
    const samples = [...(state.samples ?? []), {
      at: record.at, model: record.model, ok: record.ok === true,
      input: record.input, output: record.output,
      ttftMs: Math.round(record.ttftMs ?? 0),
      tps: record.decodeMs && record.output ? Math.round((record.output / record.decodeMs) * 1000) : 0,
      effort: record.effort ?? '',
      origin: record.origin ?? 'chat',
    }].slice(-400)
    return { ...state, days, models, requests: (state.requests ?? 0) + 1, samples }
  })
}

/** Trim day buckets older than `keepDays`, keeping the payload chart-sized. */
export function pruneDays(state, keepDays = 120) {
  const keys = Object.keys(state.days ?? {}).sort()
  if (keys.length <= keepDays) return state
  const drop = new Set(keys.slice(0, keys.length - keepDays))
  const days = {}
  for (const key of keys) if (!drop.has(key)) days[key] = state.days[key]
  return { ...state, days }
}
