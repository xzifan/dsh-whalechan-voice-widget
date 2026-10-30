import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createEndpointChain,
  createPassthroughStrategy,
  listEndpointStrategies,
  registerEndpointStrategy,
  resolveEndpointChain,
  unregisterEndpointStrategy,
} from '../src/core/endpoint/index.js'

const FRAME_MS = 20

function tone(amplitude = 3000, length = 320) {
  const frame = new Int16Array(length)
  for (let i = 0; i < length; i += 1) frame[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * i) / 16000))
  return frame
}

function silence(length = 320) {
  return new Int16Array(length)
}

async function feed(chain, frames, frameMs = FRAME_MS) {
  const decisions = []
  for (const frame of frames) decisions.push(await chain.push(frame, { frameMs }))
  return decisions
}

function speechThenSilence({ speechMs = 800, silenceMs = 800 } = {}) {
  const frames = []
  for (let i = 0; i < speechMs / FRAME_MS; i += 1) frames.push(tone())
  for (let i = 0; i < silenceMs / FRAME_MS; i += 1) frames.push(silence())
  return frames
}

test('内置策略可枚举，重复注册默认报错', () => {
  assert.deepEqual(listEndpointStrategies().sort(), ['energy-vad', 'passthrough'])
  assert.throws(() => registerEndpointStrategy('energy-vad', () => ({})), /already registered/)
  const id = registerEndpointStrategy('probe-strategy', () => createPassthroughStrategy(), { override: true })
  assert.equal(id, 'probe-strategy')
  assert.equal(unregisterEndpointStrategy('probe-strategy'), true)
  assert.ok(!listEndpointStrategies().includes('probe-strategy'))
})

test('能量 VAD：纯静音不下任何结论', async () => {
  const chain = resolveEndpointChain({ order: ['energy-vad'] })
  const decisions = await feed(chain, Array.from({ length: 60 }, () => silence()))
  assert.ok(decisions.every(d => !d.speechStarted && !d.speechStopped))
  assert.ok(decisions.every(d => d.strategy === 'energy-vad'))
})

test('能量 VAD：说话后静音超过阈值判定说完，且只判一次', async () => {
  const chain = resolveEndpointChain({ order: ['energy-vad'], silenceMs: 700 })
  const decisions = await feed(chain, speechThenSilence({ speechMs: 800, silenceMs: 800 }))
  const started = decisions.filter(d => d.speechStarted)
  const stopped = decisions.filter(d => d.speechStopped)
  assert.equal(started.length, 1, '开口只应触发一次')
  assert.equal(stopped.length, 1, '说完只应触发一次')
  assert.ok(decisions.indexOf(started[0]) < decisions.indexOf(stopped[0]))
  assert.ok(stopped[0].confidence > 0)
})

test('能量 VAD：句间短停顿（300ms）不判说完', async () => {
  const chain = resolveEndpointChain({ order: ['energy-vad'], silenceMs: 700 })
  const frames = [...Array(25).fill(tone()), ...Array(15).fill(silence()), ...Array(25).fill(tone())]
  const decisions = await feed(chain, frames)
  assert.equal(decisions.filter(d => d.speechStopped).length, 0)
})

test('能量 VAD：极短噪声不算一次说话', async () => {
  const chain = resolveEndpointChain({ order: ['energy-vad'], silenceMs: 700, minSpeechMs: 250 })
  const frames = [...Array(2).fill(tone()), ...Array(60).fill(silence())]
  const decisions = await feed(chain, frames)
  assert.equal(decisions.filter(d => d.speechStopped).length, 0)
})

test('降级链：第一级抛错后被禁用，判定来自下一级且记录 fallbackFrom', async () => {
  let calls = 0
  const broken = {
    id: 'broken',
    reset() {},
    push() {
      calls += 1
      throw new Error('model not loaded')
    },
  }
  const warn = console.warn
  console.warn = () => {}
  try {
    const chain = createEndpointChain({ strategies: [broken, createPassthroughStrategy()] })
    const first = await chain.push(tone())
    assert.equal(first.strategy, 'passthrough')
    assert.equal(first.fallbackFrom, 'broken')
    assert.deepEqual(chain.disabled, ['broken'])
    await chain.push(tone())
    assert.equal(calls, 1, '被禁用的策略不应再被调用')
    assert.equal(chain.failures.length, 1)
  } finally {
    console.warn = warn
  }
})

test('降级链：异步策略超时同样降级，不阻塞音频循环', async () => {
  const slow = {
    id: 'slow',
    reset() {},
    push() {
      return new Promise(() => {})
    },
  }
  const warn = console.warn
  console.warn = () => {}
  try {
    const chain = createEndpointChain({ strategies: [slow, createPassthroughStrategy()], timeoutMs: 30 })
    const decision = await chain.push(tone())
    assert.equal(decision.strategy, 'passthrough')
    assert.equal(decision.fallbackFrom, 'slow')
  } finally {
    console.warn = warn
  }
})

test('provider 自带语义断句时用 passthrough，本地不插嘴', async () => {
  const chain = resolveEndpointChain({ capabilities: { semanticTurn: true }, order: ['energy-vad'] })
  const decision = await chain.push(tone())
  assert.equal(decision.strategy, 'passthrough')
  assert.equal(decision.speechStopped, undefined)
})

test('音频格式不合法也不应抛错（帧长 0 / 空输入）', async () => {
  const chain = resolveEndpointChain({ order: ['energy-vad'] })
  const empty = await chain.push(new Int16Array(0))
  const missing = await chain.push(undefined)
  assert.equal(empty.speechStarted, undefined)
  assert.equal(missing.speechStarted, undefined)
})

test('reset 清空回合状态，dispose 逐个释放策略', async () => {
  let disposed = 0
  const strategy = {
    ...createPassthroughStrategy(),
    id: 'with-dispose',
    async dispose() {
      disposed += 1
    },
  }
  const chain = createEndpointChain({ strategies: [strategy] })
  await chain.push(tone())
  chain.reset()
  await chain.dispose()
  assert.equal(disposed, 1)
})

test('没有可用策略时链尾兜底为 passthrough，不会静默失联', () => {
  const chain = resolveEndpointChain({ order: ['not-registered'] })
  assert.deepEqual(chain.strategies, ['passthrough'])
})
