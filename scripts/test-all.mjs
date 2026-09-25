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
import { spawnSync } from 'node:child_process'
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
  ['effort', 'effort-test.mjs', []],
  ['sniff', 'sniff-test.mjs', []],
  ['truncation', 'truncation-test.mjs', []],
  ['retry-safety', 'retry-safety-test.mjs', []],
  ['speed-stat', 'speed-stat-test.mjs', []],
  ['picker', 'picker-test.mjs', []],
  ['tui', 'tui-test.mjs', []],
].filter(([name]) => only === null || name.startsWith(only))

const results = []
for (const [name, script, args] of suites) {
  const started = Date.now()
  const run = spawnSync(process.execPath, [path.join(scriptsDir, script), ...args], { encoding: 'utf8', timeout: 180_000 })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trimEnd().split('\n')
  const ok = run.status === 0
  results.push({ name, ok, ms: Date.now() - started, output })
  const tail = output.filter(line => /^(FAIL|✗|Error|error:)/.test(line.trim())).slice(0, 6)
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(14)} ${String(Date.now() - started).padStart(5)} ms`)
  if (!ok) for (const line of tail.length > 0 ? tail : output.slice(-6)) console.log(`       ${line}`)
}

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} suites passed${failed.length > 0 ? ` — ${failed.map(f => f.name).join(', ')} failed` : ''}`)
process.exitCode = failed.length === 0 ? 0 : 1
