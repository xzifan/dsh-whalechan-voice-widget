import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createService} from '../src/core/service.js'
import {BREEZE_PRESET_VOICES,BREEZE_ZH_VOICES,resolveBreezeLanguage,normalizeBreezeProfile} from '../src/core/breeze-voices.js'
import {sanitizeAuditRecord} from '../src/core/audit-log.js'

const audio=Buffer.from('ID3fixed-voice-test')
const tick=()=>new Promise(resolve=>setImmediate(resolve))
async function settled(check){for(let n=0;n<200;n++){if(check())return;await tick()}assert.ok(check(),'asynchronous synthesis did not settle')}
async function fixture(t,{fillerText}={}){
 const dir=await mkdtemp(join(tmpdir(),'breeze-fixed-')),requests=[],credentials=[],sockets=[]
 let fail=false,serial=0,releaseTool
 class Socket{
  constructor(){this.handlers={};this.readyState=1;this.outputs=new Map();sockets.push(this)}
  on(name,fn){this.handlers[name]=fn}
  send(raw){const e=JSON.parse(raw);if(e.item?.type==='function_call_output')this.outputs.get(e.item.call_id)?.(JSON.parse(e.item.output))}
  close(){}
  emit(type,data={}){this.handlers.message?.(Buffer.from(JSON.stringify({type,...data})))}
  invoke(name,args={}){const id='call-'+(++serial),responseId='response-'+serial;const result=new Promise(resolve=>this.outputs.set(id,resolve));this.emit('response.created',{response:{id:responseId}});this.emit('response.output_item.done',{response_id:responseId,item:{type:'function_call',name,call_id:id,arguments:JSON.stringify(args)}});return result}
  auto(text){const responseId='automatic-'+(++serial);this.emit('input_audio_buffer.speech_started',{item_id:'user-'+serial});this.emit('input_audio_buffer.speech_stopped');this.emit('response.created',{response:{id:responseId}});this.emit('response.text.done',{response_id:responseId,text});this.emit('response.done',{response:{id:responseId,status:'completed'}})}
 }
 const service=createService({stateDir:dir},{realtimeWebSocket:Socket,
  resolveModelCredential:async provider=>{credentials.push(provider);return {provider,key:provider+'-private-key',source:'provider'}},
  fetch:async(url,options)=>{requests.push({url,body:JSON.parse(options.body),headers:options.headers});return fail?new Response('private-upstream-detail',{status:500}):new Response(audio)},
  generateFiller:fillerText?async()=>fillerText:undefined,
  catalog:async()=>({tools:[{name:'wait',parameters:{type:'object',properties:{}}}],toolExecutionAvailable:true}),
  runTool:()=>new Promise(resolve=>{releaseTool=resolve}),
 })
 t.after(async()=>{releaseTool?.({done:true});await service.dispose();await rm(dir,{recursive:true,force:true})})
 const settings=(await service.handle('GET','/api/config')).body.settings
 settings.tts_voice_provider='breeze';settings.realtime.language='zh';settings.realtime.instructions='Test';settings.tts_profiles={breeze:{voice:'legacy-custom-id'}}
 if(fillerText){settings.enabled_tools=['wait'];settings.tools_configured=true}
 await service.handle('PUT','/api/config',{settings})
 const {sessionId}=(await service.handle('POST','/api/realtime/start')).body
 const socket=sockets[0];socket.emit('session.created')
 const audit=async()=>(await service.handle('POST','/api/audit',{kind:'synthesis'})).body.records
 return {service,socket,sessionId,requests,credentials,audit,setFail(value){fail=value},release(){releaseTool?.({done:true})}}
}

test('Breeze language detection honors supported explicit languages and deterministic script priority',()=>{
 for(const language of ['zh','ja','en'])assert.equal(resolveBreezeLanguage('Hello こんにちは 中文',language),language)
 for(const [text,language] of [['こんにちは世界','ja'],['カタカナ','ja'],['漢字','zh'],['Hello world','en'],['école','en'],['123!?','zh'],['','zh'],['漢字 and latin','zh']])assert.equal(resolveBreezeLanguage(text),language)
 assert.equal(resolveBreezeLanguage('???','bad','ja'),'ja')
 assert.equal(resolveBreezeLanguage('???','','invalid'),'zh')
 assert.equal(resolveBreezeLanguage('hello','constructor'),'en')
 assert.equal(normalizeBreezeProfile({voice:'custom',model:'retained'}).voice,BREEZE_PRESET_VOICES.zh)
 // 中文默认是机灵版，可在设置里切到迷糊版；日语/英语不受影响。
 assert.equal(BREEZE_PRESET_VOICES.zh,BREEZE_ZH_VOICES[0].voiceId)
 assert.equal(normalizeBreezeProfile({zhVoice:BREEZE_ZH_VOICES[1].voiceId},{text:'你好'}).voice,BREEZE_ZH_VOICES[1].voiceId)
 assert.equal(normalizeBreezeProfile({zhVoice:BREEZE_ZH_VOICES[1].voiceId},{text:'こんにちは'}).voice,BREEZE_PRESET_VOICES.ja)
 assert.equal(normalizeBreezeProfile({zhVoice:'voc_not_a_real_voice'},{text:'你好'}).voice,BREEZE_PRESET_VOICES.zh)
 assert.equal(normalizeBreezeProfile({zhVoice:'voc_not_a_real_voice'},{text:'你好'}).zhVoice,undefined)
 assert.deepEqual(normalizeBreezeProfile({voice:'custom',model:'retained'},{text:'こんにちは'}),{voice:BREEZE_PRESET_VOICES.ja,model:'retained'})
})

test('Breeze synthesis selects all three actual endpoint IDs and reports real voice/language',async t=>{
 const h=await fixture(t)
 assert.equal(h.requests.length,0,'start must not perform remote design or synthesis')
 const cases=[['中文回复','','zh'],['こんにちは世界','','ja'],['Hello world','','en'],['Hello explicitly Chinese','zh','zh'],['中文但是明确日语','ja','ja'],['!!!','','zh'],['中文明确英语','en','en']]
 for(const [text,language,expected] of cases){
  const result=await h.socket.invoke('synth_tts',{text,...(language?{language}:{})})
  assert.equal(result.synth,true);assert.equal(result.provider,'breeze');assert.equal(result.voice,BREEZE_PRESET_VOICES[expected]);assert.equal(result.language,expected)
  const request=h.requests.at(-1)
  assert.equal(new URL(request.url).pathname,'/v1/text-to-speech/'+BREEZE_PRESET_VOICES[expected])
  assert.equal(request.body.language_code,expected);assert.equal(request.headers['xi-api-key'],'breeze-private-key')
  const record=(await h.audit()).find(record=>record.text===text)
  assert.equal(record.voice,BREEZE_PRESET_VOICES[expected]);assert.equal(record.language,expected)
 }
 assert.ok(h.requests.every(request=>!request.url.includes('/voice-previews/')))
 const config=(await h.service.handle('GET','/api/config')).body
 assert.equal(config.models.tts.voice,BREEZE_PRESET_VOICES.zh)
 assert.equal(config.settings.tts_profiles.breeze.voice,BREEZE_PRESET_VOICES.zh)
})

test('Breeze automatic English/Japanese synthesis ignores realtime Chinese default',async t=>{
 const h=await fixture(t)
 for(const [text,language] of [['The weather is sunny.','en'],['今日はいい天気ですね。','ja'],['今天晴天。','zh']]){
  const before=h.requests.length;h.socket.auto(text)
  await settled(()=>h.requests.length===before+1)
  await settled(()=>h.requests.length===before+1)
  const request=h.requests.at(-1)
  assert.equal(new URL(request.url).pathname,'/v1/text-to-speech/'+BREEZE_PRESET_VOICES[language])
  assert.equal(request.body.language_code,language)
  await settled(()=>h.requests.length===before+1)
  await h.audit()
 }
})

test('Breeze list/config tools describe fixed presets and reject design mutations before credentials',async t=>{
 const h=await fixture(t)
 const list=await h.socket.invoke('list_voice_presets')
 assert.equal(list.provider,'breeze');assert.deepEqual(list.presets.map(p=>p.voiceId),Object.values(BREEZE_PRESET_VOICES));assert.deepEqual(list.candidates,[])
 const config=await h.socket.invoke('get_voice_config')
 assert.equal(config.currentVoice,BREEZE_PRESET_VOICES.zh);assert.equal(config.presetsAvailable,true);assert.match(config.note,/不支持提示词生成\/复刻/)
 for(const name of ['design_voice','apply_voice','delete_voice']){
  const before=h.credentials.length
  const result=await h.socket.invoke(name,{description:'希望设计新音色',voice_id:'old-custom'})
  assert.ok(result.error);assert.equal(h.credentials.length,before)
 }
 const changed=await h.socket.invoke('set_tts_profile',{provider:'breeze',voice:'forbidden-voice'})
 assert.match(changed.error,/固定三语预设/)
 assert.equal(h.requests.length,0)
 assert.equal((await h.service.handle('GET','/api/config')).body.settings.tts_voice_provider,'breeze')
 const profile=await h.socket.invoke('set_tts_profile',{provider:'breeze',model:'breeze-tts-2-multilingual',extra:{speed:1}})
 assert.equal(profile.profile.voice,BREEZE_PRESET_VOICES.zh)
})

test('Breeze filler uses the same language voice routing as main speech',async t=>{
 const h=await fixture(t,{fillerText:'I am checking that for you.'})
 const result=h.socket.invoke('wait')
 let timeout
 try{
  await Promise.race([(async()=>{while(!h.requests.length)await new Promise(resolve=>setTimeout(resolve,10))})(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('filler did not synthesize')),4000)})])
 }finally{clearTimeout(timeout);h.release()}
 await result
 assert.equal(new URL(h.requests[0].url).pathname,'/v1/text-to-speech/'+BREEZE_PRESET_VOICES.en)
 assert.equal(h.requests[0].body.language_code,'en')
 const records=await h.audit();assert.equal(records[0].voice,BREEZE_PRESET_VOICES.en);assert.equal(records[0].language,'en')
})

test('Breeze failed synthesis audits the selected real language/voice without upstream details',async t=>{
 const h=await fixture(t);h.setFail(true)
 assert.ok((await h.socket.invoke('synth_tts',{text:'こんにちは'})).error)
 const [record]=await h.audit();assert.equal(record.status,'failed');assert.equal(record.language,'ja');assert.equal(record.voice,BREEZE_PRESET_VOICES.ja)
 assert.doesNotMatch(JSON.stringify(record),/private-upstream-detail/)
})

test('audit language accepts only the three supported non-secret tags',()=>{
 for(const language of ['zh','ja','en'])assert.equal(sanitizeAuditRecord({kind:'synthesis',language}).language,language)
 for(const language of ['xx','private-value',{},null])assert.equal(sanitizeAuditRecord({kind:'synthesis',language}).language,undefined)
})

test('Breeze checks shared credentials before opening the realtime socket',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'breeze-missing-fixed-'));let sockets=0,network=0
 class Socket{constructor(){sockets++}on(){}send(){}close(){}}
 const service=createService({stateDir:dir},{realtimeWebSocket:Socket,resolveModelCredential:async provider=>provider==='bailian'?{key:'rt-key'}:null,fetch:async()=>{network++;throw Error('unexpected')}})
 t.after(async()=>{await service.dispose();await rm(dir,{recursive:true,force:true})})
 const settings=(await service.handle('GET','/api/config')).body.settings
 settings.tts_voice_provider='breeze';settings.tts_profiles={breeze:{}}
 await service.handle('PUT','/api/config',{settings})
 await assert.rejects(service.handle('POST','/api/realtime/start'),error=>error.status===503&&/Breeze/.test(error.message))
 assert.equal(sockets,0);assert.equal(network,0)
})
