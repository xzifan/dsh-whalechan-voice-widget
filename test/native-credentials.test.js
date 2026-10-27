import test from 'node:test'
import assert from 'node:assert/strict'
import {createNativeServices} from '../src/native-services.js'

function harness(t,{routes=[],profiles={},refs={},records={},credentialsAvailable=true}={}) {
  const calls={resolve:[],records:[],set:[],modify:[]}
  const services={
    llm:{listConfigurableProviders:()=>routes},
    settings:{describe:options=>{
      assert.deepEqual(options,{redactSecrets:true})
      return Object.entries(profiles).map(([ns,value])=>({ns,value}))
    }},
    credentials:{
      resolve:async ref=>{calls.resolve.push(ref);return Object.hasOwn(refs,ref)?{value:refs[ref]}:undefined},
      set:async(ref,value)=>{calls.set.push({ref,value});refs[ref]=value},
      readRecord:async key=>{calls.records.push(key);return records[key]},
      modifyRecord:async(key,mutate)=>{
        calls.modify.push(key)
        const next=await mutate(records[key])
        if(next!==undefined)records[key]=next
        return records[key]
      },
    },
  }
  if(!credentialsAvailable)delete services.credentials
  const native=createNativeServices({get:name=>services[name]})
  t.after(()=>native.dispose())
  return {native,services,calls,refs,records}
}
function route(provider,apiKeyEnv) {
  return {
    routes:[{provider,settingsNs:'llm-pi-ai',settingsPath:['providers',provider],nativeAuth:{env:[],oauth:false}}],
    profiles:{'llm-pi-ai':{providers:{[provider]:apiKeyEnv===undefined?{}:{apiKeyEnv}}}},
  }
}

test('default shared refs for absent speech routes stay strictly provider-isolated',async t=>{
  const h=harness(t,{refs:{DASHSCOPE_API_KEY:'bailian-key',BREEZE_API_KEY:'breeze-key',VOLCENGINE_API_KEY:'volc-key'}})
  const expected={bailian:['DASHSCOPE_API_KEY','bailian-key'],breeze:['BREEZE_API_KEY','breeze-key'],volcengine:['VOLCENGINE_API_KEY','volc-key']}
  for(const [provider,[ref,key]] of Object.entries(expected)) {
    const result=await h.native.resolveModelCredential(provider)
    assert.equal(result.provider,provider);assert.equal(result.credentialRef,ref)
    assert.equal(result.key,key);assert.equal(result.configured,true)
    assert.equal(result.routeAvailable,false);assert.equal(result.writable,true)
  }
  assert.deepEqual(h.calls.resolve,['DASHSCOPE_API_KEY','BREEZE_API_KEY','VOLCENGINE_API_KEY'])
  assert.deepEqual(h.calls.records,[])
})

test('missing default credential does not reuse another speech provider key',async t=>{
  const h=harness(t,{refs:{DASHSCOPE_API_KEY:'bailian-only'}})
  for(const provider of ['breeze','volcengine']) {
    const result=await h.native.resolveModelCredential(provider)
    assert.equal(result.configured,false);assert.equal(result.key,undefined)
    assert.equal(result.routeAvailable,false);assert.equal(result.writable,true)
  }
  assert.deepEqual(h.calls.resolve,['BREEZE_API_KEY','VOLCENGINE_API_KEY'])
})

test('existing route explicit ref remains authoritative and cannot fall back to shared ref',async t=>{
  const h=harness(t,{...route('bailian','MODEL_ACCOUNT_KEY'),refs:{DASHSCOPE_API_KEY:'wrong-shared-key'},records:{'llm-pi-ai/bailian':{kind:'api-key',key:'wrong-native-key'}}})
  const result=await h.native.resolveModelCredential('bailian')
  assert.equal(result.configured,false);assert.equal(result.key,undefined)
  assert.equal(result.routeAvailable,true);assert.equal(result.credentialRef,'MODEL_ACCOUNT_KEY')
  assert.equal(result.recordKey,undefined);assert.equal(result.writable,true)
  assert.deepEqual(h.calls.resolve,['MODEL_ACCOUNT_KEY']);assert.deepEqual(h.calls.records,[])
})

test('configure writes shared reference for absent routes and exact route reference for existing ones',async t=>{
  const absent=harness(t)
  for(const [provider,ref] of [['bailian','DASHSCOPE_API_KEY'],['breeze','BREEZE_API_KEY'],['volcengine','VOLCENGINE_API_KEY']]) {
    await absent.native.configureModelCredential(provider,`${provider}-new-key`)
    assert.equal(absent.refs[ref],`${provider}-new-key`)
    assert.equal((await absent.native.resolveModelCredential(provider)).key,`${provider}-new-key`)
  }
  assert.equal(absent.calls.modify.length,0)
  const existing=harness(t,{...route('breeze','EXACT_BREEZE_ACCOUNT'),refs:{BREEZE_API_KEY:'leave-alone'}})
  await existing.native.configureModelCredential('breeze','new-route-key')
  assert.deepEqual(existing.calls.set,[{ref:'EXACT_BREEZE_ACCOUNT',value:'new-route-key'}])
  assert.equal(existing.refs.BREEZE_API_KEY,'leave-alone')
  assert.equal((await existing.native.resolveModelCredential('breeze')).key,'new-route-key')
})

test('verified native record target is modified in place and resolver immediately sees new key',async t=>{
  const h=harness(t,{...route('bailian'),records:{'llm-pi-ai/bailian':{kind:'api-key',env:{DECLARED_KEY:'keep-existing-field'}}}})
  const before=await h.native.resolveModelCredential('bailian')
  assert.equal(before.recordKey,'llm-pi-ai/bailian');assert.equal(before.writable,true)
  await h.native.configureModelCredential('bailian','new-native-key')
  assert.deepEqual(h.calls.modify,['llm-pi-ai/bailian'])
  assert.deepEqual(h.calls.set,[])
  assert.deepEqual(h.records['llm-pi-ai/bailian'],{kind:'api-key',key:'new-native-key',env:{DECLARED_KEY:'keep-existing-field'}})
  assert.equal((await h.native.resolveModelCredential('bailian')).key,'new-native-key')
})

test('native record.env credentials rotate through record key instead of being shadowed by stale env',async t=>{
  const details=route('bailian');details.routes[0].nativeAuth.env=['NATIVE_KEY']
  const h=harness(t,{...details,records:{'llm-pi-ai/bailian':{kind:'api-key',env:{NATIVE_KEY:'old-native-key'}}}})
  assert.equal((await h.native.resolveModelCredential('bailian')).key,'old-native-key')
  await h.native.configureModelCredential('bailian','rotated-native-key')
  assert.equal((await h.native.resolveModelCredential('bailian')).key,'rotated-native-key')
  assert.deepEqual(h.calls.set,[])
})

test('configuration cannot replace an OAuth grant with an API key',async t=>{
  const grant={kind:'grant',payload:{access:'opaque-owner-token',refresh:'opaque-refresh'}}
  const h=harness(t,{...route('bailian'),records:{'llm-pi-ai/bailian':grant}})
  await assert.rejects(h.native.configureModelCredential('bailian','replacement'),error=>error.status===503&&/账户授权/.test(error.message))
  assert.deepEqual(h.records['llm-pi-ai/bailian'],grant)
  assert.deepEqual(h.calls.set,[])
})

test('unknown providers are refused before reading or modifying any credential',async t=>{
  const h=harness(t)
  for(const provider of ['qwen','dashscope','unknown','constructor']) {
    await assert.rejects(h.native.resolveModelCredential(provider),{status:400})
    await assert.rejects(h.native.configureModelCredential(provider,'value'),{status:400})
  }
  assert.deepEqual(h.calls,{resolve:[],records:[],set:[],modify:[]})
})

test('absent credential service yields writable false for shared refs and known native records',async t=>{
  for(const options of [{},route('bailian'),route('bailian','EXPLICIT_KEY')]) {
    const h=harness(t,{...options,credentialsAvailable:false})
    const result=await h.native.resolveModelCredential('bailian')
    assert.equal(result.configured,false);assert.equal(result.writable,false)
    await assert.rejects(h.native.configureModelCredential('bailian','key'),{status:503})
  }
})
