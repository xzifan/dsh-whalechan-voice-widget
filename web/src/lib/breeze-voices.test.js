import test from 'node:test'
import assert from 'node:assert/strict'
import {normalizeSettings} from './core.js'
import {BREEZE_PRESET_VOICES} from '../../../src/breeze-voices.js'
import {VOICE_PRESETS as frontendPresets} from './voice-layer.js'
import {VOICE_PRESETS as backendPresets} from '../../../src/voice-design.js'

test('Breeze legacy generated voice normalizes to the shared Chinese preset without changing transport or Qwen',()=>{
 const source={tts_voice_provider:'breeze',tts_profiles:{breeze:{voice:'old-generated-voice',endpoint:'https://breeze.example/v1/text-to-speech/{voice_id}',model:'breeze-tts-2-multilingual',extra:{speed:1.05},key_file:'/legacy/breeze.env'},qwen:{voice:'qwen-unchanged',model:'qwen-audio-3.1-tts-plus'}}}
 const value=normalizeSettings(source)
 assert.equal(value.tts_profiles.breeze.voice,BREEZE_PRESET_VOICES.zh)
 assert.equal(value.tts_profiles.breeze.key_file,undefined)
 assert.equal(value.tts_profiles.breeze.endpoint,source.tts_profiles.breeze.endpoint)
 assert.equal(value.tts_profiles.breeze.model,source.tts_profiles.breeze.model)
 assert.deepEqual(value.tts_profiles.breeze.extra,{speed:1.05})
 assert.deepEqual(value.tts_profiles.qwen,source.tts_profiles.qwen)
 assert.equal(source.tts_profiles.breeze.voice,'old-generated-voice')
})

test('a configured Breeze profile without a voice defaults to the shared Chinese preset',()=>{
 const value=normalizeSettings({tts_profiles:{breeze:{}}})
 assert.equal(value.tts_profiles.breeze.voice,BREEZE_PRESET_VOICES.zh)
 assert.deepEqual(Object.keys(BREEZE_PRESET_VOICES),['zh','ja','en'])
})

test('the frontend built-in default prompt matches the backend warm default exactly',()=>{
 const prompt=frontendPresets.find(preset=>preset.id==='preset-warm').designPrompt
 assert.equal(prompt,backendPresets.find(preset=>preset.id==='preset-warm').description)
 assert.ok(prompt.length>=4&&prompt.length<=500)
})
