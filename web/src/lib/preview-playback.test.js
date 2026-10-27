import test from 'node:test'
import assert from 'node:assert/strict'
import {createPreviewPlayer} from './preview-playback.js'

function fixture({play,createUrl}={}){
 const states=[],audios=[],revoked=[],played=[]
 const player=createPreviewPlayer({
  createUrl:createUrl||((data)=>`blob:${data??audios.length}`),
  revokeUrl:url=>revoked.push(url),onState:p=>states.push(p),
  createAudio:url=>{
   const audio={url,play(){played.push(url);return play?play(audio):Promise.resolve()},pause(){this.paused=true}}
   audios.push(audio);return audio
  },
 })
 return {player,states,audios,revoked,played}
}
test('preview clips arriving in one poll play in FIFO order without truncation',async()=>{
 const f=fixture()
 for(const data of ['one','two','three'])f.player.start({data})
 await Promise.resolve()
 assert.deepEqual(f.played,['blob:one']) // play() resolving is not the end of the clip.
 assert.equal(f.audios[0].paused,undefined)
 f.audios[0].onplaying();assert.equal(f.states.at(-1).speaking,true)
 f.audios[0].onended()
 assert.deepEqual(f.played,['blob:one','blob:two'])
 assert.deepEqual(f.revoked,['blob:one'])
 f.player.start({data:'four'}) // A later poll must join the existing queue.
 f.audios[1].onended();f.audios[2].onended();f.audios[3].onended()
 assert.deepEqual(f.played,['blob:one','blob:two','blob:three','blob:four'])
 assert.deepEqual(f.revoked,f.played)
 assert.equal(f.player.hasAudio,false)
 assert.deepEqual(f.states.at(-1),{speaking:false,playbackError:''})
})
test('blocked autoplay retains queue head and retry drains remaining clips in order',async()=>{
 let blocked=true
 const f=fixture({play:async audio=>{if(blocked)throw Object.assign(new Error(),{name:'NotAllowedError'});audio.onplaying()}})
 f.player.start({data:'one'});f.player.start({data:'two'})
 await Promise.resolve()
 assert.match(f.states.at(-1).playbackError,/浏览器阻止/);assert.equal(f.player.hasAudio,true)
 assert.deepEqual(f.played,['blob:one']);assert.deepEqual(f.revoked,[])
 blocked=false;await f.player.retry()
 assert.deepEqual(f.states.at(-1),{speaking:true,playbackError:''})
 f.audios[0].onended();assert.deepEqual(f.played,['blob:one','blob:one','blob:two'])
 f.audios[1].onended();assert.equal(f.player.hasAudio,false)
})
test('stop clears queued clips and stale callbacks cannot affect a new queue',async()=>{
 const f=fixture();let reject
 f.player.start({data:'old'});const old=f.audios[0]
 old.play=()=>new Promise((_,r)=>{reject=r});const pending=f.player.retry()
 const ended=old.onended,playing=old.onplaying,error=old.onerror
 f.player.start({data:'discarded'});f.player.stop()
 assert.equal(f.player.hasAudio,false);assert.equal(old.paused,true)
 f.player.start({data:'new'});f.audios[1].onplaying();const count=f.states.length
 reject(new Error('old failure'));await pending;ended();playing();error()
 assert.equal(f.states.length,count);assert.deepEqual(f.played,['blob:old','blob:new'])
 f.audios[1].onended();assert.equal(f.player.hasAudio,false)
 assert.deepEqual(f.revoked,['blob:old','blob:new'])
})
test('late failure from an older retry does not overwrite a successful retry',async()=>{
 const f=fixture();let reject
 f.player.start({});const audio=f.audios[0]
 audio.play=()=>new Promise((_,r)=>{reject=r});const pending=f.player.retry()
 audio.play=async()=>audio.onplaying();await f.player.retry();const count=f.states.length
 reject(new Error('stale attempt'));await pending
 assert.equal(f.states.length,count);assert.equal(f.states.at(-1).speaking,true)
})
test('invalid audio and decoder errors are visible instead of silently ignored',()=>{
 const states=[];const player=createPreviewPlayer({createUrl:()=>null,onState:p=>states.push(p)});player.start({});assert.match(states.at(-1).playbackError,/音频无效/)
 const f=fixture();f.player.start({});f.player.start({data:'next'});f.audios[0].onerror()
 assert.match(f.states.at(-1).playbackError,/未能播放/);assert.equal(f.audios.length,1);assert.equal(f.player.hasAudio,true)
})
test('invalid queued clip does not prevent subsequent valid clips playing',()=>{
 const f=fixture({createUrl:data=>{if(data==='throw')throw new Error('bad base64');return data==='invalid'?null:`blob:${data}`}})
 for(const data of ['one','invalid','throw','two'])f.player.start({data})
 f.audios[0].onended()
 assert.deepEqual(f.played,['blob:one','blob:two'])
 assert.ok(f.states.some(state=>/音频无效/.test(state.playbackError)))
 assert.ok(f.states.some(state=>/未能播放/.test(state.playbackError)))
 f.audios[1].onended();assert.equal(f.player.hasAudio,false)
})
