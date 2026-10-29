import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createService } from '../src/core/service.js'
import { MODEL_TTS } from '../src/core/voice-design.js'
import { mergeVoiceSettingsPatch } from '../web/src/lib/voice-settings.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'voice-settings-patch-')), requests = [], sockets = []
  class Socket {
    constructor() { this.readyState = 1; this.handlers = {}; this.sent = []; sockets.push(this) }
    on(name, fn) { this.handlers[name] = fn }
    send(raw) { this.sent.push(JSON.parse(raw)) }
    close() {}
    event(type, fields = {}) { this.handlers.message(Buffer.from(JSON.stringify({ type, ...fields }))) }
    user() { this.responseId = 'confirmed-response'; this.event('input_audio_buffer.speech_started', { item_id: 'confirm-item' }); this.event('conversation.item.input_audio_transcription.completed', { item_id: 'confirm-item', transcript: '好的，就用这个声音' }) }
    tool(name, args) { const id = 'call-' + this.sent.length; this.event('response.output_item.done', { response_id: this.responseId || 'design-response', item: { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) } }); return id }
    output(id) { const e = this.sent.find(e => e.item?.call_id === id); return e && JSON.parse(e.item.output) }
  }
  const dependencies = { realtimeWebSocket: Socket, resolveBailianProvider: async () => ({ key: 'fake', source: 'provider' }), fetch: async (_url, options) => {
    if (!options) return { ok: true, arrayBuffer: async () => Buffer.from('audio') }
    const body = JSON.parse(options.body); requests.push(body)
    return { ok: true, json: async () => ({ output: body.input.action === 'create_voice' ? body.input.voice_prompt ? { voice_id: 'new-design', preview_audio: { data: 'preview' } } : { voice_id: 'new-native' } : { audio: { url: 'https://audio.test/audio' } } }) }
  } }
  const service = createService({ stateDir: dir }, dependencies)
  t.after(async () => { await service.dispose(); await rm(dir, { recursive: true, force: true }) })
  const config = async () => (await service.handle('GET', '/api/config')).body.settings
  const original = await config()
  await service.handle('PUT', '/api/config', { settings: { ...original, tts_profiles: { ...original.tts_profiles, qwen: { ...original.tts_profiles?.qwen, voice: 'longanhuan_v3.1' } }, realtime: { ...original.realtime, use_tts_voice: true, instructions: 'test' } } })
  const start = async settings => { const { sessionId } = (await service.handle('POST', '/api/realtime/start', settings ? { settings } : {})).body; return { socket: sockets.at(-1), sessionId } }
  const first = await start()
  const invoke = async (name, args, socket = first.socket) => { const id = socket.tool(name, args); for (let i = 0; i < 300 && !socket.output(id); i++) await tick(); assert.ok(socket.output(id), name); return socket.output(id) }
  return { service, dir, requests, config, start, invoke, ...first }
}

test('successful conversation apply persists, current and stale-snapshot sessions synthesize new voice, patch prevents later stale save rollback', async t => {
  const s = await setup(t), browserSnapshot = await s.config()
  await s.invoke('design_voice', { description: '柔和自然的女声' })
  s.socket.user()
  const applied = await s.invoke('apply_voice', { voice_id: 'new-native' })
  assert.equal(applied.applied, true)
  const persisted = JSON.parse(await readFile(join(s.dir, 'settings.json'), 'utf8'))
  assert.equal(persisted.tts_profiles.qwen.voice, 'new-design')
  await s.invoke('synth_tts', { text: '本会话已经应用' })
  assert.equal(s.requests.at(-1).input.voice, 'new-design')
  const other = await s.start(browserSnapshot)
  await s.invoke('synth_tts', { text: '旧会话快照仍读取新配置' }, other.socket)
  assert.equal(s.requests.at(-1).input.voice, 'new-design')
  assert.equal((await s.config()).tts_profiles.qwen.voice, 'new-design')
  const events = (await s.service.handle('POST', '/api/realtime/events', { sessionId: s.sessionId, after: 0 })).body.events
  const event = events.find(e => e.type === 'voice-settings-changed')
  assert.deepEqual(event?.patch, { tts_voice_provider: 'qwen', tts_profiles: { qwen: { voice: 'new-design', model: MODEL_TTS } } })
  assert.equal(applied.__voiceSettingsPatch, undefined, 'internal patch must not enter model tool output')
  const draft = { ...browserSnapshot, system_prompt: '保留未保存的对话草稿', tts_profiles: { ...browserSnapshot.tts_profiles, custom: { voice: 'draft-custom' } } }
  const merged = mergeVoiceSettingsPatch(draft, event.patch)
  const baseline = mergeVoiceSettingsPatch(browserSnapshot, event.patch)
  assert.equal(merged.system_prompt, draft.system_prompt)
  assert.equal(merged.tts_profiles.custom.voice, 'draft-custom')
  assert.equal(baseline.system_prompt, browserSnapshot.system_prompt)
  assert.notDeepEqual(merged, baseline, 'unrelated drafts remain dirty')
  await s.service.handle('PUT', '/api/config', { settings: merged })
  assert.equal((await s.config()).tts_profiles.qwen.voice, 'new-design')
  assert.equal((await s.config()).system_prompt, draft.system_prompt)
})

test('voice patch merges provider fields without erasing other draft profile values', () => {
  const settings = { system_prompt: 'draft', tts_voice_provider: 'qwen', realtime: { voice: 'old', instructions: 'draft-instructions' }, tts_profiles: { qwen: { key_file: 'draft-key-file', voice: 'old' }, breeze: { voice: 'breeze-draft', model: 'breeze-model' } } }
  const changed = mergeVoiceSettingsPatch(settings, { tts_voice_provider: 'qwen', tts_profiles: { qwen: { voice: 'new', model: 'tts-model' } } })
  assert.equal(changed.tts_profiles.qwen.key_file, 'draft-key-file')
  assert.deepEqual(changed.tts_profiles.breeze, settings.tts_profiles.breeze)
  assert.deepEqual(mergeVoiceSettingsPatch(changed, { realtime: { voice: 'new-native' } }).realtime, { voice: 'new-native', instructions: 'draft-instructions' })
  assert.deepEqual(mergeVoiceSettingsPatch(settings, { tts_voice_provider: 'breeze', tts_profiles: { breeze: {} } }).tts_profiles.breeze, settings.tts_profiles.breeze)
  assert.equal(settings.tts_profiles.qwen.voice, 'old', 'merge does not mutate saved baseline')
})
