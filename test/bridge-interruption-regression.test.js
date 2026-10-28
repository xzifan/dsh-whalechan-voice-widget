import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
import {createPlaybackReporter} from '../web/src/lib/filler-playback.js'
import {createPreviewPlayer} from '../web/src/lib/preview-playback.js'

const source=await readFile(new URL('../lib/client.js',import.meta.url),'utf8')
// Locate the admission guard by its condition and cut to its matching brace, so the
// substitution survives Prettier re-wrapping the block across lines (`;return}` anchor rots).
const ADMISSION_GUARD=/if\s*\(counts\[lane\]\s*>=\s*limits\[lane\]\)\s*\{/
function replaceAdmissionGuard(code){
 const start=code.search(ADMISSION_GUARD)
 assert.ok(start>=0,'lib/client.js 里找不到 counts[lane]>=limits[lane] 准入判断')
 let depth=0
 for(let i=code.indexOf('{',start);i<code.length;i++){
  if(code[i]==='{')depth++
  else if(code[i]==='}'&&--depth===0)return code.slice(0,start)+'if(pending.size>=10)return'+code.slice(i+1)
 }
 return code
}
function bridge(legacyAdmission=false){
 const origin='http://localhost:3080',requests=[],replies=[],listeners=new Set()
 let component,plugin,cleanup
 const child={postMessage(data){replies.push(data)}}
 const React={useRef:()=>({current:{contentWindow:child}}),useState:()=>['',()=>{}],useEffect(fn){cleanup=fn()},createElement(){return {}}}
 const window={__ModuleLoader__:{load({factory}){plugin=factory(()=>React)}},addEventListener(_,fn){listeners.add(fn)},removeEventListener(_,fn){listeners.delete(fn)}}
 // Reconstruct only the pre-fix admission policy, leaving routing/fetch behavior identical.
 const code=legacyAdmission?replaceAdmissionGuard(source):source
 if(legacyAdmission)assert.ok(code.includes('if(pending.size>=10)return'))
 vm.runInNewContext(code,{window,document:{baseURI:origin+'/'},URL,AbortController,fetch(url,init){return new Promise(resolve=>requests.push({path:new URL(url).pathname,init,resolve}))}})
 plugin.apply({slots:{inject(_,fn){fn()},register(slot,fn){if(slot.name==='main')component=fn}}});component()
 let id=0
 return {requests,replies,send(path,extra={}){const data={type:'voice-workbench:request',id:String(++id),path:'/api/'+path,method:'POST',body:{sessionId:'test'}};for(const fn of listeners)void fn({source:child,origin,data,...extra});return data.id},finish(){for(const request of requests)request.resolve({status:200,json:async()=>({ok:true})})},close(){cleanup()}}
}
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve()}

test('legacy admission reproduction: ninth audio plus playback report silently loses interruption poll',async()=>{
 const h=bridge(true)
 try{
  for(let i=0;i<9;i++)h.send('realtime/audio')
  h.send('realtime/playback')
  const poll=h.send('realtime/events')
  assert.equal(h.requests.length,10)
  assert.equal(h.requests.filter(r=>r.path.endsWith('/events')).length,0)
  h.finish();await flush()
  assert.equal(h.replies.length,10)
  assert.equal(h.replies.some(r=>r.id===poll),false)
 }finally{h.close()}
})

test('audio and other saturation cannot displace playback reports or interruption polls; overload replies immediately',async()=>{
 const h=bridge()
 try{
  h.send('realtime/audio');h.send('realtime/audio')
  const rejected=h.send('realtime/audio')
  assert.equal(h.replies.find(r=>r.id===rejected)?.status,429)
  for(let i=0;i<8;i++)h.send('history/messages',{})
  const report=h.send('realtime/playback'),poll=h.send('realtime/events')
  assert.equal(h.requests.filter(r=>r.path.endsWith('/events')).length,1)
  assert.equal(h.requests.filter(r=>r.path.endsWith('/playback')).length,1)
  h.finish();await flush()
  assert.equal(h.replies.find(r=>r.id===poll)?.status,200)
  assert.equal(h.replies.find(r=>r.id===report)?.status,200)
  const next=h.send('realtime/audio');h.finish();await flush()
  assert.equal(h.replies.find(r=>r.id===next)?.status,200)
 }finally{h.close()}
})

test('control overflow also returns a prompt error and invalid source/origin/route stays rejected',()=>{
 const h=bridge()
 try{
  h.send('realtime/events',{origin:'http://evil.test'})
  h.send('realtime/events',{source:{}})
  h.send('not-allowed')
  assert.equal(h.requests.length,0)
  for(let i=0;i<4;i++)h.send('realtime/events')
  const id=h.send('realtime/cancel')
  assert.equal(h.replies.find(r=>r.id===id)?.status,429)
  assert.equal(h.requests.length,4)
 }finally{h.close()}
})

test('hung playback reporting cannot delay local preview interruption',async()=>{
 let paused=0
 const reporter=createPlaybackReporter(()=>new Promise(()=>{}))
 const audio={play(){this.onplaying?.();return Promise.resolve()},pause(){paused++}}
 const player=createPreviewPlayer({createAudio:()=>audio,createUrl:()=> 'test-audio',onActive:active=>reporter.set('main','preview',active)})
 player.start({data:'test'});await flush();assert.equal(player.hasAudio,true)
 player.stop();assert.equal(paused,1);assert.equal(player.hasAudio,false)
})
