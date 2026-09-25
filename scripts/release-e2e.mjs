/**
 * Does the release this repository actually describes install cleanly?
 *
 * `updater-test.mjs` verifies the upgrade *mechanism* against synthetic fixtures.
 * This asks the narrower and nastier question about the real `feed/manifest.json`
 * and the real files it names, because that pairing is the publisher's promise to
 * every installed user: a manifest whose byte count or digest disagrees with the
 * tree makes the in-app upgrade fail verification for all of them at once, and
 * nothing else in the build notices (issue #1).
 *
 * The negative control is what makes the pass mean something: a manifest that
 * lies about one file's size has to be refused, so a check that only ever
 * "verifies" nothing cannot slip through here.
 *
 * Local HTTP only — no network, no free-lane quota.
 *
 * Run: node scripts/release-e2e.mjs
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PluginUpdater } from '../src/updater.js'

const repo = fileURLToPath(new URL('..', import.meta.url))
const PREVIOUS = '1.2.1'
const manifestRaw = fs.readFileSync(path.join(repo, 'feed/manifest.json'))
const manifest = JSON.parse(manifestRaw.toString('utf8'))

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.log(`FAIL ${name} — ${error.message}`) }
}
const assert = (cond, message) => { if (!cond) throw new Error(message) }
const sha = body => crypto.createHash('sha256').update(body).digest('hex')

/** A stand-in for the installed copy: one release behind, with a stale file. */
function installedPackage(dir) {
  for (const item of ['index.js', 'client.js', 'package.json', 'icon.svg', 'src', 'locale']) {
    fs.cpSync(path.join(repo, item), path.join(dir, item), { recursive: true })
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  pkg.version = PREVIOUS
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  fs.writeFileSync(path.join(dir, 'client.js'), 'stale installed copy\n')
  return dir
}

/** Serve the repository the way GitHub does, so file URLs resolve beside it. */
let tampered = null
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(String(req.url ?? '').split('?')[0])
  if (url === '/feed/manifest.json') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(tampered ?? manifestRaw)
    return
  }
  const file = path.resolve(repo, `.${url}`)
  if (!file.startsWith(path.resolve(repo)) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
    return
  }
  res.writeHead(200, { 'content-type': 'application/octet-stream' })
  res.end(fs.readFileSync(file))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
server.unref()
const base = `http://127.0.0.1:${server.address().port}`

function updaterFor(pkgDir, dataDir) {
  fs.mkdirSync(dataDir, { recursive: true })
  return new PluginUpdater({
    pkgDir, dataDir,
    settings: () => ({ feedUrl: `${base}/feed/announcements.json` }),
    fetchImpl: fetch,
    // The published CDN sources stay out of a test run: only this server.
    defaultSources: [],
    log: () => {},
  })
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-release-'))
console.log(`manifest: version=${manifest.version}, ${manifest.files.length} files, ${manifest.files.reduce((sum, row) => sum + row.size, 0)} bytes`)

await check('the manifest describes the tree it lives in', () => {
  const drifted = manifest.files.filter(row => {
    const file = path.join(repo, row.path)
    if (!fs.existsSync(file)) return true
    const body = fs.readFileSync(file)
    return body.length !== row.size || sha(body) !== row.sha256
  })
  assert(drifted.length === 0, `drifted: ${drifted.map(row => row.path).join(', ')} — run: node scripts/build-manifest.mjs`)
})

await check('every shipped file is named by the manifest', () => {
  const named = new Set(manifest.files.map(row => row.path))
  // Anything the package publishes but the manifest omits would be installed
  // unverified, which is the mirror image of the issue #1 failure.
  const unverified = ['index.js', 'client.js', 'package.json'].filter(item => !named.has(item))
  assert(unverified.length === 0, `not covered: ${unverified.join(', ')}`)
})

await check('an older installed copy is offered this release', async () => {
  const pkgDir = installedPackage(path.join(scratch, 'a', 'node_modules', 'dsh-our-free-model'))
  const status = await updaterFor(pkgDir, path.join(scratch, 'a', 'dsh-home')).check()
  assert(status.available === true, `not offered: ${JSON.stringify(status)}`)
  assert(status.latest === manifest.version, `latest ${status.latest} != ${manifest.version}`)
  assert(status.current === PREVIOUS, `current read as ${status.current}`)
})

await check('applying it installs every real file and the digests match', async () => {
  const pkgDir = installedPackage(path.join(scratch, 'b', 'node_modules', 'dsh-our-free-model'))
  const dataDir = path.join(scratch, 'b', 'dsh-home')
  await updaterFor(pkgDir, dataDir).apply({ version: manifest.version })
  const installed = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  assert(installed.version === manifest.version, `installed ${installed.version}, wanted ${manifest.version}`)
  assert(fs.readFileSync(path.join(pkgDir, 'client.js'), 'utf8').length > 1000, 'the stale file was not replaced')
  for (const row of manifest.files) {
    const file = path.join(pkgDir, row.path)
    assert(fs.existsSync(file), `${row.path} did not arrive`)
    const body = fs.readFileSync(file)
    assert(body.length === row.size, `${row.path}: ${body.length} bytes installed, manifest promised ${row.size}`)
    assert(sha(body) === row.sha256, `${row.path}: installed digest differs from the manifest`)
  }
  const history = JSON.parse(fs.readFileSync(path.join(dataDir, 'updates.json'), 'utf8'))
  const rows = Array.isArray(history) ? history : (history.applied ?? [])
  assert(rows.length > 0 && JSON.stringify(rows.at(-1)).includes(manifest.version), 'the upgrade was not recorded in updates.json')
  console.log(`     ${manifest.files.length} files re-hashed off disk and matched`)
})

await check('NEGATIVE CONTROL: a manifest that lies about one byte is refused', async () => {
  const bad = JSON.parse(manifestRaw.toString('utf8'))
  bad.version = '9.9.9'
  bad.files[0] = { ...bad.files[0], size: bad.files[0].size + 1 }
  const pkgDir = installedPackage(path.join(scratch, 'c', 'node_modules', 'dsh-our-free-model'))
  const dataDir = path.join(scratch, 'c', 'dsh-home')
  tampered = Buffer.from(JSON.stringify(bad))
  let error
  try { await updaterFor(pkgDir, dataDir).apply({ version: '9.9.9' }) } catch (reason) { error = reason }
  tampered = null
  assert(error !== undefined, 'the upgrade SUCCEEDED against a lying manifest — verification is not happening')
  assert(/size \d+ != manifest \d+/.test(String(error?.message)), `refused for the wrong reason: ${error?.message}`)
  const after = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  assert(after.version === PREVIOUS, `the bad release was installed anyway (${after.version})`)
  console.log(`     refused as designed: ${String(error.message).slice(0, 74)}…`)
})

server.close()
fs.rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0
  ? '\nrelease-e2e: this repository would upgrade an installed user cleanly'
  : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
