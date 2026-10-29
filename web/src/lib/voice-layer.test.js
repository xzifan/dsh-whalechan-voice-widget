import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeVoiceLayer,normalizeVoiceLayerSettings,VOICE_PRESETS,VOICE_PROVIDERS,DEFAULT_VOICE_ID,REALTIME_PROVIDERS} from './voice-layer.js'

test('voice layer defaults to Qwen TTS with the TTS mouth on',()=>{
  const value=normalizeVoiceLayer({})
  assert.equal(value.use_tts_voice,true)
  assert.ok(value.tools.includes('synth_tts'))
  const layer=normalizeVoiceLayerSettings({})
  assert.equal(layer.tts_voice_provider,'qwen')
  assert.deepEqual(layer.tts_profiles,{})
})

test('partial realtime input is coerced without dropping required keys',()=>{
  const value=normalizeVoiceLayer({enabled:false,use_tts_voice:false})
  assert.equal(value.enabled,false)
  assert.equal(value.use_tts_voice,false)
  assert.equal(value.turn_mode,'smart_turn')
  assert.equal(value.language,'zh')
})

test('voice layer settings keep provider id and profile map',()=>{
  const value=normalizeVoiceLayerSettings({tts_voice_provider:'openai',tts_profiles:{openai:{voice:'alloy'}}})
  assert.equal(value.tts_voice_provider,'openai')
  assert.deepEqual(value.tts_profiles,{openai:{voice:'alloy'}})
})

test('presets and providers expose the default warm voice and three presets',()=>{
  assert.equal(VOICE_PRESETS.length,3)
  assert.deepEqual(VOICE_PRESETS.map(p=>p.name),['清亮灵动','柔甜亲近','清冷知性'])
  assert.equal(VOICE_PRESETS[1].id,'preset-warm')
  assert.equal(DEFAULT_VOICE_ID,'qwen-audio-3.1-realtime-plus-whalebrt-86754649b8a14117ac9c0f9e1716ac2b')
  assert.equal(VOICE_PROVIDERS[0].value,'qwen')
})
test('realtime provider list only offers brains that actually work',()=>{
  // 火山引擎曾以 `WorkInProgress` 禁用项挂在实时模型下拉里：没有音频协议、没有连接，
  // 却能预存凭据，读起来像"配了凭据就能用"。入口已移除，接入时再和实现一起加回来。
  assert.deepEqual(REALTIME_PROVIDERS.map(p=>p.value),['qwen'])
  for(const item of REALTIME_PROVIDERS){
    assert.equal(item.disabled,undefined)
    assert.doesNotMatch(item.label,/WorkInProgress/i)
    assert.doesNotMatch(item.label,/火山/)
  }
})
test('voice presets: only the warm preset carries a real voiceId',async()=>{
  const {VOICE_PRESETS,DEFAULT_VOICE_ID}=await import('./voice-layer.js')
  const warm=VOICE_PRESETS.find(p=>p.id==='preset-warm')
  const bright=VOICE_PRESETS.find(p=>p.id==='preset-bright')
  const calm=VOICE_PRESETS.find(p=>p.id==='preset-calm')
  assert.equal(warm.voiceId,DEFAULT_VOICE_ID)
  assert.equal(bright.voiceId,'')
  assert.equal(calm.voiceId,'')
  // each preset must carry a design prompt distinct from its short description
  for(const p of VOICE_PRESETS){assert.ok(typeof p.designPrompt==='string'&&p.designPrompt.length>p.description.length)}
})
