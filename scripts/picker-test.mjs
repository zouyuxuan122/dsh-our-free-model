/**
 * What the model picker is allowed to advertise.
 *
 * Issue #3: a model the gateway names in `/zen/v1/models` but refuses to route
 * at all still appeared in the picker, so picking it spent a turn on a
 * guaranteed failure. The probe already knew — the settings page said 暂不可用 —
 * but `computeMembership` only ever separated the region-gated ones and left
 * every other verdict on the main route.
 *
 * These checks mount the real Host half against a gateway stand-in that hands
 * out one scripted verdict per model, and read the picker's own three surfaces:
 * `listModels`, the model-discovery callback, and the settings summary.
 *
 * Run: node scripts/picker-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chatFrames, callRoute, fakeContext, stubUpstream, until } from './lib/fake-kernel.mjs'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

const LISTING = [
  'mimo-v2.6-flash-free', 'space-bunny-free', 'deepseek-v4-flash-free',
  'jev-1.13-free', 'ling-3.0-flash-fin-free', 'nemotron-3-ultra-free',
  'nemotron-3.5-lightning-free', 'muse-spark-1.3-contributor-free',
]

/** One answer per model, standing in for what the lane really does. */
function verdict(id) {
  if (id === 'deepseek-v4-flash-free') {
    return { status: 400, body: JSON.stringify({ error: { type: 'ModelError', message: 'Model is unavailable.' } }) }
  }
  // Named by the listing, no route for it at all: the message says the id, and
  // so does the status.
  if (id === 'jev-1.13-free') return { status: 404, body: JSON.stringify({ error: { message: 'No such model: jev-1.13-free' } }) }
  // The gateway's own trouble, which is not a fact about the model.
  if (id === 'ling-3.0-flash-fin-free') return { status: 500, body: JSON.stringify({ error: { message: 'Internal server error' } }) }
  if (id === 'nemotron-3-ultra-free') {
    return { status: 429, body: JSON.stringify({ error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached' } }) }
  }
  if (id === 'muse-spark-1.3-contributor-free') {
    return { status: 403, body: JSON.stringify({ error: { type: 'RegionError', message: 'This model is not available in your country.' } }) }
  }
  if (id === 'nemotron-3.5-lightning-free') return { socket: true } // no answer at all: the probe learns nothing
  // Held by the test itself, so the "in the catalog, not yet probed" state can be
  // read as long as the test likes rather than racing a clock.
  if (id === 'union-alpha') return { wait: gate.promise, body: chatFrames() }
  return { body: chatFrames() }
}

const stub = await stubUpstream({ listing: LISTING, answer: verdict })
process.env.OUR_FREE_MODEL_BASE = stub.base
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-picker-'))
process.env.DSH_HOME = scratch

const { apply, inject } = await import('../index.js')
const routes = []
const ctx = fakeContext({ inject, onRegister: route => routes.push(route) })
apply(ctx, {})

const { ROUTE_MAIN, ROUTE_REGION } = await import('../src/adapter.js')
const adapter = ctx.__captured.adapters[0]?.adapter
if (adapter === undefined) {
  console.log('FAIL the plugin never registered an adapter\n' + ctx.__logs.join('\n'))
  process.exit(1)
}

/** The prefix handler the plugin mounted on the fake web server. */
const api = () => routes.find(route => route.kind === 'prefix')?.handler
await until(() => api() !== undefined, { what: 'the settings API route' })

const ids = models => models.map(model => model.id)
const advertised = async route => ids(await adapter.listModels(route))

// Every probe in the round has to have landed before the verdicts mean anything.
await until(() => {
  const store = JSON.parse(fs.readFileSync(path.join(scratch, 'our-free-model', 'availability.json'), 'utf8'))
  return Object.keys(store.results ?? {}).length >= LISTING.length && store.at > 0
}, { what: 'a full probe round' }).catch(error => {
  console.log(`FAIL ${error.message}\nlogs: ${ctx.__logs.join(' | ')}\nrequests seen by the stub: ${stub.requests.length}`)
  process.exit(1)
})

check('a refused model leaves the picker', (await advertised(ROUTE_MAIN)).includes('deepseek-v4-flash-free'), false)
check('and so does one the listing names but no route answers for', (await advertised(ROUTE_MAIN)).includes('jev-1.13-free'), false)
check('a working model stays', (await advertised(ROUTE_MAIN)).includes('mimo-v2.6-flash-free'), true)
check('the gateway having trouble is not a verdict about the model',
  (await advertised(ROUTE_MAIN)).includes('ling-3.0-flash-fin-free'), true)
check('a quota refusal keeps its model: the next window may answer', (await advertised(ROUTE_MAIN)).includes('nemotron-3-ultra-free'), true)
check('a probe that got no answer keeps its model: that is not a verdict',
  (await advertised(ROUTE_MAIN)).includes('nemotron-3.5-lightning-free'), true)
check('region-gated models move to their own route', await advertised(ROUTE_REGION), ['muse-spark-1.3-contributor-free'])

// A catalog entry with no verdict at all is the ordinary state of a fresh install
// (no probe history until the boot round lands) and of a model the listing just
// added. It has to read as "not knowing", which is not the same as "refused" —
// and reading it as a verdict used to throw on the spot.
const verdicts = JSON.parse(fs.readFileSync(path.join(scratch, 'our-free-model', 'availability.json'), 'utf8')).results
check('the probe did leave a verdict for every model it saw', Object.keys(verdicts).length, LISTING.length)

// Grow the roster while a refresh round is in flight: `union-alpha` enters the
// catalog with the listing response, and its probe answer is held by the gate
// below until the test is done looking. This is the state of every fresh install
// before the first round lands, and of every model upstream has just added — and
// reading it used to throw `Cannot read properties of undefined (reading state)`
// out of `computeMembership`, which took the picker down with it.
const gate = Promise.withResolvers()
stub.api.setListing([...LISTING, 'union-alpha'])
const round = ctx.__captured.discovery()
let midRoundError = null
let midRoundModels = null
await until(async () => {
  try {
    const models = await adapter.listModels(ROUTE_MAIN)
    if (!models.some(model => model.id === 'union-alpha')) return false
    midRoundModels = models
    return true
  } catch (error) {
    if (midRoundError === null) midRoundError = error
    throw error
  }
}, { what: 'the newly listed model to be advertised while its probe is still held', timeoutMs: 5000 }).catch(() => {})
check('no read throws while a verdict is missing', midRoundError?.message ?? 'none', 'none')
check('and the new model is advertised in that window', midRoundModels !== null, true)
check('and the picker keeps the models that do have verdicts', (await advertised(ROUTE_MAIN)).includes('mimo-v2.6-flash-free'), true)
const midRoundRow = (await callRoute(api(), 'GET', '/api/our-free-model/summary')).json.catalog
  .find(row => row.id === 'union-alpha')
check('the settings page says it has not been probed', midRoundRow?.availability, 'unknown')
check('rather than a verdict it does not have', midRoundRow?.detail ?? '', '')
gate.resolve()
await round
check('once the round lands it carries a verdict',
  (await callRoute(api(), 'GET', '/api/our-free-model/summary')).json.catalog
    .find(row => row.id === 'union-alpha')?.availability, 'available')
stub.api.setListing(LISTING)

const discovered = ids(await ctx.__captured.discovery())
check('model discovery offers what the picker advertises, nothing more',
  discovered.sort(), [...await advertised(ROUTE_MAIN), ...await advertised(ROUTE_REGION)].sort())

const summary = await callRoute(api(), 'GET', '/api/our-free-model/summary')
const rowOf = id => summary.json.catalog.find(row => row.id === id)
check('the roster still lists the hidden model, with its verdict', [rowOf('jev-1.13-free').route, rowOf('jev-1.13-free').availability], [null, 'unavailable'])
check('the refusal is on record for the user to read', /No such model/.test(rowOf('jev-1.13-free').detail), true)
check('and the picker positions of the working models are named', rowOf('mimo-v2.6-flash-free').route, ROUTE_MAIN)
check('a reasoning model carries the rung ladder it will really send',
  rowOf('mimo-v2.6-flash-free').budgets.map(row => `${row.id}:${row.tokens}`), ['light:4096', 'balanced:16384', 'deep:32768'])
check('a model with no effort menu carries no ladder to mislead with', rowOf('jev-1.13-free').budgets, undefined)

// The effort menu the composer shows has to print the same number, or it is the
// issue-#2 mismatch wearing a different hat.
const menu = async id => (await adapter.resolveModel(ROUTE_MAIN, id))?.reasoning?.efforts ?? []
const mimoMenu = await menu('mimo-v2.6-flash-free')
check('the thinking-always-on menu states the doubled ceiling it will send',
  mimoMenu.map(row => row.description.match(/^(\d+) K/)?.[1]), ['4', '16', '32'])
check('and says out loud that thinking cannot be switched off here',
  mimoMenu.every(row => /cannot be switched off/.test(row.description)), true)
const museMenu = await menu('muse-spark-1.3-contributor-free')
check('a model that can think nothing at all keeps the published rungs',
  museMenu.map(row => row.description.match(/^(\d+) K/)?.[1]), ['2', '8', '32'])
check('without the always-thinking clause', museMenu.every(row => !/cannot be switched off/.test(row.description)), true)

// Turning the region group off hides those models rather than listing them as broken.
await callRoute(api(), 'POST', '/api/our-free-model/settings', { exposeRegionModels: false })
check('withhold-region hides them from the region route', await advertised(ROUTE_REGION), [])
check('and from the main route too', (await advertised(ROUTE_MAIN)).includes('muse-spark-1.3-contributor-free'), false)
await callRoute(api(), 'POST', '/api/our-free-model/settings', { exposeRegionModels: true })

// The round where the lane itself is down: every model reads as refused.
stub.api.refuseAll = true
await callRoute(api(), 'POST', '/api/our-free-model/reprobe')
check('a lane-wide failure never empties the picker', (await advertised(ROUTE_MAIN)).length > 0, true)
check('it keeps the refused models rather than dropping them', (await advertised(ROUTE_MAIN)).includes('deepseek-v4-flash-free'), true)
check('and says so in the log', ctx.__logs.some(line => line.includes('refused all')), true)

stub.api.refuseAll = false
await callRoute(api(), 'POST', '/api/our-free-model/reprobe')
check('the next honest round hides them again', (await advertised(ROUTE_MAIN)).includes('deepseek-v4-flash-free'), false)

for (const dispose of ctx.__disposers.reverse()) dispose()
await stub.close()
fs.rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\npicker: only what this egress can use is offered' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
