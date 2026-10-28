import { test } from 'node:test'
import assert from 'node:assert'
import { designVoice, deleteBailianVoice, synthesizeTts, VOICE_PRESETS, DEFAULT_VOICE_ID, readDashKey, MODEL_TTS, MODEL_RT } from '../src/voice-design.js'
import { toolDefinitions, REALTIME_INSTRUCTIONS, realtimeInstructions, DEFAULT_TOOLS } from '../src/realtime-service.js'

function fakeFetch(handler) { return async (url, options) => { const result = await handler(url, options); return { ok: result.ok !== false, status: result.status || 200, json: async () => result.json, arrayBuffer: async () => result.buffer || new ArrayBuffer(0) } } }

test('toolDefinitions includes voice tools', () => {
  const defs = toolDefinitions(DEFAULT_TOOLS)
  const names = defs.map(d => d.function.name)
  assert.ok(names.includes('design_voice'))
  assert.ok(names.includes('list_voice_presets'))
  assert.ok(names.includes('apply_voice'))
  assert.ok(names.includes('delete_voice'))
  assert.ok(names.includes('synth_tts'))
  assert.ok(!names.includes('web_fetch')) // Native tools require selected catalog schemas.
})

test('REALTIME_INSTRUCTIONS mentions presets and default voice', () => {
  assert.ok(REALTIME_INSTRUCTIONS.includes('design_voice'))
  assert.ok(REALTIME_INSTRUCTIONS.includes('柔甜亲近'))
  assert.ok(REALTIME_INSTRUCTIONS.includes('清亮灵动'))
})

test('VOICE_PRESETS has three styles and a default id', () => {
  assert.equal(VOICE_PRESETS.length, 3)
  assert.ok(VOICE_PRESETS.every(p => p.id && p.name && p.description))
  assert.ok(DEFAULT_VOICE_ID.length > 0)
})

test('designVoice calls design then clone and returns ids + preview', async () => {
  const calls = []
  const fetcher = fakeFetch(async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    const body = JSON.parse(options.body)
    const input = body.input || {}
    if (input.target_model === MODEL_TTS) {
      return { ok: true, json: { output: { voice_id: 'design-1', preview_audio: { data: Buffer.from('RIFF....').toString('base64') } } } }
    }
    if (input.target_model === MODEL_RT) {
      return { ok: true, json: { output: { voice_id: 'rt-1' } } }
    }
    return { ok: false, json: { code: 'BadRequest', message: 'unknown' } }
  })
  const result = await designVoice({ key: 'test-key', description: '清亮女声', fetcher })
  assert.equal(result.designVoiceId, 'design-1')
  assert.equal(result.realtimeVoiceId, 'rt-1')
  assert.ok(result.previewData)
  assert.equal(result.previewMime, 'audio/wav')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].body.input.target_model, MODEL_TTS)
  assert.equal(calls[1].body.input.target_model, MODEL_RT)
  assert.match(calls[1].body.input.audio, /^data:audio\/wav;base64,/)
})

test('designVoice keeps generated and custom prefixes within upstream limits', async () => {
  for (const prefix of ['vmvqwtu27', '1234567890', 'voice-name_']) {
    const calls = []
    const fetcher = fakeFetch(async (url, options) => {
      const input = JSON.parse(options.body).input
      calls.push(input)
      // Enforce the upstream contract rather than accepting any mock request.
      assert.match(input.prefix, /^[A-Za-z0-9]{1,10}$/)
      return { json: { output: input.target_model === MODEL_TTS
        ? { voice_id: 'design', preview_audio: { data: 'AAAA' } }
        : { voice_id: 'realtime' } } }
    })
    const result = await designVoice({ key: 'k', description: '清亮女声', prefix, fetcher })
    assert.equal(result.realtimeVoiceId, 'realtime')
    assert.equal(calls.length, 2)
    assert.ok(calls[1].prefix.endsWith('rt'))
  }
})

test('designVoice without clone skips realtime step', async () => {
  const fetcher = fakeFetch(async () => ({ ok: true, json: { output: { voice_id: 'd2', preview_audio: { data: 'AAAA' } } } }))
  const result = await designVoice({ key: 'k', description: 'x', cloneToRealtime: false, fetcher })
  assert.equal(result.realtimeVoiceId, '')
  assert.equal(result.designVoiceId, 'd2')
})

test('designVoice redacts no key and rejects bad status', async () => {
  const fetcher = fakeFetch(async () => ({ ok: false, status: 401, json: { code: 'InvalidApiKey', message: 'bad' } }))
  await assert.rejects(() => designVoice({ key: 'k', description: 'x', cloneToRealtime: false, fetcher }), /百炼音色请求失败/)
})

test('readDashKey returns empty when file missing', async () => {
  const key = await readDashKey('/nonexistent/nope.env')
  assert.equal(key, '')
})

test('designVoice passes preview_language as language_hints', async () => {
  let seenLang = null
  const fetcher = fakeFetch(async (url, options) => {
    const body = JSON.parse(options.body)
    if (body.input?.target_model === MODEL_TTS) {
      seenLang = body.input.language_hints?.[0]
      return { ok: true, json: { output: { voice_id: 'd3', preview_audio: { data: 'AAAA' } } } }
    }
    return { ok: true, json: { output: { voice_id: 'rt3' } } }
  })
  await designVoice({ key: 'k', description: 'x', previewLanguage: 'ja', fetcher })
  assert.equal(seenLang, 'ja')
})

test('deleteBailianVoice sends delete_voice action', async () => {
  let seenAction = null, seenVoiceId = null
  const fetcher = fakeFetch(async (url, options) => {
    const body = JSON.parse(options.body)
    seenAction = body.input?.action
    seenVoiceId = body.input?.voice_id
    return { ok: true, json: { output: {} } }
  })
  await deleteBailianVoice('k', 'rt-9', undefined, fetcher)
  assert.equal(seenAction, 'delete_voice')
  assert.equal(seenVoiceId, 'rt-9')
})

test('synthesizeTts calls SpeechSynthesizer then downloads audio URL', async () => {
  const calls = []
  const wav = Buffer.from('RIFF....WAVEfmt ')
  const fetcher = fakeFetch(async (url, options) => {
    calls.push({ url, hasBody: !!options?.body, body: options?.body ? JSON.parse(options.body) : null })
    if (url.endsWith('/SpeechSynthesizer')) {
      return { ok: true, json: { output: { audio: { url: 'https://cdn.example/audio.wav' } } } }
    }
    return { ok: true, buffer: wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) }
  })
  const result = await synthesizeTts({ key: 'k', text: '你好', voice: 'v1', language: 'zh', fetcher })
  assert.equal(result.mime, 'audio/wav')
  assert.ok(result.audio)
  assert.equal(calls.length, 2)
  assert.ok(calls[0].url.endsWith('/SpeechSynthesizer'))
  assert.equal(calls[0].body.input.text, '你好')
  assert.deepEqual(calls[0].body.input.language_hints, ['zh'])
})

test('REALTIME_INSTRUCTIONS mentions synth_tts', () => {
  assert.ok(realtimeInstructions(true).includes('synth_tts'))
})

test('realtimeInstructions toggles synth_tts guidance', () => {
  const off = realtimeInstructions(false)
  const on = realtimeInstructions(true)
  assert.ok(!off.includes('synth_tts 工具把你要说的话合成'))
  assert.ok(on.includes('synth_tts 工具把你要说的话合成'))
  // base persona preserved in both
  assert.ok(off.includes('鲸鱼娘'))
  assert.ok(on.includes('鲸鱼娘'))
})

test('voice settings assistant tools are defined and enabled by default', () => {
  const names = toolDefinitions(DEFAULT_TOOLS).map(d => d.function.name)
  for (const t of ['get_voice_config', 'set_tts_provider', 'set_tts_profile']) {
    assert.ok(names.includes(t), `missing tool ${t}`)
    assert.ok(DEFAULT_TOOLS.includes(t), `not in DEFAULT_TOOLS ${t}`)
  }
  // set_tts_provider enumerates the valid providers
  const prov = toolDefinitions(DEFAULT_TOOLS).find(d => d.function.name === 'set_tts_provider')
  assert.deepEqual(prov.function.parameters.properties.provider.enum, ['qwen', 'openai', 'mimo', 'breeze', 'custom'])
})
