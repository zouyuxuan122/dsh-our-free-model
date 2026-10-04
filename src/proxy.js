/**
 * Egress proxy.
 *
 * The free lane is gated by egress country: a turn from a blocked region is
 * refused outright, and no amount of retrying from the same address changes
 * that. This module is the way out — point the plugin at a proxy and every
 * request that the region gate can see leaves through it instead.
 *
 * It replaces `fetch` for those call sites rather than teaching each of them
 * about sockets, so the rest of the plugin keeps the interface it already had.
 * `egressFetch` is deliberately shaped like `fetch`: it returns a real
 * `Response` whose `body` is a web `ReadableStream`, because `src/http.js`
 * reads the stream through `getReader()` and the probe reads `.json()`.
 *
 * Three proxy dialects, picked from the URL scheme, all sharing one tunnel:
 *
 *   http://      plain TCP to the proxy, `CONNECT`, optional Basic credentials
 *   https://     TLS to the proxy first, then `CONNECT` inside it, then a
 *                second TLS session to the target (nested TLS)
 *   socks5://    SOCKS5 greeting, optional username/password sub-negotiation,
 *                and the target hostname sent as a name (ATYP 3) so the proxy
 *                resolves it — which also sidesteps local DNS pollution
 *
 * The one piece that is not obvious: Node 24 ignores a `createConnection`
 * callback passed through `http.request` options — it is not part of the Agent
 * API and the request just dials out directly, silently. The working seam is to
 * subclass the Agent and override `createConnection`, which is what
 * `createAgent` below does. The override must call back and return `undefined`;
 * returning a socket makes the base class treat it as already handled.
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import zlib from 'node:zlib'
import { Readable } from 'node:stream'

import { openSecret, sealSecret, secretBackend } from './secret.js'

/** How long a proxy dial, a CONNECT answer or a SOCKS5 step may take. */
const CONNECT_TIMEOUT_MS = 30_000

/** A CONNECT response head that never ends is a broken proxy, not a slow one. */
const MAX_CONNECT_HEAD_BYTES = 64 * 1024

/**
 * The bypass list a fresh install starts with.
 *
 * It is a visible default rather than a hidden rule, so the settings page shows
 * exactly what is excluded and a user who wants loopback proxied can say so.
 * Nothing the plugin fetches is on loopback — the forward listener is inbound —
 * so this is a courtesy default, not a load-bearing one.
 */
export const DEFAULT_BYPASS = 'localhost, 127.0.0.1, ::1'

const PROXY_SCHEMES = new Set(['http', 'https', 'socks5', 'socks5h'])

const DEFAULT_PORTS = { http: 8080, https: 443, socks5: 1080, socks5h: 1080 }

const SOCKS5_ERRORS = {
  1: 'general failure',
  2: 'connection not allowed by ruleset',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused',
  6: 'TTL expired',
  7: 'command not supported',
  8: 'address type not supported',
}

/**
 * One tunnel per live configuration, split by target protocol. Both are
 * destroyed whenever the configuration changes, so a stale password can never
 * keep serving requests out of a pooled socket.
 */
let active = null
let agents = null

/** Serialises reconfiguration: boot and a settings POST can overlap. */
let queue = Promise.resolve()

/** Hide `user:password@` wherever a proxy address might be printed. */
export function redactProxy(text) {
  return String(text ?? '')
    .replace(/(:\/\/)[^/@\s]+@/g, '$1***@')
    .replace(/^[^/@\s]+@/, '***@')
}

/**
 * Parse a proxy address into the shape the tunnel needs.
 *
 * A bare `host:port` is read as `http://host:port`, because that is what people
 * paste from a Clash or v2rayN window.
 *
 * @param {string} raw
 * @returns {{ok: true, scheme: string, host: string, port: number, username: string, password: string}|{ok: false, error: string}}
 */
export function parseProxyUrl(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return { ok: false, error: '代理地址为空' }
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  let url
  try {
    url = new URL(candidate)
  } catch {
    return { ok: false, error: `代理地址无法解析：${redactProxy(text)}` }
  }
  const scheme = url.protocol.replace(':', '').toLowerCase()
  if (!PROXY_SCHEMES.has(scheme)) {
    return { ok: false, error: `不支持的代理协议 ${scheme}（请使用 http、https 或 socks5）` }
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === '') return { ok: false, error: '代理地址缺少主机名' }
  const port = url.port === '' ? DEFAULT_PORTS[scheme] : Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `代理端口不合法：${redactProxy(url.port)}` }
  }
  let username = ''
  let password = ''
  try {
    username = decodeURIComponent(url.username ?? '')
    password = decodeURIComponent(url.password ?? '')
  } catch {
    return { ok: false, error: '代理地址中的用户名或密码编码不正确' }
  }
  return { ok: true, scheme, host, port, username, password }
}

/**
 * Whether a target host must skip the proxy.
 *
 * Rules are `*`, an exact host, or a `.suffix`/`suffix` that also covers
 * subdomains.
 *
 * @param {string} hostname
 * @param {string[]} bypass
 */
export function isBypassed(hostname, bypass = []) {
  const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  if (host === '') return false
  for (const raw of bypass) {
    const rule = String(raw ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '')
    if (rule === '') continue
    if (rule === '*') return true
    if (rule.startsWith('.')) {
      if (host === rule.slice(1) || host.endsWith(rule)) return true
      continue
    }
    if (host === rule || host.endsWith(`.${rule}`)) return true
  }
  return false
}

/** `"a.com, .b.com c.com"` -> `['a.com', '.b.com', 'c.com']`. */
export function splitBypass(text) {
  return String(text ?? '').split(/[\s,;]+/).filter(part => part !== '')
}

/**
 * Apply a proxy configuration.
 *
 * Accepts the stored record merged with a settings patch. The password is taken
 * from, in order: an explicitly supplied `password`, the userinfo of `url`, or
 * the encrypted `secret` already on disk. A blank password field therefore
 * means "keep what is stored", which is the only behaviour that lets the
 * settings page render without ever echoing the password back.
 *
 * Returns the record to persist — `url` has its password stripped, and the
 * password itself lives only in the encrypted `secret` — plus `ok: false` with
 * a reason when the address is unusable.
 *
 * @param {{enabled?: boolean, url?: string, bypass?: string, password?: string, clearPassword?: boolean, secret?: unknown}} config
 * @returns {Promise<{ok: boolean, error?: string, record: object}>}
 */
export function configureEgress(config = {}) {
  const run = () => applyConfig(config)
  const next = queue.then(run, run)
  queue = next.then(() => undefined, () => undefined)
  return next
}

async function applyConfig(config) {
  const enabled = config?.enabled === true
  const rawUrl = String(config?.url ?? '').trim()
  const bypassText = String(config?.bypass ?? '').trim()
  const bypass = splitBypass(bypassText)
  const supplied = typeof config?.password === 'string' ? config.password : ''
  let secret = config?.secret ?? null

  const parsed = rawUrl === '' ? { ok: false, error: '代理地址为空' } : parseProxyUrl(rawUrl)
  // A disabled proxy may keep an unusable address on disk: the settings page
  // has to be able to show it while the user is still typing. Only an address
  // that is about to be used has to work.
  if (enabled && !parsed.ok) {
    return { ok: false, error: parsed.error, record: recordOf(enabled, rawUrl, parsed, bypassText, secret) }
  }

  let password = ''
  let secretUnreadable = false
  if (config?.clearPassword === true) {
    secret = null
  } else if (supplied !== '') {
    password = supplied
    secret = await sealSecret(supplied)
  } else if (parsed.ok && parsed.password !== '') {
    password = parsed.password
    secret = await sealSecret(parsed.password)
  } else if (secret !== null && secret !== undefined) {
    const opened = await openSecret(secret)
    if (opened === undefined) secretUnreadable = true
    else password = opened
  }

  const record = recordOf(enabled, rawUrl, parsed, bypassText, secret)

  teardown()
  if (!enabled) {
    active = { enabled: false, url: record.url, bypass, bypassText, secret, secretUnreadable }
    return { ok: true, record }
  }

  const proxy = {
    scheme: parsed.scheme, host: parsed.host, port: parsed.port,
    username: parsed.username, password,
  }
  active = { enabled: true, ...proxy, url: record.url, bypass, bypassText, secret, secretUnreadable }
  agents = { secure: createAgent(proxy, true), plain: createAgent(proxy, false) }
  return { ok: true, record }
}

/** The persisted shape: never a password, only a scheme and a host. */
function recordOf(enabled, rawUrl, parsed, bypassText, secret) {
  if (!parsed.ok) return { enabled, url: rawUrl, bypass: bypassText, secret: secret ?? null }
  const user = parsed.username === '' ? '' : `${encodeURIComponent(parsed.username)}@`
  return {
    enabled,
    url: `${parsed.scheme}://${user}${parsed.host}:${parsed.port}`,
    bypass: bypassText,
    secret: secret ?? null,
  }
}

/** The view the settings page and the summary read. Never carries a password. */
export function egressStatus() {
  const backend = secretBackend()
  if (active === null) {
    return {
      enabled: false, url: '', host: '', port: 0, scheme: '', bypass: '',
      hasPassword: false, secretScheme: '', secretUnreadable: false, backend,
    }
  }
  return {
    enabled: active.enabled === true,
    url: active.url ?? '',
    host: active.enabled === true ? active.host : '',
    port: active.enabled === true ? active.port : 0,
    scheme: active.enabled === true ? active.scheme : '',
    bypass: active.bypassText ?? '',
    hasPassword: active.secret !== null && active.secret !== undefined,
    secretScheme: active.secret?.scheme ?? '',
    secretUnreadable: active.secretUnreadable === true,
    backend,
  }
}

/** Drop every pooled tunnel. Called on reconfigure and on plugin disposal. */
export function disposeEgress() {
  teardown()
  active = null
}

function teardown() {
  if (agents === null) return
  agents.secure.destroy()
  agents.plain.destroy()
  agents = null
}

/**
 * A `fetch` that leaves through the proxy when one is configured and behaves
 * exactly like the global one when none is.
 *
 * The passthrough matters more than the proxy: with the feature off, not one
 * byte of behaviour changes, and the whole existing test suite stays valid.
 *
 * @param {string|URL} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function egressFetch(url, init = {}) {
  const current = active
  if (current === null || current.enabled !== true) return fetch(url, init)
  let target
  try {
    target = url instanceof URL ? url : new URL(String(url))
  } catch {
    return fetch(url, init)
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return fetch(url, init)
  if (isBypassed(target.hostname, current.bypass)) return fetch(url, init)
  return proxiedRequest(target, init, agents)
}

async function proxiedRequest(target, init, pool) {
  const secure = target.protocol === 'https:'
  const headers = headersOf(init.headers)
  const method = String(init.method ?? 'GET').toUpperCase()

  // Deliberately no `accept-encoding`. Node's `http.request` does not decode,
  // so advertising gzip would hand the caller bytes it cannot read; leaving the
  // header off makes the origin send plain text. A proxy may compress anyway,
  // which is what the decode step after the response head is for.
  const body = init.body
  if (body !== null && body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
    throw new TypeError('egressFetch: only string, Buffer and Uint8Array bodies can go through a proxy')
  }
  const payload = body === null || body === undefined ? null : (Buffer.isBuffer(body) ? body : Buffer.from(body))
  if (payload !== null && headers['content-length'] === undefined && headers['transfer-encoding'] === undefined) {
    // Without this the request silently becomes chunked, and a gateway that
    // validates `content-length` rejects it.
    headers['content-length'] = String(payload.length)
  }

  const response = await new Promise((resolve, reject) => {
    const request = (secure ? https : http).request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port === '' ? (secure ? 443 : 80) : Number(target.port),
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      agent: secure ? pool.secure : pool.plain,
      signal: init.signal ?? undefined,
    }, resolve)
    request.on('error', reject)
    if (payload !== null) request.write(payload)
    request.end()
  })

  const status = response.statusCode ?? 502
  if (status >= 300 && status < 400) {
    // `redirect: 'error'` is what every existing call site asks for, and the
    // global fetch honours it. Following a redirect here would quietly send the
    // request somewhere the caller refused to go.
    response.destroy()
    throw new TypeError(`egressFetch: refused a ${status} redirect`)
  }

  const out = new Headers()
  for (const [key, value] of Object.entries(response.headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const item of value) out.append(key, item)
    else out.set(key, String(value))
  }

  const encoding = String(response.headers['content-encoding'] ?? '').trim().toLowerCase()
  let stream = response
  if (encoding === 'gzip' || encoding === 'x-gzip') stream = response.pipe(zlib.createGunzip())
  else if (encoding === 'deflate') stream = response.pipe(zlib.createInflate())
  else if (encoding === 'br') stream = response.pipe(zlib.createBrotliDecompress())
  if (encoding !== '') {
    // The caller gets decoded bytes, so the headers that describe the encoded
    // ones have to go — `fetch` does the same.
    out.delete('content-encoding')
    out.delete('content-length')
  }

  // A null-body status may not carry a stream, and `src/http.js` reads an empty
  // body as `null` rather than as zero bytes.
  const empty = status === 204 || status === 205 || status === 304
  return new Response(empty ? null : Readable.toWeb(stream), {
    status,
    statusText: response.statusMessage ?? '',
    headers: out,
  })
}

function headersOf(input) {
  const out = {}
  if (input === undefined || input === null) return out
  if (typeof Headers !== 'undefined' && input instanceof Headers) {
    input.forEach((value, key) => { out[key.toLowerCase()] = value })
    return out
  }
  if (Array.isArray(input)) {
    for (const pair of input) {
      if (Array.isArray(pair) && pair.length >= 2) out[String(pair[0]).toLowerCase()] = String(pair[1])
    }
    return out
  }
  if (typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined && value !== null) out[String(key).toLowerCase()] = String(value)
    }
  }
  return out
}

// ── tunnel ───────────────────────────────────────────────────────────────────

function createAgent(proxy, secure) {
  const Base = secure ? https.Agent : http.Agent
  class EgressAgent extends Base {
    createConnection(options, callback) {
      const host = options.host ?? options.hostname ?? ''
      const port = Number(options.port) || (secure ? 443 : 80)
      openTunnel(proxy, { host, port }, secure).then(
        socket => callback(null, socket),
        error => callback(error),
      )
      // The base class treats a returned socket as authoritative, and a Promise
      // is not one. Returning `undefined` is what makes the callback the answer.
      return undefined
    }
  }
  return new EgressAgent({
    keepAlive: true,
    keepAliveMsecs: 15_000,
    maxSockets: 8,
    maxFreeSockets: 2,
    timeout: CONNECT_TIMEOUT_MS,
  })
}

/** Open a raw byte pipe to `target`, either already TLS-wrapped or not. */
async function openTunnel(proxy, target, secureTarget) {
  const socket = proxy.scheme === 'socks5' || proxy.scheme === 'socks5h'
    ? await openSocks5(proxy, target)
    : await openConnect(proxy, target)
  if (!secureTarget) return socket
  return wrapTls(socket, target)
}

function hostForConnect(host) {
  return net.isIPv6(host) ? `[${host}]` : host
}

function openConnect(proxy, target) {
  return new Promise((resolve, reject) => {
    const overTls = proxy.scheme === 'https'
    const socket = overTls
      ? tls.connect({
        host: proxy.host,
        port: proxy.port,
        // Lenient on purpose, and only for this hop. A self-signed certificate
        // on a personal VPS is the common case and must not make the feature
        // unusable. The session to the model gateway below keeps full
        // verification, so a wrong certificate there still fails the request.
        rejectUnauthorized: false,
        servername: net.isIP(proxy.host) === 0 ? proxy.host : undefined,
      })
      : net.connect({ host: proxy.host, port: proxy.port })

    let settled = false
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => fail(new Error(`连接代理超时（${CONNECT_TIMEOUT_MS}ms）`)), CONNECT_TIMEOUT_MS)
    timer.unref?.()

    function cleanup() {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', fail)
      socket.removeListener('close', onClose)
    }
    function fail(error) {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(error)
    }
    function onClose() {
      fail(new Error('代理在应答 CONNECT 之前关闭了连接'))
    }
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) {
        if (buffer.length > MAX_CONNECT_HEAD_BYTES) fail(new Error('代理返回的 CONNECT 响应过大'))
        return
      }
      const head = buffer.subarray(0, end).toString('latin1')
      const status = Number(head.split(' ')[1])
      if (status !== 200) {
        fail(new Error(`代理拒绝 CONNECT（状态码 ${Number.isFinite(status) ? status : '?'}）`))
        return
      }
      settled = true
      cleanup()
      // A proxy that answers and immediately starts relaying leaves the first
      // bytes in the same packet. Put them back before handing the socket over.
      const rest = buffer.subarray(end + 4)
      if (rest.length > 0) {
        try { socket.unshift(rest) } catch { /* nothing better to do with them */ }
      }
      resolve(socket)
    }

    socket.setNoDelay?.(true)
    socket.on('error', fail)
    socket.on('close', onClose)
    socket.on('data', onData)
    socket.on(overTls ? 'secureConnect' : 'connect', () => {
      const authority = `${hostForConnect(target.host)}:${target.port}`
      const lines = [
        `CONNECT ${authority} HTTP/1.1`,
        `Host: ${authority}`,
        'Proxy-Connection: keep-alive',
      ]
      if (proxy.username !== '' || proxy.password !== '') {
        const token = Buffer.from(`${proxy.username}:${proxy.password}`, 'utf8').toString('base64')
        lines.push(`Proxy-Authorization: Basic ${token}`)
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
  })
}

/**
 * Wrap the tunnel in TLS to the target.
 *
 * `rejectUnauthorized` is left at its default, so this hop is verified exactly
 * as the direct connection would have been.
 */
function wrapTls(socket, target) {
  return new Promise((resolve, reject) => {
    const wrapped = tls.connect({
      socket,
      servername: net.isIP(target.host) === 0 ? target.host : undefined,
      // Without this the offer includes h2, and an HTTP/1.1 request over an h2
      // session is not something `http.request` can speak.
      ALPNProtocols: ['http/1.1'],
    })
    const timer = setTimeout(() => {
      wrapped.destroy()
      reject(new Error('与目标站建立 TLS 超时'))
    }, CONNECT_TIMEOUT_MS)
    timer.unref?.()
    wrapped.once('secureConnect', () => { clearTimeout(timer); resolve(wrapped) })
    wrapped.once('error', error => { clearTimeout(timer); reject(error) })
  })
}

function openSocks5(proxy, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port })
    let settled = false
    let stage = 'greeting'
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => fail(new Error(`SOCKS5 握手超时（${CONNECT_TIMEOUT_MS}ms）`)), CONNECT_TIMEOUT_MS)
    timer.unref?.()

    function cleanup() {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', fail)
      socket.removeListener('close', onClose)
    }
    function fail(error) {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(error)
    }
    function onClose() {
      fail(new Error('SOCKS5 代理在握手过程中关闭了连接'))
    }

    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk])
      try {
        if (stage === 'greeting') {
          if (buffer.length < 2) return
          const version = buffer[0]
          const method = buffer[1]
          buffer = buffer.subarray(2)
          if (version !== 5) {
            fail(new Error('SOCKS5 代理返回了非预期的版本号'))
            return
          }
          if (method === 0x02) {
            if (proxy.username === '' && proxy.password === '') {
              fail(new Error('SOCKS5 代理要求用户名密码，但代理地址里没有填写'))
              return
            }
            stage = 'auth'
            socket.write(socks5Auth(proxy))
            return
          }
          if (method !== 0x00) {
            fail(new Error('SOCKS5 代理拒绝了所有可用的认证方式'))
            return
          }
          stage = 'connect'
          socket.write(socks5Connect(target))
          return
        }
        if (stage === 'auth') {
          if (buffer.length < 2) return
          const status = buffer[1]
          buffer = buffer.subarray(2)
          if (status !== 0x00) {
            fail(new Error('SOCKS5 认证失败，请检查代理用户名与密码'))
            return
          }
          stage = 'connect'
          socket.write(socks5Connect(target))
          return
        }
        if (buffer.length < 4) return
        const version = buffer[0]
        const status = buffer[1]
        const atyp = buffer[3]
        if (version !== 5) {
          fail(new Error('SOCKS5 代理返回了非预期的版本号'))
          return
        }
        if (status !== 0x00) {
          fail(new Error(`SOCKS5 代理拒绝连接：${SOCKS5_ERRORS[status] ?? `错误码 ${status}`}`))
          return
        }
        const addressLength = atyp === 0x01 ? 4 : atyp === 0x03 ? 1 + (buffer[4] ?? 0) : atyp === 0x04 ? 16 : -1
        if (addressLength === -1) {
          fail(new Error('SOCKS5 代理返回了未知的地址类型'))
          return
        }
        if (buffer.length < 4 + addressLength + 2) return
        const rest = buffer.subarray(4 + addressLength + 2)
        settled = true
        cleanup()
        if (rest.length > 0) {
          try { socket.unshift(rest) } catch { /* best effort */ }
        }
        resolve(socket)
      } catch (error) {
        fail(error)
      }
    }

    socket.setNoDelay?.(true)
    socket.on('error', fail)
    socket.on('close', onClose)
    socket.on('data', onData)
    socket.on('connect', () => {
      const methods = proxy.username !== '' || proxy.password !== '' ? [0x00, 0x02] : [0x00]
      socket.write(Buffer.from([0x05, methods.length, ...methods]))
    })
  })
}

function socks5Auth(proxy) {
  const user = Buffer.from(proxy.username, 'utf8').subarray(0, 255)
  const pass = Buffer.from(proxy.password, 'utf8').subarray(0, 255)
  return Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass])
}

function socks5Connect(target) {
  const port = Buffer.alloc(2)
  port.writeUInt16BE(target.port)
  if (net.isIPv4(target.host)) {
    return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01]), Buffer.from(target.host.split('.').map(Number)), port])
  }
  if (net.isIPv6(target.host)) {
    const groups = expandIpv6(target.host)
    return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x04]), groups, port])
  }
  // A name, not an address: the proxy resolves it, so local DNS never sees the
  // target and a poisoned local resolver cannot redirect the tunnel.
  const name = Buffer.from(target.host, 'utf8').subarray(0, 255)
  return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, port])
}

function expandIpv6(address) {
  const [head, tail] = address.split('::')
  const left = head === '' ? [] : head.split(':')
  const right = tail === undefined || tail === '' ? [] : tail.split(':')
  const fill = new Array(Math.max(0, 8 - left.length - right.length)).fill('0')
  return Buffer.from([...left, ...fill, ...right].map(part => Number.parseInt(part || '0', 16)).flatMap(value => [value >> 8, value & 0xff]))
}
