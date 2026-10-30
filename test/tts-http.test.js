import test from 'node:test'
import assert from 'node:assert/strict'
import {synthesizeHttpTts} from '../src/core/tts-http.js'
import {failureAdvice,failureDetail,synthesisFailureText} from '../src/core/voice-design.js'
const mp3=Buffer.from('ID3fake-audio-for-unit-tests')
const base={name:'test',endpoint:'https://tts.example.test/v1/audio/speech',model:'test-model',voice:'alloy',speed:1.05,format:'mp3',instructions:'',auth_type:'bearer',extra:{}}
function fixture(profile,reply=()=>new Response(mp3,{headers:{'content-type':'audio/mpeg'}})){
 const calls=[];const run=(options={})=>synthesizeHttpTts({profile:{...base,...profile},text:'主人，测试。',key:'fake-provider-token',fetcher:async(url,options)=>{calls.push({url,options,body:JSON.parse(options.body)});return reply()},...options})
 return {calls,run}
}

test('MiMo uses assistant text and user style, header key and base64 response with protected fields',async()=>{
 const {calls,run}=fixture({protocol:'mimo-chat',endpoint:'https://api.xiaomimimo.com/v1/chat/completions',model:'mimo-v2.5-tts',voice:'冰糖',instructions:'语气自然。',auth_type:'header',auth_header:'api-key',extra:{model:'wrong',messages:[{role:'user',content:'wrong'}],audio:{voice:'wrong'},stream:true}},()=>Response.json({choices:[{message:{audio:{data:mp3.toString('base64')}}}]}))
 assert.deepEqual(await run(),{audio:mp3.toString('base64'),mime:'audio/mpeg',usage:null,usageAvailable:false})
 const {body,options}=calls[0];assert.equal(body.model,'mimo-v2.5-tts');assert.deepEqual(body.messages,[{role:'user',content:'语气自然。'},{role:'assistant',content:'主人，测试。'}]);assert.deepEqual(body.audio,{voice:'冰糖',format:'mp3'});assert.equal(body.stream,false);assert.equal(body.speed,undefined);assert.equal(options.headers['api-key'],'fake-provider-token');assert.equal(options.redirect,'error')
})
test('Breeze Blue encodes path voice, uses query output format and raw audio, protects fields and speed',async()=>{
 const {calls,run}=fixture({protocol:'breeze-tts',endpoint:'https://api.breeze.blue/v1/text-to-speech/{voice_id}',model:'breeze-tts-2-multilingual',voice:'voice/with ?chars',auth_type:'header',auth_header:'xi-api-key',extra:{text:'wrong',model_id:'wrong',language_code:'xx',stream:true,voice_settings:{speed:9,guidance_scale:4,volume:.8}}})
 await run({language:'ja'});const {url,body,options}=calls[0]
 assert.equal(url,'https://api.breeze.blue/v1/text-to-speech/voice%2Fwith%20%3Fchars?output_format=mp3');assert.equal(body.text,'主人，测试。');assert.equal(body.model_id,'breeze-tts-2-multilingual');assert.equal(body.language_code,'ja');assert.equal(body.stream,undefined);assert.deepEqual(body.voice_settings,{speed:1.05,guidance_scale:4,volume:.8});assert.equal(options.headers['xi-api-key'],'fake-provider-token')
})
test('OpenAI speech keeps JSON voice type and rejects extra overrides',async()=>{
 const voice={id:'voice-owned-example'};const {calls,run}=fixture({protocol:'openai-speech',voice,instructions:'Speak softly.',extra:{input:'wrong',model:'wrong',voice:'wrong',response_format:'wav',speed:8,stream:true,stream_format:'sse'}})
 await run();const {body,options}=calls[0];assert.deepEqual(body.voice,voice);assert.equal(body.input,'主人，测试。');assert.equal(body.model,'test-model');assert.equal(body.response_format,'mp3');assert.equal(body.speed,1.05);assert.equal(body.instructions,'Speak softly.');assert.equal(body.stream,undefined);assert.equal(body.stream_format,undefined);assert.equal(options.headers.Authorization,'Bearer fake-provider-token')
})
test('custom templates preserve typed full placeholders and safely interpolate JSON text',async()=>{
 const voice={speaker_id:12,options:{language:'ja'}},spoken='A "quote" and \\ slash\nline'
 const {calls,run}=fixture({protocol:'custom-http',voice,auth_type:'none',request_template:{model:'{{model}}',speech:'{{text}}',voice:'{{voice}}',speed:'{{speed}}',metadata:{language:'{{language}}',label:'prefix {{text}}'},stream:true},response_type:'json-hex',response_path:'result.0.audio'},()=>Response.json({result:[{audio:mp3.toString('hex')}]}))
 const result=await run({text:spoken,language:'ja'});assert.equal(result.mime,'audio/mpeg');assert.deepEqual(calls[0].body,{model:'test-model',speech:spoken,voice,speed:1.05,metadata:{language:'ja',label:'prefix '+spoken},stream:false});assert.equal(calls[0].options.headers.Authorization,undefined)
})
test('PCM16 responses are wrapped in mono little endian WAV at the configured rate',async()=>{
 const pcm=Buffer.from([0,0,1,0,255,127,0,128]);const {calls,run}=fixture({protocol:'breeze-tts',endpoint:'https://api.breeze.blue/v1/text-to-speech/{voice_id}',format:'pcm16',sample_rate:16000},()=>new Response(pcm,{headers:{'content-type':'audio/pcm'}}))
 const result=await run();const wav=Buffer.from(result.audio,'base64');assert.equal(result.mime,'audio/wav');assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.readUInt32LE(24),16000);assert.equal(wav.readUInt16LE(22),1);assert.equal(wav.readUInt16LE(34),16);assert.deepEqual(wav.subarray(44),pcm);assert.match(calls[0].url,/output_format=pcm_16000$/)
})
test('unsafe endpoints, unsupported contracts and prototype response paths fail safely',async()=>{
 for(const profile of [{protocol:'openai-speech',endpoint:'http://outside.example/v1/audio/speech'},{protocol:'openai-speech',endpoint:'https://user:secret@example.test/speech'},{protocol:'mimo-chat',model:'mimo-v2.5-tts-voiceclone'},{protocol:'mimo-chat',model:'mimo-v2.5-tts-voicedesign'},{protocol:'openai-speech',auth_type:'header',auth_header:'Host'}]){
  const {calls,run}=fixture(profile);await assert.rejects(run(),error=>error.name==='VoiceNativeError'&&error.status===400);assert.equal(calls.length,0)
 }
 const {run}=fixture({protocol:'custom-http',request_template:{text:'{{text}}'},response_type:'json-base64',response_path:'constructor.prototype.audio'},()=>Response.json({audio:mp3.toString('base64')}))
 await assert.rejects(run(),error=>error.name==='VoiceNativeError'&&error.status===400)
})
test('provider errors, disguised JSON and invalid base64 never echo raw response or credentials',async()=>{
 for(const reply of [()=>new Response('fake-secret-upstream',{status:401}),()=>Response.json({error:'fake-secret-upstream'}),()=>new Response('not actual audio',{headers:{'content-type':'audio/mpeg'}})]){
  const {run}=fixture({protocol:'openai-speech'},reply)
  await assert.rejects(run(),error=>error.name==='VoiceNativeError'&&error.status===502&&!error.message.includes('fake-secret')&&!error.message.includes('fake-provider'))
 }
 const {run}=fixture({protocol:'mimo-chat',voice:'mimo_default'},()=>Response.json({choices:[{message:{audio:{data:'not-valid-base64@'}}}]}));await assert.rejects(run(),{name:'VoiceNativeError',status:502})
 const paid=fixture({protocol:'openai-speech'},()=>new Response('billing secret',{status:402}));await assert.rejects(paid.run(),{name:'VoiceNativeError',status:402})
})
test('speed ranges are provider scoped and fixed-rate PCM cannot be relabeled',async()=>{
 for(const speed of [.25,4]){const {calls,run}=fixture({protocol:'openai-speech',speed});await run();assert.equal(calls[0].body.speed,speed)}
 for(const speed of [.24,4.01]){const {calls,run}=fixture({protocol:'openai-speech',speed});await assert.rejects(run(),{name:'VoiceNativeError',status:400});assert.equal(calls.length,0)}
 const mimo=fixture({protocol:'mimo-chat',voice:'mimo_default',speed:'unused generic field',extra:{speed:9}},()=>Response.json({choices:[{message:{audio:{data:mp3.toString('base64')}}}]}))
 await mimo.run();assert.equal(mimo.calls[0].body.speed,undefined)
 for(const protocol of ['openai-speech','mimo-chat']){const {calls,run}=fixture({protocol,voice:'mimo_default',format:'pcm16',sample_rate:48000});await assert.rejects(run(),{name:'VoiceNativeError',status:400});assert.equal(calls.length,0)}
 const pcm=Buffer.from([0,0,1,0]),fixed=fixture({protocol:'openai-speech',format:'pcm16',sample_rate:24000},()=>new Response(pcm,{headers:{'content-type':'audio/pcm'}}))
 assert.equal(Buffer.from((await fixed.run()).audio,'base64').readUInt32LE(24),24000)
})

test('abort reaches fetch and oversized streamed responses are cancelled without unbounded retention',async()=>{
 const controller=new AbortController(),{calls,run}=fixture({protocol:'openai-speech'});controller.abort();await assert.rejects(run({signal:controller.signal}),{name:'VoiceNativeError',status:499});assert.equal(calls.length,0)
 const active=new AbortController();let received
 await assert.rejects(synthesizeHttpTts({profile:{...base,protocol:'openai-speech'},text:'test',key:'fake',signal:active.signal,fetcher:async(_,options)=>{received=options.signal;active.abort();throw Error('private upstream exception')}}),{name:'VoiceNativeError',status:499});assert.equal(received,active.signal)
 let cancelled=false
 const large=fixture({protocol:'openai-speech'},()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(24*1024*1024));c.enqueue(new Uint8Array(1))},cancel(){cancelled=true}}),{headers:{'content-type':'audio/mpeg'}}))
 await assert.rejects(large.run(),{name:'VoiceNativeError',status:502});assert.equal(cancelled,true)
})

// 非百炼提供方的 4xx 以前一律记成 `HTTP 502, upstream`：UI 把「Key 失效」「配额耗尽」
// 这两类重试确定无效的失败显示成「请重试」。分类与真实码进 safe，对外状态码不变。
test('非百炼 4xx 保留真实状态码与失败分类，上游原文不回显',async()=>{
 const cases=[
  [401,{code:'InvalidApiKey',message:'Invalid API-key provided'},'authorization','InvalidApiKey',true],
  [429,{code:'Throttling.AllocationQuota',message:'insufficient quota'},'quota-or-balance','Throttling.AllocationQuota',true],
  [403,{},'authorization','unknown',true],
  [400,{code:'ModelNotFound',message:'model not exist'},'model-unavailable','ModelNotFound',true],
  [404,{code:'NotFound',message:'no such model'},'model-unavailable','NotFound',true],
  [400,{code:'BadRequest',message:'voice id is invalid'},'upstream','BadRequest',false],
  [500,{code:'InternalError',message:'upstream secret boom'},'upstream','InternalError',false],
 ]
 for(const [real,body,category,code,actionable] of cases){
  const {run}=fixture({protocol:'openai-speech'},()=>Response.json(body,{status:real}))
  await assert.rejects(run(),error=>{
   assert.equal(error.name,'VoiceNativeError')
   assert.equal(error.status,502,'对外状态码仍是 502（402 例外）')
   assert.equal(error.safe.status,real,'safe.status 必须是上游真实码')
   assert.equal(error.safe.category,category)
   assert.equal(error.safe.code,code)
   assert.equal(error.message,`语音服务返回 HTTP ${real}`,'文案只报状态码，不回显上游原文')
   assert.equal(failureDetail(error),`HTTP ${real}, ${category}${code==='unknown'?'':`, ${code}`}`)
   assert.equal(synthesisFailureText(error),`Speech synthesis failed (HTTP ${real}, ${category}${code==='unknown'?'':`, ${code}`})`)
   assert.equal(Boolean(failureAdvice(error)),actionable,'只有能靠改配置修好的失败才给「重试无效」建议')
   return true
  })
 }
 // 非 JSON 错误体不影响 401/402/429 的分类。
 const plain=fixture({protocol:'openai-speech'},()=>new Response('quota exceeded',{status:429}))
 await assert.rejects(plain.run(),{name:'VoiceNativeError',status:502})
 const error=await plain.run().then(()=>null,e=>e)
 assert.equal(error.safe.category,'quota-or-balance');assert.equal(error.safe.status,429);assert.equal(error.safe.code,'unknown')
})
