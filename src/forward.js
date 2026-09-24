/**
 * OpenAI-compatible forward listener.
 *
 * Other local harnesses speak OpenAI at a base URL; this turns one of those
 * requests into a harness-shaped call and streams the answer back in the spelling
 * the caller expects. It exists so the same免密 lane that powers the picker can
 * also serve a `baseURL` in someone else's config.
 *
 * The harness's own web server is deliberately not reused: its port belongs to
 * the application, while this port belongs to the user and has to be settable
 * independently. Authentication is ours to enforce too — the listener is a
 * network-facing door with no session behind it, so every request must present a
 * issued key, compared in constant time.
 *
 * @module src/forward.js
 */

import http from 'node:http'
import crypto from 'node:crypto'
import { baseModelId } from './upstream.js'

const MAX_BODY_BYTES = 8 * 1024 * 1024

/** Mint a forward-proxy key. Not derived from anything user-visible. */
export function generateKey() {
  return `ofm-${crypto.randomBytes(24).toString('base64url')}`
}

/** Constant-time comparison of a bearer token against the issued key. */
export function keyMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string') return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.byteLength === b.byteLength && crypto.timingSafeEqual(a, b)
}

function bearerOf(req) {
  const header = String(req.headers.authorization ?? '')
  if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
  const key = req.headers['x-api-key']
  return typeof key === 'string' ? key.trim() : ''
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  res.end(body)
}

function openAiError(res, status, type, message) {
  json(res, status, { error: { message, type, param: null, code: null } })
}

/**
 * Start the listener.
 *
 * @param {object} options
 * @param {() => {host: string, port: number, enabled: boolean, key: string}} options.config
 * @param {(request: object, onChunk: (chunk: object) => void) => Promise<object>} options.complete -
 *   runs one completion through the adapter and reports chunks as they arrive
 * @param {() => Array<{id: string, created: number, owned_by: string}>} options.modelRows
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{server: http.Server, port: number, close: () => Promise<void>}>}
 */
export async function startForwardServer({ config, complete, modelRows, log = () => {} }) {
  const server = http.createServer((req, res) => {
    void handle(req, res).catch(error => {
      log(`request failed: ${error?.message ?? error}`)
      if (!res.headersSent) openAiError(res, 500, 'server_error', String(error?.message ?? error))
      else res.end()
    })
  })

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const settings = config()
    if (!settings.enabled) {
      openAiError(res, 503, 'service_unavailable', 'the forward listener is switched off in Our Free Model settings')
      return
    }
    // CORS preflight, so a browser-based harness on another origin can use it.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders())
      res.end()
      return
    }
    if (path === '/' || path === '/health') {
      json(res, 200, { ok: true, service: 'our-free-model', models: modelRows().length })
      return
    }
    if (!authorized(req, settings.key)) {
      openAiError(res, 401, 'invalid_request_error', 'missing or invalid API key')
      return
    }
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      json(res, 200, { object: 'list', data: modelRows() })
      return
    }
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
      await chatCompletions(req, res, complete)
      return
    }
    if (req.method === 'POST' && (path === '/v1/responses' || path === '/responses')) {
      await responsesEndpoint(req, res, complete)
      return
    }
    openAiError(res, 404, 'not_found_error', `no route for ${req.method} ${path}`)
  }

  const port = await new Promise((resolve, reject) => {
    const onError = error => reject(error)
    server.once('error', onError)
    const desired = config()
    server.listen(Number.isFinite(desired.port) ? desired.port : 0, desired.host || '127.0.0.1', () => {
      server.off('error', onError)
      server.on('error', error => log(`listener error: ${error?.message ?? error}`))
      resolve(server.address()?.port ?? 0)
    })
  })

  return {
    server,
    port,
    close: () => new Promise(resolve => {
      server.closeAllConnections?.()
      server.close(() => resolve())
    }),
  }
}

function authorized(req, key) {
  if (typeof key !== 'string' || key === '') return false
  return keyMatches(bearerOf(req), key)
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, x-api-key',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '600',
  }
}

function sendSse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function openStreamHeaders(res) {
  res.writeHead(200, {
    ...corsHeaders(),
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
}

/** Drive one chat-completion through `complete`, in either response style. */
async function chatCompletions(req, res, complete) {
  const body = await readBody(req)
  const model = baseModelId(String(body.model ?? ''))
  if (model === '') {
    openAiError(res, 400, 'invalid_request_error', '`model` is required')
    return
  }
  const id = `chatcmpl-${crypto.randomBytes(8).toString('hex')}`
  const created = Math.floor(Date.now() / 1000)
  const wantsStream = body.stream === true

  if (!wantsStream) {
    const outcome = await complete({ model, openAi: body }, collectAccumulator())
    const text = [outcome.text ?? '', ...(outcome.toolCalls ?? []).map(() => '')].join('')
    json(res, 200, {
      id, object: 'chat.completion', created, model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text === '' ? null : text,
          ...(outcome.toolCalls?.length ? { tool_calls: outcome.toolCalls.map((call, i) => ({ id: call.id || `call_${i}`, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}),
        },
        finish_reason: outcome.toolCalls?.length ? 'tool_calls' : outcome.truncated ? 'length' : 'stop',
      }],
      usage: outcome.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
    return
  }

  openStreamHeaders(res)
  sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
  const seenToolStart = new Set()
  const outcome = await complete({ model, openAi: body }, (chunk) => {
    if (chunk.type === 'text-delta') {
      sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }] })
      return
    }
    if (chunk.type === 'reasoning-delta') {
      sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { reasoning: chunk.text }, finish_reason: null }] })
      return
    }
    if (chunk.type === 'tool-call-delta') {
      const first = !seenToolStart.has(chunk.index)
      if (first) seenToolStart.add(chunk.index)
      sendSse(res, {
        id, object: 'chat.completion.chunk', created, model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: chunk.index,
              ...(first ? { id: chunk.id, function: { name: chunk.name ?? '', arguments: '' } } : {}),
            }],
          },
          finish_reason: null,
        }],
      })
      if (chunk.argumentsDelta) {
        sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: chunk.index, function: { arguments: chunk.argumentsDelta } }] }, finish_reason: null }] })
      }
      return
    }
    if (chunk.type === 'usage') {
      sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [], usage: toOpenAiUsage(chunk.usage) })
    }
  })
  sendSse(res, {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: {}, finish_reason: outcome.toolCalls?.length || seenToolStart.size > 0 ? 'tool_calls' : outcome.truncated ? 'length' : 'stop' }],
  })
  res.write('data: [DONE]\n\n')
  res.end()
}

/** Responses-API spelling, so Codex-shaped local clients work too. */
async function responsesEndpoint(req, res, complete) {
  const body = await readBody(req)
  const model = baseModelId(String(body.model ?? ''))
  const id = `resp-${crypto.randomBytes(8).toString('hex')}`
  const outcome = await complete({ model, openAi: { ...body, input: body.input ?? body.messages ?? [] }, responses: true }, collectAccumulator())
  json(res, 200, {
    id, object: 'response', created_at: Math.floor(Date.now() / 1000), model, status: 'completed',
    output: [
      ...(outcome.text ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: outcome.text }] }] : []),
      ...(outcome.toolCalls ?? []).map((call, i) => ({ type: 'function_call', call_id: call.id || `call_${i}`, name: call.name, arguments: call.arguments })),
    ],
    usage: {
      input_tokens: outcome.usage?.prompt_tokens ?? 0,
      output_tokens: outcome.usage?.completion_tokens ?? 0,
      total_tokens: outcome.usage?.total_tokens ?? 0,
    },
  })
}

/** Accumulator used by the non-streaming paths. */
function collectAccumulator() {
  /** @type {{text:string, toolCalls:Array<{id:string,name:string,arguments:string}>, usage?:object, truncated?:boolean, error?:string}} */
  const state = { text: '', toolCalls: [], usage: undefined, truncated: false }
  return chunk => {
    if (typeof chunk === 'string') return state
    switch (chunk.type) {
      case 'text-delta': state.text += chunk.text; break
      case 'tool-call-delta': {
        let call = state.toolCalls.find(candidate => candidate.slot === chunk.index)
        if (call === undefined) {
          call = { slot: chunk.index, id: chunk.id ?? '', name: chunk.name ?? '', arguments: '' }
          state.toolCalls.push(call)
        }
        if (chunk.id) call.id = chunk.id
        if (chunk.name) call.name = chunk.name
        call.arguments += chunk.argumentsDelta ?? ''
        break
      }
      case 'block-end':
        if (chunk.block?.type === 'tool-call') {
          const existing = state.toolCalls.find(candidate => candidate.id === chunk.block.id)
          if (existing === undefined) state.toolCalls.push({ slot: chunk.index, id: chunk.block.id, name: chunk.block.name, arguments: chunk.block.arguments })
          else { existing.name = chunk.block.name; existing.arguments = chunk.block.arguments }
        }
        break
      case 'usage': state.usage = toOpenAiUsage(chunk.usage); break
      case 'finish':
        if (chunk.reason?.kind === 'max-tokens') state.truncated = true
        if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') state.error = chunk.reason.failure?.message
        break
      default: break
    }
    return state
  }
}

function toOpenAiUsage(usage) {
  if (usage === undefined) return undefined
  return {
    prompt_tokens: (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0),
    completion_tokens: usage.outputTokens ?? 0,
    total_tokens: (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.outputTokens ?? 0),
    prompt_tokens_details: { cached_tokens: usage.cacheReadTokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
  }
}
