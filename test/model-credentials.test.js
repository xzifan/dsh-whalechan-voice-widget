import test from 'node:test'
import assert from 'node:assert/strict'
import {createModelCredentialResolver} from '../src/model-credentials.js'

function host({provider='bailian', namespace='llm-pi-ai', path=['providers',provider], profile={}, env=[], record, refs={}, routes=true}={}) {
  const calls={resolve:[],records:[],describe:[]}
  const entry={provider,settingsNs:namespace,settingsPath:path,nativeAuth:{env,oauth:false}}
  const form={ns:namespace,value:path.length?{providers:{[provider]:profile}}:profile}
  const services={
    llm:{listConfigurableProviders:()=>routes?[entry]:[]},
    settings:{describe:options=>{calls.describe.push(options);return [form]}},
    credentials:{
      resolve:async ref=>{calls.resolve.push(ref);return Object.hasOwn(refs,ref)?{value:refs[ref]}:undefined},
      readRecord:async key=>{calls.records.push(key);return record},
    },
  }
  return {calls,services,entry,profile,refs,resolve:createModelCredentialResolver({get:name=>services[name]})}
}

for (const provider of ['bailian','breeze','volcengine']) {
  test(`${provider}: resolve route credential-ref and retain configurable metadata`,async()=>{
    const h=host({provider,namespace:'custom-model-owner',profile:{apiKeyEnv:'CHOSEN_KEY'},refs:{CHOSEN_KEY:'  sample-key  '}})
    assert.deepEqual(await h.resolve(provider),{key:'sample-key',source:'provider',provider,configured:true,routeAvailable:true,credentialRef:'CHOSEN_KEY'})
    assert.deepEqual(h.calls.records,[])
    assert.deepEqual(h.calls.describe,[{redactSecrets:true}])
  })
}

test('explicit missing apiKeyEnv never falls back to caller ref, native record or env',async()=>{
  const h=host({profile:{apiKeyEnv:'ABSENT'},refs:{USER_KEY:'caller-key',NATIVE_KEY:'native-key'},env:['NATIVE_KEY'],record:{kind:'api-key',key:'stored-key'}})
  const result=await h.resolve('bailian',{credentialRef:'USER_KEY'})
  assert.equal(result.configured,false);assert.equal(result.credentialRef,'ABSENT');assert.ok(result.error)
  assert.equal(result.key,undefined);assert.equal(result.recordKey,undefined)
  assert.deepEqual(h.calls.resolve,['ABSENT']);assert.deepEqual(h.calls.records,[])
})

test('blank, malformed or non-string route ref is authoritative and never falls back',async()=>{
  for (const apiKeyEnv of ['', ' key ', 'secret/value', null, 42]) {
    const h=host({profile:{apiKeyEnv},record:{kind:'api-key',key:'wrong-key'}})
    const result=await h.resolve('bailian')
    assert.equal(result.configured,false);assert.match(result.error,/reference/)
    assert.deepEqual(h.calls.resolve,[]);assert.deepEqual(h.calls.records,[])
  }
})

test('verified pi-ai owner address determines provider-specific native record keys',async()=>{
  for (const provider of ['bailian','breeze','volcengine']) {
    const h=host({provider,record:{kind:'api-key',key:'stored-key'}})
    const result=await h.resolve(provider)
    assert.equal(result.key,'stored-key');assert.equal(result.recordKey,`llm-pi-ai/${provider}`)
    assert.deepEqual(h.calls.records,[`llm-pi-ai/${provider}`]);assert.deepEqual(h.calls.resolve,[])
  }
})

test('unknown owners and mismatched settings paths cannot read guessed pi records',async()=>{
  for (const options of [{namespace:'models-main'},{namespace:'llm-pi-ai-copy'},{path:[]}]) {
    const h=host({...options,record:{kind:'api-key',key:'unrelated-key'},env:['DECLARED_KEY'],refs:{DECLARED_KEY:'env-key'}})
    const result=await h.resolve('bailian')
    assert.equal(result.key,'env-key');assert.equal(result.credentialRef,'DECLARED_KEY')
    assert.equal(result.recordKey,undefined);assert.deepEqual(h.calls.records,[])
  }
})

test('nativeAuth.env uses stored native environment values before resolving matching refs',async()=>{
  const h=host({env:['MISSING','ADVERTISED_KEY'],record:{kind:'api-key',env:{ADVERTISED_KEY:'record-env-key',UNADVERTISED:'wrong-key'}},refs:{ADVERTISED_KEY:'ambient-key'}})
  const result=await h.resolve('bailian')
  assert.equal(result.key,'record-env-key');assert.equal(result.credentialRef,undefined)
  assert.equal(result.recordKey,'llm-pi-ai/bailian')
  assert.deepEqual(h.calls.resolve,['MISSING'])
})

test('nativeAuth.env resolves in order, skips invalid names, and treats blank values as absent',async()=>{
  const h=host({env:['invalid/ref','EMPTY','AVAILABLE','LATER'],refs:{EMPTY:'  ',AVAILABLE:'found',LATER:'other'}})
  const result=await h.resolve('bailian')
  assert.equal(result.key,'found');assert.equal(result.credentialRef,'AVAILABLE')
  assert.deepEqual(h.calls.resolve,['EMPTY','AVAILABLE'])
})

test('OAuth grant payloads are opaque and never returned as API keys',async()=>{
  const h=host({record:{kind:'grant',payload:{access:'private-token',key:'not-an-api-key'}}})
  const result=await h.resolve('bailian')
  assert.equal(result.configured,false);assert.equal(result.key,undefined)
  assert.doesNotMatch(JSON.stringify(result),/private-token|not-an-api-key/)
})

test('Breeze without a route resolves only an explicitly supplied credential-ref',async()=>{
  const h=host({provider:'breeze',routes:false,refs:{BREEZE_API_KEY:'breeze-key'},record:{kind:'api-key',key:'unknown-storage'}})
  const missing=await h.resolve('breeze')
  assert.equal(missing.routeAvailable,false);assert.equal(missing.configured,false);assert.ok(missing.error)
  assert.deepEqual(h.calls.resolve,[]);assert.deepEqual(h.calls.records,[])
  const result=await h.resolve('breeze',{credentialRef:'BREEZE_API_KEY'})
  assert.deepEqual(result,{source:'provider',provider:'breeze',routeAvailable:false,configured:true,credentialRef:'BREEZE_API_KEY',key:'breeze-key'})
  assert.deepEqual(h.calls.describe,[])
})

test('caller reference does not override existing route native credential ownership',async()=>{
  const h=host({record:{kind:'api-key',key:'route-key'},refs:{USER_KEY:'user-key'}})
  assert.equal((await h.resolve('bailian',{credentialRef:'USER_KEY'})).key,'route-key')
  assert.deepEqual(h.calls.resolve,[])
})

test('missing keys retain a safe write destination',async()=>{
  const pi=await host().resolve('bailian')
  assert.equal(pi.recordKey,'llm-pi-ai/bailian');assert.equal(pi.configured,false)
  const native=await host({namespace:'foreign',env:['NATIVE_KEY']}).resolve('bailian')
  assert.equal(native.credentialRef,'NATIVE_KEY');assert.equal(native.configured,false)
  const explicit=await host({routes:false}).resolve('breeze',{credentialRef:'CUSTOM_KEY'})
  assert.equal(explicit.credentialRef,'CUSTOM_KEY');assert.equal(explicit.routeAvailable,false)
})

test('does not invent aliases or default credential names',async()=>{
  const h=host({provider:'dashscope',refs:{DASHSCOPE_API_KEY:'not-requested'}})
  const result=await h.resolve('bailian')
  assert.equal(result.routeAvailable,false);assert.equal(result.configured,false)
  assert.deepEqual(h.calls.resolve,[]);assert.deepEqual(h.calls.records,[])
})

test('directory, settings and credentials changes are observed on every operation',async()=>{
  const h=host({profile:{apiKeyEnv:'FIRST'},refs:{FIRST:'first',SECOND:'second'}})
  assert.equal((await h.resolve('bailian')).key,'first')
  h.profile.apiKeyEnv='SECOND'
  assert.equal((await h.resolve('bailian')).key,'second')
  h.refs.SECOND='rotated'
  assert.equal((await h.resolve('bailian')).key,'rotated')
  h.services.llm.listConfigurableProviders=()=>[]
  assert.equal((await h.resolve('bailian')).routeAvailable,false)
})

test('missing public services report missing metadata without throwing',async()=>{
  const resolve=createModelCredentialResolver({get:()=>undefined})
  assert.equal((await resolve('breeze')).routeAvailable,false)
  const explicit=await resolve('breeze',{credentialRef:'BREEZE_API_KEY'})
  assert.equal(explicit.credentialRef,'BREEZE_API_KEY');assert.equal(explicit.configured,false)
  const h=host({record:{kind:'api-key',key:'must-not-read'}})
  delete h.services.settings
  assert.equal((await h.resolve('bailian')).configured,false)
  assert.deepEqual(h.calls.records,[])
})

test('host errors cannot leak secret material or trigger fallback',async()=>{
  const h=host({profile:{apiKeyEnv:'BROKEN'},record:{kind:'api-key',key:'fallback'}})
  h.services.credentials.resolve=()=>{throw new Error('sensitive-key-in-exception')}
  const result=await h.resolve('bailian')
  assert.equal(result.configured,false);assert.equal(result.credentialRef,'BROKEN')
  assert.equal(result.key,undefined);assert.doesNotMatch(JSON.stringify(result),/sensitive-key-in-exception/)
  assert.deepEqual(h.calls.records,[])
})

test('invalid caller refs never reach host or expose their input as metadata',async()=>{
  const h=host({routes:false})
  const result=await h.resolve('breeze',{credentialRef:'not a reference'})
  assert.equal(result.configured,false);assert.equal(result.credentialRef,undefined)
  assert.deepEqual(h.calls.resolve,[])
})
