import test from 'node:test'
import assert from 'node:assert/strict'
import { createFillerCoordinator } from '../src/core/filler-coordinator.js'
import { createRealtimeSession, realtimeDefaults } from '../src/core/realtime-service.js'
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function clock() {
  let at = 100000, id = 0
  const timers = new Map()
  return { now: () => at, setTimer: (fn, ms) => { timers.set(++id, { fn, due: at + ms }); return id }, clearTimer: id => timers.delete(id),
    async advance(ms) { at += ms; for (const [id, timer] of [...timers]) if (timer.due <= at) { timers.delete(id); void timer.fn() }; await flush() } }
}
function setup(overrides = {}) {
  const time = clock(), events = [], requests = []
  const coordinator = createFillerCoordinator({ ...time, context: () => ({ history: [{ role: 'user', text: '帮我看看天气' }], persona: '鲸鱼娘', language: 'zh' }),
    generate: async args => { requests.push(args); return '我看一眼。' }, synthesize: async () => ({ audio: 'audio', mime: 'audio/wav' }), emit: e => events.push(e), ...overrides })
  coordinator.newTurn('t1')
  return { coordinator, time, events, requests, audio: () => events.filter(e => e.type === 'filler-audio') }
}
test('wait opportunities use LLM context, accept silence and never choose canned fallback', async () => {
  const s = setup({ generate: async () => '' }); s.coordinator.schedule('thinking'); await s.time.advance(1800)
  assert.equal(s.audio().length, 0)
  const t = setup(); t.coordinator.schedule('tool-wait', { toolName: 'weather' }); await t.time.advance(1400)
  assert.equal(t.requests[0].reason, 'tool-wait'); assert.equal(t.requests[0].toolName, 'weather')
  assert.equal(t.requests[0].history[0].text, '帮我看看天气'); assert.equal(t.audio().length, 1)
})
test('interruption acknowledgement waits for a gap, is cancellable and not repeated', async () => {
  const s = setup(); s.coordinator.userStarted({ interrupted: true }); await s.time.advance(200)
  assert.equal(s.audio().length, 0)
  s.coordinator.userStopped(); assert.equal(s.audio().length, 1)
  s.coordinator.userStopped(); assert.equal(s.audio().length, 1)
  s.coordinator.userStarted(); assert.equal(s.events.at(-1).type, 'filler-cancel')
})
test('normal user speech never creates an interruption acknowledgement', async () => {
  const s = setup(); s.coordinator.userStarted(); await s.time.advance(2500)
  assert.equal(s.requests.length, 0)
  s.coordinator.userStopped(); await s.time.advance(1800)
  assert.equal(s.requests[0].reason, 'thinking')
})
for (const stop of ['mainOutput', 'dispose', 'cancel']) test(`late generation is dropped on ${stop}`, async () => {
  const waiting = deferred(); let synthesis = 0
  const s = setup({ generate: () => waiting.promise, synthesize: async () => { synthesis++; return { audio: 'late' } } })
  s.coordinator.schedule('thinking'); await s.time.advance(1800); s.coordinator[stop]()
  waiting.resolve('等等'); await flush(); assert.equal(synthesis, 0); assert.equal(s.audio().length, 0)
})
test('late synthesis from old turn cannot leak into new turn', async () => {
  const waiting = deferred(); const s = setup({ synthesize: () => waiting.promise })
  s.coordinator.schedule('thinking'); await s.time.advance(1800); s.coordinator.newTurn('t2')
  waiting.resolve({ audio: 'late' }); await flush(); assert.equal(s.audio().length, 0)
})
test('main playback suppresses fillers; cooldown limits chatter across turns', async () => {
  const s = setup(); s.coordinator.playback(true); s.coordinator.schedule('tool-wait'); await s.time.advance(2000)
  assert.equal(s.requests.length, 0)
  s.coordinator.playback(false); s.coordinator.schedule('tool-wait'); await s.time.advance(1400)
  assert.equal(s.audio().length, 1)
  s.coordinator.newTurn('t2'); s.coordinator.schedule('thinking'); await s.time.advance(1800)
  assert.equal(s.audio().length, 1)
})
test('slow interruption acknowledgement expires instead of speaking after the gap', async () => {
  const waiting = deferred(); const s = setup({ generate: () => waiting.promise })
  s.coordinator.userStarted({ interrupted: true }); await s.time.advance(200); s.coordinator.userStopped()
  await s.time.advance(2300); waiting.resolve('你说'); await flush(); assert.equal(s.audio().length, 0)
})
function realtime() {
  const time = clock(), events = [], requests = []
  let socket
  class Socket {
    constructor() { socket = this; this.readyState = 1; this.handlers = {} }
    on(name, fn) { this.handlers[name] = fn }
    send() {}
    close() {}
    event(type, fields = {}) { this.handlers.message(Buffer.from(JSON.stringify({ type, ...fields }))) }
  }
  const work = deferred()
  const session = createRealtimeSession({ settings: realtimeDefaults(), key: 'secret', emit: e => events.push(e), WebSocketCtor: Socket,
    executeTool: () => work.promise, generateFiller: async args => { requests.push(args); return '我看看。' },
    synthesizeFiller: async () => ({ audio: 'filler' }), fillerOptions: time })
  session.connect()
  return { session, socket, time, events, requests, work }
}
test('realtime tool wait and next-response transition generate contextual opportunities', async () => {
  const s = realtime(); s.socket.event('response.created', { response: { id: 'r1' } })
  s.socket.event('response.output_item.done', { response_id: 'r1', item: { type: 'function_call', call_id: 'c1', name: 'get_voice_config', arguments: '{}' } })
  s.socket.event('response.done', { response: { id: 'r1', status: 'completed' } })
  await s.time.advance(1400)
  assert.equal(s.requests[0].reason, 'tool-wait'); assert.equal(s.requests[0].toolName, 'get_voice_config')
  assert.equal(s.events.filter(e => e.type === 'filler-audio').length, 1)
  const priorEvents = s.events.length
  s.work.resolve({}); await flush()
  assert.ok(s.events.slice(priorEvents).some(e => e.type === 'filler-cancel'))
  s.session.dispose()
})
test('browser playback state detects interruption even after provider response finished', async () => {
  const s = realtime()
  s.socket.event('response.created', { response: { id: 'r1' } })
  s.socket.event('response.done', { response: { id: 'r1', status: 'completed' } })
  s.session.playback({ kind: 'main', active: true })
  s.socket.event('input_audio_buffer.speech_started', { item_id: 'u2' })
  await s.time.advance(200)
  assert.equal(s.requests[0].reason, 'interrupt')
  assert.equal(s.events.filter(e => e.type === 'filler-audio').length, 0)
  s.socket.event('input_audio_buffer.speech_stopped', { item_id: 'u2' })
  assert.equal(s.events.filter(e => e.type === 'filler-audio').length, 1)
  s.session.dispose()
})
