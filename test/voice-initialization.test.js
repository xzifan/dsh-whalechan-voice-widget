import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createService} from '../src/service.js'
import {BREEZE_PRESET_VOICES} from '../src/breeze-voices.js'
import {MODEL_TTS,VOICE_PRESETS} from '../src/voice-design.js'

async function fixture(t,{gate,fail=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'voice-init-')),requests=[],sockets=[]
 let completed=false,shouldFail=fail
 class Socket{constructor(){assert.equal(completed||requests.length===0,true,'socket must open after design');this.readyState=1;this.handlers={};sockets.push(this)}on(name,fn){this.handlers[name]=fn}send(){}close(){}}
 const dependencies={realtimeWebSocket:Socket,resolveBailianProvider:async()=>({key:'test-key',source:'provider'}),fetch:async(url,options)=>{
  const body=JSON.parse(options.body);requests.push(body);if(gate)await gate
  if(shouldFail)return {ok:false,status:500,json:async()=>({code:'TestFailure'})}
  completed=true
  return {ok:true,json:async()=>({output:{voice_id:'initialized-voice',preview_audio:{data:'preview'}}})}
 }}
 let service=createService({stateDir:dir},dependencies)
 t.after(async()=>{await service.dispose();await rm(dir,{recursive:true,force:true})})
 const config=async()=>(await service.handle('GET','/api/config')).body.settings
 const start=(settings)=>(service.handle('POST','/api/realtime/start',settings?{settings}:{}))
 return {requests,sockets,config,start,get service(){return service},setFail(value){shouldFail=value},async reload(){await service.dispose();service=createService({stateDir:dir},dependencies)}}
}

test('first start designs exact default and saves before opening socket; restart and stale drafts reuse it',async t=>{
 const s=await fixture(t),before=await s.config()
 const first=await s.start()
 assert.equal(s.requests.length,1)
 assert.equal(s.requests[0].input.voice_prompt,VOICE_PRESETS.find(p=>p.id==='preset-warm').description)
 assert.equal(s.requests[0].input.action,'create_voice')
 assert.equal(first.body.voiceSettingsPatch.tts_profiles.qwen.voice,'initialized-voice')
 const saved=await s.config();assert.equal(saved.tts_profiles.qwen.model,MODEL_TTS);assert.equal(saved.tts_profiles.qwen.voice,'initialized-voice')
 assert.equal(saved.system_prompt,before.system_prompt)
 await s.start(before);assert.equal(s.requests.length,1)
 await s.reload();await s.start();assert.equal(s.requests.length,1)
})

test('explicit existing voice and raw Realtime mode skip design',async t=>{
 const s=await fixture(t),initial=await s.config()
 await s.service.handle('PUT','/api/config',{settings:{...initial,tts_profiles:{qwen:{voice:'chosen-voice',model:MODEL_TTS}}}})
 await s.start();assert.equal(s.requests.length,0)
 await s.start({...initial,realtime:{...initial.realtime,use_tts_voice:false}});assert.equal(s.requests.length,0)
})

test('stale explicit voice snapshot reuses the current saved voice only in the same scope',async t=>{
 const s=await fixture(t),initial=await s.config()
 const old={...initial,tts_profiles:{qwen:{voice:'old-voice',model:MODEL_TTS}}}
 await s.service.handle('PUT','/api/config',{settings:{...initial,tts_profiles:{qwen:{voice:'new-voice',model:MODEL_TTS}}}})
 const result=(await s.start(old)).body
 assert.equal(result.voiceSettingsPatch.tts_profiles.qwen.voice,'new-voice')
 assert.equal((await s.config()).tts_profiles.qwen.voice,'new-voice')
 assert.equal(s.requests.length,0)
 await assert.rejects(s.start({...old,realtime:{...old.realtime,api_host:'https://different.example'}}),/请先保存声音设置/)
 assert.equal(s.sockets.length,1)
})

test('simultaneous first starts share paid design and atomic saved voice',async t=>{
 let release;const gate=new Promise(r=>{release=r}),s=await fixture(t,{gate})
 const a=s.start(),b=s.start();
 for(let n=0;n<30&&s.requests.length===0;n++)await new Promise(r=>setImmediate(r))
 assert.equal(s.requests.length,1);assert.equal(s.sockets.length,0)
 release();const results=await Promise.all([a,b]);assert.equal(s.requests.length,1);assert.equal(s.sockets.length,2)
 assert.equal(results[0].body.voiceSettingsPatch.tts_profiles.qwen.voice,results[1].body.voiceSettingsPatch.tts_profiles.qwen.voice)
})

test('failed initialization opens no socket and retries without pretending a voice exists',async t=>{
 const s=await fixture(t,{fail:true})
 await assert.rejects(s.start(),/默认音色初始化失败/)
 assert.equal(s.sockets.length,0);assert.equal((await s.config()).tts_profiles.qwen,undefined)
 s.setFail(false);await s.start();assert.equal(s.requests.length,2);assert.equal(s.sockets.length,1)
})

test('settings edit during design is not overwritten; paid design remains cached for retry',async t=>{
 let release;const gate=new Promise(r=>{release=r}),s=await fixture(t,{gate}),initial=await s.config()
 const start=s.start();
 for(let n=0;n<30&&s.requests.length===0;n++)await new Promise(r=>setImmediate(r))
 await s.service.handle('PUT','/api/config',{settings:{...initial,realtime:{...initial.realtime,use_tts_voice:false}}})
 release();await assert.rejects(start,/声音配置在初始化期间已改变/)
 assert.equal(s.sockets.length,0);assert.equal((await s.config()).realtime.use_tts_voice,false)
  await s.service.handle('PUT','/api/config',{settings:initial});await s.start();assert.equal(s.requests.length,1)
})

test('an unsaved explicit voice cannot bypass initialization of the actual TTS profile',async t=>{
 const s=await fixture(t),initial=await s.config()
 await assert.rejects(s.start({...initial,tts_profiles:{qwen:{voice:'unsaved-voice'}}}),/请先保存声音设置/)
 assert.equal(s.requests.length,0);assert.equal(s.sockets.length,0)
})

test('cancelled first start keeps paid cache but opens no socket and does not apply',async t=>{
 let release;const gate=new Promise(r=>{release=r}),s=await fixture(t,{gate}),controller=new AbortController()
 const start=s.service.handle('POST','/api/realtime/start',{},controller.signal)
 for(let n=0;n<30&&s.requests.length===0;n++)await new Promise(r=>setImmediate(r))
 controller.abort();release();await assert.rejects(start,{name:'AbortError'})
 assert.equal(s.sockets.length,0);assert.equal((await s.config()).tts_profiles.qwen,undefined)
 await s.start();assert.equal(s.requests.length,1)
})

test('initialization wait does not allow simultaneous starts to exceed session limit',async t=>{
 let release;const gate=new Promise(r=>{release=r}),s=await fixture(t,{gate})
 const starts=Array.from({length:6},()=>s.start())
 for(let n=0;n<30&&s.requests.length===0;n++)await new Promise(r=>setImmediate(r))
 release();const results=await Promise.allSettled(starts)
 assert.equal(results.filter(r=>r.status==='fulfilled').length,4)
 assert.equal(s.sockets.length,4)
 for(const r of results.filter(r=>r.status==='rejected'))assert.equal(r.reason.status,429)
})

test('startup reuses an already designed default candidate without designing again',async t=>{
 const s=await fixture(t)
 const generated=(await s.service.handle('POST','/api/voice-presets/generate',{presetId:'preset-warm'})).body
 assert.equal(generated.candidate.voiceId,'initialized-voice')
 const designCount=()=>s.requests.filter(r=>r.input?.voice_prompt).length
 assert.equal(designCount(),1)
 await s.start();assert.equal(designCount(),1)
 assert.equal((await s.config()).tts_profiles.qwen.voice,generated.candidate.voiceId)
})

test('disposal while design is in flight never opens a session',async t=>{
 let release;const gate=new Promise(r=>{release=r}),s=await fixture(t,{gate})
 const start=s.start()
 for(let n=0;n<30&&s.requests.length===0;n++)await new Promise(r=>setImmediate(r))
 const stopped=s.service.dispose();release()
 await assert.rejects(start);await stopped
 assert.equal(s.sockets.length,0)
})

test('Breeze starts from fixed presets with saved scope and never designs a remote voice',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'breeze-fixed-init-')),requests=[],sockets=[]
 class Socket{constructor(){this.readyState=1;sockets.push(this)}on(){}send(){}close(){}}
 const service=createService({stateDir:dir},{realtimeWebSocket:Socket,resolveModelCredential:async provider=>({key:provider==='breeze'?'test-key':'rt-key',source:'provider',provider}),fetch:async(url)=>{requests.push(url);throw Error('must not design')}})
 t.after(async()=>{await service.dispose();await rm(dir,{recursive:true,force:true})})
 const initial=(await service.handle('GET','/api/config')).body.settings
 const settings={...initial,tts_voice_provider:'breeze',tts_profiles:{breeze:{voice:'old-custom-voice',endpoint:'https://api.breeze.blue/v1/text-to-speech/{voice_id}',model:'breeze-tts-2-multilingual'}}}
 await assert.rejects(service.handle('POST','/api/realtime/start',{settings}),/请先保存声音设置/)
 await service.handle('PUT','/api/config',{settings})
 const first=(await service.handle('POST','/api/realtime/start',{settings})).body
 assert.equal(first.voiceSettingsPatch.tts_voice_provider,'breeze')
 assert.equal(first.voiceSettingsPatch.tts_profiles.breeze.voice,BREEZE_PRESET_VOICES.zh)
 const config=(await service.handle('GET','/api/config')).body
 assert.equal(config.settings.tts_profiles.breeze.voice,BREEZE_PRESET_VOICES.zh)
 assert.equal(config.models.tts.voice,BREEZE_PRESET_VOICES.zh)
 assert.deepEqual(config.breezeVoicePresets,[])
 assert.equal(requests.length,0);assert.equal(sockets.length,1)
 await assert.rejects(service.handle('POST','/api/realtime/start',{settings:{...settings,tts_profiles:{breeze:{...settings.tts_profiles.breeze,endpoint:'https://different.example/v1/text-to-speech/{voice_id}'}}}}),/请先保存声音设置/)
 await service.handle('POST','/api/realtime/start');assert.equal(requests.length,0);assert.equal(sockets.length,2)
})
