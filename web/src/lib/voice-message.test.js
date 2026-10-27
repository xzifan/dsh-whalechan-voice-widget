import test from 'node:test'
import assert from 'node:assert/strict'
import {applyRealtimeEvent,bytesToBase64} from './realtime.js'
const reduce=events=>events.reduce(applyRealtimeEvent,{})

test('input voice appears before ASR and uses audio offsets instead of delivery latency',()=>{
 let state=reduce([{type:'speech-started',messageId:'u',at:1000,audioStartMs:400}])
 assert.equal(state.messages[0].text,'')
 assert.equal(state.messages[0].voice,true)
 state=applyRealtimeEvent(state,{type:'speech-stopped',messageId:'u',at:6000,audioEndMs:2900})
 state=applyRealtimeEvent(state,{type:'user-transcript-done',messageId:'u',text:'你好'})
 assert.equal(state.messages.length,1)
 assert.equal(state.messages[0].audioDurationSeconds,2.5)
 assert.equal(state.messages[0].text,'你好')
})

test('native PCM arriving before text counts exact bytes and stays with its response',()=>{
 const data=bytesToBase64(new Uint8Array(24000))
 const state=reduce([
  {type:'audio',messageId:'m',responseId:'a',data},
  {type:'audio',messageId:'m',responseId:'a',data},
  {type:'transcript-done',messageId:'m',responseId:'a',text:'第一句'},
  {type:'transcript-done',messageId:'m',responseId:'b',text:'第二句'},
  {type:'audio',messageId:'m',responseId:'b',data},
 ])
 assert.deepEqual(state.messages.map(m=>m.audioDurationSeconds),[1,.5])
})

test('speech previews accumulate actual duration, while design previews create no voice messages',()=>{
 const state=reduce([
  {type:'preview-audio',messageId:'design',audioDurationSeconds:20,data:'preview'},
  {type:'preview-audio',purpose:'speech',messageId:'m',audioDurationSeconds:1.25},
  {type:'tts-transcript',messageId:'m',callId:'one',text:'第一句'},
  {type:'preview-audio',purpose:'speech',messageId:'m',audioDurationSeconds:2},
  {type:'tts-transcript',messageId:'m',callId:'two',text:'第二句'},
 ])
 assert.equal(state.messages.length,1)
 assert.equal(state.messages[0].audioDurationSeconds,3.25)
 assert.equal(state.messages[0].voice,true)
})

test('unknown synthesis duration remains unknown and failures retain fallback delivery',()=>{
 const state=reduce([
  {type:'preview-audio',purpose:'speech',messageId:'m'},
  {type:'tts-transcript',messageId:'m',text:'你好'},
  {type:'tts-transcript',messageId:'failed',text:'失败回退',delivery:'failed'},
 ])
 assert.equal(state.messages[0].audioDurationSeconds,undefined)
 assert.equal(state.messages[1].delivery,'failed')
})
