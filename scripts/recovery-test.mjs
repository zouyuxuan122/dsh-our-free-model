/**
 * 纯推理 EOF 的有界续写回归：真实 Adapter、本地 HTTP、实际请求和流输出。
 * 运行：node scripts/recovery-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { callRoute, chatFrames, fakeContext, until } from './lib/fake-kernel.mjs'

let activeCase
let forwardScenario
const server = http.createServer((req, res) => {
  const pieces = []
  req.on('data', piece => pieces.push(piece))
  req.on('end', async () => {
    if (forwardScenario !== undefined && req.method === 'GET' && req.url === '/zen/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: forwardScenario.models.map(id => ({ id })) }))
      return
    }
    const body = JSON.parse(Buffer.concat(pieces).toString('utf8'))
    if (forwardScenario !== undefined && !JSON.stringify(body).includes(TASK)) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(chatFrames('healthy local boot probe'))
      return
    }
    const scenario = forwardScenario ?? activeCase
    const ordinal = scenario.requests.length
    scenario.requests.push({ body, path: req.url, headers: req.headers })
    scenario.responses.add(res)
    let released = false
    const release = () => {
      if (released) return
      released = true
      scenario.responses.delete(res)
      scenario.closed++
    }
    res.on('finish', release)
    res.on('close', release)
    const answer = scenario.answers[ordinal] ?? { status: 500, body: '{"error":{"message":"unexpected extra request"}}' }
    if (answer.socket) { req.destroy(); res.destroy(); return }
    res.writeHead(answer.status ?? 200, { 'content-type': answer.status ? 'application/json' : 'text/event-stream' })
    const send = () => {
      if (answer.hold) { res.write(answer.body ?? ': waiting\n\n'); return }
      res.end(answer.body ?? '')
    }
    if (answer.delayMs) {
      const timer = setTimeout(send, answer.delayMs)
      scenario.timers.push(timer)
    } else send()
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
server.unref()
process.env.OUR_FREE_MODEL_BASE = `http://127.0.0.1:${server.address().port}`

const { FreeModelAdapter, ROUTE_MAIN } = await import('../src/adapter.js')
const { buildCatalog } = await import('../src/catalog.js')
const { wireFor } = await import('../src/upstream.js')

const MODELS = [
  'mimo-v2.6-flash-free', 'mimo-v2.5-free', 'muse-spark-1.3-contributor-free',
  'muse-spark-1.2-contributor-free', 'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free',
  'ling-3.0-flash-fin-free', 'space-bunny-free', 'union-alpha', 'deepseek-v4-flash-free',
  'jev-1.13-free', 'future-provider-free',
]
const CATALOG = buildCatalog(MODELS)
const REPRESENTATIVES = ['mimo-v2.6-flash-free', 'muse-spark-1.3-contributor-free', 'union-alpha']
const TASK = 'ORIGINAL_TASK_SENTINEL: answer the original question'
const CHECKPOINT = 'CHECKPOINT_SENTINEL: established reasoning to continue'
const ANSWER = 'VISIBLE_ANSWER_SENTINEL'
const TOOL = { name: 'dangerous_operation', description: 'A caller-owned tool', parameters: { type: 'object', properties: {} } }
const sse = payload => `data: ${JSON.stringify(payload)}\n\n`

function deltas(wire, { reasoning, text, toolName, toolArgs } = {}) {
  if (wire === 'chat') {
    const delta = {
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(text === undefined ? {} : { content: text }),
      ...(toolName === undefined && toolArgs === undefined ? {} : { tool_calls: [{ index: 0, function: {
        ...(toolName === undefined ? {} : { name: toolName }),
        ...(toolArgs === undefined ? {} : { arguments: toolArgs }),
      } }] }),
    }
    return sse({ choices: [{ index: 0, delta }] })
  }
  if (wire === 'responses') {
    return [
      reasoning === undefined ? '' : sse({ type: 'response.reasoning_summary_text.delta', item_id: 'r0', delta: reasoning }),
      text === undefined ? '' : sse({ type: 'response.output_text.delta', output_index: 1, delta: text }),
      toolName === undefined ? '' : sse({ type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', call_id: 'call_local', name: toolName } }),
      toolArgs === undefined ? '' : sse({ type: 'response.function_call_arguments.delta', output_index: 2, delta: toolArgs }),
    ].join('')
  }
  return [
    reasoning === undefined ? '' : sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: reasoning } }),
    text === undefined ? '' : sse({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } }),
    toolName === undefined ? '' : sse({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call_local', name: toolName } }),
    toolArgs === undefined ? '' : sse({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: toolArgs } }),
  ].join('')
}

function usageFrames(wire, input = 11, output = 7) {
  if (wire === 'chat') return sse({ choices: [], usage: { prompt_tokens: input, completion_tokens: output } })
  if (wire === 'messages') return sse({ type: 'message_start', message: { usage: { input_tokens: input, output_tokens: 0 } } })
    + sse({ type: 'message_delta', delta: {}, usage: { output_tokens: output } })
  throw new Error('Responses 的 usage 由终帧携带')
}

function terminal(wire, { reason = 'stop', input = 11, output = 7, usage = true } = {}) {
  if (wire === 'chat') return (usage ? usageFrames(wire, input, output) : '')
    + sse({ choices: [{ index: 0, delta: {}, finish_reason: reason }] }) + 'data: [DONE]\n\n'
  if (wire === 'messages') return (usage ? usageFrames(wire, input, output) : '')
    + sse({ type: 'message_delta', delta: { stop_reason: reason === 'length' ? 'max_tokens' : reason === 'tool_calls' ? 'tool_use' : 'end_turn' } })
    + sse({ type: 'message_stop' })
  return sse({
    type: reason === 'length' ? 'response.incomplete' : 'response.completed',
    response: { status: reason === 'length' ? 'incomplete' : 'completed',
      ...(reason === 'length' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
      ...(usage ? { usage: { input_tokens: input, output_tokens: output } } : {}),
    },
  })
}

function setup(model, answers, { settings = {}, options = {}, entryOverrides = {}, onWarn, hideModel = false } = {}) {
  assert.ok(CATALOG.some(entry => entry.id === model), `目录缺少 ${model}`)
  const scenario = { answers, requests: [], responses: new Set(), timers: [], closed: 0 }
  activeCase = scenario
  const records = []
  const turns = []
  const controller = new AbortController()
  const adapter = new FreeModelAdapter({
    state: () => ({ catalog: hideModel ? [] : CATALOG.map(entry => entry.id === model ? { ...entry, ...entryOverrides } : entry), membership: { [ROUTE_MAIN]: MODELS }, settings: { enabled: true, defaultMaxTokens: 32768, ...settings }, attributionUserAgent: 'offline-recovery-test' }),
    recordUsage: row => records.push(row),
    recordTurn: row => turns.push(row),
    warn: message => onWarn?.(message, controller),
  })
  const stream = adapter.stream({ provider: ROUTE_MAIN, model, reasoningEffort: 'deep', maxTokens: 4096,
    sessionId: `recovery:${model}`, messages: [{ role: 'user', content: [{ type: 'text', text: TASK }] }],
    tools: [TOOL], signal: controller.signal, ...options })
  return { scenario, records, turns, controller, adapter, stream }
}

function cleanup(run) {
  run.controller.abort()
  for (const timer of run.scenario.timers) clearTimeout(timer)
  for (const response of run.scenario.responses) response.destroy()
}

async function drive(model, answers, config) {
  const run = setup(model, answers, config)
  const chunks = []
  const started = Date.now()
  const deadline = setTimeout(() => run.controller.abort(new Error('测试超时')), 1500)
  try {
    for await (const chunk of run.stream) chunks.push(chunk)
    return { ...run, chunks, elapsedMs: Date.now() - started,
      finish: chunks.find(chunk => chunk.type === 'finish')?.reason,
      usage: chunks.find(chunk => chunk.type === 'usage')?.usage }
  } finally {
    clearTimeout(deadline)
    cleanup(run)
  }
}

function checkBlocks(chunks) {
  const starts = chunks.filter(chunk => chunk.type === 'block-start')
  assert.deepEqual(starts.map(chunk => chunk.index), starts.map((_, index) => index), '块索引必须连续且不重复')
  const opened = new Map()
  const ended = new Set()
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') opened.set(chunk.index, chunk.blockType)
    if (chunk.type.endsWith('-delta')) {
      assert.ok(opened.has(chunk.index), 'delta 必须指向已开启的块')
      assert.ok(!ended.has(chunk.index), '已结束的块不能继续接收 delta')
    }
    if (chunk.type === 'block-end') {
      assert.equal(opened.get(chunk.index), chunk.block.type, '块开始/结束类型必须一致')
      assert.ok(!ended.has(chunk.index), '每个块只能结束一次')
      ended.add(chunk.index)
    }
  }
  assert.equal(ended.size, starts.length, '每个已开启的块必须结束')
}

function checkFinal(run, kind, requests) {
  assert.equal(run.scenario.requests.length, requests, '实际 HTTP 请求数')
  assert.equal(run.chunks.filter(chunk => chunk.type === 'finish').length, 1, '只能有一个最终 finish')
  const usageCount = run.chunks.filter(chunk => chunk.type === 'usage').length
  if (kind === 'stop' || requests === 2) assert.equal(usageCount, 1, '正常或恢复路径只能有一个最终 usage')
  else assert.ok(usageCount <= 1, '首段失败或取消最多有一个 usage')
  assert.equal(run.finish?.kind, kind)
  assert.equal(run.turns.length, 1, '一次适配器调用只能记一条逻辑回合')
  assert.equal(run.turns[0].ok, kind === 'stop', '逻辑回合结果必须跟最终结果一致')
  assert.equal(run.turns[0].attempts, requests, '逻辑回合保留实际物理请求数')
  assert.equal(run.turns[0].recovered, kind === 'stop' && requests === 2, '只有成功续写才标为 recovered')
  checkBlocks(run.chunks)
}

function checkCut(run, requests = 2) {
  checkFinal(run, 'error', requests)
  assert.equal(run.finish?.failure?.code, 'STREAM_CUT')
  assert.equal(run.adapter.providerRetryPolicy().retryableCodes.includes(run.finish.failure.code), false, '恢复失败不能触发宿主整轮重发')
}

function noToolChunks(chunks) {
  return chunks.every(chunk => chunk.type !== 'tool-call-delta'
    && !(chunk.type === 'block-start' && chunk.blockType === 'tool-call')
    && !(chunk.type === 'block-end' && chunk.block?.type === 'tool-call'))
}

function emptyToolMetadata(wire) {
  if (wire === 'chat') return sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0 }] } }] })
  if (wire === 'responses') return sse({ type: 'response.output_item.added', output_index: 2, item: { type: 'function_call' } })
  return sse({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use' } })
}

let failures = 0
let checks = 0
const suiteStarted = Date.now()
const check = async (name, fn) => {
  checks++
  console.log(`run  ${name} (${Date.now() - suiteStarted} ms)`)
  try { await fn(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.log(`FAIL ${name} - ${error.message}`) }
}

try {
  // 遍历目录中的不同能力和未知型号，禁止把恢复条件限定为型号白名单。
  for (const model of MODELS) {
    await check(`${model}: 纯推理 EOF 续写正文并正常结束`, async () => {
      const wire = wireFor(model)
      const run = await drive(model, [
        { body: deltas(wire, { reasoning: CHECKPOINT }) },
        { body: deltas(wire, { reasoning: 'SECOND_SEGMENT_REASONING', text: ANSWER }) + terminal(wire) },
      ])
      checkFinal(run, 'stop', 2)
      assert.equal(run.chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), ANSWER)
      assert.equal(run.chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join(''), CHECKPOINT + 'SECOND_SEGMENT_REASONING')
      const [first, continuation] = run.scenario.requests
      assert.equal(first.body.model, model)
      assert.equal(continuation.body.model, model)
      assert.equal(first.headers['x-opencode-session'], continuation.headers['x-opencode-session'], '续写保留原逻辑会话')
      assert.notEqual(first.headers['x-opencode-request'], continuation.headers['x-opencode-request'], '每次 HTTP 请求使用独立请求标识')
      assert.ok(JSON.stringify(continuation.body).includes(TASK), '续写必须携带原任务')
      assert.ok(JSON.stringify(continuation.body).includes(CHECKPOINT), '续写必须携带已完成推理检查点')
      assert.notDeepEqual(continuation.body, first.body, '不能原样重发整轮')
      assert.equal(continuation.body.tool_choice?.type ?? continuation.body.tool_choice, 'none', '续写禁止工具选择')
      assert.equal(run.records.length, 2, '每次真实 HTTP 调用独立记账')
      assert.deepEqual(run.turns, [{ at: run.turns[0].at, model, ok: true, recovered: true, attempts: 2, origin: 'harness' }])
      assert.deepEqual(run.records.map(row => row.attempt), [0, 1])
      assert.equal(typeof run.records[0].recoveryId, 'string')
      assert.ok(run.records[0].recoveryId.length > 0)
      assert.equal(run.records[0].recoveryId, run.records[1].recoveryId, '两段属于同一次逻辑调用')
      assert.equal(run.records[0].recoveryScheduled, true)
      assert.equal(run.records[1].recoveryAttempt, true)
      assert.equal(run.records[1].recovered, true)
      assert.equal(run.records[0].noUsage, true, '首段缺 usage 必须明确标记')
      assert.equal(run.usage.inputTokens, 11)
      assert.equal(run.usage.outputTokens, 7)
    })
  }

  await check('deviceIp 贯穿真 adapter 到网关的 x-forwarded-for，缺失时不添加该头', async () => {
    const model = REPRESENTATIVES[0]
    const wire = wireFor(model)
    const withIp = await drive(model, [{ body: deltas(wire, { text: ANSWER }) + terminal(wire) }], { options: { deviceIp: '198.51.100.23' } })
    assert.equal(withIp.scenario.requests[0].headers['x-forwarded-for'], '198.51.100.23', 'deviceIp 必须变成网关上的 x-forwarded-for')
    const withoutIp = await drive(model, [{ body: deltas(wire, { text: ANSWER }) + terminal(wire) }])
    assert.ok(!('x-forwarded-for' in withoutIp.scenario.requests[0].headers), '无 deviceIp 时出站头必须与从前一致')
  })

  for (const model of REPRESENTATIVES) {
    const wire = wireFor(model)
    for (const [label, delta] of [['正文', { reasoning: CHECKPOINT, text: 'partial answer' }], ['工具名', { reasoning: CHECKPOINT, toolName: TOOL.name }], ['工具参数', { reasoning: CHECKPOINT, toolArgs: '{"x":1}' }]]) {
      await check(`${wire}: 首段已有${label}时不续写`, async () => {
        const run = await drive(model, [{ body: deltas(wire, delta) }])
        checkCut(run, 1)
      })
    }
    for (const reason of ['stop', 'length']) {
      await check(`${wire}: 第二段只有推理即使 ${reason} 也未恢复`, async () => {
        const run = await drive(model, [{ body: deltas(wire, { reasoning: CHECKPOINT }) },
          { body: deltas(wire, { reasoning: 'more thinking' }) + terminal(wire, { reason }) }])
        checkCut(run)
      })
    }
    await check(`${wire}: 第二段空格换行不能冒充正文恢复成功`, async () => {
      const run = await drive(model, [{ body: deltas(wire, { reasoning: CHECKPOINT }) },
        { body: deltas(wire, { text: ' \n\t ' }) + terminal(wire) }])
      checkCut(run)
      assert.ok(run.records.every(row => row.recovered !== true))
    })
    await check(`${wire}: 第二段再 EOF 不发第三次请求`, async () => {
      const run = await drive(model, [{ body: deltas(wire, { reasoning: CHECKPOINT }) }, { body: deltas(wire, { reasoning: 'still thinking' }) }])
      checkCut(run)
    })
    await check(`${wire}: 第二段已有正文但 length 终止也不能冒充恢复成功`, async () => {
      const run = await drive(model, [{ body: deltas(wire, { reasoning: CHECKPOINT }) },
        { body: deltas(wire, { text: ANSWER }) + terminal(wire, { reason: 'length' }) }])
      checkCut(run)
    })
    await check(`${wire}: 首段无名字无参数的工具元数据也禁止恢复`, async () => {
      const run = await drive(model, [{ body: deltas(wire, { reasoning: CHECKPOINT }) + emptyToolMetadata(wire) }])
      checkCut(run, 1)
    })
    await check(`${wire}: 第二段空工具元数据也不能传给宿主`, async () => {
      const run = await drive(model, [{ body: deltas(wire, { reasoning: CHECKPOINT }) },
        { body: deltas(wire, { text: ANSWER }) + emptyToolMetadata(wire) + terminal(wire) }])
      checkCut(run)
      assert.ok(noToolChunks(run.chunks))
    })
    for (const tool of [{ toolName: TOOL.name }, { toolArgs: '{"x":1}' }]) {
      await check(`${wire}: 第二段工具输出不能泄漏给宿主`, async () => {
        const run = await drive(model, [{ body: deltas(wire, { reasoning: CHECKPOINT }) },
          { body: deltas(wire, { text: ANSWER, ...tool }) + terminal(wire, { reason: 'tool_calls' }) }])
        checkCut(run)
        assert.ok(noToolChunks(run.chunks), '不允许任何可执行工具块或参数 delta')
      })
    }
    await check(`${wire}: 纯思考正常 stop 收尾会续写一次要正文`, async () => {
      const warns = []
      const run = await drive(model, [
        { body: deltas(wire, { reasoning: CHECKPOINT }) + terminal(wire) },
        { body: deltas(wire, { text: ANSWER }) + terminal(wire) },
      ], { onWarn: message => warns.push(message) })
      checkFinal(run, 'stop', 2)
      assert.equal(run.chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), ANSWER, '正文必须来自续写段')
      assert.equal(run.records[0].recoveryScheduled, true, '首段须记 recoveryScheduled')
      assert.equal(run.records[0].ok, false, '首段空停不能记成功')
      assert.equal(run.records[1].ok, true)
      assert.equal(run.records[1].recovered, true)
      const continuation = run.scenario.requests[1].body
      assert.ok(JSON.stringify(continuation).includes(CHECKPOINT), '续写必须携带思考检查点')
      assert.equal(continuation.tool_choice?.type ?? continuation.tool_choice, 'none', '续写禁止工具选择')
      assert.ok(warns.some(message => message.includes('stopped turn held only its reasoning')), '空停续写须上报告警')
    })
    await check(`${wire}: 续写段仍只有思考时按断流失败`, async () => {
      const run = await drive(model, [
        { body: deltas(wire, { reasoning: CHECKPOINT }) + terminal(wire) },
        { body: deltas(wire, { reasoning: CHECKPOINT }) + terminal(wire) },
      ])
      checkCut(run)
      assert.equal(run.records.every(row => row.recovered !== true), true)
    })
    await check(`${wire}: 关闭恢复时纯思考正常收尾保持原分类`, async () => {
      const run = await drive(model, [{ body: deltas(wire, { reasoning: CHECKPOINT }) + terminal(wire) }],
        { settings: { streamRecovery: false } })
      checkFinal(run, 'stop', 1)
      assert.equal(run.records[0].recoveryScheduled, undefined)
    })
    await check(`${wire}: 首段输出预算烧尽的纯思考空停不再追加请求`, async () => {
      const run = await drive(model, [{ body: deltas(wire, { reasoning: CHECKPOINT }) + terminal(wire, { output: 4096 }) }])
      checkFinal(run, 'stop', 1)
      assert.equal(run.records[0].recoveryScheduled, undefined, '预算不足不应记 recoveryScheduled')
    })
    // chat 线不存在「带终帧却无 token」的正常收尾：finish_reason 一到就有 token，没有终帧则属于断流。
    if (wire !== 'chat') {
      await check(`${wire}: 无 token 的正常收尾纯思考也续写一次`, async () => {
        const tokenless = wire === 'messages'
          ? usageFrames('messages') + sse({ type: 'message_stop' })
          : sse({ type: 'response.done', response: {} })
        const run = await drive(model, [
          { body: deltas(wire, { reasoning: CHECKPOINT }) + tokenless },
          { body: deltas(wire, { text: ANSWER }) + terminal(wire) },
        ])
        checkFinal(run, 'stop', 2)
        assert.equal(run.records[0].recoveryScheduled, true, 'tokenless 正常收尾须记 recoveryScheduled')
        assert.equal(run.records[0].ok, false, '首段空停不能记成功')
        assert.equal(run.chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), ANSWER, '正文必须来自续写段')
      })
    }
    await check(`${wire}: 关闭恢复保持原始断流`, async () => {
      const run = await drive(model, [{ body: deltas(wire, { reasoning: CHECKPOINT }) }], { settings: { streamRecovery: false } })
      checkCut(run, 1)
    })
    await check(`${wire}: 第二段正文到达但无终帧仍是断流`, async () => {
      const run = await drive(model, [{ body: deltas(wire, { reasoning: CHECKPOINT }) }, { body: deltas(wire, { text: ANSWER }) }])
      checkCut(run)
    })
  }

  await check('Responses cancelled 终态不能将第二段部分正文记为恢复成功', async () => {
    const run = await drive('muse-spark-1.3-contributor-free', [
      { body: deltas('responses', { reasoning: CHECKPOINT }) },
      { body: deltas('responses', { text: ANSWER }) + sse({ type: 'response.done', response: {
        status: 'cancelled', usage: { input_tokens: 11, output_tokens: 7 },
      } }) },
    ])
    checkCut(run)
    assert.ok(run.records.every(row => row.recovered !== true))
  })

  for (const phase of ['首段', '续写段']) {
    await check(`Responses ${phase} response.failed 缺 status 仍必须返回失败`, async () => {
      const failed = sse({ type: 'response.failed', response: { usage: { input_tokens: 11, output_tokens: 7 } } })
      const answers = phase === '首段'
        ? [{ body: deltas('responses', { reasoning: CHECKPOINT }) + failed }]
        : [{ body: deltas('responses', { reasoning: CHECKPOINT }) }, { body: deltas('responses', { text: ANSWER }) + failed }]
      const run = await drive('muse-spark-1.3-contributor-free', answers)
      checkCut(run, phase === '首段' ? 1 : 2)
      assert.ok(run.records.every(row => row.recovered !== true))
    })
  }

  for (const model of ['mimo-v2.6-flash-free', 'union-alpha']) {
    const wire = wireFor(model)
    await check(`${wire}: 已知 usage 只累加一次且减少续写预算`, async () => {
      const run = await drive(model, [{ body: deltas(wire, { reasoning: CHECKPOINT }) + usageFrames(wire, 20, 100) },
        { body: deltas(wire, { text: ANSWER }) + terminal(wire, { input: 30, output: 40 }) }])
      checkFinal(run, 'stop', 2)
      assert.equal(run.usage.inputTokens, 50)
      assert.equal(run.usage.outputTokens, 140)
      assert.equal(run.usage.totalTokens, 190)
      assert.deepEqual(run.records.map(row => [row.input, row.output]), [[20, 100], [30, 40]])
      assert.ok(run.records.every(row => row.noUsage !== true))
      const ceiling = run.scenario.requests[1].body.max_tokens
      assert.ok(ceiling > 0 && ceiling <= 4096 - 100, '续写预算必须扣除首段已知输出')
    })
    await check(`${wire}: 已知输出耗尽预算时不续写`, async () => {
      const run = await drive(model, [{ body: deltas(wire, { reasoning: CHECKPOINT }) + usageFrames(wire, 20, 4096) }])
      checkCut(run, 1)
    })
  }

  const model = REPRESENTATIVES[0]
  const wire = wireFor(model)
  for (const [label, answer] of [
    ['HTTP 429', { status: 429, body: '{"error":{"message":"rate limit"}}' }],
    ['HTTP 503', { status: 503, body: '{"error":{"message":"server unavailable"}}' }],
    ['socket reset', { socket: true }],
    ['空响应', { body: '' }],
    ['流内错误', { body: sse({ type: 'error', error: { type: 'RegionError', message: 'This model is not available in your country.' } }) }],
  ]) {
    await check(`恢复失败 ${label} 不触发整轮重发`, async () => {
      const run = await drive(model, [{ body: deltas(wire, { reasoning: CHECKPOINT }) }, answer])
      checkCut(run)
    })
  }

  await check('Chat content_filter 终态有正文仍不能标为恢复成功', async () => {
    const run = await drive(model, [{ body: deltas(wire, { reasoning: CHECKPOINT }) },
      { body: deltas(wire, { text: ANSWER }) + terminal(wire, { reason: 'content_filter' }) }])
    checkCut(run)
    assert.ok(run.records.every(row => row.recovered !== true))
  })

  await check('两段都缺 usage 保留 missing 而不伪造零消耗证据', async () => {
    const run = await drive(model, [{ body: deltas(wire, { reasoning: CHECKPOINT }) },
      { body: deltas(wire, { text: ANSWER }) + terminal(wire, { usage: false }) }])
    checkFinal(run, 'stop', 2)
    assert.equal(run.records.length, 2)
    assert.ok(run.records.every(row => row.noUsage === true))
    assert.deepEqual(run.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, '宿主结构保持数值型，缺失由各段 noUsage 记录')
  })

  for (const [label, tail] of [
    ['工具违约', deltas(wire, { toolName: TOOL.name, toolArgs: '{}' })],
    ['流内错误', sse({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached.' } })],
  ]) {
    await check(`续写 usage 已到达后${label}仍保留已知计数`, async () => {
      const run = await drive(model, [{ body: deltas(wire, { reasoning: CHECKPOINT }) + usageFrames(wire, 20, 100) },
        { body: usageFrames(wire, 30, 40) + tail }])
      checkCut(run)
      assert.equal(run.usage.inputTokens, 50)
      assert.equal(run.usage.outputTokens, 140)
      assert.deepEqual(run.records.map(row => [row.input, row.output]), [[20, 100], [30, 40]])
      assert.ok(run.records.every(row => row.noUsage !== true))
      assert.ok(noToolChunks(run.chunks))
    })
  }

  await check('首段 usage 已到达后流内错误仍保留计数且不进入 EOF 恢复', async () => {
    const run = await drive(model, [{ body: usageFrames(wire, 20, 100) + deltas(wire, { reasoning: CHECKPOINT })
      + sse({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached.' } }) }])
    checkFinal(run, 'error', 1)
    assert.equal(run.usage?.inputTokens, 20)
    assert.equal(run.usage?.outputTokens, 100)
    assert.deepEqual(run.records.map(row => [row.input, row.output]), [[20, 100]])
    assert.ok(run.records.every(row => row.noUsage !== true))
  })

  await check('首段 EOF 后续写警告回调取消仍保留用量且不发第二次 HTTP', async () => {
    const run = await drive(model, [{ body: usageFrames(wire, 20, 100) + deltas(wire, { reasoning: CHECKPOINT }) }],
      { onWarn: (_, controller) => controller.abort(new Error('cancelled between attempts')) })
    checkFinal(run, 'aborted', 1)
    assert.equal(run.finish.failure.code, 'ABORTED')
    assert.equal(run.chunks.filter(chunk => chunk.type === 'usage').length, 1)
    assert.equal(run.usage?.inputTokens, 20)
    assert.equal(run.usage?.outputTokens, 100)
    assert.deepEqual(run.records.map(row => [row.input, row.output]), [[20, 100]])
  })

  for (const phase of ['首段', '续写段']) {
    await check(`${phase} usage 已到达后取消仍保留已知计数`, async () => {
      const first = { body: usageFrames(wire, 20, 100) + deltas(wire, { reasoning: CHECKPOINT }), hold: phase === '首段' }
      const run = setup(model, [first, { hold: true, body: usageFrames(wire, 30, 40) + deltas(wire, { reasoning: 'CANCEL_WITH_USAGE' }) }])
      const chunks = []
      try {
        for await (const chunk of run.stream) {
          chunks.push(chunk)
          if (chunk.type === 'reasoning-delta' && (phase === '首段' || chunk.text === 'CANCEL_WITH_USAGE')) run.controller.abort(new Error('user cancelled after usage'))
        }
        const out = { ...run, chunks, finish: chunks.find(chunk => chunk.type === 'finish')?.reason }
        checkFinal(out, 'aborted', phase === '首段' ? 1 : 2)
        assert.ok(run.records.every(row => row.noUsage !== true))
        assert.deepEqual(run.records.map(row => [row.input, row.output]), phase === '首段' ? [[20, 100]] : [[20, 100], [30, 40]])
        const usage = chunks.find(chunk => chunk.type === 'usage')?.usage
        assert.equal(usage?.inputTokens, phase === '首段' ? 20 : 50)
        assert.equal(usage?.outputTokens, phase === '首段' ? 100 : 140)
      } finally { cleanup(run) }
    })
  }

  await check('checkpoint 超过容量不能截断后冒充完整检查点恢复', async () => {
    const reasoning = 'discarded_prefix_'.repeat(300) + 'KEPT_CHECKPOINT_SUFFIX'
    const run = await drive(model, [{ body: deltas(wire, { reasoning }) },
      { body: deltas(wire, { text: ANSWER }) + terminal(wire) }], { settings: { streamRecovery: { checkpointLimit: 128 } } })
    checkCut(run, 1)
  })

  await check('续写输出上限可以缩小且实际发送受限预算', async () => {
    const run = await drive(model, [{ body: deltas(wire, { reasoning: CHECKPOINT }) },
      { body: deltas(wire, { text: ANSWER }) + terminal(wire) }], { settings: { streamRecovery: { maxOutputTokens: 600 } } })
    checkFinal(run, 'stop', 2)
    assert.ok(run.scenario.requests[1].body.max_tokens > 0 && run.scenario.requests[1].body.max_tokens <= 600)
  })

  await check('目录 context 容量不足时不追加续写请求', async () => {
    const run = await drive(model, [{ body: deltas(wire, { reasoning: CHECKPOINT }) },
      { body: deltas(wire, { text: ANSWER }) + terminal(wire) }], { entryOverrides: { contextWindow: 200 } })
    checkCut(run, 1)
  })

  await check('enabled:false 的恢复配置保持原始断流', async () => {
    const run = await drive(model, [{ body: deltas(wire, { reasoning: CHECKPOINT }) }], { settings: { streamRecovery: { enabled: false } } })
    checkCut(run, 1)
  })

  await check('续写时间上限中止在途 HTTP 并保持非重试错误', async () => {
    const run = await drive(model, [{ body: deltas(wire, { reasoning: CHECKPOINT }) }, { hold: true, body: deltas(wire, { reasoning: 'held recovery' }) }],
      { settings: { streamRecovery: { maxContinuationMs: 80, totalTimeoutMs: 1000 } } })
    checkCut(run)
    assert.ok(run.elapsedMs < 1000, `续写未按时结束：${run.elapsedMs} ms`)
  })

  await check('整轮时间上限包含首段耗时并避免追加超时续写', async () => {
    const run = await drive(model, [{ hold: true, body: deltas(wire, { reasoning: CHECKPOINT }) }, { body: deltas(wire, { text: ANSWER }) + terminal(wire) }],
      { settings: { streamRecovery: { totalTimeoutMs: 80, maxContinuationMs: 1000 } } })
    checkFinal(run, 'error', 1)
    assert.equal(run.adapter.providerRetryPolicy().retryableCodes.includes(run.finish?.failure?.code), false)
    assert.ok(run.elapsedMs < 1000)
    assert.match(run.finish.failure.message, /^our free model reached its 0s time limit before its finish token$/)
  })

  await check('恢复回合的丢弃内容告警不按 payload 重建次数累积', async () => {
    const notices = []
    const run = await drive(model, [{ body: deltas(wire, { reasoning: CHECKPOINT }) },
      { body: deltas(wire, { text: ANSWER }) + terminal(wire) }], {
      options: { messages: [{ role: 'user', content: [
        { type: 'text', text: TASK }, { type: 'image', attachment: {} }, { type: 'image', attachment: {} },
      ] }] },
      onWarn: message => notices.push(message),
    })
    checkFinal(run, 'stop', 2)
    assert.deepEqual(run.records.map(row => row.warnings?.filter(w => w === 'image-dropped').length), [2, 2],
      '两张被丢弃的图片在本回合各记一次，不随检查点估算和续写段的重复 build 增长')
    const dropped = notices.filter(message => message.includes('image-dropped'))
    assert.equal(dropped.length, 1, '面向用户的丢弃告警只发一次')
    assert.equal(dropped[0].split('image-dropped').length - 1, 2, '告警文本不得重复累积')
  })

  for (const phase of ['首段', '续写段']) {
    await check(`用户取消${phase}关闭在途 HTTP`, async () => {
      const first = { body: deltas(wire, { reasoning: CHECKPOINT }), hold: phase === '首段' }
      const run = setup(model, [first, { hold: true, body: deltas(wire, { reasoning: 'CANCEL_TARGET' }) }])
      const chunks = []
      try {
        for await (const chunk of run.stream) {
          chunks.push(chunk)
          if (chunk.type === 'reasoning-delta' && (phase === '首段' || chunk.text === 'CANCEL_TARGET')) run.controller.abort(new Error('user cancelled'))
        }
        const out = { ...run, chunks, finish: chunks.find(chunk => chunk.type === 'finish')?.reason }
        checkFinal(out, 'aborted', phase === '首段' ? 1 : 2)
        assert.equal(out.finish.failure.code, 'ABORTED')
        await until(() => run.scenario.responses.size === 0, { what: '取消关闭 HTTP 连接', timeoutMs: 600 })
      } finally { cleanup(run) }
    })
  }

  await check('generator.return() 可取消排队 next 正在等待的 HTTP', async () => {
    const run = setup(model, [{ hold: true, body: deltas(wire, { reasoning: CHECKPOINT }) }])
    let timer
    try {
      let chunk
      do { chunk = await run.stream.next() } while (!chunk.done && chunk.value.type !== 'reasoning-delta')
      const pending = run.stream.next()
      const returning = run.stream.return()
      await Promise.race([Promise.all([pending, returning]), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('return 未取消正在等待的 HTTP')), 600) })])
      assert.equal(run.scenario.requests.length, 1)
      await until(() => run.scenario.responses.size === 0, { what: 'return 关闭 HTTP 连接', timeoutMs: 600 })
      assert.equal(run.turns.length, 1)
      assert.deepEqual({ ok: run.turns[0].ok, recovered: run.turns[0].recovered, attempts: run.turns[0].attempts }, { ok: false, recovered: false, attempts: 1 })
    } finally { clearTimeout(timer); cleanup(run) }
  })

  await check('首个上游请求前取消也记录失败回合', async () => {
    const run = setup(model, [])
    run.controller.abort(new Error('cancelled before request'))
    const chunks = []
    try {
      for await (const chunk of run.stream) chunks.push(chunk)
      checkFinal({ ...run, chunks, finish: chunks.find(chunk => chunk.type === 'finish')?.reason }, 'aborted', 0)
    } finally { cleanup(run) }
  })

  for (const [label, config, code] of [
    ['插件关闭', { settings: { enabled: false } }, 'CONFIG_DISABLED'],
    ['模型未被目录提供', { hideModel: true }, 'SERVER'],
  ]) {
    await check(`${label}也记录零物理请求的失败回合`, async () => {
      const run = await drive(model, [], config)
      checkFinal(run, 'error', 0)
      assert.equal(run.finish.failure.code, code)
      assert.deepEqual(run.turns[0], { at: run.turns[0].at, model, ok: false, recovered: false, attempts: 0, origin: 'harness' })
    })
  }

  const { apply, inject } = await import('../index.js')
  async function withForward(answers, fn) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-recovery-forward-'))
    const dataDir = path.join(home, 'our-free-model')
    const originalHome = process.env.DSH_HOME
    fs.mkdirSync(dataDir)
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
      distribution: 'managed', forward: { enabled: true, host: '127.0.0.1', port: 0 },
    }))
    process.env.DSH_HOME = home
    const scenario = { answers, models: [model], requests: [], responses: new Set(), timers: [], closed: 0 }
    forwardScenario = scenario
    const ctx = fakeContext({ inject, mounted: ['llm', 'webServer'] })
    let api
    try {
      apply(ctx, { distribution: 'managed' })
      await until(() => {
        api = ctx.__captured.serverRoutes.find(route => route.kind === 'prefix')?.handler
        return api !== undefined
      }, { what: '本地插件设置 API', timeoutMs: 3000 })
      let summary
      await until(async () => {
        summary = await callRoute(api, 'GET', '/api/our-free-model/summary')
        return summary.json?.settings?.forward?.running === true && summary.json?.probedAt > 0
      }, { what: '启动探测完成并开启 Forward', timeoutMs: 3000 })
      const port = summary.json.settings.forward.actualPort
      const key = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).forwardKey
      const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
      const savedStats = async count => {
        let saved
        await until(() => {
          saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'stats.json'), 'utf8'))
          return saved.samples?.length === count
        }, { what: `${count} 条物理请求统计落盘`, timeoutMs: 3000 })
        return saved
      }
      await fn({ scenario, headers, base: `http://127.0.0.1:${port}`, savedStats })
    } finally {
      if (api) await callRoute(api, 'POST', '/api/our-free-model/settings', { forward: { enabled: false } })
      for (const dispose of ctx.__disposers.reverse()) dispose()
      for (const timer of scenario.timers) clearTimeout(timer)
      for (const response of scenario.responses) response.destroy()
      forwardScenario = undefined
      if (originalHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = originalHome
      fs.rmSync(home, { recursive: true, force: true })
    }
  }
  const requestBody = stream => ({ model, messages: [{ role: 'user', content: TASK }], stream, max_tokens: 4096, reasoning_effort: 'deep' })
  const usageCounters = usage => ({ prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.total_tokens })
  const ssePayloads = raw => raw.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6))
  for (const wantsStream of [true, false]) {
    await check(`Forward ${wantsStream ? 'SSE' : 'JSON'} 经真实插件返回续写正文并保存两段统计`, async () => {
      await withForward([{ body: deltas(wire, { reasoning: CHECKPOINT }) }, { body: deltas(wire, { text: ANSWER }) + terminal(wire) }],
        async ({ base, headers, scenario, savedStats }) => {
        const response = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody(wantsStream)),
          signal: AbortSignal.timeout(3000),
        })
        assert.equal(response.status, 200)
        if (wantsStream) {
          const raw = await response.text()
          const payloads = ssePayloads(raw)
          assert.equal(payloads.filter(payload => payload === '[DONE]').length, 1, 'Forward 只发送一个 DONE')
          const frames = payloads.filter(payload => payload !== '[DONE]').map(payload => JSON.parse(payload))
          assert.ok(frames.every(frame => frame.error === undefined))
          assert.equal(frames.flatMap(frame => frame.choices ?? []).map(choice => choice.delta?.content ?? '').join(''), ANSWER)
          assert.equal(frames.flatMap(frame => frame.choices ?? []).map(choice => choice.delta?.reasoning ?? '').join(''), CHECKPOINT)
          assert.deepEqual(frames.flatMap(frame => frame.choices ?? []).filter(choice => choice.finish_reason).map(choice => choice.finish_reason), ['stop'])
          assert.deepEqual(frames.filter(frame => frame.usage !== undefined).map(frame => usageCounters(frame.usage)), [{ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }])
        } else {
          const body = await response.json()
          assert.equal(body.error, undefined)
          assert.equal(body.choices.length, 1)
          assert.equal(body.choices[0].message.content, ANSWER)
          assert.equal(body.choices[0].finish_reason, 'stop')
          assert.deepEqual(usageCounters(body.usage), { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 })
        }
        const requests = scenario.requests
        assert.equal(requests.length, 2, 'Forward 实际向上游发送首段和续写两次请求')
        assert.ok(JSON.stringify(requests[1].body).includes(CHECKPOINT))
        assert.equal(requests[1].body.tool_choice, 'none')
        const saved = await savedStats(2)
        assert.equal(saved.requests, 2)
        assert.deepEqual(saved.samples.map(row => row.attempt), [0, 1])
        assert.equal(saved.samples[0].recoveryId, saved.samples[1].recoveryId)
        assert.equal(saved.samples[0].recoveryScheduled, true)
        assert.equal(saved.samples[0].noUsage, true)
        assert.equal(saved.samples[1].recovered, true)
        assert.equal(saved.samples[1].recoveryAttempt, true)
        assert.deepEqual(saved.samples.map(row => [row.input, row.output]), [[0, 0], [11, 7]])
      })
    })
  }

  for (const [endpoint, wantsStream] of [['/v1/chat/completions', true], ['/v1/chat/completions', false], ['/v1/responses', false]]) {
    for (const [label, tail] of [['EOF', ''], ['流内错误', sse({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached.' } })]]) {
      await check(`Forward ${endpoint} ${wantsStream ? 'SSE' : 'JSON'} 部分正文后${label}不能返回正常完成`, async () => {
        await withForward([{ body: deltas(wire, { reasoning: CHECKPOINT }) }, { body: usageFrames(wire) + deltas(wire, { text: ANSWER }) + tail }],
          async ({ base, headers, scenario, savedStats }) => {
          const response = await fetch(`${base}${endpoint}`, { method: 'POST', headers,
            body: JSON.stringify(requestBody(wantsStream)), signal: AbortSignal.timeout(3000) })
          if (wantsStream) {
            assert.equal(response.status, 200, 'SSE 的 HTTP 头已经发送')
            const payloads = ssePayloads(await response.text())
            assert.equal(payloads.filter(payload => payload === '[DONE]').length, 1)
            const frames = payloads.filter(payload => payload !== '[DONE]').map(payload => JSON.parse(payload))
            assert.equal(frames.flatMap(frame => frame.choices ?? []).map(choice => choice.delta?.content ?? '').join(''), ANSWER)
            assert.equal(frames.filter(frame => frame.error !== undefined).length, 1, '必须发送一次明确错误')
            assert.ok(!frames.flatMap(frame => frame.choices ?? []).some(choice => choice.finish_reason === 'stop'), '错误后不能补一个正常 stop')
          } else {
            assert.equal(response.status, 502)
            const body = await response.json()
            assert.equal(body.error?.type, 'server_error')
            assert.notEqual(body.status, 'completed')
            assert.equal(body.choices, undefined)
          }
          assert.equal(scenario.requests.length, 2)
          const saved = await savedStats(2)
          assert.ok(saved.samples.every(row => row.recovered !== true))
          assert.deepEqual(saved.samples.map(row => [row.input, row.output]), [[0, 0], [11, 7]])
        })
      })
    }
  }

  for (const wantsStream of [true, false]) {
    for (const phase of ['首段', '续写段']) {
      await check(`Forward ${wantsStream ? 'SSE' : 'JSON'} 客户端断开${phase}立即关闭上游且不再续写`, async () => {
        const first = { body: deltas(wire, { reasoning: CHECKPOINT }), hold: phase === '首段' }
        await withForward([first, { hold: true, body: deltas(wire, { reasoning: 'CANCEL_TARGET' }) }],
          async ({ base, headers, scenario, savedStats }) => {
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(new Error('测试超时')), 3000)
          const pending = fetch(`${base}/v1/chat/completions`, { method: 'POST', headers,
            body: JSON.stringify(requestBody(wantsStream)), signal: controller.signal })
            .then(async response => ({ text: await response.text() })).catch(error => ({ error }))
          try {
            const count = phase === '首段' ? 1 : 2
            await until(() => scenario.requests.length === count && scenario.responses.size === 1,
              { what: `${phase}真实上游连接已在途`, timeoutMs: 1000 })
            controller.abort()
            const result = await pending
            assert.equal(result.error?.name, 'AbortError')
            await until(() => scenario.responses.size === 0, { what: '客户端取消关闭真实上游连接', timeoutMs: 600 })
            const saved = await savedStats(count)
            assert.equal(saved.requests, count)
            assert.ok(saved.samples.every(row => row.recovered !== true))
            assert.equal(scenario.requests.length, count, '取消后禁止追加恢复请求')
          } finally { clearTimeout(timeout); controller.abort(); await pending }
        })
      })
    }
  }
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}

console.log(`\nrecovery: ${checks - failures}/${checks} checks passed`)
process.exitCode = failures === 0 ? 0 : 1
