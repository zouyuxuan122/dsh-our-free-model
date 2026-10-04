/**
 * The exit proxy as the settings API sees it.
 *
 * `proxy-test.mjs` proves the tunnel. This proves the wiring around it, which is
 * where a password can actually escape: the settings route parses the address,
 * seals the password, stores the record, installs the tunnel and hands the page
 * a view with no password in it. A tunnel that works and a settings file that
 * leaks the credential would still be the bug this feature must not ship, and
 * only a route-level test sees the difference.
 *
 * Everything here is local. The "proxy" is a CONNECT listener in this process
 * that refuses any target but the stand-in origin, so the boot-time probe and
 * the egress watch fail fast instead of reaching the network, and no request
 * leaves the box.
 *
 * Run: node scripts/proxy-host-test.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { callRoute, fakeContext, until } from './lib/fake-kernel.mjs'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}
const checkThat = (name, ok) => check(name, ok === true, true)

/** A port that answers nothing, forever: the honest stand-in for "no gateway". */
const dead = http.createServer()
await new Promise(resolve => dead.listen(0, '127.0.0.1', resolve))
process.env.OUR_FREE_MODEL_BASE = `http://127.0.0.1:${dead.address().port}`
await new Promise(resolve => dead.close(resolve))

const { apply, inject } = await import('../index.js')
const { egressFetch, egressStatus } = await import('../src/proxy.js')

// ── the stand-in origin the tunnel is allowed to reach ───────────────────────
const origin = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ reached: true }))
})
await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve))
const originPort = origin.address().port

// ── a CONNECT proxy that records every tunnel it is asked to open ────────────
const seen = []
const proxy = http.createServer((req, res) => {
  res.writeHead(405, { connection: 'close' })
  res.end()
})
proxy.on('connect', (req, clientSocket, head) => {
  const target = String(req.url)
  seen.push({ target, authorization: String(req.headers['proxy-authorization'] ?? '') })
  const [host, port] = target.split(':')
  // Anything but the stand-in origin is refused, so the plugin's own egress
  // probe cannot leave the machine and fails in milliseconds rather than in the
  // eight seconds each of its three sources would otherwise take.
  if (host !== '127.0.0.1' && host !== 'localhost') {
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    return
  }
  const upstream = net.connect(Number(port), host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head !== undefined && head.length > 0) upstream.write(head)
    upstream.pipe(clientSocket)
    clientSocket.pipe(upstream)
  })
  upstream.on('error', () => clientSocket.destroy())
  clientSocket.on('error', () => upstream.destroy())
})
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
const proxyPort = proxy.address().port

const originTunnels = () => seen.filter(entry => entry.target === `127.0.0.1:${originPort}`)
const throughOrigin = async () => {
  const response = await egressFetch(`http://127.0.0.1:${originPort}/json`)
  return response.json()
}

/** Boot one plugin generation against its own scratch home. */
function boot() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-proxy-host-'))
  process.env.DSH_HOME = home
  const routes = []
  const ctx = fakeContext({ inject, mounted: ['llm', 'webServer', 'attachments'], onRegister: route => routes.push(route) })
  apply(ctx, {})
  return { ctx, home, api: () => routes.find(route => route.kind === 'prefix')?.handler }
}

const { ctx, home, api } = boot()
await until(() => api() !== undefined, { what: 'the settings API route', timeoutMs: 5000 })
const dataDir = path.join(home, 'our-free-model')
const settingsFile = path.join(dataDir, 'settings.json')
const readSettings = () => fs.readFileSync(settingsFile, 'utf8')

// ── 1. the default is honest: no proxy, nothing to protect ───────────────────
{
  const summary = await callRoute(api(), 'GET', '/api/our-free-model/summary')
  check('the settings page is told there is no proxy', summary.json.settings.proxy, {
    enabled: false, url: '', bypass: 'localhost, 127.0.0.1, ::1',
    hasPassword: false, active: false, scheme: '', host: '', port: 0,
    secretScheme: '', secretUnreadable: false, backend: process.platform === 'win32' ? 'windows-dpapi' : 'machine-aes',
  })
}

// ── 2. saving an address seals the password and reports no password back ─────
const address = `http://alice:s3cret-pw@127.0.0.1:${proxyPort}`
{
  const saved = await callRoute(api(), 'POST', '/api/our-free-model/settings', { proxy: { enabled: true, url: address, bypass: '' } })
  check('the address is accepted', saved.status, 200)
  checkThat('the answer carries no password', !JSON.stringify(saved.json).includes('s3cret-pw'))
  checkThat('the stored url carries no password', !String(saved.json.settings.proxy.url).includes('s3cret-pw'))
  check('the stored url keeps the username', saved.json.settings.proxy.url, `http://alice@127.0.0.1:${proxyPort}`)
  check('the page is told a password is on file', saved.json.settings.proxy.hasPassword, true)
  check('and that the tunnel is live', saved.json.settings.proxy.active, true)
  check('with the address it parsed', [saved.json.settings.proxy.scheme, saved.json.settings.proxy.host, saved.json.settings.proxy.port], ['http', '127.0.0.1', proxyPort])
  check('the password is sealed, not stored', saved.json.settings.proxy.secretScheme, process.platform === 'win32' ? 'windows-dpapi' : 'machine-aes')
}

// ── 3. the file on disk has no plaintext anywhere in it ─────────────────────
{
  const raw = readSettings()
  checkThat('settings.json holds no plaintext password', !raw.includes('s3cret-pw'))
  checkThat('and no plaintext secret field', !/"password"/.test(raw))
}

// ── 4. the tunnel the route installed is the one requests use ───────────────
{
  check('the origin answers through the tunnel', await throughOrigin(), { reached: true })
  const tunnels = originTunnels()
  check('the request really went through the proxy', tunnels.length, 1)
  check('with the credentials the address named', tunnels[0]?.authorization, `Basic ${Buffer.from('alice:s3cret-pw').toString('base64')}`)
}

// ── 5. a blank password field keeps the stored one ─────────────────────────
{
  const again = await callRoute(api(), 'POST', '/api/our-free-model/settings', { proxy: { enabled: true, url: `http://alice@127.0.0.1:${proxyPort}`, bypass: '' } })
  check('re-saving without a password is accepted', again.status, 200)
  check('and keeps the password on file', again.json.settings.proxy.hasPassword, true)
  check('the origin still answers', await throughOrigin(), { reached: true })
  check('still with credentials', originTunnels()[1]?.authorization, `Basic ${Buffer.from('alice:s3cret-pw').toString('base64')}`)
}

// ── 6. clearing is explicit, and it really clears ──────────────────────────
{
  const cleared = await callRoute(api(), 'POST', '/api/our-free-model/settings', { proxy: { clearPassword: true } })
  check('clearing the password is accepted', cleared.status, 200)
  check('and the page is told there is none', cleared.json.settings.proxy.hasPassword, false)
  check('the tunnel still works without it', await throughOrigin(), { reached: true })
  // The username stays: it is part of the address the user typed and it is shown
  // on the page, so what goes on the wire is that address and an empty password —
  // the same thing curl sends for `http://alice@host:port`. What must be gone is
  // the secret, and the base64 below decodes to `alice:`.
  check('and sends the address without the secret', originTunnels()[2]?.authorization, `Basic ${Buffer.from('alice:').toString('base64')}`)
  checkThat('settings.json still holds no plaintext', !readSettings().includes('s3cret-pw'))
}

// ── 7. a bad address is refused without disturbing the live tunnel ──────────
{
  const refused = await callRoute(api(), 'POST', '/api/our-free-model/settings', { proxy: { enabled: true, url: 'ftp://nope:1', bypass: '' } })
  check('an unusable address is a 400', refused.status, 400)
  checkThat('and the reason is shown', typeof refused.json.error === 'string' && refused.json.error.length > 0)
  const live = egressStatus()
  check('the live tunnel is untouched', [live.enabled, live.host, live.port], [true, '127.0.0.1', proxyPort])
  check('and the page still reads the good address', (await callRoute(api(), 'GET', '/api/our-free-model/summary')).json.settings.proxy.url, `http://alice@127.0.0.1:${proxyPort}`)
}

// ── 8. a reachability check answers, it does not throw ─────────────────────
{
  const test = await callRoute(api(), 'POST', '/api/our-free-model/proxy/test')
  check('the probe route answers', test.status, 200)
  // Every echo source is off-box and this proxy refuses them, so the honest
  // answer here is "no", and it has to arrive as a value rather than a 500.
  check('and says the exit could not be named', test.json.ok, false)
  check('with no address to report', test.json.egress, null)
}

// ── 9. switching the proxy off puts requests back on the direct path ───────
{
  const off = await callRoute(api(), 'POST', '/api/our-free-model/settings', { proxy: { enabled: false } })
  check('the proxy can be switched off', off.status, 200)
  check('and the page says so', off.json.settings.proxy.active, false)
  const before = originTunnels().length
  check('the origin still answers', await throughOrigin(), { reached: true })
  check('without opening a tunnel this time', originTunnels().length, before)
}

for (const disposer of ctx.__disposers.reverse()) {
  try { disposer() } catch { /* a suite tearing down must not fail on teardown */ }
}
await new Promise(resolve => proxy.close(resolve))
await new Promise(resolve => origin.close(resolve))
fs.rmSync(home, { recursive: true, force: true })

if (failures === 0) console.log('proxy-host-test: OK')
else {
  console.error(`proxy-host-test: ${failures} failure(s)`)
  process.exit(1)
}
