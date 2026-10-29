import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVoicePresets, PRESET_GREETING_TEXT, PRESET_GREETING_INSTRUCTION } from '../src/core/voice-presets.js'
import { VOICE_PRESETS, MODEL_TTS } from '../src/core/voice-design.js'
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
async function fixture(t, options = {}) {
 const dir = await mkdtemp(join(tmpdir(), 'preset-cache-')), provider = options.provider || 'qwen'
 let settings = { realtime: { api_host: 'https://route-a.test', key_file: '/key-a' }, tts_voice_provider: provider, tts_profiles: { [provider]: { endpoint: 'https://breeze-a.test/v1/text-to-speech/{voice_id}', model: provider === 'qwen' ? MODEL_TTS : 'breeze-v1', key_file: '/key-a', format: 'mp3', voice: 'original' } } }
 let tail = Promise.resolve(), instance, fails = false
 const calls = { design: [], synth: [] }
 const statePath = join(dir, provider === 'qwen' ? 'voice-presets.json' : 'breeze-voice-presets.json')
 const dependencies = { stateDir: dir, provider, getSettings: () => settings, profileFor: provider === 'breeze' ? s => s.tts_profiles.breeze : undefined,
  mutate(work) { const result = tail.then(work); tail = result.catch(() => {}); return result },
  persistSettings: async patch => { settings = { ...settings, ...patch(settings) } },
  credential: async profile => { await options.credential?.(); return { key: 'private-credential-' + profile.key_file } },
  design: async args => { calls.design.push(args); await options.design?.(args); return { designVoiceId: 'voice-' + calls.design.length } },
  synthesize: async args => { calls.synth.push(args); await options.synth?.(args, statePath); if (fails) throw Error('private-credential-failure');return { audio: Buffer.from(args.voice + ':' + args.text).toString('base64'), mime: 'audio/mpeg' } },
  error: (message, status) => Object.assign(new Error(message), { status }),
 }
 const start = () => { instance = createVoicePresets(dependencies); return instance.ready }
 await start()
 t.after(async () => { await instance.dispose(); await rm(dir, { recursive: true, force: true }) })
 return { calls, statePath, settings: () => settings, update: patch => { settings = { ...settings, ...patch } }, fail: value => { fails = value },
  snapshot: () => instance.snapshot(), post: (action, extra = {}, signal) => instance.handle(action, { provider, presetId: 'preset-bright', ...extra }, signal),
  restart: async () => { await instance.dispose(); await start() },
 }
}

test('candidate is durable before synthesis; failure retries only audio across restart', async t => {
 const f = await fixture(t, { synth: async (_args, path) => { const state = JSON.parse(await readFile(path, 'utf8')); assert.ok(state.presets[0].candidate);assert.equal(state.designs.length, 1) } })
 f.fail(true)
 const result = await f.post('generate')
 assert.ok(result.candidate);assert.ok(result.greetingError);assert.equal(result.greeting, undefined)
 assert.equal(result.voicePresets[0].applied, false)
 await f.restart();f.fail(false)
 const retry = await f.post('generate')
 assert.equal(f.calls.design.length, 1);assert.equal(f.calls.synth.length, 2)
 assert.equal(retry.greeting.text, PRESET_GREETING_TEXT)
 assert.equal(f.calls.synth[1].language, '')
 assert.equal(f.calls.synth[1].instruction, PRESET_GREETING_INSTRUCTION)
 assert.equal(f.settings().tts_profiles.qwen.voice, 'original')
 await f.post('apply');await f.post('greeting');await f.restart();await f.post('generate')
 assert.equal(f.calls.synth.length, 2)
 assert.doesNotMatch(await readFile(f.statePath, 'utf8'), /private-credential/)
})

test('saved prompt restoration and refresh reuse both durable design and audio', async t => {
 const f = await fixture(t)
 const first = await f.post('generate'), original = first.candidate.prompt
 await f.post('save', { prompt: '另一种成年女性声音' });await f.post('generate')
 await f.post('save', { prompt: original });assert.equal(f.snapshot()[0].candidate, null)
 await f.restart()
 const restored = await f.post('generate')
 assert.equal(restored.candidate.voiceId, first.candidate.voiceId)
 assert.deepEqual(restored.greeting, first.greeting)
 assert.equal(f.calls.design.length, 2);assert.equal(f.calls.synth.length, 2)
})

test('same prompt across preset slots coalesces design and audio work', async t => {
 const designGate = deferred(), entered = deferred()
 const f = await fixture(t, { design: async () => { entered.resolve();await designGate.promise } })
 await f.post('save', { presetId: 'preset-warm', prompt: VOICE_PRESETS[0].description })
 const one = f.post('generate');await entered.promise
 const two = f.post('generate', { presetId: 'preset-warm' })
 designGate.resolve()
 const results = await Promise.all([one, two])
 assert.equal(f.calls.design.length, 1);assert.equal(f.calls.synth.length, 1)
 assert.equal(results[0].candidate.voiceId, results[1].candidate.voiceId)
 assert.equal(f.settings().tts_profiles.qwen.voice, 'original')
 assert.ok(f.snapshot().every(p => !p.applied))
})

test('generate/apply/greeting share pending synthesis and no automatic application', async t => {
 const gate = deferred(), entered = deferred()
 const f = await fixture(t, { synth: async () => { entered.resolve();await gate.promise } })
 const generating = f.post('generate');await entered.promise
 assert.equal(f.snapshot()[0].candidate.voiceId, 'voice-1')
 assert.equal(f.settings().tts_profiles.qwen.voice, 'original')
 const preview = f.post('greeting'), apply = f.post('apply')
 gate.resolve()
 const values = await Promise.all([generating, preview, apply])
 assert.equal(f.calls.synth.length, 1)
 assert.deepEqual(values[0].greeting, values[1].greeting)
 assert.deepEqual(values[0].greeting, values[2].greeting)
})

test('editing and restoring while design is pending cannot let old waiter attach candidate', async t => {
 const gate = deferred(), entered = deferred()
 const f = await fixture(t, { design: async () => { entered.resolve();await gate.promise } })
 const pending = f.post('generate'), rejected = assert.rejects(pending, e => e.status === 409)
 await entered.promise
 await f.post('save', { prompt: '临时改过的音色提示词' })
 await f.post('save', { prompt: VOICE_PRESETS[0].description })
 gate.resolve();await rejected
 assert.equal(f.snapshot()[0].candidate, null)
 const restored = await f.post('generate')
 assert.ok(restored.greeting);assert.equal(f.calls.design.length, 1)
})

test('editing during synthesis rejects stale response but retains paid audio for later restoration', async t => {
 const gate = deferred(), entered = deferred()
 const f = await fixture(t, { synth: async () => { entered.resolve();await gate.promise } })
 const pending = f.post('generate'), rejected = assert.rejects(pending, e => e.status === 409)
 await entered.promise;await f.post('save', { prompt: '新的已保存音色描述' })
 gate.resolve();await rejected
 assert.equal(f.snapshot()[0].candidate, null)
 assert.equal(f.settings().tts_profiles.qwen.voice, 'original')
 await f.post('save', { prompt: VOICE_PRESETS[0].description })
 await f.post('generate')
 assert.equal(f.calls.design.length, 1);assert.equal(f.calls.synth.length, 1)
})

test('provider profile and credentials isolate cached designs; restoring identity reuses them', async t => {
 const f = await fixture(t, { provider: 'breeze' }), original = structuredClone(f.settings())
 const first = await f.post('generate')
 for (const change of [{ endpoint: 'https://breeze-b.test/v1/text-to-speech/{voice_id}' }, { model: 'breeze-v2' }, { key_file: '/key-b' }]) {
  f.update({ tts_profiles: { breeze: { ...original.tts_profiles.breeze, ...change } } })
  await assert.rejects(f.post('apply'), e => e.status === 409)
  const next = await f.post('generate');assert.notEqual(next.candidate.voiceId, first.candidate.voiceId)
 }
 f.update(original);await f.restart()
 assert.equal((await f.post('generate')).candidate.voiceId, first.candidate.voiceId)
 assert.equal(f.calls.design.length, 4);assert.equal(f.calls.synth.length, 4)
 assert.doesNotMatch(await readFile(f.statePath, 'utf8'), /private-credential/)
})

test('legacy candidate array migrates without another paid design', async t => {
 const f = await fixture(t)
 const rows = f.snapshot().map(({ applied, generating, ...row }) => row)
 rows[0].candidate = { voiceId: 'legacy-voice', designVoiceId: 'legacy-voice', prompt: rows[0].prompt, model: MODEL_TTS, createdAt: 1 }
 await writeFile(f.statePath, JSON.stringify(rows));await f.restart()
 const result = await f.post('generate')
 assert.equal(result.candidate.voiceId, 'legacy-voice');assert.equal(f.calls.design.length, 0)
 assert.equal(JSON.parse(await readFile(f.statePath, 'utf8')).version, 2)
 await f.restart();await f.post('generate');assert.equal(f.calls.synth.length, 1)
})

for (const action of ['greeting', 'apply']) test(`${action} finishing after prompt save cannot return stale candidate snapshot`, async t => {
 const gate = deferred(), entered = deferred();let hold = false
 const f = await fixture(t, { synth: async () => { if (hold) { entered.resolve();await gate.promise } } })
 f.fail(true);await f.post('generate');f.fail(false);hold = true
 const pending = f.post(action), rejected = assert.rejects(pending, e => e.status === 409)
 await entered.promise
 await f.post('save', { prompt: '刚保存的新提示词声音' })
 gate.resolve();await rejected
 assert.equal(f.snapshot()[0].candidate, null)
 assert.equal(f.settings().tts_profiles.qwen.voice, action === 'apply' ? 'voice-1' : 'original')
})

test('legacy paid candidate survives editing while credentials are unavailable', async t => {
 let offline = false
 const f = await fixture(t, { credential: async () => { if (offline) throw Error('offline') } })
 const rows = f.snapshot().map(({ applied, generating, ...row }) => row)
 rows[0].candidate = { voiceId: 'legacy-offline', designVoiceId: 'legacy-offline', prompt: rows[0].prompt, model: MODEL_TTS }
 await writeFile(f.statePath, JSON.stringify(rows));await f.restart()
 offline = true
 await f.post('save', { prompt: '离线也可以编辑保存声音' })
 await f.post('save', { prompt: rows[0].prompt });await f.restart();offline = false
 assert.equal((await f.post('generate')).candidate.voiceId, 'legacy-offline')
 assert.equal(f.calls.design.length, 0)
 const state = JSON.parse(await readFile(f.statePath, 'utf8'))
 assert.ok(state.designs.every(v => !v.legacyProfile))
})

test('durable history caches are bounded while current candidate remains usable', async t => {
 const f = await fixture(t)
 for (let i = 0; i < 27; i++) { await f.post('save', { prompt: '不同的成年女性声音编号' + i });await f.post('generate') }
 const state = JSON.parse(await readFile(f.statePath, 'utf8'))
 assert.equal(state.designs.length, 24);assert.equal(state.audios.length, 12)
 await f.restart();await f.post('generate')
 assert.equal(f.calls.design.length, 27);assert.equal(f.calls.synth.length, 27)
})
