import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createService } from '../src/core/service.js'
import { VOICE_PRESETS, MODEL_TTS } from '../src/core/voice-design.js'
import { PRESET_GREETING_TEXT } from '../src/core/voice-presets.js'

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function fixture(t, options = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'voice-presets-test-'))
  const calls = []
  let failGreeting = false
  const dependencies = {
    resolveBailianProvider: async () => { await options.credential?.(); return { key: 'secret-must-not-leak', source: 'provider' } },
    fetch: async (url, init) => {
      if (url === 'https://audio.test/greeting') return new Response(options.audio || Buffer.from('greeting'))
      const body = JSON.parse(init.body); calls.push(body)
      if (url.endsWith('/customization')) {
        options.started?.resolve()
        if (options.gate) await options.gate.promise
        return Response.json({ output: { voice_id: 'designed-' + calls.filter(c => c.model === 'voice-enrollment').length, preview_audio: { data: 'cHJldmlldw==' } } })
      }
      if (failGreeting) throw Error('secret-must-not-leak')
      return Response.json({ output: { audio: { url: 'https://audio.test/greeting' } }, usage: options.usage, request_id: 'greeting-request' })
    },
  }
  let service = createService({ stateDir }, dependencies)
  t.after(async () => { await service.dispose(); await rm(stateDir, { recursive: true, force: true }) })
  return { calls, stateDir, fail: value => { failGreeting = value },
    query: async path => (await service.handle('POST', '/api/' + path, {})).body,
    request: (method, path) => service.handle(method, path),
    config: async () => (await service.handle('GET', '/api/config')).body,
    post: async (action, body = { presetId: 'preset-bright' }, signal) => (await service.handle('POST', '/api/voice-presets/' + action, body, signal)).body,
    put: async settings => (await service.handle('PUT', '/api/config', { settings })).body,
    restart: async () => { await service.dispose(); service = createService({ stateDir }, dependencies) },
  }
}

test('saved prompts generate TTS candidates, survive restart, and explicit apply greets with applied voice', async t => {
  const f = await fixture(t)
  const initial = await f.config()
  assert.deepEqual(initial.voicePresets.map(p => [p.id, p.prompt]), VOICE_PRESETS.map(p => [p.id, p.description]))
  await f.post('save', { presetId: 'preset-bright', prompt: '自然开心的成年女性声音' })
  const generated = await f.post('generate')
  assert.equal(f.calls.length, 2)
  assert.equal(f.calls[0].input.voice_prompt, '自然开心的成年女性声音')
  assert.equal(f.calls[0].input.target_model, MODEL_TTS)
  assert.equal(generated.voicePresets[0].applied, false)
  assert.deepEqual((await f.config()).settings, initial.settings)
  assert.equal((await f.post('generate')).candidate.voiceId, generated.candidate.voiceId)
  assert.equal(f.calls.length, 2)
  await f.restart()
  assert.equal((await f.config()).voicePresets[0].candidate.voiceId, generated.candidate.voiceId)
  const applied = await f.post('apply')
  assert.equal(applied.applied, true)
  assert.equal(applied.settings.tts_voice_provider, 'qwen')
  assert.equal(applied.settings.tts_profiles.qwen.voice, generated.candidate.voiceId)
  assert.equal(applied.settings.tts_profiles.qwen.model, MODEL_TTS)
  assert.equal(applied.settings.realtime.use_tts_voice, true)
  assert.equal(applied.voicePresets[0].applied, true)
  assert.deepEqual(applied.greeting, { audio: Buffer.from('greeting').toString('base64'), mime: 'audio/wav', text: PRESET_GREETING_TEXT })
  assert.equal(f.calls[1].input.text, PRESET_GREETING_TEXT)
  assert.equal(f.calls[1].input.language_hints, undefined)
  assert.ok(generated.greeting.audio)
  assert.match(f.calls[1].input.instruction, /开心.*自然.*轻快/)
  assert.equal(f.calls[1].input.voice, generated.candidate.voiceId)
  assert.equal(JSON.parse(await readFile(join(f.stateDir, 'settings.json'), 'utf8')).voicePresets, undefined)
  await f.restart()
  assert.equal((await f.config()).voicePresets[0].applied, true)
  const snapshot = await f.config(); snapshot.voicePresets[0].candidate.voiceId = 'mutated'
  assert.equal((await f.config()).voicePresets[0].candidate.voiceId, generated.candidate.voiceId)
})

test('greeting failure keeps apply successful, safe, durable and retryable', async t => {
  const f = await fixture(t)
  f.fail(true); const generated = await f.post('generate')
  assert.ok(generated.candidate); assert.ok(generated.greetingError)
  const result = await f.post('apply')
  assert.equal(result.applied, true)
  assert.equal(result.greeting, undefined)
  assert.equal(typeof result.greetingError, 'string')
  assert.doesNotMatch(JSON.stringify(result), /secret-must-not-leak/)
  await f.restart()
  assert.equal((await f.config()).voicePresets[0].applied, true)
  f.fail(false)
  assert.ok((await f.post('greeting')).greeting.audio)
  assert.equal(f.calls.filter(c => c.model === 'voice-enrollment').length, 1)
})

test('validation rejects malformed input; changed prompts invalidate only candidate', async t => {
  const f = await fixture(t)
  for (const body of [null, [], {}, { presetId: '../x' }, { presetId: 'preset-bright', prompt: 'tiny' }]) {
    await assert.rejects(f.post('generate', body), e => e.status === 400)
  }
  for (const prompt of ['', 'abc', 'x'.repeat(501), null, 123]) await assert.rejects(f.post('save', { presetId: 'preset-bright', prompt }), e => e.status === 400)
  await assert.rejects(f.post('apply'), e => e.status === 409)
  await f.post('generate')
  assert.ok((await f.post('greeting')).greeting.audio)
  await f.post('apply')
  const settings = (await f.config()).settings
  await f.post('save', { presetId: 'preset-bright', prompt: VOICE_PRESETS[0].description })
  assert.ok((await f.config()).voicePresets[0].candidate)
  await f.post('save', { presetId: 'preset-bright', prompt: '新的成年女性音色描述' })
  assert.equal((await f.config()).voicePresets[0].candidate, null)
  assert.deepEqual((await f.config()).settings, settings)
  await assert.rejects(f.post('apply'), e => e.status === 409)
})

test('concurrent generation deduplicates and disconnect does not discard shared candidate', async t => {
  const gate = deferred(), started = deferred(), f = await fixture(t, { gate, started })
  const controller = new AbortController()
  const one = f.post('generate', undefined, controller.signal)
  await started.promise
  const two = f.post('generate')
  controller.abort()
  assert.equal((await f.config()).voicePresets[0].generating, true)
  gate.resolve()
  const results = await Promise.all([one, two])
  assert.equal(f.calls.length, 2)
  assert.deepEqual(results[0].candidate, results[1].candidate)
  assert.equal((await f.config()).voicePresets[0].generating, false)
})

test('editing during generation prevents stale paid result from being applied', async t => {
  const gate = deferred(), started = deferred(), f = await fixture(t, { gate, started })
  const pending = f.post('generate')
  const rejected = assert.rejects(pending, e => e.status === 409)
  await started.promise
  await f.post('save', { presetId: 'preset-bright', prompt: '已经修改的成年女性音色描述' })
  gate.resolve(); await rejected
  assert.equal((await f.config()).voicePresets[0].candidate, null)
  await assert.rejects(f.post('apply'), e => e.status === 409)
})

test('GET config keeps settings, model and applied state from one snapshot during concurrent apply', async t => {
  const entered = deferred(), release = deferred()
  let pause = false
  const f = await fixture(t, { credential: async () => { if (pause) { pause = false; entered.resolve(); await release.promise } } })
  await f.post('generate')
  const before = await f.config()
  pause = true
  const pending = f.config()
  await entered.promise
  const applied = await f.post('apply')
  release.resolve()
  const response = await pending
  assert.deepEqual(response.settings, before.settings)
  assert.deepEqual(response.models, before.models)
  assert.equal(response.voicePresets[0].applied, false)
  assert.equal(applied.voicePresets[0].applied, true)
  assert.equal((await f.config()).voicePresets[0].applied, true)
})

test('greeting audit records real usage and duration without inventing conversation identity', async t => {
  const wav = Buffer.alloc(44 + 48000)
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8)
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(48000, 40)
  const f = await fixture(t, { audio: wav, usage: { total_tokens: 9 } })
  const generated = await f.post('generate')
  await f.post('apply')
  const record = (await f.query('audit')).records.find(r => r.kind === 'synthesis')
  assert.equal(record.text, PRESET_GREETING_TEXT)
  assert.equal(record.provider, 'bailian')
  assert.equal(record.model, MODEL_TTS)
  assert.equal(record.voice, generated.candidate.voiceId)
  assert.equal(record.requestId, 'greeting-request')
  assert.equal(record.audioDurationSeconds, 1)
  assert.equal(record.audioOutput, true)
  assert.equal(record.usage.total_tokens, 9)
  assert.equal(record.sessionId, undefined)
  assert.equal(record.status, 'completed')
  assert.equal((await f.query('statistics')).tokens, 9)
  f.fail(true)
  assert.ok((await f.post('greeting')).greeting.audio)
  const records = (await f.query('audit')).records
  assert.equal(records.filter(r => r.kind === 'synthesis').length, 1)
  assert.doesNotMatch(JSON.stringify(records), /secret-must-not-leak/)
  await f.restart()
  assert.equal((await f.query('statistics')).tokens, 9)
  assert.equal((await f.query('history/sessions')).total, 0)
})

test('preset routes reject unsupported methods and unknown actions without mutation', async t => {
  const f = await fixture(t)
  for (const method of ['GET', 'PATCH', 'DELETE', 'PUT']) await assert.rejects(f.request(method, '/api/voice-presets/apply'), e => e.status === 405)
  await assert.rejects(f.request('POST', '/api/voice-presets/unknown'), e => e.status === 404)
  assert.equal(f.calls.length, 0)
})

test('queued settings save and apply preserve unrelated configuration', async t => {
  const f = await fixture(t)
  await f.post('generate')
  const settings = (await f.config()).settings
  settings.system_prompt = 'Keep this unrelated saved setting'
  await Promise.all([f.put(settings), f.post('apply')])
  const result = await f.config()
  assert.equal(result.settings.system_prompt, settings.system_prompt)
  assert.equal(result.voicePresets[0].applied, true)
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(f.post('save', { presetId: 'preset-bright', prompt: '应该不会保存的音色描述' }, aborted.signal))
  assert.equal((await f.config()).voicePresets[0].prompt, VOICE_PRESETS[0].description)
})
