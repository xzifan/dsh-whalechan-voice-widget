import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createService} from '../src/core/service.js'
import {TTS_BUILTINS} from '../src/core/tts-config.js'

async function fixture(t,{keys={},failResolve=false,failSave=false,saveError=null}={}) {
  const dir=await mkdtemp(join(tmpdir(),'model-credential-service-'))
  const resolutions=[],saves=[],sockets=[],network=[]
  class Socket {
    constructor(url,options){this.readyState=1;this.url=url;this.options=options;sockets.push(this)}
    on(){}send(){}close(){this.readyState=3}
  }
  const service=createService({stateDir:dir},{
    realtimeWebSocket:Socket,
    resolveModelCredential:async provider=>{
      resolutions.push(provider)
      if(failResolve)throw Error('private-secret-in-resolver-exception')
      return {provider,source:'provider',configured:!!keys[provider],routeAvailable:provider==='bailian',credentialRef:`TEST_${provider.toUpperCase()}_KEY`,...(keys[provider]?{key:keys[provider]}:{})}
    },
    configureModelCredential:async(provider,key)=>{
      if(failSave)throw Error('private-secret-in-save-exception')
      if(saveError)throw saveError
      saves.push({provider,key});keys[provider]=key
    },
    fetch:async(url,options)=>{network.push({url,options});throw Error('Unexpected network request')},
  })
  t.after(async()=>{await service.dispose();await rm(dir,{recursive:true,force:true})})
  const config=async()=>(await service.handle('GET','/api/config')).body
  const status=async()=>(await service.handle('POST','/api/credentials/status',{})).body
  const save=body=>service.handle('POST','/api/credentials/save',body)
  return {service,keys,dir,resolutions,saves,sockets,network,config,status,save}
}

test('legacy realtime file credentials are removed and never authenticate a session',async t=>{
  const h=await fixture(t),keyFile=join(h.dir,'legacy-bailian.env')
  await writeFile(keyFile,'DASHSCOPE_API_KEY=valid-legacy-file-key')
  const initial=(await h.config()).settings
  const legacy={...initial,realtime:{...initial.realtime,use_tts_voice:false,credential_source:'file',key_file:keyFile,credential_ref:'LEGACY_REF'}}
  const saved=(await h.service.handle('PUT','/api/config',{settings:legacy})).body.settings
  assert.equal(saved.realtime.credential_source,'provider')
  assert.equal(saved.realtime.key_file,undefined);assert.equal(saved.realtime.credential_ref,undefined)
  await assert.rejects(h.service.handle('POST','/api/realtime/start',{settings:legacy}),{status:503})
  assert.equal(h.sockets.length,0);assert.equal(h.network.length,0)
  assert.equal((await h.status()).providers.bailian.ready,false)
})

test('legacy Breeze file credentials remain ignored while voice design is disabled',async t=>{
  const h=await fixture(t,{keys:{bailian:'bailian-only-key'}}),keyFile=join(h.dir,'legacy-breeze.env')
  await writeFile(keyFile,'BREEZE_API_KEY=valid-legacy-breeze-key')
  const settings=(await h.config()).settings
  settings.tts_voice_provider='breeze'
  settings.tts_profiles={breeze:{...TTS_BUILTINS.breeze,key_file:keyFile,credential_source:'file',credential_ref:'LEGACY_BREEZE'}}
  const saved=(await h.service.handle('PUT','/api/config',{settings})).body.settings
  assert.equal(saved.tts_profiles.breeze.key_file,undefined)
  assert.equal(saved.tts_profiles.breeze.credential_source,undefined)
  assert.equal(saved.tts_profiles.breeze.credential_ref,undefined)
  await assert.rejects(h.service.handle('POST','/api/voice-presets/generate',{provider:'breeze',presetId:'preset-warm'}),{status:400})
  assert.equal(h.network.length,0)
  const providers=(await h.status()).providers
  assert.equal(providers.bailian.ready,true);assert.equal(providers.breeze.ready,false)
})

test('provider credentials are isolated and a Breeze key cannot authenticate Bailian',async t=>{
  const h=await fixture(t,{keys:{breeze:'breeze-only-key',volcengine:'volcano-only-key'}})
  const settings=(await h.config()).settings
  settings.realtime.use_tts_voice=false
  await assert.rejects(h.service.handle('POST','/api/realtime/start',{settings}),{status:503})
  assert.equal(h.sockets.length,0)
  const providers=(await h.status()).providers
  assert.deepEqual(Object.keys(providers).sort(),['bailian','breeze','volcengine'])
  assert.equal(providers.bailian.ready,false);assert.equal(providers.breeze.ready,true);assert.equal(providers.volcengine.ready,true)
  assert.doesNotMatch(JSON.stringify(providers),/breeze-only-key|volcano-only-key/)
})

test('refresh and rotation resolve credentials afresh and affect the next connection',async t=>{
  const h=await fixture(t,{keys:{bailian:'first-private-key'}})
  const settings=(await h.config()).settings;settings.realtime.use_tts_voice=false
  await h.service.handle('POST','/api/realtime/start',{settings})
  assert.equal(h.sockets[0].options.headers.Authorization,'Bearer first-private-key')
  h.keys.bailian='rotated-private-key'
  const refreshed=await h.status()
  assert.equal(refreshed.providers.bailian.ready,true)
  await h.service.handle('POST','/api/realtime/start',{settings})
  assert.equal(h.sockets[1].options.headers.Authorization,'Bearer rotated-private-key')
  delete h.keys.bailian
  assert.equal((await h.status()).providers.bailian.ready,false)
  await assert.rejects(h.service.handle('POST','/api/realtime/start',{settings}),{status:503})
  assert.equal(h.sockets.length,2)
  assert.ok(h.resolutions.filter(p=>p==='bailian').length>=5)
})

test('save accepts provider/key only, stores through host, and returns metadata without secrets',async t=>{
  const h=await fixture(t),initial=(await h.config()).settings
  await h.service.handle('PUT','/api/config',{settings:initial})
  const response=(await h.save({provider:'breeze',key:'  saved-private-key  '})).body
  assert.deepEqual(h.saves,[{provider:'breeze',key:'saved-private-key'}])
  assert.equal(response.providers.breeze.ready,true)
  const config=await h.config()
  assert.equal(config.credentials.providers.breeze.ready,true)
  assert.deepEqual(config.settings,initial)
  for(const value of [response,config,await h.status()])assert.doesNotMatch(JSON.stringify(value),/saved-private-key/)
  assert.doesNotMatch(await readFile(join(h.dir,'settings.json'),'utf8'),/saved-private-key|apiKey|api_key/)
})

test('credential endpoint validates provider, value, unsupported fields and status payload',async t=>{
  const h=await fixture(t)
  for(const body of [null,[],{},'key',{provider:'qwen',key:'x'},{provider:'constructor',key:'x'},{provider:'bailian'},{provider:'bailian',key:''},{provider:'bailian',key:3},{provider:'bailian',key:'bad key'},{provider:'bailian',key:'line\nbreak'},{provider:'bailian',key:'x'.repeat(8193)},{provider:'bailian',key:'x',credentialRef:'INJECTED'},{provider:'breeze',key:'x',endpoint:'https://other.example'},{provider:'volcengine',key:'x',recordKey:'unknown/record'}]) {
    await assert.rejects(h.save(body),{status:400})
  }
  for(const body of [null,[],{provider:'bailian'},{key:'x'}])await assert.rejects(h.service.handle('POST','/api/credentials/status',body),{status:400})
  assert.deepEqual(h.saves,[])
})

test('resolver and save exceptions do not leak their messages into states or errors',async t=>{
  const h=await fixture(t,{failResolve:true,failSave:true})
  const state=await h.status()
  assert.ok(Object.values(state.providers).every(p=>p.ready===false&&p.writable===false))
  assert.doesNotMatch(JSON.stringify(state),/private-secret/)
  await assert.rejects(h.save({provider:'bailian',key:'not-persisted-key'}),error=>error.status===503&&!/private-secret/.test(error.message))
  const settings=(await h.config()).settings;settings.realtime.use_tts_voice=false
  await assert.rejects(h.service.handle('POST','/api/realtime/start',{settings}),error=>error.status===503&&!/private-secret/.test(error.message))
})

test('host-issued credential guidance reaches the caller instead of a constant 503',async t=>{
  const authorization=Object.assign(new Error('此模型正在使用账户授权，请在 DSH 模型设置中管理'),{name:'VoiceNativeError',status:409})
  const h=await fixture(t,{saveError:authorization})
  await assert.rejects(h.save({provider:'bailian',key:'never-echoed-key'}),error=>{
    assert.equal(error.status,409)
    assert.equal(error.message,'此模型正在使用账户授权，请在 DSH 模型设置中管理')
    assert.doesNotMatch(error.message,/never-echoed-key/)
    return true
  })
  const noStatus=new Error('当前模型凭据无法在此编辑，请在 DSH 模型设置中配置')
  noStatus.name='VoiceNativeError'
  const fallback=await fixture(t,{saveError:noStatus})
  await assert.rejects(fallback.save({provider:'bailian',key:'never-echoed-key'}),error=>{
    assert.equal(error.status,503,'宿主异常没带状态码时仍要给一个明确状态')
    assert.equal(error.message,noStatus.message)
    return true
  })
  assert.deepEqual(h.saves,[]);assert.deepEqual(fallback.saves,[])
  for(const result of [h,fallback])for(const provider of Object.values((await result.status()).providers))assert.equal(provider.ready,false)
})

test('configuring Volcengine credentials does not activate its unavailable realtime model',async t=>{
  const h=await fixture(t),before=(await h.config()).settings
  await h.save({provider:'volcengine',key:'private-volcano-key'})
  const after=await h.config()
  assert.equal(after.credentials.providers.volcengine.ready,true)
  assert.deepEqual(after.settings,before)
  assert.equal(after.settings.realtime.model,'qwen-audio-3.1-realtime-plus')
  assert.equal(h.sockets.length,0);assert.equal(h.network.length,0)
})
