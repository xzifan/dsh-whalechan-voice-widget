import test from 'node:test'
import assert from 'node:assert/strict'
import {createFillerPlayer,createPlaybackReporter,createPcmScheduler} from './filler-playback.js'
import {createPreviewPlayer} from './preview-playback.js'

function fixture(options={}){
 const audios=[],revoked=[],active=[]
 const player=createFillerPlayer({now:()=>100,createUrl:data=>`blob:${data}`,revokeUrl:url=>revoked.push(url),onActive:value=>active.push(value),createAudio:url=>{
  const audio={url,play(){return Promise.resolve()},pause(){this.paused=true}};audios.push(audio);return audio
 },...options})
 return {player,audios,revoked,active}
}
test('late ASR after speech-stopped leaves thinking filler eligible',()=>{
 const f=fixture()
 for(const event of [{type:'speech-started'},{type:'speech-stopped'},{type:'user-transcript-delta',text:'late'},{type:'user-transcript-done',text:'late'}])assert.equal(f.player.handleEvent(event),false)
 assert.equal(f.player.handleEvent({type:'filler-audio',id:'thinking',reason:'thinking',data:'thinking'}),true)
 assert.equal(f.audios.length,1);f.audios[0].onplaying();assert.deepEqual(f.active,[true])
 f.player.handleEvent({type:'speech-started'});assert.equal(f.audios[0].paused,true)
 f.player.handleEvent({type:'filler-audio',id:'drop'});assert.equal(f.audios.length,1)
})
test('late assistant transcript cannot clear VAD listening',()=>{
 const f=fixture();f.player.handleEvent({type:'speech-started'})
 for(const type of ['transcript-delta','transcript-done','tts-transcript']){
  f.player.handleEvent({type,text:'old reply'})
  f.player.handleEvent({type:'filler-audio',id:type})
 }
 assert.equal(f.audios.length,0)
 f.player.handleEvent({type:'speech-stopped'});f.player.handleEvent({type:'filler-audio',id:'ready'})
 assert.equal(f.audios.length,1)
 f.player.handleEvent({type:'filler-cancel',id:'ready'});assert.equal(f.player.hasAudio,false)
})
test('filler is dropped during listening or main playback, never queued',()=>{
 let busy=false
 const f=fixture({isMainBusy:()=>busy})
 f.player.setListening(true);assert.equal(f.player.start({data:'listening'}),false)
 f.player.setListening(false);busy=true;assert.equal(f.player.start({data:'main'}),false)
 busy=false;assert.equal(f.audios.length,0)
 assert.equal(f.player.start({id:'a',data:'a',expiresAt:101}),true)
 assert.equal(f.player.start({id:'b',data:'b'}),false)
 f.audios[0].onplaying();f.audios[0].onended()
 assert.deepEqual(f.active,[true,false]);assert.equal(f.audios.length,1)
})
test('filler expiry is checked on arrival and actual playing',()=>{
 const f=fixture()
 for(const expiresAt of [99,100,'invalid','1970-01-01T00:00:00.100Z'])assert.equal(f.player.start({expiresAt}),false)
 let time=100
 const g=fixture({now:()=>time})
 g.player.start({expiresAt:101});time=102;g.audios[0].onplaying()
 assert.equal(g.player.hasAudio,false);assert.deepEqual(g.active,[])
})
test('cancel matches id, omitted id cancels all, stale callbacks are harmless',()=>{
 const f=fixture();f.player.start({id:'one',data:'one'})
 const old=f.audios[0],playing=old.onplaying,ended=old.onended
 old.onplaying();f.player.stop('other');assert.equal(f.player.hasAudio,true)
 f.player.stop('one');assert.equal(old.paused,true)
 f.player.start({id:'two',data:'two'});f.audios[1].onplaying();playing();ended()
 assert.equal(f.player.hasAudio,true);f.player.stop()
 assert.deepEqual(f.active,[true,false,true,false]);assert.deepEqual(f.revoked,['blob:one','blob:two'])
})
test('speech-started stops filler immediately, even before playing',()=>{
 const f=fixture();f.player.start({id:'one'});const playing=f.audios[0].onplaying
 f.player.setListening(true);playing();assert.equal(f.player.hasAudio,false)
 assert.equal(f.audios[0].paused,true);assert.deepEqual(f.active,[])
 assert.equal(f.player.start({id:'two'}),false)
})
test('autoplay failure drops filler without retry or UI error state',async()=>{
 const f=fixture({createAudio:()=>({play:()=>Promise.reject(new Error('blocked')),pause(){}})})
 f.player.start({id:'one',data:'one'});await Promise.resolve()
 assert.equal(f.player.hasAudio,false);assert.deepEqual(f.active,[]);assert.deepEqual(f.revoked,['blob:one'])
})
test('main becoming busy before onplaying drops filler',()=>{
 let busy=false;const f=fixture({isMainBusy:()=>busy})
 f.player.start({id:'one'});busy=true;f.audios[0].onplaying()
 assert.equal(f.player.hasAudio,false);assert.deepEqual(f.active,[])
})
test('playback reports aggregate sources and preserve request order',async()=>{
 const reports=[];let unblock
 const reporter=createPlaybackReporter(state=>{reports.push(state);if(reports.length===1)return new Promise(resolve=>{unblock=resolve})})
 reporter.set('main','pcm',true);reporter.set('main','preview',true)
 reporter.set('main','pcm',false);reporter.set('main','preview',false)
 reporter.set('filler','filler',true);reporter.set('filler','filler',false)
 await Promise.resolve();assert.deepEqual(reports,[{kind:'main',active:true}])
 unblock();await reporter.settled
 assert.deepEqual(reports,[{kind:'main',active:true},{kind:'main',active:false},{kind:'filler',active:true},{kind:'filler',active:false}])
})
test('failed reporting does not block later stop report',async()=>{
 const reports=[];const reporter=createPlaybackReporter(state=>{reports.push(state);if(state.active)throw new Error('offline')})
 reporter.set('main','pcm',true);reporter.set('main','pcm',false);await reporter.settled
 assert.deepEqual(reports,[{kind:'main',active:true},{kind:'main',active:false}])
})
test('existing preview FIFO reports one active interval across queued clips',()=>{
 const audios=[],active=[]
 const player=createPreviewPlayer({createUrl:data=>data,onActive:value=>active.push(value),createAudio:()=>{const audio={play:()=>Promise.resolve(),pause(){}};audios.push(audio);return audio}})
 player.start({data:'one'});player.start({data:'two'})
 assert.deepEqual(active,[]);audios[0].onplaying();audios[0].onended()
 assert.deepEqual(active,[true]);audios[1].onplaying();audios[1].onended()
 assert.deepEqual(active,[true,false])
})
test('pending or blocked design preview protects main priority',async()=>{
 const preview=createPreviewPlayer({createUrl:()=> 'preview',createAudio:()=>({play:()=>Promise.reject(new Error('blocked')),pause(){}})})
 const f=fixture({isMainBusy:()=>preview.hasAudio})
 preview.start({});await Promise.resolve();assert.equal(f.player.start({}),false)
 preview.stop();assert.equal(f.player.start({}),true)
})

function pcmFixture(){
 const sources=[],active=[],busy=[],listeners=new Set()
 const ctx={state:'running',currentTime:0,destination:{},
  addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn),
  createBuffer:(_,length,rate)=>({duration:length/rate,getChannelData:()=>new Float32Array(length)}),
  createBufferSource(){const source={connect(){},disconnect(){},start(at){this.at=at},stop(){this.stopped=true}};sources.push(source);return source},
  resume:async()=>{},
 }
 const scheduler=createPcmScheduler(ctx,{onActive:value=>active.push(value),onBusy:value=>busy.push(value)})
 return {sources,active,busy,ctx,listeners,scheduler}
}
test('multiple queued PCM chunks stay active until final source ends',()=>{
 const f=pcmFixture()
 f.scheduler.schedule(new Float32Array(24000),24000);f.scheduler.schedule(new Float32Array(24000),24000)
 assert.deepEqual(f.active,[true]);assert.equal(f.sources[1].at,1)
 f.sources[0].onended();assert.deepEqual(f.active,[true]);assert.equal(f.busy.at(-1),true)
 f.sources[1].onended();assert.deepEqual(f.active,[true,false]);assert.equal(f.busy.at(-1),false)
 f.scheduler.stop();assert.equal(f.listeners.size,0)
})
test('PCM stop clears sources and ignores captured stale ended callbacks',()=>{
 const f=pcmFixture();f.scheduler.schedule(new Float32Array(1),24000)
 const ended=f.sources[0].onended;f.scheduler.stop();ended()
 assert.deepEqual(f.active,[true,false]);assert.equal(f.busy.at(-1),false);assert.equal(f.sources[0].stopped,true)
})
test('suspended PCM is busy but only reports active when context runs',()=>{
 const f=pcmFixture();f.ctx.state='suspended';f.scheduler.schedule(new Float32Array(1),24000)
 assert.deepEqual(f.active,[]);assert.equal(f.busy.at(-1),true)
 f.ctx.state='running';for(const listener of f.listeners)listener()
 assert.deepEqual(f.active,[true]);f.scheduler.stop();assert.deepEqual(f.active,[true,false])
})
