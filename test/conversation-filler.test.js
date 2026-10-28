import test from 'node:test'
import assert from 'node:assert/strict'
import { createConversationFiller } from '../src/conversation-filler.js'
import { createNativeServices } from '../src/native-services.js'

const stop = { type: 'finish', reason: { kind: 'stop' } }
const delta = text => ({ type: 'text-delta', index: 0, text })
function harness(chunks = [delta('"稍等一下。"'), stop], options) {
  const calls = []
  const ctx = { get(name) {
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }) }
    if (name === 'llm') return { async prepareCall(config, signal, configure) {
      const call = { config, signal };calls.push(call)
      const { provider, model, ...controls } = config
      const metadata = options?.modelInfo ?? { reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }
      const configured = configure ? configure(controls, metadata) : controls
      return { config: { ...configured, provider, model }, stream(request) {
        call.request = request
        return (async function* () { for (const chunk of chunks) { if (chunk instanceof Error) throw chunk;yield chunk } })()
      } }
    } }
    if (name === 'agents') throw new Error('Must not create an agent')
  } }
  return { ...createConversationFiller(ctx, options), ctx, calls }
}

test('all four events use the default prepared model directly with bounded output and persona context', async () => {
  const h = harness()
  for (const reason of ['interrupt', 'tool-wait', 'thinking', 'transition']) {
    assert.equal(await h.generateFiller({ reason, persona: '口语、简短', language: 'zh-CN', toolName: 'read', history: [{ role: 'user', text: '继续查一下' }] }), '稍等一下。')
    const { config, request, signal } = h.calls.at(-1)
    assert.deepEqual(config, { provider: 'default-provider', model: 'default-model', maxTokens: 96 })
    assert.equal(request.reasoningEffort, 'low')
    assert.equal(request.signal, signal)
    assert.deepEqual(request.tools, [])
    assert.equal(request.messages[0].role, 'user')
    assert.deepEqual(request.messages[0].source, { kind: 'user' })
    assert.equal(typeof request.system, 'string')
    assert.match(request.system, /Never speak tool names/)
    assert.ok(request.messages[0].id)
    const input = JSON.parse(request.messages[0].content[0].text)
    assert.equal(input.persona, '口语、简短')
    assert.equal(input.reason, reason)
    assert.match(request.system, /Never claim a tool succeeded/)
    assert.match(request.system, /Never reveal or fabricate internal reasoning/)
    assert.match(request.system, /language actually used by the most recent user utterance/)
    assert.match(request.system, /language field is only a fallback/)
  }
})

test('silence, invalid JSON, repetition, long output and failed finishes return empty strings', async () => {
  for (const raw of ['""', 'plain text', '{"text":"hello"}', JSON.stringify('x'.repeat(81)), JSON.stringify('a\nb'), '"already said"']) {
    const h = harness([delta(raw), stop])
    assert.equal(await h.generateFiller({ reason: 'thinking', previousFillers: ['already said'] }), '')
  }
  for (const kind of ['max-tokens', 'error', 'aborted', 'tool-calls']) {
    assert.equal(await harness([delta('"partial"'), { type: 'finish', reason: { kind } }]).generateFiller({ reason: 'thinking' }), '')
  }
  assert.equal(await harness([delta('"partial"')]).generateFiller({ reason: 'thinking' }), '')
  assert.equal(await harness([new Error('provider failure')]).generateFiller({ reason: 'thinking' }), '')
})

test('only text blocks are assembled, final blocks replace deltas without duplication', async () => {
  const h = harness([
    { type: 'reasoning-delta', index: 2, text: 'private reasoning' },
    { type: 'block-end', index: 2, block: { type: 'reasoning', text: 'private reasoning' } },
    delta('"稍等'),
    { type: 'block-end', index: 0, block: { type: 'text', text: '"稍等一下。"' } },
    delta('ignored'), stop,
  ])
  assert.equal(await h.generateFiller({ reason: 'tool-wait' }), '稍等一下。')
  assert.equal(await harness([{ type: 'tool-call-delta', name: 'read' }, stop]).generateFiller({ reason: 'thinking' }), '')
})

test('context is bounded, keeps recent turns and excludes reasoning and arbitrary fields', async () => {
  const h = harness()
  await h.generateFiller({ reason: 'transition', persona: 'p'.repeat(9000), language: 'l'.repeat(500), toolName: 't'.repeat(500),
    history: Array.from({ length: 20 }, (_, i) => ({ role: 'user', secret: 'not forwarded', content: [{ type: 'reasoning', text: 'not forwarded' }, { type: 'text', text: `${i}:` + 'h'.repeat(4000) }] })),
    previousFillers: Array(100).fill('f'.repeat(1000)),
  })
  const serialized = h.calls[0].request.messages[0].content[0].text
  const input = JSON.parse(serialized)
  assert.ok(serialized.length < 9000)
  assert.equal(input.history.length, 8)
  assert.ok(input.history[0].text.startsWith('12:'))
  assert.equal(input.persona.length, 2000)
  assert.equal(input.previousFillers.length, 8)
  assert.ok(!serialized.includes('not forwarded'))
})

test('missing services, invalid reason and pre-cancelled requests do not dispatch', async () => {
  assert.equal(await createConversationFiller({}).generateFiller({ reason: 'thinking' }), '')
  const h = harness()
  assert.equal(await h.generateFiller({ reason: 'invalid' }), '')
  const c = new AbortController();c.abort()
  assert.equal(await h.generateFiller({ reason: 'thinking', signal: c.signal }), '')
  assert.equal(h.calls.length, 0)
})

test('abort and timeout settle even when preparation or streaming ignores cancellation', async () => {
  for (const phase of ['prepare', 'stream']) {
    let observedSignal
    const ctx = { get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      if (name === 'llm') return { prepareCall(config, signal) {
        observedSignal = signal
        if (phase === 'prepare') return new Promise(() => {})
        return Promise.resolve({ config, stream: () => ({ [Symbol.asyncIterator]() { return this }, next: () => new Promise(() => {}) }) })
      } }
    } }
    const c = new AbortController()
    const h = createConversationFiller(ctx)
    const pending = h.generateFiller({ reason: 'thinking', signal: c.signal })
    await Promise.resolve();await Promise.resolve()
    c.abort()
    assert.equal(await pending, '')
    assert.equal(observedSignal.aborted, true)
    const timed = createConversationFiller(ctx, { timeoutMs: 10 })
    assert.equal(await timed.generateFiller({ reason: 'thinking' }), '')
    assert.equal(observedSignal.aborted, true)
  }
})

test('reasoning selection uses only advertised known low-latency levels', async () => {
  for (const [ids, expected] of [
    [['high', 'low', 'minimal', 'off'], 'off'],
    [['high', 'low', 'minimal'], 'minimal'],
    [['high', 'low'], 'low'],
    [['custom-deep'], undefined],
    [[], undefined],
  ]) {
    const modelInfo = ids.length ? { reasoning: { efforts: ids.map(id => ({ id, name: id })), defaultEffort: ids[0] } } : {}
    const h = harness(undefined, { modelInfo })
    assert.equal(await h.generateFiller({ reason: 'thinking' }), '稍等一下。')
    assert.equal(h.calls[0].request.reasoningEffort, expected)
  }
})

test('interrupt is constrained to an extremely brief acknowledgment or silence', async () => {
  for (const output of ['好，你说。', 'Go ahead, I’m listening.']) {
    assert.equal(await harness([delta(JSON.stringify(output)), stop]).generateFiller({ reason: 'interrupt' }), output)
  }
  for (const output of ['这'.repeat(13), 'Please go ahead I am listening']) {
    assert.equal(await harness([delta(JSON.stringify(output)), stop]).generateFiller({ reason: 'interrupt' }), '')
  }
  const h = harness()
  await h.generateFiller({ reason: 'interrupt' })
  assert.match(h.calls[0].request.system, /at most 12 Chinese characters or 4 English words/)
  assert.match(h.calls[0].request.system, /about 2 seconds spoken/)
})

test('outcome callback fires exactly once with safe classifications', async () => {
  const aborted = new AbortController();aborted.abort()
  for (const [h, input, expected] of [
    [harness(), {}, 'generated'],
    [harness([delta('""'), stop]), {}, 'silent'],
    [harness([delta('bad JSON'), stop]), {}, 'invalid'],
    [harness([new Error('do not expose this secret')]), {}, 'error'],
    [harness(), { signal: aborted.signal }, 'cancelled'],
    [harness(), { reason: 'unknown' }, 'invalid'],
    [createConversationFiller({}), {}, 'error'],
  ]) {
    const outcomes = []
    await h.generateFiller({ reason: 'thinking', ...input, onOutcome: value => outcomes.push(value) })
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0].status, expected)
    assert.ok(Number.isFinite(outcomes[0].latencyMs))
    assert.ok(Object.keys(outcomes[0]).every(key => ['status', 'latencyMs', 'code'].includes(key)))
    assert.ok(!JSON.stringify(outcomes).includes('secret'))
  }
  const outcomes = []
  const h = createConversationFiller({ get: name => name === 'agentDefaultModel'
    ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
    : { prepareCall: () => new Promise(() => {}) } }, { timeoutMs: 5 })
  assert.equal(await h.generateFiller({ reason: 'thinking', onOutcome: value => outcomes.push(value) }), '')
  assert.equal(outcomes.length, 1)
  assert.equal(outcomes[0].status, 'timeout')
  for (const onOutcome of [() => { throw new Error('callback failed') }, async () => { throw new Error('callback failed') }]) {
    assert.equal(await harness().generateFiller({ reason: 'thinking', onOutcome }), '稍等一下。')
  }
})

test('native wiring exposes filler and prevents requests after disposal', async () => {
  const h = harness()
  const native = createNativeServices(h.ctx)
  assert.equal(await native.generateFiller({ reason: 'interrupt' }), '稍等一下。')
  await native.dispose()
  assert.equal(await native.generateFiller({ reason: 'thinking' }), '')
  assert.equal(h.calls.length, 1)
})
