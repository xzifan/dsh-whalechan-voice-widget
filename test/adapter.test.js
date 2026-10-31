import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {apply,Config} from '../src/index.js'

const clientSource=async()=>(await readFile(new URL('../lib/client.js',import.meta.url),'utf8')).replace(/\s+/g,'')

test('adapter registers authenticated exact APIs and cleans every registration',async()=>{
  const routes=[],statics=[],effects=[];let disposed=0
  const ctx={
    effect(fn){const cleanup=fn();if(cleanup)effects.push(cleanup)},
    connection:{fetch:{register(route){routes.push(route);return ()=>disposed++}},admit(){return {rejection:401}}},
    webServer:{register(route){statics.push(route);return ()=>disposed++}},
  }
  apply(ctx,{stateDir:await mkdtemp(join(tmpdir(),'dsh-voice-adapter-'))})
  assert.ok(Config)
  assert.equal(routes.length,24)
  const health=routes.find(r=>r.path==='/api/voice-workbench/health')
  assert.deepEqual(health.methods,['GET'])
  // GET 路由必须走 buffered：宿主的 streaming 模式会让 GET 在到达插件前就返回 400（实测过）。
  assert.equal(health.requestBody,'buffered')
  const healthResponse=await health.fetch(new Request('http://localhost/api/voice-workbench/health'))
  assert.equal(healthResponse.status,200)
  const healthBody=await healthResponse.json()
  assert.equal(healthBody.ok,true)
  assert.equal(healthBody.version,JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')).version)
  assert.equal(healthBody.realtime.activeSessions,0)
  assert.equal(typeof healthBody.tts.provider,'string')
  assert.equal(typeof healthBody.tts.ready,'boolean')
  assert.ok(Number.isFinite(healthBody.uptimeMs)&&healthBody.uptimeMs>=0)
  assert.ok(!JSON.stringify(healthBody).match(/sk-|api[_-]?key|secret/i))
  assert.equal((await health.fetch(new Request('http://localhost/api/voice-workbench/health',{method:'POST',body:'{}'}))).status,404)
  const changelog=routes.find(r=>r.path==='/api/voice-workbench/changelog')
  assert.deepEqual(changelog.methods,['GET'])
  assert.equal(changelog.requestBody,'buffered')
  const changelogBody=await (await changelog.fetch(new Request('http://localhost/api/voice-workbench/changelog'))).json()
  assert.equal(changelogBody.version,healthBody.version)
  assert.ok(Array.isArray(changelogBody.entries)&&changelogBody.entries.length>0)
  assert.ok(changelogBody.entries.every(e=>e.version&&Array.isArray(e.sections)))

  for (const action of ['save','generate','apply','greeting']) {
    const route = routes.find(r => r.path === '/api/voice-workbench/voice-presets/' + action)
    assert.deepEqual(route.methods, ['POST'])
    const response = await route.fetch(new Request('http://localhost' + route.path, { method: 'POST', body: '{"presetId":"unknown"}' }))
    assert.equal(response.status, 400)
  }
  const playback=routes.find(r=>r.path==='/api/voice-workbench/realtime/playback')
  assert.deepEqual(playback.methods,['POST'])
  // 比对前先折叠空白：Prettier 会在 `:` 后加空格，源码排版不该让路由断言变红。
  assert.match(await clientSource(), /'\/api\/realtime\/playback':\s*\['POST'\]/)
  const statistics=routes.find(r=>r.path==='/api/voice-workbench/statistics')
  assert.deepEqual(statistics.methods,['POST'])
  assert.match(await clientSource(), /'\/api\/statistics':\s*\['POST'\]/)
  const stats=await statistics.fetch(new Request('http://localhost/api/voice-workbench/statistics',{method:'POST',body:'{}'}))
  assert.equal(stats.status,200)
  assert.equal((await stats.json()).total,0)
  const invalidStats=await statistics.fetch(new Request('http://localhost/api/voice-workbench/statistics',{method:'POST',body:'{"since":2,"until":1}'}))
  assert.equal(invalidStats.status,400)
  const client=await clientSource()
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
  // 只有 GET 路由用 buffered；POST 一律 streaming。
  assert.ok(routes.filter(r=>r!==config&&r!==health&&r!==changelog).every(r=>r.requestBody==='streaming'))
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
  assert.equal(disposed,25)
})