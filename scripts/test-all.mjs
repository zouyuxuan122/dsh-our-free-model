/**
 * Run every offline suite in one command.
 *
 *     node scripts/test-all.mjs [--only <name>]
 *
 * These are the checks that need no network and spend no free-lane quota: each
 * one mounts the real module against a local stand-in. The live end-to-end run
 * against the gateway is separate and costs minutes and quota, so it stays a
 * deliberate act: `node scripts/host-selftest.mjs`.
 *
 * The manifest check is in here because shipping a manifest that disagrees with
 * the files it describes breaks the in-app upgrade for every user at once
 * (issue #1), and nothing else fails when that happens.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = fileURLToPath(new URL('.', import.meta.url))
const only = process.argv.indexOf('--only') === -1 ? null : process.argv[process.argv.indexOf('--only') + 1]

const suites = [
  ['manifest', 'build-manifest.mjs', ['--check']],
  ['release', 'release-e2e.mjs', []],
  ['client-lint', 'client-lint.mjs', []],
  ['trust', 'trust-test.mjs', []],
  ['sanitize', 'sanitize-test.mjs', []],
  ['feed', 'feed-test.mjs', []],
  ['updater', 'updater-test.mjs', []],
  ['forward', 'forward-test.mjs', []],
  ['proxy', 'proxy-test.mjs', []],
  ['proxy-host', 'proxy-host-test.mjs', []],
  ['effort', 'effort-test.mjs', []],
  ['projection', 'projection-test.mjs', []],
  ['fingerprint', 'fingerprint-test.mjs', []],
  ['sniff', 'sniff-test.mjs', []],
  ['truncation', 'truncation-test.mjs', []],
  ['recovery', 'recovery-test.mjs', []],
  ['retry-safety', 'retry-safety-test.mjs', []],
  ['speed-stat', 'speed-stat-test.mjs', []],
  ['picker', 'picker-test.mjs', []],
  ['tui', 'tui-test.mjs', []],
  ['catalog', 'catalog-test.mjs', []],
  ['offline', 'offline-test.mjs', []],
].filter(([name]) => only === null || name.startsWith(only))

if (only !== null && suites.length === 0) {
  console.error(`--only "${only}" selected no suite`)
  process.exit(1)
}

/**
 * A suite that hangs must leave enough output to identify where it stopped.
 *
 * One of these bound a fixed port, lost the race to a suite running beside it, and
 * then sat in a `fetch` whose socket nobody answered — three minutes of the
 * runner's own ceiling, after which it printed six `ok` lines as the "failure
 * detail" because buffered child output was unavailable. The deadline is well
 * above the slowest suite, and live output now identifies the last check seen.
 */
const SUITE_TIMEOUT_MS = 60_000

/**
 * Run a suite while forwarding its output as it arrives. Keeping the output
 * live is important here: a timeout kills the child before a buffered pipe can
 * be read, which used to erase the last check printed by recovery-test.mjs.
 */
function runSuite(script, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(scriptsDir, script), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let forceKillTimer
    let spawnError = null
    const started = Date.now()
    const forward = (stream, chunk) => {
      const text = chunk.toString()
      stream === 'stdout' ? stdout += text : stderr += text
      process[stream].write(text)
    }
    child.stdout.on('data', chunk => forward('stdout', chunk))
    child.stderr.on('data', chunk => forward('stderr', chunk))
    const deadline = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return
      timedOut = true
      child.kill()
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 500)
    }, SUITE_TIMEOUT_MS)
    child.once('error', error => {
      spawnError = error
    })
    child.once('close', (status, signal) => {
      clearTimeout(deadline)
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer)
      resolve({ error: spawnError, signal, status, stdout, stderr, ms: Date.now() - started, timedOut })
    })
  })
}

const results = []
for (const [name, script, args] of suites) {
  const run = await runSuite(script, args)
  const output = `${run.stdout}${run.stderr}`.trimEnd().split('\n')
  const hung = run.timedOut || run.error !== null || run.signal !== null
  const ok = !hung && run.status === 0
  results.push({ name, ok, ms: run.ms, output })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(14)} ${String(run.ms).padStart(5)} ms`)
  if (!ok) {
    if (run.timedOut) console.log(`       killed at the ${SUITE_TIMEOUT_MS / 1000}s deadline — the live output above is the last diagnostic from the suite`)
    else if (hung) console.log(`       never finished (${run.error?.message ?? `signal ${run.signal}`})`)
    const detail = output.filter(line => /^(FAIL|✗|Error|error:)/.test(line.trim())).slice(0, 6)
    for (const line of (detail.length > 0 ? detail : output.slice(-12))) console.log(`       ${line}`)
  }
}

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} suites passed${failed.length > 0 ? ` — ${failed.map(f => f.name).join(', ')} failed` : ''}`)
process.exitCode = failed.length === 0 ? 0 : 1
