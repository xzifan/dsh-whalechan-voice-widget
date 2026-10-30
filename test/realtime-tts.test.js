import test from 'node:test'
import assert from 'node:assert/strict'
import { createRealtimeSession, realtimeDefaults } from '../src/core/realtime-service.js'
import { applyRealtimeEvent, finalizeRealtimeMessages } from '../web/src/lib/realtime.js'

const visibleState = s => s.events.reduce(applyRealtimeEvent, { messages: [], toolCalls: [] })
for (const automatic of [false, true]) {
  for (const doneFirst of [false, true]) test(`${automatic ? 'automatic' : 'explicit'} TTS delivers text only after audio, provider done ${doneFirst ? 'first' : 'last'}`, async () => {
    const waiting = deferred()
    const s = setup(() => waiting.promise)
    s.start()
    s.socket.event('response.text.delta', { response_id: 'r1', delta: '你好' })
    s.socket.event('response.text.done', { response_id: 'r1', text: '你好主人' })
    assert.equal(visibleState(s).messages.length, 0)
    if (!automatic) s.tool('speech')
    if (doneFirst || automatic) s.done()
    await tick()
    assert.equal(visibleState(s).messages.length, 0)
    assert.notEqual(visibleState(s).done, true)
    assert.equal(s.events.filter(e => ['transcript-delta', 'transcript-done', 'tts-transcript', 'done'].includes(e.type)).length, 0)
    waiting.resolve({ __previewData: 'audio' })
    await tick()
    const audioIndex = s.events.findIndex(e => e.type === 'preview-audio')
    const textIndex = s.events.findIndex(e => e.type === 'tts-transcript')
    assert.ok(audioIndex >= 0 && textIndex > audioIndex)
    assert.equal(visibleState(s).messages[0].text, '你好主人')
    if (!doneFirst && !automatic) s.done()
    assert.equal(visibleState(s).done, true)
    assert.equal(visibleState(s).messages[0].status, 'complete')
    assert.equal(s.events.filter(e => e.type === 'done').length, 1)
    s.session.dispose()
  })

  for (const kind of ['throw', 'error-result', 'no-audio']) test(`${automatic ? 'automatic' : 'explicit'} TTS ${kind} releases marked fallback text`, async () => {
    const waiting = deferred()
    const s = setup(() => waiting.promise)
    s.start()
    if (automatic) s.socket.event('response.text.done', { response_id: 'r1', text: '你好主人' })
    else s.tool('speech')
    s.done()
    await tick()
    assert.equal(visibleState(s).messages.length, 0)
    if (kind === 'throw') waiting.reject(new Error('cannot synthesize'))
    else waiting.resolve(kind === 'error-result' ? { error: 'cannot synthesize' } : {})
    await tick()
    const state = visibleState(s)
    assert.equal(state.messages[0].text, '你好主人')
    assert.equal(state.messages[0].delivery, 'failed')
    assert.ok(state.error)
    assert.equal(state.done, true)
    assert.equal(state.toolCalls[0].status, 'failed')
    assert.equal(s.events.filter(e => e.type === 'preview-audio').length, 0)
    s.session.dispose()
  })

  for (const cancel of ['speech-start', 'cancel', 'dispose', 'provider']) test(`${automatic ? 'automatic' : 'explicit'} TTS ${cancel} discards undisplayed text and late delivery`, async () => {
    const waiting = deferred()
    const s = setup(() => waiting.promise)
    s.start()
    s.socket.event('response.text.done', { response_id: 'r1', text: '你好主人' })
    if (!automatic) s.tool('speech')
    // Provider cancellation must precede its first response.done.
    if (cancel !== 'provider' || automatic) s.done()
    await tick()
    if (cancel === 'speech-start') s.socket.event('input_audio_buffer.speech_started', { item_id: 'next' })
    else if (cancel === 'provider' && !automatic) s.done('r1', { status: 'cancelled' })
    else s.session[cancel === 'provider' ? 'cancel' : cancel]()
    waiting.resolve({ __previewData: 'late-audio' })
    await tick()
    const state = finalizeRealtimeMessages(visibleState(s))
    assert.equal(state.messages.filter(message => message.role === 'assistant').length, 0)
    if (cancel === 'speech-start') {
      assert.equal(state.messages.length, 1)
      assert.equal(state.messages[0].role, 'user')
      assert.equal(state.messages[0].text, '')
      assert.equal(state.messages[0].voice, true)
    } else assert.equal(state.messages.length, 0)
    assert.equal(state.toolCalls[0].status, 'cancelled')
    assert.equal(s.events.filter(e => ['preview-audio', 'tts-transcript', 'done'].includes(e.type)).length, 0)
    s.session.dispose()
  })
}

test('each speech call reveals only its own text and done waits for all queued speech', async () => {
  const first = deferred(), second = deferred()
  const s = setup((_name, args) => args.text === '第一段' ? first.promise : second.promise)
  s.start()
  s.tool('one', 'synth_tts', 'r1', { text: '第一段' })
  s.tool('two', 'synth_tts', 'r1', { text: '第二段' })
  s.done()
  await tick()
  assert.equal(visibleState(s).messages.length, 0)
  first.resolve({ __previewData: 'first' })
  await tick()
  assert.equal(visibleState(s).messages.map(m => m.text).join(''), '第一段')
  assert.notEqual(visibleState(s).done, true)
  second.resolve({ __previewData: 'second' })
  await tick()
  assert.equal(visibleState(s).messages.map(m => m.text).join(''), '第一段第二段')
  assert.equal(visibleState(s).done, true)
  for (const callId of ['one', 'two']) {
    assert.ok(s.events.findIndex(e => e.type === 'preview-audio' && e.callId === callId) < s.events.findIndex(e => e.type === 'tts-transcript' && e.callId === callId))
  }
  s.session.dispose()
})

test('native mode retains immediate streaming text and completion without TTS', () => {
  const s = setup(undefined, { use_tts_voice: false })
  s.start()
  s.socket.event('response.text.delta', { response_id: 'r1', delta: '原生' })
  assert.equal(visibleState(s).messages[0].text, '原生')
  assert.equal(visibleState(s).messages[0].status, 'streaming')
  s.socket.event('response.audio.delta', { response_id: 'r1', delta: 'AAAA' })
  s.socket.event('response.text.done', { response_id: 'r1', text: '原生回复' })
  s.done()
  assert.equal(visibleState(s).messages[0].text, '原生回复')
  assert.equal(visibleState(s).done, true)
  assert.equal(s.events.filter(e => e.type === 'audio').length, 1)
  assert.equal(s.events.filter(e => e.type === 'tool-start').length, 0)
  s.session.dispose()
})

const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function setup(executeTool = async () => ({}), settings = {}) {
  const events = []
  let socket
  class Socket {
    constructor() { socket = this; this.readyState = 1; this.sent = []; this.handlers = {} }
    on(name, fn) { this.handlers[name] = fn }
    send(data) { this.sent.push(JSON.parse(data)) }
    close() { this.readyState = 3; this.handlers.close?.() }
    event(type, fields = {}) { this.handlers.message(Buffer.from(JSON.stringify({ type, ...fields }))) }
  }
  const session = createRealtimeSession({ settings: { ...realtimeDefaults(), ...settings }, key: 'secret', executeTool, emit: event => events.push(event), WebSocketCtor: Socket })
  session.connect()
  const start = (id = 'r1') => socket.event('response.created', { response: { id } })
  const tool = (callId, name = 'synth_tts', responseId = 'r1', args = { text: '你好主人' }) => socket.event('response.output_item.done', { response_id: responseId, item: { id: `item-${callId}`, type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) } })
  const done = (id = 'r1', extra = {}) => socket.event('response.done', { response: { id, status: 'completed', ...extra } })
  const requests = () => socket.sent.filter(event => event.type === 'response.create')
  const outputs = () => socket.sent.filter(event => event.item?.type === 'function_call_output')
  return { session, socket, events, start, tool, done, requests, outputs }
}

test('HQ synthesis is terminal, deduplicates call IDs, and never plays native audio', async () => {
  let executions = 0, toolContext
  const s = setup(async (_name, _args, context) => { executions++; toolContext = context; return { __previewData: 'tts-audio' } })
  s.socket.event('session.created')
  s.session.createResponse()
  s.socket.event('input_audio_buffer.speech_started', { item_id: 'user-1' })
  s.start()
  s.tool('speech')
  s.tool('speech')
  s.socket.event('response.audio.delta', { response_id: 'r1', delta: 'native-audio' })
  s.done('r1', { output: [{ type: 'function_call', call_id: 'speech', name: 'synth_tts', arguments: '{"text":"你好主人"}' }] })
  await tick()
  s.tool('speech')
  s.done()
  assert.equal(executions, 1)
  assert.equal(s.requests().length, 1)
  assert.deepEqual(s.requests()[0].response.modalities, ['text'])
  assert.deepEqual(s.socket.sent.find(e => e.type === 'session.update').session.modalities, ['text'])
  assert.equal(s.outputs().length, 1)
  assert.equal(s.events.filter(e => e.type === 'preview-audio').length, 1)
  assert.equal(s.events.filter(e => e.type === 'audio').length, 0)
  const transcript = s.events.find(e => e.type === 'tts-transcript')
  assert.match(transcript.messageId, /^turn-[\da-f-]+:assistant$/)
  assert.equal(transcript.messageId, toolContext.messageId)
  assert.equal(transcript.turnId, toolContext.turnId)
  assert.equal(toolContext.responseId, 'r1')
  assert.equal(toolContext.callId, 'speech')
  assert.equal(s.events.filter(e => e.type === 'tool-start').length, 1)
  assert.equal(s.events.filter(e => e.type === 'tool-end').length, 1)
  assert.equal(s.events.find(e => e.type === 'audit' && e.record.kind === 'tool').record.text, 'synth_tts')
})

for (const doneFirst of [false, true]) test(`two tools resume once after all outputs, response.done ${doneFirst ? 'first' : 'last'}`, async () => {
  const slow = deferred(), fast = deferred()
  const s = setup(name => name === 'get_voice_config' ? slow.promise : fast.promise)
  s.start()
  s.tool('slow', 'get_voice_config')
  s.tool('fast', 'list_voice_presets')
  if (doneFirst) s.done()
  fast.resolve({ ok: true })
  await tick()
  assert.equal(s.outputs().length, 1)
  assert.equal(s.requests().length, 0)
  slow.resolve({ ok: true })
  await tick()
  assert.equal(s.outputs().length, 2)
  if (!doneFirst) {
    assert.equal(s.requests().length, 0)
    s.done()
  }
  assert.equal(s.requests().length, 1)
  assert.deepEqual(s.requests()[0].response.modalities, ['text'])
  s.done()
  assert.equal(s.requests().length, 1)
})

test('successful speech in a mixed tool batch suppresses further answers; failed speech can recover', async () => {
  const s = setup(async name => name === 'synth_tts' ? { __previewData: 'speech' } : {})
  s.start()
  s.tool('read', 'get_voice_config')
  s.tool('speech')
  s.done()
  await tick()
  assert.equal(s.outputs().length, 2)
  assert.equal(s.requests().length, 0)
  const failure = setup(async () => ({ error: 'synthesis unavailable' }))
  failure.start()
  failure.tool('speech')
  failure.done()
  await tick()
  assert.equal(failure.requests().length, 1)
  assert.equal(failure.events.find(e => e.type === 'tool-end').ok, false)
})

for (const interrupt of ['speech-start', 'cancel', 'dispose']) test(`late tool completion after ${interrupt} cannot play audio or continue`, async () => {
  const waiting = deferred()
  const s = setup(() => waiting.promise)
  s.start()
  s.tool('speech')
  s.done()
  await tick()
  if (interrupt === 'speech-start') s.socket.event('input_audio_buffer.speech_started', { item_id: 'next-user' })
  else s.session[interrupt]()
  const eventsAfterInterrupt = s.events.length
  waiting.resolve({ __previewData: 'stale-audio', __applyVoiceId: 'stale-voice' })
  await tick()
  s.socket.event('response.audio.delta', { response_id: 'r1', delta: 'late-native' })
  s.socket.event('response.text.done', { response_id: 'r1', text: '旧回答' })
  assert.equal(s.requests().length, 0)
  assert.equal(s.outputs().length, 0)
  assert.equal(s.events.filter(e => ['preview-audio', 'voice-applied', 'audio', 'transcript-done'].includes(e.type)).length, 0)
  assert.equal(s.events.length, eventsAfterInterrupt)
  const audit = s.events.find(e => e.type === 'audit' && e.record.kind === 'tool')
  assert.equal(audit.record.status, 'cancelled')
})

test('native mode retains audio modalities for initial and tool continuation requests', async () => {
  const s = setup(async () => ({}), { use_tts_voice: false })
  s.socket.event('session.created')
  s.session.createResponse()
  s.start()
  s.tool('config', 'get_voice_config')
  s.done()
  await tick()
  s.start('r2')
  s.socket.event('response.audio.delta', { response_id: 'r2', delta: 'native' })
  assert.deepEqual(s.socket.sent.find(e => e.type === 'session.update').session.modalities, ['text', 'audio'])
  assert.equal(s.requests().length, 2)
  assert.ok(s.requests().every(e => JSON.stringify(e.response.modalities) === '["text","audio"]'))
  assert.equal(s.events.find(e => e.type === 'audio').data, 'native')
})

test('turn IDs survive tool continuations and late user transcription uses its original item mapping', async () => {
  const contexts = []
  const s = setup(async (_name, _args, ctx) => { contexts.push(ctx); return {} })
  s.socket.event('input_audio_buffer.speech_started', { item_id: 'u1' })
  s.start('r1')
  s.tool('config', 'get_voice_config')
  s.done()
  await tick()
  s.start('r2')
  s.tool('speech', 'synth_tts', 'r2')
  s.done('r2')
  await tick()
  s.socket.event('input_audio_buffer.speech_started', { item_id: 'u2' })
  s.socket.event('input_audio_buffer.committed', { item_id: 'u1' })
  s.socket.event('conversation.item.input_audio_transcription.completed', { item_id: 'u1', transcript: '原始问题' })
  s.socket.event('conversation.item.input_audio_transcription.completed', { item_id: 'u2', transcript: '下一轮问题' })
  const transcripts = s.events.filter(e => e.type === 'user-transcript-done')
  assert.equal(contexts[0].turnId, contexts[1].turnId)
  assert.equal(contexts[0].messageId, contexts[1].messageId)
  assert.equal(transcripts[0].messageId, `${contexts[0].turnId}:user`)
  assert.notEqual(transcripts[0].turnId, transcripts[1].turnId)
  assert.equal(transcripts[0].itemId, 'u1')
  assert.equal(s.events.find(e => e.type === 'tts-transcript').messageId, contexts[1].messageId)
})

test('Qwen text events and response.done fallback finalize once with real usage even for tools-only output', async () => {
  const s = setup(undefined, { use_tts_voice: false })
  s.socket.event('input_audio_buffer.speech_started', { item_id: 'user' })
  s.start()
  s.socket.event('response.text.delta', { response_id: 'r1', item_id: 'assistant-item', delta: '你好' })
  s.socket.event('response.text.done', { response_id: 'r1', item_id: 'assistant-item', text: '你好主人' })
  const usage = { total_tokens: 17, input_tokens: 11, output_tokens: 6, input_tokens_details: { audio_tokens: 9 } }
  s.done('r1', { output: [{ id: 'assistant-item', type: 'message', content: [{ type: 'text', text: '你好主人' }] }], usage })
  assert.equal(s.events.filter(e => e.type === 'transcript-done').length, 1)
  const deltas = s.events.filter(e => e.type.startsWith('transcript-'))
  assert.equal(deltas[0].messageId, deltas[1].messageId)
  const usageAudit = s.events.find(e => e.type === 'audit' && e.record.kind === 'response').record
  assert.deepEqual(usageAudit.usage, usage)
  assert.equal(usageAudit.provider, 'bailian')
  assert.equal(usageAudit.responseId, 'r1')
  assert.equal(usageAudit.messageId, deltas[0].messageId)
  s.start('r2')
  s.done('r2', { output: [{ id: 'fallback', type: 'message', content: [{ type: 'text', text: '没有增量的回答' }] }] })
  assert.equal(s.events.filter(e => e.type === 'transcript-done').at(-1).text, '没有增量的回答')
  assert.equal(s.events.filter(e => e.type === 'audit' && e.record.kind === 'usage').length, 0)
  s.start('r3')
  s.done('r3', { output: [{ id: 'tool-only', type: 'function_call', name: 'get_voice_config', call_id: 'config', arguments: '{}' }], usage: { input_tokens: 3, output_tokens: 2 } })
  await tick()
  assert.equal(s.events.filter(e => e.type === 'audit' && e.record.kind === 'usage').length, 0)
  assert.deepEqual(s.events.find(e => e.type === 'audit' && e.record.responseId === 'r3' && e.record.kind === 'response').record.usage, { input_tokens: 3, output_tokens: 2 })
  assert.equal(s.requests().length, 1)
})

test('late tool rejection is ignored after cancellation, including recovery in the next turn', async () => {
  const old = deferred()
  const s = setup(name => name === 'get_voice_config' ? old.promise : Promise.resolve({ __previewData: 'new-audio' }))
  s.start()
  s.tool('old', 'get_voice_config')
  s.done()
  s.session.cancel()
  s.socket.event('input_audio_buffer.speech_started', { item_id: 'new-user' })
  s.start('new-response')
  s.tool('new', 'synth_tts', 'new-response')
  s.done('new-response')
  old.reject(new Error('old failure should not surface'))
  await tick()
  assert.equal(s.outputs().length, 1)
  assert.equal(s.outputs()[0].item.call_id, 'new')
  assert.equal(s.requests().length, 0)
  assert.deepEqual(s.events.filter(e => e.type === 'preview-audio').map(e => e.data), ['new-audio'])
  assert.equal(s.events.filter(e => e.type === 'tool-end' && e.callId === 'old').length, 1)
})

test('server cancelled response marks outstanding tools cancelled and retains actual usage', async () => {
  const waiting = deferred()
  const s = setup(() => waiting.promise)
  s.start()
  s.tool('config', 'get_voice_config')
  s.done('r1', { status: 'cancelled', usage: { input_tokens: 7, output_tokens: 1 } })
  waiting.resolve({ __previewData: 'cancelled-audio' })
  await tick()
  assert.equal(s.events.find(e => e.type === 'tool-end').status, 'cancelled')
  // A cancelled call reports its own outcome and must not invent an exit code.
  const cancelledEnd = s.events.find(e => e.type === 'tool-end')
  assert.equal(cancelledEnd.outcome, 'cancelled')
  assert.equal(cancelledEnd.ok, false)
  assert.equal('exitCode' in cancelledEnd, false)
  const responseAudit = s.events.find(e => e.type === 'audit' && e.record.kind === 'response').record
  assert.equal(responseAudit.status, 'cancelled')
  assert.deepEqual(responseAudit.usage, { input_tokens: 7, output_tokens: 1 })
  assert.equal(s.requests().length, 0)
  assert.equal(s.outputs().length, 0)
  assert.equal(s.events.filter(e => e.type === 'preview-audio').length, 0)
})

test('response transcript audit includes usage and stays finalized after cancellation', () => {
  const s = setup()
  s.start()
  s.socket.event('response.text.delta', { response_id: 'r1', item_id: 'text-1', delta: '完整' })
  s.socket.event('response.text.done', { response_id: 'r1', item_id: 'text-1', text: '完整回答' })
  s.done('r1', { usage: { input_tokens: 2, output_tokens: 3 } })
  s.session.cancel()
  const records = s.events.filter(e => e.type === 'audit').map(e => e.record)
  const responses = records.filter(record => record.kind === 'response')
  assert.equal(responses.length, 1)
  assert.equal(responses[0].text, '完整回答')
  assert.equal(responses[0].status, 'completed')
  assert.deepEqual(responses[0].usage, { input_tokens: 2, output_tokens: 3 })
  assert.equal(records.filter(record => record.kind === 'usage').length, 0)
})

for (const interrupt of ['speech-start', 'cancel', 'dispose']) test(`unfinished assistant transcript is audited once on ${interrupt}`, () => {
  const s = setup()
  s.start()
  s.socket.event('response.text.delta', { response_id: 'r1', item_id: 'partial-item', delta: '还没说完' })
  if (interrupt === 'speech-start') s.socket.event('input_audio_buffer.speech_started', { item_id: 'next-user' })
  else s.session[interrupt]()
  let responses = s.events.filter(e => e.type === 'audit' && e.record.kind === 'response')
  assert.equal(responses.length, 1)
  assert.equal(responses[0].record.text, '还没说完')
  assert.equal(responses[0].record.status, 'cancelled')
  assert.equal(responses[0].record.itemId, 'partial-item')
  assert.ok(Number.isInteger(responses[0].record.firstTextMs), '文字首字延迟必须落审计')
  if (interrupt === 'speech-start') {
    assert.equal(responses[0].record.interrupted, true)
    assert.ok(Number.isInteger(responses[0].record.playedMs), '打断必须带已播时长（可为 0）')
  } else {
    assert.equal('interrupted' in responses[0].record, false, '手动取消/关闭不是打断')
    assert.equal('playedMs' in responses[0].record, false)
  }
  s.done('r1', { status: 'cancelled', usage: { input_tokens: 2, output_tokens: 1 } })
  responses = s.events.filter(e => e.type === 'audit' && e.record.kind === 'response')
  assert.equal(responses.length, interrupt === 'dispose' ? 1 : 2)
  assert.equal(responses[0].record.usage, undefined)
  if (interrupt !== 'dispose') {
    assert.deepEqual(responses[1].record, { ...responses[0].record, usage: { input_tokens: 2, output_tokens: 1 } })
    s.done('r1', { status: 'cancelled', usage: { input_tokens: 2, output_tokens: 1 } })
    assert.equal(s.events.filter(e => e.type === 'audit' && e.record.kind === 'response').length, 2)
  }
  assert.equal(s.events.filter(e => e.type === 'audit' && e.record.kind === 'usage').length, 0)
})

test('fast successful TTS receives late model usage on the original response audit', async () => {
  const s = setup(async () => ({ __previewData: 'speech' }))
  s.start()
  s.tool('speech')
  await tick()
  const audit = () => s.events.filter(e => e.type === 'audit' && e.record.kind === 'response').map(e => e.record)
  const original = audit()[0]
  assert.equal(original.text, '你好主人')
  assert.equal(original.callId, 'speech')
  assert.equal(original.usage, undefined)
  s.done('r1', { usage: { input_tokens: 4, output_tokens: 2 } })
  assert.deepEqual(audit(), [original, { ...original, usage: { input_tokens: 4, output_tokens: 2 } }])
  assert.equal(s.events.filter(e => e.type === 'preview-audio').length, 1)
  assert.equal(s.events.filter(e => e.type === 'audit' && e.record.kind === 'usage').length, 0)
  s.session.dispose()
})

test('duplicate completion enriches missing usage once without replaying response side effects', () => {
  const s = setup(undefined, { use_tts_voice: false })
  s.start()
  s.done('r1', { output: [{ type: 'message', content: [{ text: 'Answer' }] }] })
  const original = s.events.find(e => e.type === 'audit').record
  const usage = { total_tokens: 0, input_tokens_details: { audio_tokens: 0 } }
  s.done('r1', { usage: { ...usage, secret: 'hidden', total: -1 } })
  s.done('r1', { usage })
  for (const invalid of [null, [], {}, { total_tokens: 'unknown' }, { total_tokens: -1 }]) s.done('r1', { usage: invalid })
  assert.deepEqual(s.events.filter(e => e.type === 'audit').map(e => e.record), [original, { ...original, usage }])
  assert.equal(s.events.filter(e => e.type === 'done').length, 1)
  assert.equal(s.events.filter(e => e.type === 'transcript-done').length, 1)
  s.session.dispose()
})

test('late usage without a provider response ID retains the original audit identity', () => {
  const s = setup(undefined, { use_tts_voice: false })
  s.socket.event('response.text.delta', { delta: 'Partial' })
  s.session.cancel()
  const original = s.events.find(e => e.type === 'audit').record
  s.socket.event('response.done', { response: { status: 'cancelled', usage: { total_tokens: 5 } } })
  assert.deepEqual(s.events.filter(e => e.type === 'audit').map(e => e.record), [original, { ...original, usage: { total_tokens: 5 } }])
  s.session.dispose()
})

test('provider cancelled response.done captures partial text without a final transcript event', () => {
  const s = setup()
  s.start()
  s.socket.event('response.text.delta', { response_id: 'r1', delta: '部分回答' })
  s.done('r1', { status: 'cancelled' })
  const responses = s.events.filter(e => e.type === 'audit' && e.record.kind === 'response')
  assert.equal(responses.length, 1)
  assert.equal(responses[0].record.text, '部分回答')
  assert.equal(responses[0].record.status, 'cancelled')
})

for (const firstSource of ['text', 'audio_transcript']) test(`native transcript ignores duplicate channels when ${firstSource} arrives first`, () => {
  const s = setup(undefined, { use_tts_voice: false })
  const otherSource = firstSource === 'text' ? 'audio_transcript' : 'text'
  s.start()
  for (const delta of ['你好', '主人']) {
    s.socket.event(`response.${firstSource}.delta`, { response_id: 'r1', item_id: 'message', delta })
    s.socket.event(`response.${otherSource}.delta`, { response_id: 'r1', item_id: 'message', delta })
  }
  s.done('r1', { output: [{ id: 'message', type: 'message', content: [{ type: 'text', text: '你好主人' }, { type: 'audio', transcript: '你好主人' }] }] })
  assert.equal(s.events.filter(e => e.type === 'transcript-delta').map(e => e.text).join(''), '你好主人')
  assert.equal(s.events.find(e => e.type === 'transcript-done').text, '你好主人')
  assert.equal(s.events.filter(e => e.type === 'audit' && e.record.kind === 'response').length, 1)
})

test('identical speech calls in one turn share synthesis while preserving outputs; new turns and different text speak', async () => {
  let executions = 0
  const waiting = deferred()
  const s = setup(async () => { executions++; return executions === 1 ? waiting.promise : { __previewData: `audio-${executions}` } })
  s.start()
  s.tool('speech-one')
  s.tool('speech-two')
  s.done()
  await tick()
  assert.equal(executions, 1)
  waiting.resolve({ __previewData: 'audio-1' })
  await tick()
  assert.equal(s.outputs().length, 2)
  assert.equal(s.events.filter(e => e.type === 'preview-audio').length, 1)
  assert.equal(s.events.filter(e => e.type === 'tts-transcript').length, 1)
  assert.equal(s.events.filter(e => e.type === 'audit' && e.record.kind === 'response').length, 1)
  assert.equal(s.requests().length, 0)
  s.start('r2')
  s.tool('speech-repeat', 'synth_tts', 'r2')
  s.tool('speech-different', 'synth_tts', 'r2', { text: '另一段话' })
  s.done('r2')
  await tick()
  assert.equal(executions, 2)
  assert.equal(s.outputs().length, 4)
  assert.equal(s.events.filter(e => e.type === 'preview-audio').length, 2)
  s.socket.event('input_audio_buffer.speech_started', { item_id: 'new-user' })
  s.start('r3')
  s.tool('speech-next-turn', 'synth_tts', 'r3')
  s.done('r3')
  await tick()
  assert.equal(executions, 3)
  assert.equal(s.events.filter(e => e.type === 'preview-audio').length, 3)
})

test('HQ final text automatically speaks once even with all voice tools disabled', async () => {
  const executions = []
  const s = setup(async (name, args, ctx) => { executions.push({ name, args, ctx }); return { __previewData: 'automatic-audio', __previewMime: 'audio/mpeg' } }, { tools: [] })
  s.start()
  s.socket.event('response.text.done', { response_id: 'r1', item_id: 'final-text', text: '你好主人' })
  assert.equal(executions.length, 0)
  s.done()
  s.done()
  await tick()
  assert.equal(executions.length, 1)
  assert.equal(executions[0].name, 'synth_tts')
  assert.deepEqual(executions[0].args, { text: '你好主人', language: 'zh' })
  assert.equal(executions[0].ctx.callId, 'auto-tts-r1')
  const preview = s.events.filter(e => e.type === 'preview-audio')
  assert.equal(preview.length, 1)
  assert.equal(preview[0].purpose, 'speech')
  assert.equal(preview[0].source, 'automatic')
  assert.equal(preview[0].mime, 'audio/mpeg')
  assert.equal(s.events.find(e => e.type === 'tts-transcript').messageId, preview[0].messageId)
  assert.equal(s.events.filter(e => e.type === 'transcript-done').length, 0)
  assert.equal(s.events.filter(e => e.type === 'tool-start').length, 1)
  assert.equal(s.events.find(e => e.type === 'tool-end').status, 'completed')
  assert.equal(s.events.filter(e => e.type === 'audit' && e.record.kind === 'response').length, 1)
  assert.equal(s.requests().length, 0)
  assert.equal(s.outputs().length, 0)
})

test('tool response spoken text and final continuation both speak', async () => {
  const executions = []
  const s = setup(async name => { executions.push(name); return name === 'synth_tts' ? { __previewData: 'answer' } : {} })
  s.start()
  s.done('r1', { output: [
    { type: 'message', content: [{ type: 'text', text: '我先查看一下。' }] },
    { type: 'function_call', call_id: 'read', name: 'get_voice_config', arguments: '{}' },
  ] })
  await tick()
  assert.deepEqual(executions, ['get_voice_config', 'synth_tts'])
  assert.equal(s.events.filter(e => e.type === 'preview-audio').length, 1)
  assert.equal(s.requests().length, 1)
  s.start('r2')
  s.done('r2', { output: [{ id: 'answer', type: 'message', content: [{ type: 'text', text: '已经查到了。' }] }] })
  await tick()
  assert.deepEqual(executions, ['get_voice_config', 'synth_tts', 'synth_tts'])
  assert.equal(s.events.filter(e => e.type === 'preview-audio').length, 2)
  assert.equal(s.requests().length, 1)
  assert.equal(s.outputs().length, 1)
})

test('model speech and automatic final text in the same turn share one playback', async () => {
  let executions = 0
  const s = setup(async () => { executions++; return { __previewData: 'speech' } })
  s.start()
  s.tool('model-speech')
  s.done('r1', { output: [{ type: 'message', content: [{ type: 'text', text: '你好主人' }] }] })
  await tick()
  assert.equal(executions, 1)
  assert.equal(s.events.filter(e => e.type === 'tool-start').length, 1)
  s.start('r2')
  s.done('r2', { output: [{ type: 'message', content: [{ type: 'text', text: '你好主人' }] }] })
  await tick()
  assert.equal(executions, 1)
  assert.equal(s.events.filter(e => e.type === 'preview-audio').length, 1)
  assert.equal(s.requests().length, 0)
  assert.equal(s.outputs().length, 1)
})

for (const interrupt of ['speech-start', 'cancel', 'dispose']) test(`automatic synthesis completion after ${interrupt} is suppressed`, async () => {
  const waiting = deferred()
  const s = setup(() => waiting.promise)
  s.start()
  s.done('r1', { output: [{ type: 'message', content: [{ type: 'text', text: '最终回答' }] }] })
  await tick()
  if (interrupt === 'speech-start') s.socket.event('input_audio_buffer.speech_started', { item_id: 'next' })
  else s.session[interrupt]()
  const count = s.events.length
  waiting.resolve({ __previewData: 'late' })
  await tick()
  assert.equal(s.events.length, count)
  assert.equal(s.events.filter(e => e.type === 'preview-audio').length, 0)
  assert.equal(s.events.find(e => e.type === 'tool-end').status, 'cancelled')
  assert.equal(s.requests().length, 0)
  assert.equal(s.outputs().length, 0)
})

for (const kind of ['too-long', 'throw', 'error-result', 'no-audio']) test(`automatic synthesis ${kind} reports a visible sanitized error`, async () => {
  let executions = 0
  const s = setup(async () => {
    executions++
    if (kind === 'throw') throw new Error('Authorization: Bearer secret')
    if (kind === 'error-result') return { error: 'TTS service unavailable' }
    return {}
  })
  s.start()
  const text = kind === 'too-long' ? '长'.repeat(2001) : '最终回答'
  s.done('r1', { output: [{ type: 'message', content: [{ type: 'text', text }] }] })
  await tick()
  assert.equal(executions, kind === 'too-long' ? 0 : 1)
  assert.equal(s.events.find(e => e.type === 'tool-end').status, 'failed')
  const error = s.events.find(e => e.type === 'error')
  assert.equal(error.code, 'automatic_tts_failed')
  assert.doesNotMatch(error.message, /secret/)
  if (kind === 'too-long') assert.match(error.message, /2000/)
  if (kind === 'error-result') assert.match(error.message, /unavailable/)
  assert.equal(s.events.filter(e => e.type === 'preview-audio').length, 0)
  assert.equal(s.requests().length, 0)
  assert.equal(s.outputs().length, 0)
})

test('native final text does not trigger automatic synthesis', async () => {
  let executions = 0
  const s = setup(async () => { executions++; return { __previewData: 'unexpected' } }, { use_tts_voice: false })
  s.start()
  s.done('r1', { output: [{ type: 'message', content: [{ type: 'text', text: '原生语音' }] }] })
  await tick()
  assert.equal(executions, 0)
  assert.equal(s.events.filter(e => e.type === 'tts-transcript').length, 0)
})

test('provider and tool errors redact credentials without including raw arguments in audit', async () => {
  const s = setup(async () => { throw new Error('Authorization: Bearer sk-do-not-expose-this-secret') })
  s.start()
  s.tool('failure', 'get_voice_config', 'r1', { api_key: 'argument-secret' })
  s.done()
  s.socket.event('error', { error: { code: 'bad credential', message: 'api_key=sk-do-not-expose-this-secret' } })
  await tick()
  const serialized = JSON.stringify(s.events)
  assert.doesNotMatch(serialized, /sk-do-not-expose-this-secret|argument-secret/)
  assert.equal(s.events.find(e => e.type === 'audit' && e.record.kind === 'tool').record.status, 'failed')
  assert.equal(s.events.find(e => e.type === 'audit' && e.record.kind === 'error').record.status, 'failed')
})

test('voice requests serialize preamble, design preview, then candidate speech', async () => {
  const waiting = deferred(), executions = []
  const s = setup(async (name, args) => {
    executions.push([name, args.text])
    if (name === 'design_voice') { await waiting.promise; return { __previewData: 'candidate-preview' } }
    return { __previewData: args.text }
  })
  s.start()
  s.socket.event('response.text.done', { response_id: 'r1', text: '我来调整。' })
  s.tool('design', 'design_voice', 'r1', { description: '柔和明亮的成年女声' })
  s.tool('confirm', 'synth_tts', 'r1', { text: '主人，要用这个声音吗？' })
  s.done()
  await tick()
  assert.deepEqual(executions, [['synth_tts', '我来调整。'], ['design_voice', undefined]])
  assert.deepEqual(s.events.filter(e => e.type === 'preview-audio').map(e => e.data), ['我来调整。'])
  waiting.resolve()
  await tick()
  assert.deepEqual(s.events.filter(e => e.type === 'preview-audio').map(e => e.data), ['我来调整。', 'candidate-preview', '主人，要用这个声音吗？'])
})

test('split internal names never reach streaming or final spoken transcripts', () => {
  const s = setup(undefined, { use_tts_voice: false })
  s.start()
  for (const delta of ['请用 ', 'apply_', 'voice', ' 工具确认。']) s.socket.event('response.text.delta', { response_id: 'r1', delta })
  s.socket.event('response.text.done', { response_id: 'r1', text: '请用 apply_voice 工具确认。' })
  assert.doesNotMatch(s.events.filter(e => e.type === 'transcript-delta').map(e => e.text).join(''), /apply_voice/)
  assert.equal(s.events.find(e => e.type === 'transcript-done').text, '请应用这个声音确认。')
})

test('response.done fallback speaks preamble even when function call precedes message', async () => {
  const executions = []
  const s = setup(async (name, args) => { executions.push([name, args.text]); return { __previewData: 'audio' } })
  s.start()
  s.done('r1', { output: [
    { type: 'function_call', call_id: 'design', name: 'design_voice', arguments: '{"description":"柔和明亮成年女声"}' },
    { type: 'message', content: [{ type: 'text', text: '我来调整。' }] },
  ] })
  await tick()
  assert.deepEqual(executions, [['synth_tts', '我来调整。'], ['design_voice', undefined]])
  assert.equal(s.requests().length, 1)
})
