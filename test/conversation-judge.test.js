import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildJudgePrompt,
  collectFindings,
  extractTurns,
  groupBySession,
  heuristicChecks,
  judgeTurns,
  parseJudgeResponse,
  toolOutcomeCancelled,
  toolOutcomeOk,
} from '../src/core/conversation-judge.js'

function record(overrides) {
  return { sessionId: 's1', turnId: 't1', at: 1, status: 'completed', ...overrides }
}

/** prompt 末尾就是 payload 的 JSON 正文，取出来好断言「模型看到的是什么」。 */
function promptPayload(prompt) {
  const start = prompt.indexOf('{\n  "scenario"')
  assert.ok(start > 0, 'prompt 末尾应能找到 payload JSON')
  return JSON.parse(prompt.slice(start))
}

test('按 session 分组并忽略没有 sessionId 的记录', () => {
  const sessions = groupBySession([
    record({ kind: 'response' }),
    record({ sessionId: 's2', kind: 'response' }),
    record({ sessionId: undefined, kind: 'response' }),
  ])
  assert.equal(sessions.size, 2)
  assert.equal(sessions.get('s1').length, 1)
})

test('把一轮对话的四种记录还原成一个回合', () => {
  const turns = extractTurns([
    record({ kind: 'transcription', text: '帮我看下天气', at: 10 }),
    record({ kind: 'tool', text: 'web_search', outcome: 'completed', at: 11 }),
    record({ kind: 'response', text: '杭州明天晴，20 度', at: 12 }),
    record({ kind: 'synthesis', text: '杭州明天晴，20 度', voice: 'voc_1', at: 13 }),
  ])
  assert.equal(turns.length, 1)
  const [turn] = turns
  assert.equal(turn.userText, '帮我看下天气')
  assert.equal(turn.assistantText, '杭州明天晴，20 度')
  assert.deepEqual(turn.tools, [{ name: 'web_search', outcome: 'completed', status: 'completed' }])
  assert.equal(turn.synthesis.voice, 'voc_1')
})

test('同一 session 的多个回合按时间排序', () => {
  const turns = extractTurns([
    record({ turnId: 't2', kind: 'response', text: '第二句', at: 20 }),
    record({ turnId: 't1', kind: 'response', text: '第一句', at: 10 }),
  ])
  assert.deepEqual(
    turns.map(t => t.turnId),
    ['t1', 't2'],
  )
})

test('用户说了话却没有回复 → error', () => {
  const findings = heuristicChecks({ userText: '你好', assistantText: '', tools: [], errors: [], synthesis: null })
  assert.equal(findings[0].code, 'EMPTY_RESPONSE')
  assert.equal(findings[0].severity, 'error')
})

test('工具失败 → error，且逐条列出', () => {
  const findings = heuristicChecks({
    userText: '改一下文件',
    assistantText: '改好了',
    tools: [
      { name: 'edit', outcome: 'failed' },
      { name: 'read', outcome: 'ok' },
    ],
    errors: [],
    synthesis: { voice: 'v' },
  })
  const failed = findings.filter(f => f.code === 'TOOL_FAILED')
  assert.equal(failed.length, 1)
  assert.match(failed[0].detail, /edit/)
})

test('用户打断（cancelled）不算工具失败', () => {
  const findings = heuristicChecks({
    userText: '念一段吧',
    assistantText: '好呀',
    tools: [
      { name: 'synth_tts', outcome: 'cancelled' },
      { name: 'synth_tts', outcome: 'canceled' },
    ],
    errors: [],
    synthesis: { voice: 'v' },
  })
  assert.ok(!findings.some(f => f.code === 'TOOL_FAILED'), '打断不是工具失败，不应产出 TOOL_FAILED')
})

test('success 与 ok/completed 一样算成功，真失败仍要逐条报', () => {
  const allOk = heuristicChecks({
    userText: '看一下',
    assistantText: '看完了',
    tools: [
      { name: 'a', outcome: 'ok' },
      { name: 'b', outcome: 'completed' },
      { name: 'c', outcome: 'success' },
    ],
    errors: [],
    synthesis: { voice: 'v' },
  })
  assert.ok(!allOk.some(f => f.code === 'TOOL_FAILED'))

  const mixed = heuristicChecks({
    userText: '改一下',
    assistantText: '改完了',
    tools: [
      { name: 'edit', outcome: 'success' },
      { name: 'bash', outcome: 'failed' },
    ],
    errors: [],
    synthesis: { voice: 'v' },
  })
  const failed = mixed.filter(f => f.code === 'TOOL_FAILED')
  assert.equal(failed.length, 1)
  assert.match(failed[0].detail, /bash/)
})

test('原生出声（audioOutput）且无合成记录 → 不报 TTS_MISSING', () => {
  const native = heuristicChecks({
    userText: '在吗',
    assistantText: '在的',
    tools: [],
    errors: [],
    synthesis: null,
    audioOutput: true,
  })
  assert.ok(!native.some(f => f.code === 'TTS_MISSING'), '原生音频已出声，不应报缺合成')

  const silent = heuristicChecks({
    userText: '在吗',
    assistantText: '在的',
    tools: [],
    errors: [],
    synthesis: null,
    audioOutput: false,
  })
  assert.ok(silent.some(f => f.code === 'TTS_MISSING'), '既无合成也无原生音频，仍要报')
})

test('extractTurns 把 response 行的 audioOutput 汇总到回合上', () => {
  const turns = extractTurns([
    record({ turnId: 't1', kind: 'transcription', text: '在吗', at: 1 }),
    record({ turnId: 't1', kind: 'response', text: '在的', audioOutput: true, at: 2 }),
    record({ turnId: 't2', kind: 'response', text: '嗯', audioOutput: false, at: 3 }),
  ])
  assert.deepEqual(
    turns.map(t => t.audioOutput),
    [true, false],
  )
})

test('启发式与 prompt 的成功判定来自同一份词表', () => {
  const outcomes = ['ok', 'completed', 'success', 'failed', 'cancelled', 'canceled', 'unknown', undefined]
  for (const outcome of outcomes) {
    const prompt = buildJudgePrompt({ turn: { userText: 'x', assistantText: 'y', tools: [{ name: 't', outcome }] } })
    const payload = promptPayload(prompt)
    assert.equal(payload.tools_called[0].ok, toolOutcomeOk(outcome), `prompt ok 标志不符：${String(outcome)}`)

    const findings = heuristicChecks({
      userText: 'x',
      assistantText: 'y',
      tools: [{ name: 't', outcome }],
      errors: [],
      synthesis: { voice: 'v' },
    })
    const reported = findings.some(f => f.code === 'TOOL_FAILED')
    assert.equal(reported, !toolOutcomeOk(outcome) && !toolOutcomeCancelled(outcome), `TOOL_FAILED 口径不符：${String(outcome)}`)
  }
})

test('声称做完但没有任何工具调用 → warn（幻觉操作）', () => {
  const findings = heuristicChecks({
    userText: '帮我把 b.txt 改成 NEW',
    assistantText: '好啦，已经帮你改好了',
    tools: [],
    errors: [],
    synthesis: { voice: 'v' },
  })
  assert.ok(findings.some(f => f.code === 'CLAIM_WITHOUT_TOOL' && f.severity === 'warn'))
})

test('有工具调用时，同样的说辞不应被误判', () => {
  const findings = heuristicChecks({
    userText: '帮我把 b.txt 改成 NEW',
    assistantText: '好啦，已经帮你改好了',
    tools: [{ name: 'edit', outcome: 'ok' }],
    errors: [],
    synthesis: { voice: 'v' },
  })
  assert.ok(!findings.some(f => f.code === 'CLAIM_WITHOUT_TOOL'))
})

test('中文提问得到纯英文回复 → warn', () => {
  const findings = heuristicChecks({
    userText: '今天天气怎么样',
    assistantText: 'The weather is fine.',
    tools: [],
    errors: [],
    synthesis: { voice: 'v' },
  })
  assert.ok(findings.some(f => f.code === 'LANGUAGE_DRIFT'))
})

test('有回复但没有合成记录 → warn', () => {
  const findings = heuristicChecks({ userText: '在吗', assistantText: '在的', tools: [], errors: [], synthesis: null })
  assert.ok(findings.some(f => f.code === 'TTS_MISSING'))
})

test('collectFindings 汇总 error/warn 计数并带上 turnId', () => {
  const turns = [
    { turnId: 'a', sessionId: 's', userText: '你好', assistantText: '', tools: [], errors: [], synthesis: null },
    { turnId: 'b', sessionId: 's', userText: '在吗', assistantText: '在的', tools: [], errors: [], synthesis: { voice: 'v' } },
    { turnId: 'c', sessionId: 's', userText: '再说一句', assistantText: '好呀', tools: [], errors: [], synthesis: null },
  ]
  const { findings, summary } = collectFindings(turns)
  assert.deepEqual(summary, { turns: 3, errors: 1, warns: 1 })
  assert.ok(!findings.some(f => f.turnId === 'b'), '干净回合不应产生任何发现')
  assert.ok(findings.every(f => f.turnId && f.sessionId))
})

test('prompt 包含标准、用户原话与工具清单', () => {
  const prompt = buildJudgePrompt({
    turn: { userText: '查天气', assistantText: '晴', tools: [{ name: 'web_search', outcome: 'completed' }] },
  })
  assert.match(prompt, /评分标准/)
  assert.match(prompt, /查天气/)
  assert.match(prompt, /web_search/)
  assert.match(prompt, /只输出 JSON/)
})

test('judge 响应解析：裸 JSON / 代码块 / 带解释 / 非法', () => {
  assert.deepEqual(parseJudgeResponse('{"pass":true,"score":90,"reasons":["好"]}'), { pass: true, score: 90, reasons: ['好'] })
  assert.equal(parseJudgeResponse('```json\n{"pass":false,"score":20,"reasons":["答非所问"]}\n```').pass, false)
  assert.equal(parseJudgeResponse('结论如下：{"pass":true,"score":80,"reasons":[]} 以上').score, 80)
  const bad = parseJudgeResponse('完全不是 JSON')
  assert.equal(bad.pass, null)
  assert.match(bad.reasons[0], /no JSON/)
})

test('judgeTurns 跳过空回合，模型异常时标记为未判定而不是崩掉', async () => {
  const turns = [
    { turnId: 'a', sessionId: 's', userText: '你好', assistantText: '你好呀', tools: [] },
    { turnId: 'b', sessionId: 's', userText: '   ', assistantText: '', tools: [] },
    { turnId: 'c', sessionId: 's', userText: '查天气', assistantText: '晴', tools: [] },
  ]
  const judged = await judgeTurns({
    turns,
    judge: async prompt => {
      if (prompt.includes('查天气')) throw new Error('upstream 500')
      return '{"pass":true,"score":88,"reasons":["自然"]}'
    },
  })
  assert.equal(judged.length, 2)
  assert.equal(judged[0].pass, true)
  assert.equal(judged[1].pass, null)
  assert.match(judged[1].reasons[0], /judge call failed/)
})

test('limit 限制复核数量（控制成本）', async () => {
  const turns = Array.from({ length: 5 }, (_, i) => ({ turnId: `t${i}`, sessionId: 's', userText: `问题${i}`, assistantText: '答', tools: [] }))
  let calls = 0
  const judged = await judgeTurns({ turns, limit: 2, judge: async () => (calls++, '{"pass":true,"score":70,"reasons":[]}') })
  assert.equal(judged.length, 2)
  assert.equal(calls, 2)
})

test('工具名优先取 tool 字段，legacy 行回落 text', () => {
  const turns = extractTurns([
    // 新行：text 带原因，名字在 tool
    record({kind: 'tool', tool: 'read', status: 'failed', outcome: 'error', text: 'read: 所在响应在工具完成前结束（failed）', at: 10}),
    // legacy 行：只有 text
    record({kind: 'tool', text: 'web_search', outcome: 'completed', at: 11}),
    // 只有 tool、没有 text
    record({kind: 'tool', tool: 'design_voice', status: 'cancelled', at: 12}),
    // 两者都没有
    record({kind: 'tool', at: 13}),
  ])
  assert.deepEqual(turns[0].tools.map(t => t.name), ['read', 'web_search', 'design_voice', 'unknown'])
  // 「是哪个工具坏了」恢复可读：detail 只剩裸名字，不再把整句报错当名字。
  assert.equal(heuristicChecks(turns[0]).find(f => f.code === 'TOOL_FAILED').detail, 'read 返回 error')
})
