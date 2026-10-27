import test from 'node:test'
import assert from 'node:assert/strict'
import { createRealtimeSession } from '../src/realtime-service.js'
import { createVoiceCandidateState } from '../src/voice-candidate.js'
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function setup(t, options = {}) {
  let socket
  class Socket {
    constructor() { socket = this; this.readyState = 1; this.sent = []; this.handlers = {} }
    on(name, handler) { this.handlers[name] = handler }
    send(raw) { this.sent.push(JSON.parse(raw)) }
    close() {}
    event(type, fields = {}) { this.handlers.message(Buffer.from(JSON.stringify({ type, ...fields }))) }
    start(id) { this.event('input_audio_buffer.speech_started', { item_id: id }) }
    final(id, text) { this.event('conversation.item.input_audio_transcription.completed', { item_id: id, transcript: text }) }
    tool(id, name = 'apply_voice') { this.event('response.output_item.done', { response_id: 'r-' + id, item: { type: 'function_call', call_id: id, name, arguments: JSON.stringify(name === 'apply_voice' ? { voice_id: 'candidate' } : { text: '准备好了。' }) } }) }
    output(id) { return this.sent.find(e => e.item?.call_id === id)?.item.output }
  }
  const state = createVoiceCandidateState(), events = [], executed = []
  state.set({ designVoiceId: 'candidate', realtimeVoiceId: 'native' }, 'design-turn')
  const session = createRealtimeSession({ settings: { use_tts_voice: true, tools: ['apply_voice', 'synth_tts'] }, key: 'secret-test-key', voiceState: state,
    confirmationTimeoutMs: options.timeoutMs ?? 1500, WebSocketCtor: Socket, emit: e => events.push(e), executeTool: async (name, args, context) => {
      executed.push({ name, args, context })
      if (options.execute) return options.execute(name, args, context)
      return name === 'apply_voice' ? { applied: true, __voiceSettingsPatch: { tts_voice_provider: 'qwen' } } : { __previewData: 'audio' }
    } })
  session.connect(); t.after(() => session.dispose())
  return { session, state, socket, events, executed }
}

test('apply waits for late same-turn ASR confirmation before dispatch and forwards only public settings event', async t => {
  const s = setup(t)
  s.socket.start('user'); s.socket.tool('apply')
  await tick(); assert.equal(s.executed.length, 0)
  await new Promise(resolve => setTimeout(resolve, 201))
  assert.equal(s.executed.length, 0)
  assert.equal(s.socket.output('apply'), undefined)
  s.socket.final('user', '可以可以，就用这个声音。')
  await tick()
  assert.equal(s.executed.length, 1)
  assert.equal(JSON.parse(s.socket.output('apply')).applied, true)
  assert.doesNotMatch(s.socket.output('apply'), /__voiceSettingsPatch/)
  assert.equal(s.events.find(e => e.type === 'voice-settings-changed').patch.tts_voice_provider, 'qwen')
})

test('late denial rejects waiting apply and preserves conservative confirmation semantics', async t => {
  const s = setup(t); s.socket.start('user'); s.socket.tool('apply'); await tick()
  s.socket.final('user', '可以，不过先不要应用。'); await tick()
  assert.equal(s.executed.length, 0)
  assert.match(JSON.parse(s.socket.output('apply')).error, /明确同意/)
})

test('missing final ASR times out rather than accepting model assertion', async t => {
  const s = setup(t, { timeoutMs: 15 }); s.socket.start('user'); s.socket.tool('apply')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(s.executed.length, 0)
  assert.match(JSON.parse(s.socket.output('apply')).error, /完整的语音确认/)
  assert.ok(s.events.some(e => e.type === 'audit' && e.record.kind === 'tool' && e.record.status === 'failed' && /完整的语音确认/.test(e.record.text)))
})

for (const action of ['new-speech', 'dispose', 'cancel']) test(`pending apply is aborted on ${action}`, async t => {
  const s = setup(t); s.socket.start('user'); s.socket.tool('apply'); await tick()
  if (action === 'new-speech') s.socket.start('next')
  else if (action === 'dispose') s.session.dispose()
  else s.session.cancel()
  s.socket.final('user', '可以可以，就用这个声音。'); await tick()
  assert.equal(s.executed.length, 0)
  assert.equal(s.socket.output('apply'), undefined)
  assert.ok(s.events.some(e => e.type === 'tool-end' && e.callId === 'apply' && e.status === 'cancelled'))
})

test('old-turn and duplicate ASR do not release or authorize current apply', async t => {
  const s = setup(t); s.socket.start('old'); s.socket.final('old', '可以')
  s.socket.start('current'); s.socket.tool('apply'); await tick()
  s.socket.final('old', '可以可以，就用这个声音。'); await tick()
  assert.equal(s.executed.length, 0)
  s.socket.final('current', '不要'); await tick()
  s.socket.final('current', '可以'); await tick()
  assert.equal(s.executed.length, 0)
  assert.match(JSON.parse(s.socket.output('apply')).error, /明确同意/)
})

test('final ASR received during queued TTS preamble remains available to apply', async t => {
  const preamble = deferred()
  const s = setup(t, { execute: async name => name === 'synth_tts' ? preamble.promise : { applied: true } })
  s.socket.start('user')
  s.socket.event('response.text.done', { response_id: 'r-apply', text: '我来设置。' })
  s.socket.tool('apply'); await tick()
  assert.deepEqual(s.executed.map(e => e.name), ['synth_tts'])
  s.socket.final('user', '可以可以，就用这个声音。'); preamble.resolve({ __previewData: 'audio' }); await tick(); await tick()
  assert.deepEqual(s.executed.map(e => e.name), ['synth_tts', 'apply_voice'])
  assert.equal(JSON.parse(s.socket.output('apply')).applied, true)
})

test('failed tool audit contains useful reason with credentials redacted', async t => {
  const s = setup(t, { execute: async () => { throw new Error('failed with secret-test-key token=super-secret') } })
  s.socket.start('user'); s.socket.final('user', '可以'); s.socket.tool('apply'); await tick()
  const audit = s.events.find(e => e.type === 'audit' && e.record.kind === 'tool').record
  assert.match(audit.text, /failed with/)
  assert.doesNotMatch(JSON.stringify(audit), /secret-test-key|super-secret/)
})
