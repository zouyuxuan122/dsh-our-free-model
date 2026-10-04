/**
 * Tests for the egress proxy (src/proxy.js) and the credential sealing it
 * depends on (src/secret.js).
 *
 * Everything here is offline: the proxy, the SOCKS5 server and the origin are
 * local stand-ins, so the suite needs no network and spends no lane quota. The
 * one hop those stand-ins cannot cover is TLS to the target, because that needs
 * a certificate the target's own CA signed — `--live` runs that hop against
 * https://opencode.ai through the same local proxy. It is opt-in, like
 * host-selftest.mjs, because it needs the public internet.
 *
 * The property that matters most is the boring one: with no proxy configured,
 * `egressFetch` must be indistinguishable from `fetch`. Several checks below
 * exist only to prove the passthrough, because a regression there would take
 * the whole plugin down for every user who never turns this on.
 *
 * Run: node scripts/proxy-test.mjs [--live]
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'

import {
  DEFAULT_BYPASS, configureEgress, disposeEgress, egressFetch, egressStatus,
  isBypassed, parseProxyUrl, redactProxy, splitBypass,
} from '../src/proxy.js'
import { openSecret, sealSecret, secretBackend } from '../src/secret.js'

const live = process.argv.includes('--live')

let failures = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL  ${name} — ${error.message}`)
  }
}

// ── stand-ins ────────────────────────────────────────────────────────────────

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function startOrigin() {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/json' })
      res.end()
      return
    }
    if (req.url === '/empty') {
      res.writeHead(204)
      res.end()
      return
    }
    if (req.url === '/slow') {
      setTimeout(() => { res.writeHead(200); res.end('late') }, 2000)
      return
    }
    if (req.url === '/echo') {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          method: req.method,
          body: Buffer.concat(chunks).toString('utf8'),
          contentLength: req.headers['content-length'] ?? '',
          acceptEncoding: req.headers['accept-encoding'] ?? '',
        }))
      })
      return
    }
    if (req.url === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      let n = 0
      const timer = setInterval(() => {
        n += 1
        res.write(`data: ${n}\n\n`)
        if (n === 5) { clearInterval(timer); res.end() }
      }, 5)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  return listen(server).then(port => ({ server, port }))
}

/** A minimal HTTP CONNECT proxy. `seen` records what actually left through it. */
function startConnectProxy({ auth = '' } = {}) {
  const seen = []
  const server = http.createServer((req, res) => { res.writeHead(405); res.end() })
  server.on('connect', (req, clientSocket, head) => {
    seen.push({ target: String(req.url ?? ''), authorization: String(req.headers['proxy-authorization'] ?? '') })
    if (auth !== '' && req.headers['proxy-authorization'] !== `Basic ${Buffer.from(auth).toString('base64')}`) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
      clientSocket.destroy()
      return
    }
    const split = String(req.url ?? '').lastIndexOf(':')
    const host = String(req.url ?? '').slice(0, split)
    const port = Number(String(req.url ?? '').slice(split + 1))
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection established\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  return listen(server).then(port => ({ server, port, seen }))
}

/** A minimal SOCKS5 server: no-auth or username/password, name and IPv4 targets. */
function startSocks5({ username = '', password = '' } = {}) {
  const seen = []
  const requireAuth = username !== '' || password !== ''
  const server = net.createServer(socket => {
    let stage = 'greeting'
    let buffer = Buffer.alloc(0)
    const reply = bytes => socket.write(Buffer.from(bytes))
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (stage === 'greeting') {
          if (buffer.length < 2) return
          const count = buffer[1]
          if (buffer.length < 2 + count) return
          const methods = [...buffer.subarray(2, 2 + count)]
          buffer = buffer.subarray(2 + count)
          if (requireAuth && !methods.includes(0x02)) { reply([0x05, 0xff]); socket.end(); return }
          stage = requireAuth ? 'auth' : 'request'
          reply([0x05, requireAuth ? 0x02 : 0x00])
          continue
        }
        if (stage === 'auth') {
          if (buffer.length < 2) return
          const ulen = buffer[1]
          if (buffer.length < 3 + ulen) return
          const user = buffer.subarray(2, 2 + ulen).toString('utf8')
          const plen = buffer[2 + ulen]
          if (buffer.length < 3 + ulen + plen) return
          const pass = buffer.subarray(3 + ulen, 3 + ulen + plen).toString('utf8')
          buffer = buffer.subarray(3 + ulen + plen)
          if (user !== username || pass !== password) { reply([0x01, 0x01]); socket.end(); return }
          reply([0x01, 0x00])
          stage = 'request'
          continue
        }
        if (buffer.length < 4) return
        const atyp = buffer[3]
        let host = ''
        let offset = 4
        if (atyp === 0x01) {
          if (buffer.length < 10) return
          host = [...buffer.subarray(4, 8)].join('.')
          offset = 8
        } else if (atyp === 0x03) {
          if (buffer.length < 5) return
          const length = buffer[4]
          if (buffer.length < 7 + length) return
          host = buffer.subarray(5, 5 + length).toString('utf8')
          offset = 5 + length
        } else {
          reply([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
          socket.end()
          return
        }
        const port = buffer.readUInt16BE(offset)
        buffer = buffer.subarray(offset + 2)
        seen.push({ host, port })
        stage = 'tunnel'
        socket.removeListener('data', onData)
        const upstream = net.connect(port, host, () => {
          reply([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
          socket.pipe(upstream)
          upstream.pipe(socket)
        })
        upstream.on('error', () => { reply([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]); socket.end() })
        socket.on('error', () => upstream.destroy())
        return
      }
    }
    socket.on('data', onData)
    socket.on('error', () => {})
  })
  return listen(server).then(port => ({ server, port, seen }))
}

const closeAll = (...servers) => Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))

// ── address parsing ──────────────────────────────────────────────────────────

await check('a bare host:port is read as an HTTP proxy', () => {
  const parsed = parseProxyUrl('127.0.0.1:7890')
  assert.equal(parsed.ok, true)
  assert.deepEqual(
    [parsed.scheme, parsed.host, parsed.port, parsed.username, parsed.password],
    ['http', '127.0.0.1', 7890, '', ''],
  )
})

await check('all three dialects parse, with and without credentials', () => {
  const http1 = parseProxyUrl('http://user:pa%40ss@1.2.3.4:8888')
  assert.deepEqual([http1.scheme, http1.username, http1.password, http1.port], ['http', 'user', 'pa@ss', 8888])
  const secure = parseProxyUrl('https://1.2.3.4:8443')
  assert.deepEqual([secure.scheme, secure.port], ['https', 8443])
  const socks = parseProxyUrl('socks5://u:p@1.2.3.4:1080')
  assert.deepEqual([socks.scheme, socks.username, socks.password], ['socks5', 'u', 'p'])
  assert.equal(parseProxyUrl('socks5h://1.2.3.4:1080').scheme, 'socks5h')
})

await check('scheme defaults and bracket handling are sane', () => {
  assert.equal(parseProxyUrl('http://1.2.3.4').port, 8080)
  assert.equal(parseProxyUrl('https://1.2.3.4').port, 443)
  assert.equal(parseProxyUrl('socks5://1.2.3.4').port, 1080)
  assert.equal(parseProxyUrl('socks5://[::1]:1080').host, '::1')
})

await check('unusable addresses are refused with a reason', () => {
  assert.equal(parseProxyUrl('').ok, false)
  assert.equal(parseProxyUrl('ftp://1.2.3.4:21').ok, false)
  assert.match(parseProxyUrl('ftp://1.2.3.4:21').error, /不支持的代理协议/)
  assert.equal(parseProxyUrl('http://1.2.3.4:99999').ok, false)
  assert.equal(parseProxyUrl('http://:8080').ok, false)
})

await check('a password never survives into an error message', () => {
  assert.equal(redactProxy('http://user:s3cret@1.2.3.4:8888'), 'http://***@1.2.3.4:8888')
  assert.equal(redactProxy('user:s3cret@1.2.3.4:8888'), '***@1.2.3.4:8888')
  assert.equal(redactProxy('http://1.2.3.4:8888'), 'http://1.2.3.4:8888')
  assert.equal(parseProxyUrl('ftp://user:s3cret@1.2.3.4').error.includes('s3cret'), false)
})

await check('bypass rules cover exact hosts, subdomains, suffixes and *', () => {
  assert.equal(isBypassed('a.com', ['a.com']), true)
  assert.equal(isBypassed('x.a.com', ['a.com']), true)
  assert.equal(isBypassed('x.a.com', ['.a.com']), true)
  assert.equal(isBypassed('a.com', ['.a.com']), true)
  assert.equal(isBypassed('nota.com', ['a.com']), false)
  assert.equal(isBypassed('anything', ['*']), true)
  assert.equal(isBypassed('127.0.0.1', splitBypass(DEFAULT_BYPASS)), true)
  assert.equal(isBypassed('[::1]', splitBypass(DEFAULT_BYPASS)), true)
  assert.equal(isBypassed('opencode.ai', []), false)
  assert.deepEqual(splitBypass('a.com, .b.com;c.com  d.com'), ['a.com', '.b.com', 'c.com', 'd.com'])
})

// ── credential sealing ───────────────────────────────────────────────────────

await check('a sealed password comes back unchanged', async () => {
  const record = await sealSecret('hunter2-秘密')
  assert.equal(record.scheme, secretBackend())
  assert.equal(await openSecret(record), 'hunter2-秘密')
})

await check('the stored record carries no plaintext', async () => {
  const record = await sealSecret('hunter2-秘密')
  const text = JSON.stringify(record)
  assert.equal(text.includes('hunter2'), false)
  assert.equal(text.includes('秘密'), false)
})

await check('an empty password seals to nothing', async () => {
  assert.equal(await sealSecret(''), null)
  assert.equal(await sealSecret(undefined), null)
})

await check('a record that cannot be opened reads as undefined, never as a crash', async () => {
  const record = await sealSecret('hunter2')
  const corrupted = record.scheme === 'windows-dpapi'
    ? { ...record, blob: 'AAAAAAAA' }
    : { ...record, data: Buffer.from('nope').toString('base64') }
  assert.equal(await openSecret(corrupted), undefined)
  assert.equal(await openSecret({ scheme: 'nonsense' }), undefined)
  assert.equal(await openSecret({ scheme: 'machine-aes', salt: 'x' }), undefined)
  assert.equal(await openSecret(null), undefined)
  assert.equal(await openSecret('not a record'), undefined)
})

// ── the passthrough that must not regress ────────────────────────────────────

const origin = await startOrigin()
const connectProxy = await startConnectProxy()

await check('with no proxy configured, requests never touch a proxy', async () => {
  disposeEgress()
  const response = await egressFetch(`http://127.0.0.1:${origin.port}/json`)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).ok, true)
  assert.equal(connectProxy.seen.length, 0)
})

await check('a configured but disabled proxy is also a passthrough', async () => {
  await configureEgress({ enabled: false, url: `http://127.0.0.1:${connectProxy.port}`, bypass: '' })
  const response = await egressFetch(`http://127.0.0.1:${origin.port}/json`)
  assert.equal(response.status, 200)
  assert.equal(connectProxy.seen.length, 0)
  assert.equal(egressStatus().enabled, false)
})

// ── through a CONNECT proxy ──────────────────────────────────────────────────

const configured = await configureEgress({
  enabled: true,
  url: `http://127.0.0.1:${connectProxy.port}`,
  bypass: '',
})

await check('a usable configuration reports itself without a password', () => {
  assert.equal(configured.ok, true)
  assert.deepEqual([configured.record.enabled, configured.record.url], [true, `http://127.0.0.1:${connectProxy.port}`])
  const status = egressStatus()
  assert.deepEqual([status.enabled, status.host, status.port, status.scheme], [true, '127.0.0.1', connectProxy.port, 'http'])
  assert.equal(status.hasPassword, false)
  assert.equal(JSON.stringify(status).includes('password'), false)
})

await check('a request through a CONNECT proxy reaches the origin', async () => {
  const before = connectProxy.seen.length
  const response = await egressFetch(`http://127.0.0.1:${origin.port}/json`)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).ok, true)
  assert.equal(connectProxy.seen.length, before + 1)
  assert.equal(connectProxy.seen.at(-1).target, `127.0.0.1:${origin.port}`)
})

await check('the response body is a web stream the SSE reader can consume', async () => {
  const response = await egressFetch(`http://127.0.0.1:${origin.port}/stream`)
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    text += decoder.decode(value, { stream: true })
  }
  assert.equal(text, 'data: 1\n\ndata: 2\n\ndata: 3\n\ndata: 4\n\ndata: 5\n\n')
})

await check('a POST body gets a content-length and arrives intact', async () => {
  const payload = JSON.stringify({ hello: '世界' })
  const response = await egressFetch(`http://127.0.0.1:${origin.port}/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  })
  const echoed = await response.json()
  assert.equal(echoed.method, 'POST')
  assert.equal(echoed.body, payload)
  assert.equal(echoed.contentLength, String(Buffer.byteLength(payload)))
})

await check('no accept-encoding is advertised, so the origin sends plain bytes', async () => {
  const echoed = await (await egressFetch(`http://127.0.0.1:${origin.port}/echo`, { method: 'POST', body: 'x' })).json()
  assert.equal(echoed.acceptEncoding, '')
})

await check('a redirect is refused, the way redirect:"error" refuses one', async () => {
  await assert.rejects(
    egressFetch(`http://127.0.0.1:${origin.port}/redirect`),
    error => error instanceof TypeError && /redirect/.test(error.message),
  )
})

await check('a 204 has a null body and not an empty one', async () => {
  const response = await egressFetch(`http://127.0.0.1:${origin.port}/empty`)
  assert.equal(response.status, 204)
  assert.equal(response.body, null)
  assert.equal(response.ok, true)
})

await check('an aborted request rejects with AbortError, as fetch does', async () => {
  const controller = new AbortController()
  const pending = egressFetch(`http://127.0.0.1:${origin.port}/slow`, { signal: controller.signal })
  setTimeout(() => controller.abort(), 30)
  await assert.rejects(pending, error => error.name === 'AbortError')
})

await check('a bypassed host skips the proxy', async () => {
  await configureEgress({ enabled: true, url: `http://127.0.0.1:${connectProxy.port}`, bypass: '127.0.0.1' })
  const before = connectProxy.seen.length
  const response = await egressFetch(`http://127.0.0.1:${origin.port}/json`)
  assert.equal(response.status, 200)
  assert.equal(connectProxy.seen.length, before)
})

await check('an unusable address is refused and leaves the live config alone', async () => {
  const before = egressStatus()
  const result = await configureEgress({ enabled: true, url: 'ftp://1.2.3.4:21', bypass: '' })
  assert.equal(result.ok, false)
  assert.match(result.error, /不支持的代理协议/)
  assert.deepEqual(egressStatus().enabled, before.enabled)
})

// ── credentials ──────────────────────────────────────────────────────────────

const authProxy = await startConnectProxy({ auth: 'alice:s3cret' })

await check('a password in the URL is sent as Basic and never stored in the clear', async () => {
  const result = await configureEgress({
    enabled: true,
    url: `http://alice:s3cret@127.0.0.1:${authProxy.port}`,
    bypass: '',
  })
  assert.equal(result.ok, true)
  assert.equal(result.record.url, `http://alice@127.0.0.1:${authProxy.port}`)
  assert.equal(JSON.stringify(result.record).includes('s3cret'), false)
  assert.equal(egressStatus().hasPassword, true)
  const response = await egressFetch(`http://127.0.0.1:${origin.port}/json`)
  assert.equal(response.status, 200)
  assert.equal(authProxy.seen.at(-1).authorization, `Basic ${Buffer.from('alice:s3cret').toString('base64')}`)
})

await check('re-saving with a blank password field keeps the stored one', async () => {
  const stored = (await configureEgress({
    enabled: true,
    url: `http://alice:s3cret@127.0.0.1:${authProxy.port}`,
    bypass: '',
  })).record
  // This is exactly what the settings page posts back: the redacted URL and no
  // password field at all.
  const again = await configureEgress({ ...stored, password: '' })
  assert.equal(again.ok, true)
  assert.equal(again.record.url, stored.url)
  const response = await egressFetch(`http://127.0.0.1:${origin.port}/json`)
  assert.equal(response.status, 200)
  assert.equal(authProxy.seen.at(-1).authorization, `Basic ${Buffer.from('alice:s3cret').toString('base64')}`)
})

await check('clearPassword really clears it', async () => {
  const stored = (await configureEgress({
    enabled: true,
    url: `http://alice:s3cret@127.0.0.1:${authProxy.port}`,
    bypass: '',
  })).record
  const cleared = await configureEgress({ ...stored, clearPassword: true })
  assert.equal(cleared.ok, true)
  assert.equal(cleared.record.secret, null)
  assert.equal(egressStatus().hasPassword, false)
  await assert.rejects(egressFetch(`http://127.0.0.1:${origin.port}/json`))
})

await check('a password supplied out of band replaces the one in the URL', async () => {
  const result = await configureEgress({
    enabled: true,
    url: `http://alice@127.0.0.1:${authProxy.port}`,
    bypass: '',
    password: 's3cret',
  })
  assert.equal(result.ok, true)
  assert.equal(JSON.stringify(result.record).includes('s3cret'), false)
  const response = await egressFetch(`http://127.0.0.1:${origin.port}/json`)
  assert.equal(response.status, 200)
})

// ── SOCKS5 ───────────────────────────────────────────────────────────────────

const socks = await startSocks5()

await check('SOCKS5 without credentials tunnels by name', async () => {
  const result = await configureEgress({ enabled: true, url: `socks5://127.0.0.1:${socks.port}`, bypass: '' })
  assert.equal(result.ok, true)
  const response = await egressFetch(`http://127.0.0.1:${origin.port}/json`)
  assert.equal(response.status, 200)
  assert.deepEqual(socks.seen.at(-1), { host: '127.0.0.1', port: origin.port })
})

const socksAuth = await startSocks5({ username: 'bob', password: 'pw' })

await check('SOCKS5 with username/password completes the sub-negotiation', async () => {
  const result = await configureEgress({ enabled: true, url: `socks5://bob:pw@127.0.0.1:${socksAuth.port}`, bypass: '' })
  assert.equal(result.ok, true)
  assert.equal(result.record.url, `socks5://bob@127.0.0.1:${socksAuth.port}`)
  const response = await egressFetch(`http://127.0.0.1:${origin.port}/json`)
  assert.equal(response.status, 200)
})

await check('SOCKS5 with a wrong password fails with a clear message', async () => {
  await configureEgress({ enabled: true, url: `socks5://bob:wrong@127.0.0.1:${socksAuth.port}`, bypass: '' })
  await assert.rejects(egressFetch(`http://127.0.0.1:${origin.port}/json`), /SOCKS5 认证失败/)
})

await check('SOCKS5 that demands credentials it was not given says so', async () => {
  await configureEgress({ enabled: true, url: `socks5://127.0.0.1:${socksAuth.port}`, bypass: '' })
  await assert.rejects(egressFetch(`http://127.0.0.1:${origin.port}/json`), /拒绝了所有可用的认证方式/)
})

await check('a refused CONNECT surfaces as a request error', async () => {
  await configureEgress({ enabled: true, url: `http://alice:wrong@127.0.0.1:${authProxy.port}`, bypass: '' })
  await assert.rejects(egressFetch(`http://127.0.0.1:${origin.port}/json`), /CONNECT/)
})

// ── optional live hop ────────────────────────────────────────────────────────

if (live) {
  await check('live: TLS to opencode.ai through a local CONNECT proxy', async () => {
    await configureEgress({ enabled: true, url: `http://127.0.0.1:${connectProxy.port}`, bypass: '' })
    const response = await egressFetch('https://opencode.ai/')
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.ok(body.length > 1000, `expected a real page, got ${body.length} bytes`)
    assert.equal(connectProxy.seen.at(-1).target, 'opencode.ai:443')
  })
}

disposeEgress()
await closeAll(origin.server, connectProxy.server, authProxy.server, socks.server, socksAuth.server)

if (failures === 0) console.log(`proxy-test: OK${live ? ' (live)' : ''}`)
else { console.error(`proxy-test: ${failures} failure(s)`); process.exit(1) }
