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
 * Two wire-hygiene rules keep the answer executable for the caller, both from
 * issue #20's "forwarded clients cannot call tools":
 *
 * - `tool_calls[].index` is renumbered from 0. Upstream block indices are
 *   shared with reasoning/text blocks, so the first tool call of a thinking
 *   turn usually arrived as index 2+, and every client that accumulates
 *   `tool_calls` by index (the common OpenAI shape) got a sparse array with
 *   holes and merged or dropped arguments.
 * - Tool calls aimed at the fingerprint decoys are suppressed. The free tier's
 *   gate makes the plugin declare the `bash/glob/grep/read` quartet even when
 *   the caller has no such tools, and a model that dialed one of those decoys
 *   handed the client a tool it never registered — the call came back as an
 *   error the caller could do nothing about.
 *
 * @module src/forward.js
 */

import http from 'node:http'
import net from 'node:net'
import dns from 'node:dns'
import crypto from 'node:crypto'
import { baseModelId, FINGERPRINT_TOOLS } from './upstream.js'

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

/** An error carrying the HTTP status the caller should see (400s, not 500s). */
function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode })
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw httpError(413, 'request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw httpError(400, 'request body is not valid JSON')
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  res.end(body)
}

function openAiError(res, status, type, message, code = null) {
  json(res, status, { error: { message, type, param: null, code } })
}

/**
 * Resolve the bind address for the listener.
 *
 * A hostname — `localhost` above all — must be resolved and *every* answer must
 * be a loopback address before `listen` sees anything: `localhost` is otherwise
 * matched as a string here and resolved as a name by the OS, and a hosts file
 * or enterprise DNS that points it at a routable interface would hand the
 *免密 lane's quota to the whole subnet while the check kept passing (issue #19).
 * The listener binds a resolved IP, never the original spelling.
 *
 * @returns {Promise<string>} the address to pass to `server.listen`
 */
export async function resolveLoopbackBind(host) {
  const value = String(host ?? '').trim() || '127.0.0.1'
  const literal = value.replace(/^\[|\]$/g, '')
  if (net.isIP(literal)) {
    if (!isLoopbackIp(literal)) throw new Error(`the forward listener binds a loopback address only (got ${value})`)
    return literal
  }
  let addresses
  try {
    addresses = await dns.promises.lookup(literal, { all: true, verbatim: true })
  } catch (error) {
    throw new Error(`could not resolve the forward bind host "${value}" (${error?.message ?? error})`)
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new Error(`the forward bind host "${value}" resolved to no address`)
  }
  const routable = addresses.find(address => !isLoopbackIp(address.address))
  if (routable !== undefined) {
    throw new Error(`the forward listener binds a loopback address only — "${value}" resolves to ${routable.address}`)
  }
  return addresses[0].address
}

function isLoopbackIp(ip) {
  return ip === '::1' || ip.startsWith('127.')
}

/**
 * Read a failed `listen` into something a settings page can show.
 *
 * `EACCES` is the interesting one. On Windows a port already owned by a
 * wildcard (`0.0.0.0`) listener does not answer `EADDRINUSE` on a loopback
 * bind — it answers `EACCES`, which reads like a permission problem and sends
 * the reader looking at the wrong thing. The usual owner is a
 * `netsh interface portproxy` rule (served by IP Helper) or a Hyper-V/WinNAT
 * reservation, both of which outlive the process that needed them.
 *
 * @returns {{kind: 'held'|'in-use'|'unavailable'|'unknown', code: string, retryable: boolean, hint: string}}
 */
export function classifyBindError(error) {
  const code = String(error?.code ?? '')
  if (code === 'EACCES' || code === 'EPERM') {
    return {
      kind: 'held',
      code,
      retryable: true,
      hint: 'another process already owns this port; on Windows a listener on 0.0.0.0 — a "netsh interface portproxy" rule served by IP Helper, for one — makes the loopback bind fail with EACCES instead of EADDRINUSE',
    }
  }
  if (code === 'EADDRINUSE') {
    return { kind: 'in-use', code, retryable: true, hint: 'another process already owns this port' }
  }
  if (code === 'EADDRNOTAVAIL') {
    return { kind: 'unavailable', code, retryable: false, hint: 'the resolved loopback address is not on this machine' }
  }
  return { kind: 'unknown', code, retryable: false, hint: '' }
}

/** Shape one bind failure for the settings payload. */
function bindFailure(error) {
  const verdict = classifyBindError(error)
  return { code: verdict.code, kind: verdict.kind, message: String(error?.message ?? error), hint: verdict.hint }
}

function listenOnce(server, port, address) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve(server.address()?.port ?? 0)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, address)
  })
}

const delay = ms => new Promise(resolve => { setTimeout(resolve, ms) })

const BIND_ATTEMPTS = 4
const BIND_BACKOFF_MS = 150
const BIND_SCAN = 10

/**
 * Bind the listener, tolerating a port that is *temporarily* or *permanently*
 * someone else's.
 *
 * Two failure shapes matter and they need different answers. A listener that is
 * closing, or a portproxy rule that was just removed, frees the port within a
 * few hundred milliseconds — so the same port is worth a few retries before the
 * listener is declared dead. A port that is genuinely taken never frees, and the
 * old behaviour (one `listen`, one rejected promise) left the forward listener
 * down until the user guessed a different port or restarted the host. Walking to
 * the next free port keeps the feature usable; the caller publishes the real
 * port, so nothing is silent about it.
 *
 * @returns {Promise<{port: number, requested: number, fellBack: boolean, bindError: object|null}>}
 */
export async function bindForwardPort(server, { address, port, attempts = BIND_ATTEMPTS, backoffMs = BIND_BACKOFF_MS, scan = BIND_SCAN, log = () => {} } = {}) {
  const requested = Number.isFinite(Number(port)) && Number(port) > 0 ? Math.trunc(Number(port)) : 0
  if (requested === 0) {
    // An ephemeral port was asked for; the OS picks and there is nothing to fall back to.
    return { port: await listenOnce(server, 0, address), requested: 0, fellBack: false, bindError: null }
  }
  let last = null
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try {
      return { port: await listenOnce(server, requested, address), requested, fellBack: false, bindError: null }
    } catch (error) {
      last = error
      const verdict = classifyBindError(error)
      if (!verdict.retryable) throw error
      log(`port ${requested} is not available yet (${verdict.code}); retrying`)
      if (attempt < attempts - 1) await delay(backoffMs * 2 ** attempt)
    }
  }
  for (let offset = 1; offset <= Math.max(0, scan) && requested + offset <= 65535; offset += 1) {
    try {
      return { port: await listenOnce(server, requested + offset, address), requested, fellBack: true, bindError: last }
    } catch (error) {
      last = error
      if (!classifyBindError(error).retryable) throw error
    }
  }
  // Every nearby port is taken too; an ephemeral port still beats no listener.
  return { port: await listenOnce(server, 0, address), requested, fellBack: true, bindError: last }
}

/**
 * PROXY protocol v1, the one-line handshake the LAN relay opens each forwarded
 * connection with. Loopback placement is what keeps the claim honest: nothing
 * outside this machine can reach the forward listener to assert a source
 * address, so a parsed header can only have come from the relay. Traffic
 * that never looks like the handshake passes through as-is; a line that
 * claims the handshake and then lies is dropped before the parser sees it.
 *
 * @see https://www.haproxy.org/download/1.8/doc/proxy-protocol.txt
 */
const PROXY_V1_MAX_BYTES = 108 // the spec's ceiling, CRLF included
const PROXY_V1_PROBE_TIMEOUT_MS = 2000 // a handshake slower than this is not a relay

/** IPv4-mapped IPv6 spellings (`::ffff:192.168.1.7`) carry a v4 address. */
function bareAddress(ip) {
  const text = String(ip ?? '')
  return text.startsWith('::ffff:') ? text.slice(7) : text
}

/**
 * The PROXY v1 line for one relayed connection: the device that dialed the
 * relay — or, when a public tunnel spoke first, the one its own PROXY line
 * claimed — is the source; this machine's relay-side endpoint the
 * destination. An address family that does not match across the pair claims
 * nothing (`UNKNOWN`), except that a claimed device keeps its family: the
 * destination then falls back to that family's loopback, because the line
 * must stay well-formed for the listener to read the device at all.
 */
function proxyHeaderV1(socket) {
  const claimed = socket.ofmDevice
  const src = bareAddress(claimed?.address ?? socket.remoteAddress)
  const dst = bareAddress(socket.localAddress)
  const srcFamily = net.isIP(src)
  const dstFamily = net.isIP(dst)
  const finalDst = srcFamily && dstFamily && srcFamily !== dstFamily
    ? (srcFamily === 4 ? '127.0.0.1' : '::1')
    : dst
  const family = srcFamily && srcFamily === net.isIP(finalDst) ? srcFamily : 0
  const srcPort = claimed?.port ?? socket.remotePort
  if (!family || !srcPort || !socket.localPort) return 'PROXY UNKNOWN\r\n'
  const proto = family === 4 ? 'TCP4' : 'TCP6'
  return `PROXY ${proto} ${src} ${finalDst} ${srcPort} ${socket.localPort}\r\n`
}

/**
 * Parse one PROXY v1 line (CRLF already stripped). Returns `{device: null}`
 * for a well-formed header that attributes nothing (`PROXY UNKNOWN`), or
 * `null` when the line is malformed and the connection should be dropped.
 */
function parseProxyV1(line) {
  const parts = line.split(' ')
  if (parts[0] !== 'PROXY') return null
  if (parts[1] === 'UNKNOWN') return { device: null } // the tail is the sender's to invent
  if ((parts[1] === 'TCP4' || parts[1] === 'TCP6') && parts.length !== 6) return null
  if (parts[1] !== 'TCP4' && parts[1] !== 'TCP6') return null
  const family = parts[1] === 'TCP4' ? 4 : 6
  const [, , src, dst, srcPort, dstPort] = parts
  const port = value => (Number.isInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 65535 ? Number(value) : null)
  const source = port(srcPort)
  const destination = port(dstPort)
  if (source === null || destination === null) return null
  if (net.isIP(src) !== family || net.isIP(dst) !== family) return null
  return { device: { address: src, port: source } }
}

/**
 * Sniff a fresh connection for a PROXY v1 header before the HTTP parser can
 * see it — the parser attaches its own data listener the moment the connection
 * is handed over, so a `connection`-event hook would race it. Here the
 * front door reads the first bytes itself, then hands the stream on
 * untouched: every byte it looked at goes back with `socket.unshift()`, so the
 * HTTP server parses from the very start of what arrived.
 *
 * `onReady(device)` fires exactly once — `device` is `null` for plain local
 * traffic — or not at all when the connection dies or lies.
 */
function sniffProxyHeader(socket, log, onReady) {
  let buffered = Buffer.alloc(0)
  let probingHeader = false
  let settled = false
  const cleanup = () => {
    socket.removeListener('data', onData)
    socket.removeListener('error', onDead)
    socket.removeListener('close', onDead)
    socket.setTimeout(0)
  }
  const finish = device => {
    if (settled) return
    settled = true
    cleanup()
    if (buffered.length > 0) socket.unshift(buffered)
    socket.ofmDevice = device
    onReady(device)
  }
  const reject = reason => {
    if (settled) return
    settled = true
    cleanup()
    log(`forward: dropped a connection: ${reason}`)
    socket.destroy()
  }
  function onDead() {
    settled = true
    cleanup()
  }
  const onData = chunk => {
    if (settled) return
    buffered = buffered.length > 0 ? Buffer.concat([buffered, chunk]) : chunk
    if (!probingHeader) {
      const sig = 'PROXY '
      const head = buffered.toString('latin1', 0, Math.min(sig.length, buffered.length))
      if (!sig.startsWith(head)) return finish(null) // plain local traffic
      if (buffered.length < sig.length) return // prefix of `PROXY `, still deciding
      probingHeader = buffered.toString('latin1', 0, sig.length) === sig
      if (!probingHeader) return finish(null)
    }
    const end = buffered.indexOf('\r\n')
    if (end >= 0) {
      if (end + 2 > PROXY_V1_MAX_BYTES) return reject('an overlong PROXY header')
      const parsed = parseProxyV1(buffered.toString('latin1', 0, end))
      if (parsed === null) return reject('a malformed PROXY header')
      buffered = buffered.subarray(end + 2)
      return finish(parsed.device)
    }
    if (buffered.length >= PROXY_V1_MAX_BYTES) reject('an unterminated PROXY header')
  }
  socket.on('data', onData)
  socket.once('error', onDead)
  socket.once('close', onDead)
  socket.setTimeout(PROXY_V1_PROBE_TIMEOUT_MS, () => reject('a connection that never finished its handshake'))
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
 * @returns {Promise<{server: net.Server, port: number, requestedPort: number, fellBack: boolean, bindError: {code: string, kind: string, message: string, hint: string}|null, host: string, close: () => Promise<void>}>}
 */
export async function startForwardServer({ config, complete, modelRows, log = () => {}, heartbeatMs = SSE_HEARTBEAT_MS }) {
  const httpServer = http.createServer((req, res) => {
    void handle(req, res).catch(error => {
      log(`request failed: ${error?.message ?? error}`)
      if (!res.headersSent) {
        const status = Number(error?.statusCode)
        const code = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500
        openAiError(res, code, code === 500 ? 'server_error' : 'invalid_request_error', String(error?.message ?? error))
      } else {
        res.end()
      }
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
    // Name the originator when the relay vouched for one, so a log line reads
    // `192.168.1.7` instead of the relay's loopback socket.
    const device = req.socket.ofmDevice
    if (device) log(`forward: ${device.address}:${device.port} → ${req.method} ${path}`)
    // Liveness only, and deliberately before the key check: a caller probing
    // whether the port is up must not need the key to get an answer. It gets a
    // count of nothing — the model roster is what the authenticated routes serve.
    if (path === '/' || path === '/health') {
      json(res, 200, { ok: true, service: 'our-free-model' })
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
      await serveCompletion(req, res, complete, chatCompletions, heartbeatMs)
      return
    }
    if (req.method === 'POST' && (path === '/v1/responses' || path === '/responses')) {
      await serveCompletion(req, res, complete, responsesEndpoint, heartbeatMs)
      return
    }
    openAiError(res, 404, 'not_found_error', `no route for ${req.method} ${path}`)
  }

  // Resolve before listen so a hostile hosts file cannot slip a routable bind
  // past the loopback-only rule. The reported `host` below stays the configured
  // spelling: the settings reconciliation compares it, not the resolved IP.
  const bindAddress = await resolveLoopbackBind(config().host)
  const sockets = new Set()
  // The HTTP server cannot be the listener: its parser claims each connection
  // the instant it appears, so a PROXY line would hit the parser as a broken
  // request. This bare TCP front door reads the optional handshake first, then
  // hands the stream over with `httpServer.emit('connection', socket)` — the
  // same feed proxies have used since before http.Server had a knob for it.
  const front = net.createServer(socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    sniffProxyHeader(socket, log, () => httpServer.emit('connection', socket))
  })
  const requestedPort = Number.isFinite(Number(config().port)) ? Math.trunc(Number(config().port)) : 0
  const bound = await bindForwardPort(front, { address: bindAddress, port: requestedPort, log: message => log(`bind: ${message}`) })
  front.on('error', error => log(`listener error: ${error?.message ?? error}`))
  if (bound.fellBack) {
    const verdict = classifyBindError(bound.bindError)
    log(`port ${bound.requested} is taken (${verdict.code}); listening on ${bound.port} instead${verdict.hint === '' ? '' : ` — ${verdict.hint}`}`)
  }

  return {
    server: front,
    port: bound.port,
    /** The port the settings asked for, which differs from `port` exactly when
     *  the bind had to move. */
    requestedPort: bound.requested,
    fellBack: bound.fellBack,
    /** `{code, kind, message, hint}` when the bind moved, `null` otherwise. */
    bindError: bound.fellBack ? bindFailure(bound.bindError) : null,
    /** The address actually bound, so a caller can tell a restart from a no-op. */
    host: config().host || '127.0.0.1',
    close: () => new Promise(resolve => {
      front.close(() => resolve())
      httpServer.closeAllConnections?.()
      httpServer.close(() => {})
      for (const socket of sockets) socket.destroy()
    }),
  }
}

/** The routes the LAN relay carries — the local listener's surface and nothing else. */
const RELAY_PATHS = new Set([
  '/v1/models', '/models',
  '/v1/chat/completions', '/chat/completions',
  '/v1/responses', '/responses',
])

/** Marks a request the relay produced, so a misconfigured loop is refused. */
const RELAY_HOP_HEADER = 'x-ofm-relay-hop'

/**
 * Start the optional LAN relay.
 *
 * The forward listener above binds loopback only, and on purpose: its key spends
 * this machine's免密 quota, and issue #19 closed the door on handing that to a
 * whole subnet through a bind address. A user who wants a second device on the
 * same network to reach these models needs something the local listener cannot
 * give — an address that is reachable *and* a credential that can be revoked on
 * its own, so the two audiences never share a key.
 *
 * Hence a second, separate door, off unless asked for:
 *
 * - it binds the configured address (`0.0.0.0` by default) and authenticates
 *   *every* request. `/health` is not exempt here as it is on the local
 *   listener: an unauthenticated answer would confirm to any host on the
 *   network that this machine is up and proxying;
 * - it demands a key of its own (`lanKey`), never the local one, so a leak on a
 *   shared network costs a rotation instead of every tool on the machine;
 * - it re-issues the request to `127.0.0.1:<local forward port>` under the local
 *   key. That keeps one implementation of the OpenAI surface — the relay adds
 *   reach, not a second dialect — and it means the caller's key is the relay's
 *   business alone.
 *
 * @param {object} options
 * @param {() => {enabled: boolean, host: string, port: number, lanKey: string, localKey: string, targetPort: number}} options.config
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{server: net.Server, port: number, host: string, close: () => Promise<void>}>}
 */
export async function startLanRelay({ config, log = () => {} }) {
  const httpServer = http.createServer((req, res) => {
    void relay(req, res).catch(error => {
      log(`lan relay request failed: ${error?.message ?? error}`)
      if (!res.headersSent) openAiError(res, 502, 'server_error', String(error?.message ?? error))
      else res.end()
    })
  })
  const sockets = new Set()
  // The same front door the listener uses, one difference: this side already
  // knows the device from the socket itself, so a PROXY line — which can only
  // arrive here chained through a second relay by mistake — is parsed away
  // and dropped, leaving the HTTP parser a clean request and the loop check
  // (508) the answer it owes.
  const front = net.createServer(socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    sniffProxyHeader(socket, log, () => httpServer.emit('connection', socket))
  })

  async function relay(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    // A browser cannot put a key on a preflight, and answering one spends
    // nothing, so OPTIONS goes through unauthenticated.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders())
      res.end()
      return
    }
    const settings = config()
    if (!settings.enabled) {
      openAiError(res, 503, 'service_unavailable', 'the LAN relay is switched off in Our Free Model settings')
      return
    }
    if (!authorized(req, settings.lanKey)) {
      openAiError(res, 401, 'invalid_request_error', 'missing or invalid LAN key')
      return
    }
    // The one way this can happen is a relay port equal to the local forward
    // port: the relay would then be dialing itself. Refuse the second pass
    // instead of spinning until the sockets run out.
    if (req.headers[RELAY_HOP_HEADER] !== undefined) {
      openAiError(res, 508, 'server_error', 'the LAN relay would be dialing itself — give it a port of its own')
      return
    }
    if (!(settings.targetPort > 0)) {
      openAiError(res, 503, 'service_unavailable', 'the local forward listener is not running')
      return
    }
    if (!RELAY_PATHS.has(path)) {
      openAiError(res, 404, 'not_found_error', `no route for ${req.method} ${path}`)
      return
    }
    log(`lan relay: ${bareAddress(req.socket.ofmDevice?.address ?? req.socket.remoteAddress)} → ${path}`)
    const headers = { ...req.headers }
    delete headers.host
    delete headers.connection
    delete headers['x-api-key']
    // The caller's LAN key stops at this door; the local listener only ever sees
    // the key that belongs to this machine.
    headers.authorization = `Bearer ${settings.localKey}`
    headers[RELAY_HOP_HEADER] = '1'
    // One loopback connection per relayed request, each opening with its own
    // PROXY line. The non-pooling agent is the part that keeps addresses
    // honest: a reused socket would carry the next device's request under
    // whatever address the first one claimed.
    const header = proxyHeaderV1(req.socket)
    const agent = new http.Agent({ keepAlive: false })
    agent.createConnection = options => {
      const socket = net.connect(options)
      socket.write(header) // queued ahead of the request bytes http writes next
      return socket
    }
    const target = http.request({
      host: '127.0.0.1',
      port: settings.targetPort,
      method: req.method,
      path: `${path}${url.search}`,
      headers,
      agent,
    })
    target.on('response', upstream => {
      const relayed = { ...upstream.headers }
      // Hop-by-hop headers belong to the hop that is ending here, not the next.
      delete relayed.connection
      delete relayed['keep-alive']
      delete relayed['transfer-encoding']
      res.writeHead(upstream.statusCode ?? 502, relayed)
      upstream.pipe(res)
    })
    target.on('error', error => {
      log(`lan relay upstream failed: ${error?.message ?? error}`)
      if (!res.headersSent) openAiError(res, 502, 'server_error', 'the local forward listener did not answer')
      else res.end()
    })
    // A caller that walks away takes its upstream request with it, the same rule
    // the local listener applies to the upstream behind it.
    res.once('close', () => {
      if (!res.writableEnded) target.destroy()
    })
    req.pipe(target)
  }

  const desired = config()
  const host = String(desired.host ?? '').trim() || '0.0.0.0'
  const port = await new Promise((resolve, reject) => {
    const onError = error => reject(error)
    front.once('error', onError)
    const wanted = Number(desired.port)
    front.listen(Number.isFinite(wanted) && wanted > 0 ? Math.trunc(wanted) : 0, host, () => {
      front.off('error', onError)
      front.on('error', error => log(`lan relay error: ${error?.message ?? error}`))
      resolve(front.address()?.port ?? 0)
    })
  })

  return {
    server: front,
    port,
    host,
    close: () => new Promise(resolve => {
      front.close(() => resolve())
      httpServer.closeAllConnections?.()
      httpServer.close(() => {})
      for (const socket of sockets) socket.destroy()
    }),
  }
}

/** 转发客户端断开时中止正在生成的段，也阻止后续恢复请求。 */
async function serveCompletion(req, res, complete, endpoint, heartbeatMs) {
  const controller = new AbortController()
  const socket = req.socket
  const abort = () => {
    if (!controller.signal.aborted) controller.abort()
  }
  // A non-streaming endpoint does not send its response headers until the
  // upstream completion is done. When the caller disconnects before then,
  // ServerResponse#close can arrive too late (notably on Linux). The request
  // and its socket expose the disconnect earlier; all three signals share one
  // idempotent abort path.
  req.once('aborted', abort)
  socket?.once('close', abort)
  res.once('close', abort)
  if (req.aborted || req.destroyed || socket?.destroyed) abort()
  try {
    await endpoint(req, res, (request, onChunk) => complete({ ...request, signal: controller.signal, deviceIp: req.socket?.ofmDevice?.address ?? undefined }, onChunk), { heartbeatMs })
  } finally {
    req.removeListener('aborted', abort)
    socket?.removeListener('close', abort)
    res.removeListener('close', abort)
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

/**
 * How long a streaming answer may stay silent before an SSE comment frame goes
 * out.
 *
 * Reasoning models on this lane think for a minute or more before the first
 * token, and the newest ones never stream that thinking at all: measured live,
 * a call sat silent for 70 seconds while the lane billed 3024 reasoning tokens.
 * Every client-side idle watchdog reads that silence as a dead socket — pi-ai
 * aborts the turn once `streamIdleTimeoutMs` passes with nothing on the wire —
 * so the wait has to be kept visible.
 */
export const SSE_HEARTBEAT_MS = 15000

/**
 * Feed a streaming response's idle watchdog until the response ends.
 *
 * A comment frame is ignored by every client that speaks SSE, and it is a real
 * byte on the socket, which is what a watchdog counts. The timer is unref'd so
 * a closing listener never waits on it, and it is stopped on `close` — the one
 * event every way of ending this response goes through, including a client that
 * walked away mid-stream.
 */
export function startHeartbeat(res, intervalMs = SSE_HEARTBEAT_MS) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return () => {}
  const timer = setInterval(() => {
    if (res.writableEnded === true || res.destroyed === true) return
    res.write(': ping\n\n')
  }, intervalMs)
  timer.unref?.()
  const stop = () => clearInterval(timer)
  res.once('close', stop)
  return stop
}

function openStreamHeaders(res, heartbeatMs = SSE_HEARTBEAT_MS) {
  res.writeHead(200, {
    ...corsHeaders(),
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  // Both streaming endpoints open their headers here, so both of them — and
  // anything relaying them — inherit the heartbeat from this one place.
  startHeartbeat(res, heartbeatMs)
}

/** Per-request tool-wire state: harness block index → OpenAI tool index. */
function createToolWire(body) {
  // The caller's own tool names, spelled as they declared them. A call whose
  // restored name is one of the fingerprint quartet but not one of these is a
  // call to a decoy the model should never have dialed — it is suppressed on
  // the wire instead of handed over as a tool the caller cannot run.
  const declared = new Set()
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) {
    const name = tool?.function?.name ?? tool?.name
    if (typeof name === 'string' && name !== '') declared.add(name)
  }
  const slots = new Map()
  let nextIndex = 0
  // A block is classified the moment it names itself. Until then its argument
  // fragments are held: a provider that streams arguments before the name is
  // rare, but forwarding them optimistically would leak decoy fragments to a
  // client that cannot run the call.
  const classified = new Map()
  const held = new Map()
  return {
    /** Is this (restored) tool name one the caller can actually execute? */
    executable: name => !(FINGERPRINT_TOOLS.includes(name) && !declared.has(name)),
    /** Sequential per-request index for a harness block, as OpenAI clients expect. */
    indexOf(blockIndex) {
      let assigned = slots.get(blockIndex)
      if (assigned === undefined) { assigned = nextIndex++; slots.set(blockIndex, assigned) }
      return assigned
    },
    /**
     * Route one tool-call delta.
     * @returns {{kind:'drop'} | {kind:'forward', openAiIndex:number, first:boolean, id?:string, name?:string, args:string}}
     */
    admit(chunk) {
      const blockIndex = chunk.index
      const verdict = classified.get(blockIndex)
      if (verdict === false) return { kind: 'drop' }
      const name = typeof chunk.name === 'string' && chunk.name !== '' ? chunk.name : undefined
      if (verdict === true) {
        return { kind: 'forward', openAiIndex: this.indexOf(blockIndex), first: false, args: chunk.argumentsDelta ?? '' }
      }
      if (name !== undefined) {
        const keep = this.executable(name)
        classified.set(blockIndex, keep)
        if (!keep) return { kind: 'drop' }
        const parked = held.get(blockIndex)
        held.delete(blockIndex)
        return {
          kind: 'forward', openAiIndex: this.indexOf(blockIndex), first: true,
          id: chunk.id ?? parked?.id, name,
          args: [...parked?.args ?? [], chunk.argumentsDelta ?? ''].join(''),
        }
      }
      const parked = held.get(blockIndex) ?? { args: [] }
      if (chunk.id !== undefined && chunk.id !== '') parked.id = chunk.id
      if (chunk.argumentsDelta) parked.args.push(chunk.argumentsDelta)
      held.set(blockIndex, parked)
      return { kind: 'drop' }
    },
  }
}

/** Drive one chat-completion through `complete`, in either response style. */
async function chatCompletions(req, res, complete, options = {}) {
  const body = await readBody(req)
  const effortSuffix = /\(([^()]+)\)\s*$/.exec(String(body.model ?? ''))
  const model = baseModelId(String(body.model ?? ''))
  if (model === '') {
    openAiError(res, 400, 'invalid_request_error', '`model` is required')
    return
  }
  const id = `chatcmpl-${crypto.randomBytes(8).toString('hex')}`
  const created = Math.floor(Date.now() / 1000)
  const wantsStream = body.stream === true
  // The trailing "(level)" rung is this plugin's own convention for thinking
  // budgets; honor it for callers that speak the spelling the picker uses,
  // without overriding an explicit `reasoning_effort`.
  if (effortSuffix !== null && body.reasoning_effort === undefined) body.reasoning_effort = effortSuffix[1].trim()

  const tools = createToolWire(body)

  if (!wantsStream) {
    const outcome = await complete({ model, openAi: body })
    // 截断或恢复失败即使已有部分正文，也不能返回正常完成。
    if (outcome.error !== undefined) {
      openAiError(res, 502, 'server_error', outcome.error)
      return
    }
    const calls = executableCalls(outcome, tools)
    json(res, 200, {
      id, object: 'chat.completion', created, model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: outcome.text === '' || outcome.text === undefined ? null : outcome.text,
          ...(calls.length ? { tool_calls: calls.map((call, i) => ({ id: call.id || `call_${i}`, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}),
        },
        finish_reason: calls.length ? 'tool_calls' : outcome.truncated ? 'length' : 'stop',
      }],
      usage: outcome.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })
    return
  }

  openStreamHeaders(res, options.heartbeatMs)
  sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
  const outcome = await complete({ model, openAi: body }, (chunk) => {
    if (res.destroyed) return
    if (chunk.type === 'text-delta') {
      sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: chunk.text }, finish_reason: null }] })
      return
    }
    if (chunk.type === 'reasoning-delta') {
      sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { reasoning: chunk.text }, finish_reason: null }] })
      return
    }
    if (chunk.type === 'tool-call-delta') {
      const action = tools.admit(chunk)
      if (action.kind === 'drop') return
      sendSse(res, {
        id, object: 'chat.completion.chunk', created, model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: action.openAiIndex,
              ...(action.first ? { id: action.id, function: { name: action.name ?? '', arguments: '' } } : {}),
            }],
          },
          finish_reason: null,
        }],
      })
      if (action.args) {
        sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: action.openAiIndex, function: { arguments: action.args } }] }, finish_reason: null }] })
      }
      return
    }
    if (chunk.type === 'usage') {
      sendSse(res, { id, object: 'chat.completion.chunk', created, model, choices: [], usage: toOpenAiUsage(chunk.usage) })
    }
  })
  if (outcome.error !== undefined) {
    // The status line went out with the first SSE header, so 200 is already spent
    // — but a turn the lane refused must still say so. Answering a refusal with a
    // clean `finish_reason: stop` and no content is the empty-200 this endpoint's
    // non-streaming branch fixed, arriving by the other door.
    sendSse(res, { error: { message: String(outcome.error), type: 'server_error' } })
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }
  // Finish reason mirrors the non-streaming branch, over the calls that
  // survived the decoy filter and (after a ceiling cut) the executability
  // filter: reporting `tool_calls` beside no callable tool — or beside one the
  // client cannot run — is how the truncation loop used to come back by the
  // streaming door.
  const calls = executableCalls(outcome, tools)
  sendSse(res, {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : outcome.truncated ? 'length' : 'stop' }],
  })
  res.write('data: [DONE]\n\n')
  res.end()
}

/**
 * The outcome's tool calls, in OpenAI spelling.
 *
 * Decoy calls are dropped; after a max-tokens finish, so are calls whose
 * arguments never closed (the model's JSON was cut mid-string — the gateway
 * still reports `tool_calls` for that turn, but the adapter has already
 * downgraded it, and reporting an unexecutable call alongside `length` is how
 * the truncation loop stays alive).
 */
function executableCalls(outcome, tools) {
  let calls = (outcome.toolCalls ?? []).filter(call => tools.executable(call.name))
  if (outcome.truncated === true) {
    calls = calls.filter(call => {
      try { JSON.parse(call.arguments === '' ? '{}' : call.arguments); return true } catch { return false }
    })
  }
  return calls.map((call, i) => ({ id: call.id || `call_${i}`, name: call.name, arguments: call.arguments }))
}

/** Responses-API spelling, so Codex-shaped local clients work too. */
async function responsesEndpoint(req, res, complete, options = {}) {
  const body = await readBody(req)
  const effortSuffix = /\(([^()]+)\)\s*$/.exec(String(body.model ?? ''))
  const model = baseModelId(String(body.model ?? ''))
  if (model === '') {
    openAiError(res, 400, 'invalid_request_error', '`model` is required')
    return
  }
  const id = `resp-${crypto.randomBytes(8).toString('hex')}`
  const created = Math.floor(Date.now() / 1000)
  // `instructions` is the Responses spelling of a system prompt and
  // `max_output_tokens` of the generation ceiling; dropping either made the
  // endpoint read compatible while silently ignoring what callers asked for.
  const input = []
  if (typeof body.instructions === 'string' && body.instructions !== '') {
    input.push({ role: 'system', content: body.instructions })
  }
  if (Array.isArray(body.input)) input.push(...body.input)
  else if (body.input !== undefined) input.push(body.input)
  else if (Array.isArray(body.messages)) input.push(...body.messages)
  const openAi = {
    ...body,
    input,
    ...(typeof body.max_output_tokens === 'number' ? { max_tokens: body.max_output_tokens } : {}),
    ...(body.reasoning_effort === undefined && effortSuffix !== null ? { reasoning_effort: effortSuffix[1].trim() } : {}),
  }

  const tools = createToolWire(openAi)
  const status = outcome => outcome.truncated === true ? 'incomplete' : 'completed'
  const incompleteDetails = outcome => outcome.truncated === true ? { reason: 'max_output_tokens' } : undefined
  const outputRows = outcome => [
    ...(outcome.text ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: outcome.text }] }] : []),
    ...executableCalls(outcome, tools).map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments })),
  ]

  if (body.stream === true) {
    openStreamHeaders(res, options.heartbeatMs)
    const say = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`)
    const response = (over = {}) => ({
      id, object: 'response', created_at: created, model, status: 'in_progress',
      output: [], usage: undefined, ...over,
    })
    say('response.created', { response: response() })
    // Items are announced before their deltas, the way the Responses wire
    // expects, and every announced item takes the next `output_index` in
    // announcement order — a message hardwired to 0 collided with the first
    // function call whenever a turn mixed text and tool calls, and neither
    // matched its position in the completed output. The final array below
    // replays the announcement order, so a client accumulating by index sees
    // exactly what the completed response lists.
    let nextOutputIndex = 0
    let messageIndex
    const callIndexes = new Map()
    const order = []
    const announceMessage = () => {
      if (messageIndex !== undefined) return
      messageIndex = nextOutputIndex++
      order.push('message')
      say('response.output_item.added', { output_index: messageIndex, item: { type: 'message', role: 'assistant', item_id: `msg_${messageIndex}`, content: [] } })
    }
    const announceCall = (openAiIndex, name) => {
      if (callIndexes.has(openAiIndex)) return
      const index = nextOutputIndex++
      callIndexes.set(openAiIndex, index)
      order.push(openAiIndex)
      say('response.output_item.added', { output_index: index, item: { type: 'function_call', item_id: `fc_${index}`, call_id: `fc_${index}`, name, arguments: '' } })
    }
    let usage
    const outcome = await complete({ model, openAi, responses: true }, (chunk) => {
      if (res.destroyed) return
      if (chunk.type === 'text-delta') {
        announceMessage()
        say('response.output_text.delta', { item_id: `msg_${messageIndex}`, output_index: messageIndex, delta: chunk.text })
        return
      }
      if (chunk.type === 'tool-call-delta') {
        const action = tools.admit(chunk)
        if (action.kind === 'drop') return
        announceCall(action.openAiIndex, action.name ?? '')
        say('response.function_call_arguments.delta', { item_id: `fc_${callIndexes.get(action.openAiIndex)}`, output_index: callIndexes.get(action.openAiIndex), delta: action.args })
        return
      }
      if (chunk.type === 'usage') {
        usage = toOpenAiUsage(chunk.usage)
      }
    })
    if (outcome.error !== undefined) {
      say('response.failed', { response: response({ status: 'failed', error: { message: String(outcome.error) } }) })
      res.end()
      return
    }
    const finalUsage = usage === undefined ? undefined : {
      input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens,
      input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0 },
      output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0 },
    }
    // The completed output replays the announcement order: the message where
    // it was announced, then every announced call mapped positionally onto the
    // calls that survived the decoy and truncation filters (the survivors keep
    // the lane's fold order, which is the announcement order for every shape
    // the free lane emits; a call the ceiling cut mid-JSON simply drops out).
    const finalCalls = executableCalls(outcome, tools)
    const messageRow = outcome.text ? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: outcome.text }] } : undefined
    const output = []
    let callPos = 0
    for (const entry of order) {
      if (entry === 'message') { if (messageRow !== undefined) output.push(messageRow); continue }
      const row = finalCalls[callPos++]
      if (row !== undefined) output.push({ type: 'function_call', call_id: row.id, name: row.name, arguments: row.arguments })
    }
    const final = response({
      status: status(outcome),
      output,
      usage: finalUsage,
      ...(incompleteDetails(outcome) === undefined ? {} : { incomplete_details: incompleteDetails(outcome) }),
    })
    say('response.completed', { response: final })
    res.end()
    return
  }

  const outcome = await complete({ model, openAi, responses: true })
  if (outcome.error !== undefined) {
    openAiError(res, 502, 'server_error', outcome.error)
    return
  }
  const rows = outputRows(outcome)
  json(res, 200, {
    id, object: 'response', created_at: created, model, status: status(outcome),
    ...(incompleteDetails(outcome) === undefined ? {} : { incomplete_details: incompleteDetails(outcome) }),
    output: rows,
    usage: {
      input_tokens: outcome.usage?.prompt_tokens ?? 0,
      output_tokens: outcome.usage?.completion_tokens ?? 0,
      total_tokens: outcome.usage?.total_tokens ?? 0,
    },
  })
}

export function toOpenAiUsage(usage) {
  if (usage === undefined) return undefined
  return {
    prompt_tokens: (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0),
    completion_tokens: usage.outputTokens ?? 0,
    total_tokens: (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.outputTokens ?? 0),
    prompt_tokens_details: { cached_tokens: usage.cacheReadTokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
  }
}
