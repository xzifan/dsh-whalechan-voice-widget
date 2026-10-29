import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createService } from '../src/core/service.js'
import { designBreezeVoice } from '../src/core/breeze-voice-design.js'
import { TTS_BUILTINS } from '../src/core/tts-config.js'

const audio = Buffer.from('ID3mock-audio')
const preview = { generated_voice_id: 'gvi_preview', audio_base_64: audio.toString('base64'), media_type: 'audio/mpeg' }

test('Breeze preset endpoints reject every design action without credentials or upstream and preserve old files', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'breeze-presets-paused-'))
  const legacy = join(stateDir, 'breeze-voice-presets.json'), contents = 'legacy-corrupt-data-must-stay-untouched'
  await writeFile(legacy, contents)
  let resolves = 0, calls = 0
  const service = createService({stateDir}, {resolveModelCredential:async()=>{resolves++;return null},fetch:async()=>{calls++;throw Error('unexpected network')}})
  t.after(async()=>{await service.dispose();await rm(stateDir,{recursive:true,force:true})})
  for (const action of ['save','generate','apply','greeting']) {
    const before=resolves
    await assert.rejects(service.handle('POST','/api/voice-presets/'+action,{provider:'breeze',presetId:'preset-warm',prompt:'新的音色提示词'}), error=>error.status===400&&error.message==='Breeze 暂不支持提示词生成/复刻，请使用预设音色')
    assert.equal(resolves,before)
  }
  const config=(await service.handle('GET','/api/config')).body
  assert.deepEqual(config.breezeVoicePresets,[])
  assert.equal(calls,0)
  assert.equal(await readFile(legacy,'utf8'),contents)
  assert.equal(config.voicePresets.length,3)
})

test('Breeze design rejects malformed/bounded responses and never forwards response URLs or credentials in errors', async () => {
  for (const response of [Response.json({ previews: [{ ...preview, generated_voice_id: '../other' }] }), Response.json({ previews: [{ ...preview, audio_base_64: 'garbage?' }] }), new Response('secret-upstream-error', { status: 401 }), new Response('{}', { headers: { 'content-length': String(13 * 1024 * 1024) } })]) {
    let requests = 0
    await assert.rejects(designBreezeVoice({ profile: TTS_BUILTINS.breeze, key: 'test-key', description: 'test voice', fetcher: async () => { requests++; return response } }), error => !error.message.includes('secret-upstream-error'))
    assert.equal(requests, 1)
  }
  let calls = 0
  await assert.rejects(designBreezeVoice({ profile: { ...TTS_BUILTINS.breeze, endpoint: 'http://remote.example/v1/text-to-speech/{voice_id}' }, key: 'test', fetcher: async () => { calls++ } }))
  assert.equal(calls, 0)
})
