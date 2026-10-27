import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {apply,Config} from '../src/index.js'

test('adapter registers authenticated exact APIs and cleans every registration',async()=>{
  const routes=[],statics=[],effects=[];let disposed=0
  const ctx={
    effect(fn){const cleanup=fn();if(cleanup)effects.push(cleanup)},
    connection:{fetch:{register(route){routes.push(route);return ()=>disposed++}},admit(){return {rejection:401}}},
    webServer:{register(route){statics.push(route);return ()=>disposed++}},
  }
  apply(ctx,{stateDir:await mkdtemp(join(tmpdir(),'dsh-voice-adapter-'))})
  assert.ok(Config)
  assert.equal(routes.length,22)
  for (const action of ['save','generate','apply','greeting']) {
    const route = routes.find(r => r.path === '/api/voice-workbench/voice-presets/' + action)
    assert.deepEqual(route.methods, ['POST'])
    const response = await route.fetch(new Request('http://localhost' + route.path, { method: 'POST', body: '{"presetId":"unknown"}' }))
    assert.equal(response.status, 400)
  }
  const playback=routes.find(r=>r.path==='/api/voice-workbench/realtime/playback')
  assert.deepEqual(playback.methods,['POST'])
  assert.match(await readFile(new URL('../lib/client.js',import.meta.url),'utf8'), /'\/api\/realtime\/playback':\['POST'\]/)
  const statistics=routes.find(r=>r.path==='/api/voice-workbench/statistics')
  assert.deepEqual(statistics.methods,['POST'])
  assert.match(await readFile(new URL('../lib/client.js',import.meta.url),'utf8'), /'\/api\/statistics':\['POST'\]/)
  const stats=await statistics.fetch(new Request('http://localhost/api/voice-workbench/statistics',{method:'POST',body:'{}'}))
  assert.equal(stats.status,200)
  assert.equal((await stats.json()).total,0)
  const invalidStats=await statistics.fetch(new Request('http://localhost/api/voice-workbench/statistics',{method:'POST',body:'{"since":2,"until":1}'}))
  assert.equal(invalidStats.status,400)
  const client=await readFile(new URL('../lib/client.js',import.meta.url),'utf8')
  for(const suffix of ['sessions','messages']) {
    const route=routes.find(r=>r.path==='/api/voice-workbench/history/'+suffix)
    assert.deepEqual(route.methods,['POST'])
    assert.ok(client.includes(`'/api/history/${suffix}':['POST']`))
    const request=body=>route.fetch(new Request('http://localhost/api/voice-workbench/history/'+suffix,{method:'POST',body}))
    const response=await request(suffix==='sessions'?'{}':'{"sessionId":"missing"}')
    assert.equal(response.status,200)
    assert.equal(response.headers.get('cache-control'),'no-store')
    assert.deepEqual(await response.json(),suffix==='sessions'?{sessions:[],total:0}:{session:null,messages:[]})
    for(const body of ['null','[]','{"unknown":true}','broken']) assert.equal((await request(body)).status,400)
    assert.equal((await route.fetch(new Request('http://localhost/api/voice-workbench/history/'+suffix))).status,405)
  }
  assert.equal(statics.length,1)
  assert.ok(routes.every(r=>r.path.startsWith('/api/voice-workbench/')))
  const config=routes.find(r=>r.path.endsWith('/config'))
  assert.equal(config.requestBody,'buffered')
  assert.ok(routes.filter(r=>r!==config).every(r=>r.requestBody==='streaming'))
  const response=await config.fetch(new Request('http://localhost/api/voice-workbench/config'))
  assert.equal(response.status,200)
  const loaded=await response.json()
  assert.equal(loaded.body,undefined)
  const invalidSettings={...loaded.settings,enabled_tools:['unavailable-tool']}
  const rejected=await config.fetch(new Request('http://localhost/api/voice-workbench/config',{method:'PUT',body:JSON.stringify({settings:invalidSettings})}))
  assert.equal(rejected.status,400)
  assert.equal(typeof (await rejected.json()).fieldErrors.enabled_tools,'string')
  const check=routes.find(r=>r.path.endsWith('/config/check'))
  const checked=await check.fetch(new Request('http://localhost/api/voice-workbench/config/check',{method:'POST',body:JSON.stringify({settings:invalidSettings})}))
  assert.equal(checked.status,200)
  assert.equal((await checked.json()).valid,false)
  const unchanged=await config.fetch(new Request('http://localhost/api/voice-workbench/config'))
  assert.deepEqual((await unchanged.json()).settings.enabled_tools,loaded.settings.enabled_tools)
  let status
  await statics[0].handler({method:'GET',url:'/voice-workbench/'},{writeHead(code){status=code},end(){}})
  assert.equal(status,401)
  for(const cleanup of effects.reverse())await cleanup()
  assert.equal(disposed,23)
})