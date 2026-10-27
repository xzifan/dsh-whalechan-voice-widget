import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createService } from '../src/service.js'
import { MODEL_TTS_SYNTH, synthesizeTts } from '../src/voice-design.js'
import { synthesizeHttpTts } from '../src/tts-http.js'

const mp3 = Buffer.from('ID3fake-audio')
function sockets() {
  return class FakeSocket {
    static instances = []
    constructor() { this.readyState = 1; this.handlers = {}; this.sent = []; this.waiters = new Map(); FakeSocket.instances.push(this) }
    on(name, fn) { this.handlers[name] = fn }
    send(raw) { const event = JSON.parse(raw); this.sent.push(event); if (event.item?.type === 'function_call_output') this.waiters.get(event.item.call_id)?.(JSON.parse(event.item.output)) }
    close() { this.readyState = 3 }
    emit(type, data = {}) { this.handlers.message?.(Buffer.from(JSON.stringify({ type, ...data }))) }
    invoke(name, args, callId = 'call1') {
      const result = new Promise(resolve => this.waiters.set(callId, resolve))
      this.emit('response.created', { response: { id: 'response1' } })
      this.emit('response.output_item.done', { response_id: 'response1', item: { id: 'tool-item', type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) } })
      return result
    }
  }
}
async function fixture(t, { provider = 'qwen', profiles = {}, fetcher, brokenStorage = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'voice-audit-service-'))
  const keyFile = join(dir, 'test.env'), secret = 'test-private-provider-credential'
  await writeFile(keyFile, 'DASHSCOPE_API_KEY=' + secret)
  const FakeSocket = sockets()
  const service = createService({ stateDir: dir }, { realtimeWebSocket: FakeSocket, fetch: fetcher, resolveModelCredential: async provider => ({ key: secret, source: 'provider', provider }) })
  t.after(async () => { await service.dispose(); await rm(dir, { recursive: true, force: true }) })
  const initial = (await service.handle('GET', '/api/config')).body.settings
  const fixtureProfiles = { ...profiles, [provider]: { voice: provider === 'qwen' ? 'longanhuan_v3.1' : 'fixture-voice', ...profiles[provider] } }
  const settings = { ...initial, tts_voice_provider: provider, tts_profiles: fixtureProfiles, realtime: { ...initial.realtime, key_file: keyFile, instructions: 'Test', use_tts_voice: true } }
  await service.handle('PUT', '/api/config', { settings })
  if (brokenStorage) await mkdir(join(dir, 'voice-audit.jsonl'))
  const { sessionId } = (await service.handle('POST', '/api/realtime/start')).body
  const socket = FakeSocket.instances[0]
  socket.emit('session.created')
  return { dir, service, socket, sessionId, secret }
}

test('realtime transcripts/usage persist with stable IDs while polling carries compact audit hints', async t => {
  const { dir, service, socket, sessionId, secret } = await fixture(t)
  socket.emit('input_audio_buffer.speech_started', { item_id: 'user1' })
  socket.emit('conversation.item.input_audio_transcription.completed', { item_id: 'user1', transcript: 'Hello ' + secret })
  socket.emit('response.created', { response: { id: 'response1' } })
  socket.emit('response.text.done', { response_id: 'response1', text: 'Reply' })
  socket.emit('response.done', { response: { id: 'response1', status: 'completed', usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11, output_tokens_details: { text_tokens: 3 } } } })
  const { records, total } = (await service.handle('POST', '/api/audit', { sessionId })).body
  assert.ok(total >= 2)
  const transcript = records.find(r => r.kind === 'transcription')
  const usage = records.find(r => r.kind === 'response')
  assert.equal(records.filter(r => r.kind === 'usage').length, 0)
  assert.equal(transcript.sessionId, sessionId)
  assert.ok(transcript.messageId); assert.ok(transcript.turnId)
  assert.equal(transcript.turnId, usage.turnId)
  assert.equal(usage.responseId, 'response1'); assert.equal(usage.usage.total_tokens, 11)
  assert.equal(transcript.usage, null)
  const events = (await service.handle('POST', '/api/realtime/events', { sessionId })).body.events
  assert.ok(events.every(event => event.sessionId === sessionId))
  assert.equal(events.find(e => e.type === 'user-transcript-done').messageId, transcript.messageId)
  for (const hint of events.filter(e => e.type === 'audit')) { assert.ok(hint.id); assert.equal(hint.record, undefined); assert.equal(hint.text, undefined) }
  assert.doesNotMatch(await readFile(join(dir, 'voice-audit.jsonl'), 'utf8'), new RegExp(secret))
  assert.equal((await service.handle('POST', '/api/audit', { search: 'Reply' })).body.total >= 1, true)
  assert.equal((await service.handle('POST', '/api/audit', { failed: true })).body.total, 0)
  await assert.rejects(service.handle('POST', '/api/audit', { before: '12' }), { status: 400 })
  await assert.rejects(service.handle('POST', '/api/audit', { since: -1 }), { status: 400 })
  await assert.rejects(service.handle('POST', '/api/audit', { until: 'soon' }), { status: 400 })
  await assert.rejects(service.handle('POST', '/api/audit', { failed: 'yes' }), { status: 400 })
})

test('late realtime usage enriches a cancelled audit without changing identity or totals after restart', async t => {
  const { dir, service, socket, sessionId } = await fixture(t)
  socket.emit('response.created', { response: { id: 'cancelled-response' } })
  socket.emit('response.text.delta', { response_id: 'cancelled-response', delta: 'Partial answer' })
  socket.emit('input_audio_buffer.speech_started', { item_id: 'next-turn' })
  const query = async instance => (await instance.handle('POST', '/api/audit', { sessionId, kind: 'response' })).body
  const original = (await query(service)).records[0]
  assert.equal(original.status, 'cancelled')
  assert.equal(original.usage, null)
  const response = { id: 'cancelled-response', status: 'cancelled', usage: { total_tokens: 9 } }
  socket.emit('response.done', { response })
  socket.emit('response.done', { response })
  const updated = await query(service)
  assert.equal(updated.total, 1)
  assert.deepEqual(updated.records, [{ ...original, usage: { total_tokens: 9 }, usageAvailable: true }])
  const stats = (await service.handle('POST', '/api/statistics')).body
  assert.equal(stats.tokens, 9)
  assert.equal(stats.tokenKnown, 1)
  assert.equal(stats.tokenMissing, 0)
  assert.equal(stats.counts.usage, 0)
  await service.dispose()
  const restarted = createService({ stateDir: dir }, {})
  t.after(() => restarted.dispose())
  assert.deepEqual(await query(restarted), updated)
  assert.deepEqual((await restarted.handle('POST', '/api/statistics')).body, stats)
})

test('audit API applies column filters across pages and validates filter shape and values', async t => {
  const { service, socket, sessionId } = await fixture(t)
  for (let i = 0; i < 5; i++) {
    socket.emit('input_audio_buffer.speech_started', { item_id: `user-${i}` })
    socket.emit('conversation.item.input_audio_transcription.completed', { item_id: `user-${i}`, transcript: i < 2 ? 'Older Needle' : 'Recent noise' })
  }
  const request = body => service.handle('POST', '/api/audit', body).then(result => result.body)
  const unfiltered = await request({ limit: 1, kind: 'transcription' })
  assert.equal(unfiltered.records[0].text, 'Recent noise')
  const query = { limit: 1, kind: 'transcription', columnFilters: { text: 'NEEDLE', sessionId: sessionId.slice(0, 8).toUpperCase() } }
  const first = await request(query)
  assert.equal(first.records[0].text, 'Older Needle')
  assert.equal(first.total, 2); assert.equal(first.hasMore, true)
  const second = await request({ ...query, before: first.nextBefore })
  assert.equal(second.records[0].text, 'Older Needle')
  assert.ok(second.records[0].seq < first.records[0].seq)
  assert.equal(second.total, 2); assert.equal(second.hasMore, false)
  const record = first.records[0]
  const allColumns = await request({ columnFilters: { text: 'NEEDLE', provider: record.provider.toUpperCase(), model: record.model.toUpperCase(), status: record.status, sessionId: sessionId.toUpperCase(), messageId: record.messageId.toUpperCase() } })
  assert.deepEqual(allColumns.records.map(r => r.id), [record.id])
  assert.equal((await request({ until: 0 })).total, 0)
  for (const columnFilters of [null, [], 'text', 1, true, new Date(), Object.create({ text: 'needle' }), { unknown: '' }, { text: 1 }, { text: null }, { text: [] }, { text: {} }, { text: 'x'.repeat(201) }, JSON.parse('{"__proto__":"x"}'), { constructor: 'x' }, { [Symbol('text')]: 'x' }]) {
    await assert.rejects(request({ columnFilters }), { status: 400 })
  }
  for (const columnFilters of [{}, { text: '' }, Object.create(null)]) {
    assert.equal((await request({ kind: 'transcription', columnFilters })).total, 5)
  }
  for (const key of ['text', 'provider', 'model', 'status', 'sessionId', 'messageId']) {
    await assert.doesNotReject(request({ columnFilters: { [key]: 'x'.repeat(200) } }))
    await assert.rejects(request({ columnFilters: { [key]: 'x'.repeat(201) } }), { status: 400 })
  }
})

test('Qwen synthesis uses its own voice/model and logs completion with tool correlation and real usage', async t => {
  const calls = []
  const { dir, service, socket, sessionId } = await fixture(t, {
    profiles: { qwen: { voice: 'own-qwen-voice' }, mimo: { voice: 'wrong-mimo-voice' } },
    fetcher: async (url, options) => {
      if (options?.body) { calls.push(JSON.parse(options.body)); return Response.json({ output: { audio: { url: 'https://audio.example/result.wav' } }, request_id: 'req-actual', usage: { characters: 8, input_tokens: 2 } }) }
      return new Response(Buffer.from('RIFF0000WAVEtest'))
    },
  })
  const output = await socket.invoke('synth_tts', { text: 'Actual spoken text' })
  assert.equal(output.synth, true)
  assert.equal(calls[0].input.voice, 'own-qwen-voice'); assert.equal(calls[0].model, MODEL_TTS_SYNTH)
  const r = (await service.handle('POST', '/api/audit', { kind: 'synthesis' })).body.records[0]
  assert.equal(r.provider, 'bailian'); assert.equal(r.model, MODEL_TTS_SYNTH); assert.equal(r.voice, 'own-qwen-voice')
  assert.equal(r.sessionId, sessionId); assert.equal(r.callId, 'call1'); assert.equal(r.responseId, 'response1')
  assert.equal(r.text, 'Actual spoken text'); assert.equal(r.status, 'completed'); assert.equal(r.requestId, 'req-actual')
  assert.deepEqual(r.usage, { characters: 8, input_tokens: 2 }); assert.equal(r.usageAvailable, true)
  assert.equal(r.audioDurationSeconds, undefined); assert.equal(r.audioOutput, true)
  const stats = (await service.handle('POST', '/api/statistics')).body
  assert.equal(stats.outputAudioSeconds, null); assert.equal(stats.audioMissing, 1); assert.equal(stats.tokens, null); assert.equal(stats.tokenMissing, 2)
  const events = (await service.handle('POST', '/api/realtime/events', { sessionId })).body.events
  assert.equal(events.find(e => e.type === 'tts-transcript').messageId, r.messageId)
  const model = (await service.handle('GET', '/api/config')).body.models.tts
  assert.equal(model.model, MODEL_TTS_SYNTH); assert.equal(model.voice, 'own-qwen-voice')
  assert.doesNotMatch(await readFile(join(dir, 'voice-audit.jsonl'), 'utf8'), /RIFF0000|audio\.example|__previewData/)
})

test('binary provider reports actual profile and unreported usage, synthesis failures get safe separate errors', async t => {
  let fail = false
  const { service, socket } = await fixture(t, { provider: 'openai', profiles: { openai: { auth_type: 'none', model: 'actual-http-model', voice: { id: 'actual-voice' } } }, fetcher: async () => fail ? new Response('Authorization Bearer raw-secret', { status: 402 }) : new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } }) })
  await socket.invoke('synth_tts', { text: 'Hello provider' })
  let records = (await service.handle('POST', '/api/audit', { kind: 'synthesis' })).body.records
  assert.equal(records[0].provider, 'openai'); assert.equal(records[0].model, 'actual-http-model'); assert.deepEqual(records[0].voice, { id: 'actual-voice' })
  assert.equal(records[0].usage, null); assert.equal(records[0].usageAvailable, false)
  fail = true
  const output = await socket.invoke('synth_tts', { text: 'Failed speech' }, 'call2')
  assert.ok(output.error)
  records = (await service.handle('POST', '/api/audit')).body.records
  assert.ok(records.some(r => r.kind === 'synthesis' && r.status === 'failed' && r.callId === 'call2'))
  assert.ok(records.some(r => r.kind === 'error' && r.callId === 'call2'))
  assert.doesNotMatch(JSON.stringify(records), /raw-secret|Authorization/)
})

test('audit filesystem failure leaves synthesis working and exposes storageError', async t => {
  const { service, socket } = await fixture(t, { brokenStorage: true, provider: 'openai', profiles: { openai: { auth_type: 'none' } }, fetcher: async () => new Response(mp3) })
  assert.equal((await socket.invoke('synth_tts', { text: 'Still works' })).synth, true)
  const result = (await service.handle('POST', '/api/audit')).body
  assert.ok(result.storageError); assert.ok(result.records.some(r => r.kind === 'synthesis'))
})

test('design previews do not create synthesis records and failed generation is audited safely', async t => {
  let failed = false
  const { service, socket } = await fixture(t, { fetcher: async (_, options) => {
    if (failed) return Response.json({ code: 'InvalidApiKey', message: 'Bearer private-design-secret' }, { status: 401 })
    const body = JSON.parse(options.body)
    return Response.json({ output: body.input.target_model.includes('tts') ? { voice_id: 'design1', preview_audio: { data: 'AAAA' } } : { voice_id: 'rt1' } })
  } })
  assert.ok((await socket.invoke('design_voice', { description: 'A soft adult voice' })).candidate)
  assert.equal((await service.handle('POST', '/api/audit', { kind: 'synthesis' })).body.total, 0)
  failed = true
  assert.ok((await socket.invoke('design_voice', { description: 'Another adult voice' }, 'design-failure')).error)
  const errors = (await service.handle('POST', '/api/audit', { kind: 'error' })).body.records
  assert.ok(errors.some(record => record.model === 'voice-enrollment' && record.callId === 'design-failure'))
  assert.doesNotMatch(JSON.stringify(errors), /private-design-secret|AAAA/)
})

test('actual TTS WAV duration survives restart and text responses do not double count audio', async t => {
  const wav = Buffer.alloc(44 + 48000)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(48000, 40)
  const { dir, service, socket } = await fixture(t, { provider: 'openai', profiles: { openai: { auth_type: 'none', format: 'wav' } }, fetcher: async () => new Response(wav) })
  await socket.invoke('synth_tts', { text: 'One second' })
  socket.emit('response.done', { response: { id: 'response1', status: 'completed' } })
  const record = (await service.handle('POST', '/api/audit', { kind: 'synthesis' })).body.records[0]
  assert.equal(record.audioDurationSeconds, 1); assert.equal(record.audioOutput, true)
  const stats = (await service.handle('POST', '/api/statistics')).body
  assert.equal(stats.outputAudioSeconds, 1); assert.equal(stats.audioKnown, 1); assert.equal(stats.audioMissing, 0)
  await service.dispose()
  const restarted = createService({ stateDir: dir }, {})
  t.after(() => restarted.dispose())
  assert.deepEqual((await restarted.handle('POST', '/api/statistics')).body, stats)
})

test('JSON TTS providers preserve real usage only; Qwen missing usage remains null', async () => {
  const result = await synthesizeHttpTts({ profile: { protocol: 'mimo-chat', endpoint: 'https://mimo.example/speech', model: 'mimo-tts', voice: 'voice', format: 'mp3', auth_type: 'none' }, text: 'Hello', fetcher: async () => Response.json({ choices: [{ message: { audio: { data: mp3.toString('base64') } } }], usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9, details: { audio_tokens: 3 }, estimated: 'no' }, id: 'provider-request-1' }) })
  assert.deepEqual(result.usage, { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9, details: { audio_tokens: 3 } })
  assert.equal(result.requestId, 'provider-request-1'); assert.equal(result.usageAvailable, true)
  const qwen = await synthesizeTts({ key: 'fake', text: 'Hello', fetcher: async (_, options) => options?.body ? Response.json({ output: { audio: { url: 'https://audio.example' } } }) : new Response(mp3) })
  assert.equal(qwen.usage, null); assert.equal(qwen.usageAvailable, false)
})
