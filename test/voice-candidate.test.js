import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createService } from '../src/service.js'
import { createVoiceCandidateState, spokenText } from '../src/voice-candidate.js'
import { MODEL_TTS } from '../src/voice-design.js'
const tick = () => new Promise(resolve => setImmediate(resolve))

async function setup(t, native = false, delayDesign, retainedBreeze = false) {
  const dir = await mkdtemp(join(tmpdir(), 'candidate-test-'))
  const requests = [], sockets = []
  class Socket {
    constructor() { this.readyState = 1; this.handlers = {}; this.sent = []; sockets.push(this) }
    on(name, fn) { this.handlers[name] = fn }
    send(raw) { this.sent.push(JSON.parse(raw)) }
    close() {}
    event(type, fields = {}) { this.handlers.message(Buffer.from(JSON.stringify({ type, ...fields }))) }
    tool(name, args = {}) {
      const callId = `call-${this.sent.length}-${Math.random()}`
      this.event('response.output_item.done', { response_id: this.responseId || 'r1', item: { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) } })
      return callId
    }
    output(callId) { const e = this.sent.find(e => e.item?.call_id === callId); return e && JSON.parse(e.item.output) }
    user(text) { this.responseId = `r-${Math.random()}`; const item_id = `u-${Math.random()}`; this.event('input_audio_buffer.speech_started', { item_id }); this.event('conversation.item.input_audio_transcription.completed', { item_id, transcript: text }) }
  }
  const service = createService({ stateDir: dir }, { realtimeWebSocket: Socket, resolveBailianProvider: async () => ({ key: 'fake', source: 'provider' }), fetch: async (url, options) => {
    if (!options) return { ok: true, arrayBuffer: async () => Buffer.from('audio') }
    const body = JSON.parse(options.body); requests.push(body)
    if (body.input.action === 'create_voice') {
      if (body.input.voice_prompt && delayDesign) await delayDesign
      return { ok: true, json: async () => ({ output: body.input.voice_prompt ? { voice_id: 'design-id', preview_audio: { data: 'preview' } } : { voice_id: 'native-id' } }) }
    }
    return { ok: true, json: async () => ({ output: { audio: { url: 'https://audio.test/audio' } } }) }
  } })
  t.after(async () => { await service.dispose(); await rm(dir, { recursive: true, force: true }) })
  const initial = (await service.handle('GET', '/api/config')).body.settings
  await service.handle('PUT', '/api/config', { settings: { ...initial, ...(retainedBreeze ? {tts_voice_provider:'breeze'} : {}), tts_profiles: retainedBreeze ? {breeze:{voice:'old-breeze-id'}} : native ? initial.tts_profiles : { ...initial.tts_profiles, qwen: { ...initial.tts_profiles?.qwen, voice: 'longanhuan_v3.1' } }, realtime: { ...initial.realtime, voice: native ? 'Cherry' : initial.realtime.voice, use_tts_voice: !native, instructions: 'test' } } })
  const start = async () => { const { sessionId } = (await service.handle('POST', '/api/realtime/start')).body; return { socket: sockets.at(-1), sessionId } }
  const first = await start()
  const config = async () => (await service.handle('GET', '/api/config')).body.settings
  const settle = async () => { for (let i = 0; i < 12; i++) await tick() }
  const invoke = async (name, args, socket = first.socket) => { const id = socket.tool(name, args); for (let i = 0; i < 100 && !socket.output(id); i++) await tick(); assert.ok(socket.output(id), name); return socket.output(id) }
  return { ...first, service, requests, start, config, invoke, settle }
}

test('candidate only changes its session; explicit yes saves design voice/model and sanitizes speech', async t => {
  const s = await setup(t), original = await s.config()
  const designed = await s.invoke('design_voice', { description: '柔和明亮的成年女声' })
  assert.doesNotMatch(designed.note, /apply_voice/)
  await s.invoke('synth_tts', { text: '要用 apply_voice 吗？' })
  assert.equal(s.requests.at(-1).input.voice, 'design-id')
  assert.equal(s.requests.at(-1).model, MODEL_TTS)
  assert.doesNotMatch(s.requests.at(-1).input.text, /apply_voice/)
  assert.deepEqual(await s.config(), original)
  assert.ok((await s.invoke('apply_voice', { voice_id: 'native-id' })).error)
  const other = await s.start()
  await s.invoke('synth_tts', { text: '另一个会话' }, other.socket)
  assert.equal(s.requests.at(-1).input.voice, 'longanhuan_v3.1')
  s.socket.user('好的')
  assert.equal((await s.invoke('apply_voice', { voice_id: 'native-id' })).applied, true)
  const saved = await s.config()
  assert.equal(saved.tts_profiles.qwen.voice, 'design-id')
  assert.equal(saved.tts_profiles.qwen.model, MODEL_TTS)
  assert.equal(saved.realtime.voice, original.realtime.voice)
})

for (const answer of ['不要', '不是', '挺好听但不要应用', '明天天气怎么样', '好听']) test(`non-confirmation restores original: ${answer}`, async t => {
  const s = await setup(t), original = await s.config()
  await s.invoke('design_voice', { description: '柔和明亮的成年女声' })
  s.socket.user(answer)
  assert.ok((await s.invoke('apply_voice', { voice_id: 'native-id' })).error)
  await s.invoke('synth_tts', { text: '继续聊天' })
  assert.equal(s.requests.at(-1).input.voice, 'longanhuan_v3.1')
  assert.deepEqual(await s.config(), original)
})

test('design and synthesis execute in request order; cancelled late design cannot revive candidate', async t => {
  let resolve
  const delay = new Promise(r => { resolve = r })
  const s = await setup(t, false, delay)
  s.socket.tool('design_voice', { description: '柔和明亮的成年女声' })
  s.socket.tool('synth_tts', { text: '试试看' })
  await s.settle()
  assert.equal(s.requests.length, 1)
  await s.service.handle('POST', '/api/realtime/cancel', { sessionId: s.sessionId })
  resolve(); await s.settle()
  s.socket.user('继续聊天')
  await s.invoke('synth_tts', { text: '恢复' })
  assert.equal(s.requests.at(-1).input.voice, 'longanhuan_v3.1')
  assert.equal(s.requests.filter(r => r.input.text === '试试看').length, 0)
})

test('native candidate uses text continuation and TTS; confirmation saves only realtime clone', async t => {
  const s = await setup(t, true)
  await s.invoke('design_voice', { description: '柔和明亮的成年女声' })
  s.socket.event('response.done', { response: { id: 'r1', status: 'completed' } })
  assert.deepEqual(s.socket.sent.findLast(e => e.type === 'response.create').response.modalities, ['text'])
  s.socket.event('response.created', { response: { id: 'r2' } })
  s.socket.event('response.text.done', { response_id: 'r2', text: '主人，要用这个声音吗？' })
  s.socket.event('response.done', { response: { id: 'r2', status: 'completed' } })
  await s.settle()
  assert.equal(s.requests.at(-1).input.voice, 'design-id')
  s.socket.user('可以')
  await s.invoke('apply_voice', { voice_id: 'native-id' })
  assert.equal((await s.config()).realtime.voice, 'native-id')
  assert.equal((await s.config()).tts_profiles.qwen, undefined)
})

test('candidate expiry and confirmation turn guard', () => {
  let now = 0
  const state = createVoiceCandidateState({ now: () => now, ttl: 10 })
  state.set({ designVoiceId: 'v' }, 'design-turn')
  state.user('是的', 'design-turn')
  assert.equal(state.confirmed('v', 'design-turn'), null)
  state.user('是的', 'next-turn')
  assert.ok(state.confirmed('v', 'next-turn'))
  now = 10
  assert.equal(state.get(), null)
})

for (const answer of ['可以可以，就用这个声音。', '好，就用这个声音吧', '这个不错，保留这个音色', '嗯，可以，就用这个']) test(`natural explicit confirmation: ${answer}`, () => {
  const state = createVoiceCandidateState()
  state.set({ designVoiceId: 'v' }, 'before')
  state.user(answer, 'after')
  assert.ok(state.confirmed('v', 'after'))
})
for (const answer of ['可以吗', '好，如果可以就用这个', '不错，但是不要应用', '嗯']) test(`ambiguous or conditional answer: ${answer}`, () => {
  const state = createVoiceCandidateState()
  state.set({ designVoiceId: 'v' }, 'before')
  state.user(answer, 'after')
  assert.equal(state.get(), null)
})
test('spoken fallback removes tool names and invocation wording', () => {
  assert.equal(spokenText('调用apply_voice工具'), '应用这个声音')
  assert.equal(spokenText('用 design_voice 工具'), '设计声音')
  assert.doesNotMatch(spokenText('synth_tts 和 delete_voice'), /synth_tts|delete_voice/)
})

test('rejected candidates remain session-local for listing and explicit deletion, never applying', async t => {
  const s = await setup(t)
  await s.invoke('design_voice', { description: '柔和明亮的成年女声' })
  s.socket.user('不要')
  assert.equal((await s.invoke('list_voice_presets')).candidates.length, 1)
  assert.ok((await s.invoke('apply_voice', { voice_id: 'native-id' })).error)
  assert.equal((await s.invoke('delete_voice', { voice_id: 'native-id' })).deleted, true)
  assert.equal((await s.invoke('list_voice_presets')).candidates.length, 0)
})

test('native text-only response keeps speaking after late rejection transcription', async t => {
  const s = await setup(t, true)
  await s.invoke('design_voice', { description: '柔和明亮的成年女声' })
  s.socket.event('input_audio_buffer.speech_started', { item_id: 'rejecting-user' })
  s.socket.event('response.created', { response: { id: 'rejection-response' } })
  s.socket.event('conversation.item.input_audio_transcription.completed', { item_id: 'rejecting-user', transcript: '不要' })
  s.socket.event('response.text.done', { response_id: 'rejection-response', text: '好，继续用原来的声音。' })
  s.socket.event('response.done', { response: { id: 'rejection-response', status: 'completed' } })
  await s.settle()
  assert.equal(s.requests.at(-1).input.text, '好，继续用原来的声音。')
  assert.equal(s.requests.at(-1).input.voice, 'longanhuan_v3.1')
})

test('native realtime keeps Bailian design, candidate synthesis and apply with retained Breeze TTS settings',async t=>{
 const s=await setup(t,true,undefined,true)
 const designed=await s.invoke('design_voice',{description:'柔和明亮的成年女声'})
 assert.equal(designed.candidate.designVoiceId,'design-id')
 assert.equal(designed.candidate.realtimeVoiceId,'native-id')
 s.socket.event('response.done',{response:{id:'r1',status:'completed'}})
 s.socket.event('response.created',{response:{id:'native-retained-breeze'}})
 s.socket.event('response.text.done',{response_id:'native-retained-breeze',text:'Hello, this is the candidate voice.'})
 s.socket.event('response.done',{response:{id:'native-retained-breeze',status:'completed'}})
 await s.settle()
 assert.equal(s.requests.at(-1).input.voice,'design-id')
 assert.equal(s.requests.at(-1).model,MODEL_TTS)
 s.socket.user('可以')
 assert.equal((await s.invoke('apply_voice',{voice_id:'native-id'})).applied,true)
 const config=await s.config()
 assert.equal(config.realtime.voice,'native-id')
 assert.equal(config.tts_voice_provider,'breeze')
 assert.equal(config.tts_profiles.qwen,undefined)
})
