import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBailianProviderResolver } from '../src/bailian-provider.js'
import { createService } from '../src/service.js'

function host({ ref = 'CUSTOM_BAILIAN_KEY', value = 'provider-test-key', record, nativeEnv = [] } = {}) {
  const calls = []
  const services = {
    llm: { listConfigurableProviders: () => [{ provider: 'bailian', settingsNs: 'llm-pi-ai', settingsPath: ['providers','bailian'], nativeAuth: { env: nativeEnv, oauth: false } }] },
    settings: { describe: options => { assert.equal(options.redactSecrets,true); return [{ ns:'llm-pi-ai', value:{ providers:{ bailian:{ apiKeyEnv:ref } } } }] } },
    credentials: { resolve: async name => { calls.push(name); return value ? { value,source:'stored' } : undefined }, readRecord: async key => { assert.equal(key,'llm-pi-ai/bailian'); return record } },
  }
  return { ctx: { get:name=>services[name] }, calls }
}

test('DSH provider follows its configured reference and resolves each operation afresh', async () => {
  const h=host(), resolve=createBailianProviderResolver(h.ctx)
  assert.equal((await resolve()).key,'provider-test-key')
  await resolve()
  assert.deepEqual(h.calls,['CUSTOM_BAILIAN_KEY','CUSTOM_BAILIAN_KEY'])
})

test('explicit missing reference never falls back to an unrelated stored record', async () => {
  const h=host({ value:'', record:{kind:'api-key',key:'wrong-key'} })
  assert.equal(await createBailianProviderResolver(h.ctx)(),null)
  assert.deepEqual(h.calls,['CUSTOM_BAILIAN_KEY'])
})

test('native API-key records and declared environment names work without guessing key names', async () => {
  const stored=host({ref:undefined,record:{kind:'api-key',key:'stored-key'}})
  // Explicitly remove the profile reference (undefined triggers the fixture default).
  stored.ctx.get('settings').describe=()=>[{ns:'llm-pi-ai',value:{providers:{bailian:{}}}}]
  assert.equal((await createBailianProviderResolver(stored.ctx)()).key,'stored-key')
  const env=host({ref:undefined,nativeEnv:['DECLARED_KEY']})
  env.ctx.get('settings').describe=()=>[{ns:'llm-pi-ai',value:{providers:{bailian:{}}}}]
  assert.equal((await createBailianProviderResolver(env.ctx)()).key,'provider-test-key')
  assert.deepEqual(env.calls,['DECLARED_KEY'])
  assert.equal(await createBailianProviderResolver({get:()=>undefined})(),null)
})

async function fixture(t, resolver) {
  const dir=await mkdtemp(join(tmpdir(),'bailian-config-'))
  const keyFile=join(dir,'test.env')
  await writeFile(keyFile,'DASHSCOPE_API_KEY=file-test-key')
  const service=createService({stateDir:dir},{resolveBailianProvider:resolver})
  t.after(()=>service.dispose())
  const settings=(await service.handle('GET','/api/config')).body.settings
  settings.realtime={...settings.realtime,key_file:keyFile,instructions:'Test'}
  return {service,settings,dir}
}

test('legacy credential modes normalize to DSH-only and never fall back to a file', async t => {
  let available=true
  const {service,settings,dir}=await fixture(t,async()=>available?{key:'provider-test-key',source:'provider'}:null)
  const check=()=>service.handle('POST','/api/config/check',{settings}).then(r=>r.body)
  assert.equal((await check()).bailian.source,'provider')
  available=false
  for (const credential_source of ['auto','provider','file']) {
    settings.realtime.credential_source=credential_source
    const missing=await check()
    assert.equal(missing.bailian.ready,false)
    assert.equal(missing.bailian.source,'provider')
  }
  available=true
  await service.handle('PUT','/api/config',{settings})
  const response=(await service.handle('GET','/api/config')).body
  assert.equal(response.settings.realtime.credential_source,'provider')
  assert.equal(response.settings.realtime.key_file,undefined)
  assert.doesNotMatch(JSON.stringify(response),/provider-test-key|file-test-key/)
  assert.doesNotMatch(await readFile(join(dir,'settings.json'),'utf8'),/provider-test-key|file-test-key/)
  assert.equal(response.credentials.bailian.networkTested,false)
})

test('Realtime, Qwen TTS and voice design all consume the DSH provider credential', async t => {
  const requests=[], sockets=[]
  class Socket {
    constructor(_url,options){assert.equal(options.headers.Authorization,'Bearer provider-test-key');this.handlers={};this.readyState=1;this.outputs=new Map();sockets.push(this)}
    on(name,handler){this.handlers[name]=handler}
    send(raw){const e=JSON.parse(raw);if(e.item?.type==='function_call_output')this.outputs.get(e.item.call_id)?.(JSON.parse(e.item.output))}
    close(){}
    emit(e){this.handlers.message?.(Buffer.from(JSON.stringify(e)))}
    invoke(name,args,callId){const result=new Promise(resolve=>this.outputs.set(callId,resolve));this.emit({type:'response.created',response:{id:callId}});this.emit({type:'response.output_item.done',response_id:callId,item:{type:'function_call',name,call_id:callId,arguments:JSON.stringify(args)}});return result}
  }
  const dir=await mkdtemp(join(tmpdir(),'bailian-shared-'))
  const service=createService({stateDir:dir},{resolveBailianProvider:async()=>({key:'provider-test-key',source:'provider'}),realtimeWebSocket:Socket,fetch:async(url,options)=>{
    if(!options?.body)return new Response(Buffer.from('RIFFtest'))
    assert.equal(options.headers.Authorization,'Bearer provider-test-key')
    const body=JSON.parse(options.body);requests.push(body)
    if(url.endsWith('/SpeechSynthesizer'))return Response.json({output:{audio:{url:'https://audio.example/test.wav'}}})
    return Response.json({output:body.input.voice_prompt?{voice_id:'design',preview_audio:{data:'AAAA'}}:{voice_id:'realtime'}})
  }})
  t.after(()=>service.dispose())
  const settings=(await service.handle('GET','/api/config')).body.settings
  settings.tts_profiles={...settings.tts_profiles,qwen:{...settings.tts_profiles?.qwen,voice:'longanhuan_v3.1'}}
  settings.realtime={...settings.realtime,credential_source:'provider',key_file:'/missing/key.env',instructions:'Test'}
  await service.handle('PUT','/api/config',{settings})
  await service.handle('POST','/api/realtime/start',{settings})
  sockets[0].emit({type:'session.created'})
  assert.equal((await sockets[0].invoke('synth_tts',{text:'你好'},'speech')).synth,true)
  assert.equal((await sockets[0].invoke('design_voice',{description:'清亮自然的成年女声'},'design')).candidate.realtimeVoiceId,'realtime')
  assert.equal(requests.length,3)
  const audit=(await service.handle('POST','/api/audit')).body
  assert.doesNotMatch(JSON.stringify(audit),/provider-test-key/)
})
