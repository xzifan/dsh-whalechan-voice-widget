import test from 'node:test'
import assert from 'node:assert/strict'
import {mergeAppliedVoice,presetPromptIssue} from './voice-presets.js'
import {ENDPOINT_METHODS} from './core.js'

test('applying a preset preserves unrelated unsaved draft fields',()=>{
 const draft={system_prompt:'unsaved chat prompt',workspace:'/draft',tts_voice_provider:'custom',tts_profiles:{custom:{voice:'keep'},qwen:{voice:'old'}},realtime:{voice:'independent realtime voice',language:'ja',use_tts_voice:false}}
 const applied={system_prompt:'server prompt',tts_voice_provider:'qwen',tts_profiles:{qwen:{voice:'new-designed',model:'qwen-audio-3.1-tts-flash'}},realtime:{use_tts_voice:true,language:'zh'}}
 const result=mergeAppliedVoice(draft,applied)
 assert.equal(result.system_prompt,draft.system_prompt)
 assert.equal(result.workspace,draft.workspace)
 assert.deepEqual(result.tts_profiles.custom,draft.tts_profiles.custom)
 assert.equal(result.realtime.language,'ja')
 assert.equal(result.realtime.voice,'independent realtime voice')
 assert.equal(result.realtime.use_tts_voice,true)
 assert.deepEqual(result.tts_profiles.qwen,applied.tts_profiles.qwen)
 assert.equal(draft.tts_profiles.qwen.voice,'old')
})

test('preset prompts enforce trimmed size and authenticated bridge methods',()=>{
 assert.ok(presetPromptIssue('   '))
 assert.ok(presetPromptIssue('abc'))
 assert.ok(presetPromptIssue('x'.repeat(501)))
 assert.equal(presetPromptIssue('  温暖自然的声音  '),'')
 for(const action of ['save','generate','apply','greeting'])assert.deepEqual(ENDPOINT_METHODS[`/api/voice-presets/${action}`],['POST'])
})
