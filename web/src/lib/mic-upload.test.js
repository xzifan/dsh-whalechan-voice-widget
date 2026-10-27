import test from 'node:test'
import assert from 'node:assert/strict'
import {createMicUploader} from './mic-upload.js'
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve()}
const frame=n=>Buffer.alloc(960,n).toString('base64')
function setup(options={}){
 const calls=[],errors=[],timers=new Map();let id=0
 const uploader=createMicUploader({send:(audio,signal)=>new Promise((resolve,reject)=>calls.push({bytes:Buffer.from(audio,'base64'),signal,resolve,reject})),onError:e=>errors.push(e.message),setTimer(fn){const key=++id;timers.set(key,fn);return key},clearTimer:key=>timers.delete(key),...options})
 return {uploader,calls,errors,timers}
}
test('slow upload combines all accumulated PCM in order with only one request in flight',async()=>{
 const s=setup(),expected=[]
 try{
  s.uploader.enqueue(frame(0));expected.push(Buffer.from(frame(0),'base64'));await flush()
  for(let i=1;i<=13;i++){s.uploader.enqueue(frame(i));expected.push(Buffer.from(frame(i),'base64'))}
  assert.equal(s.calls.length,1);assert.equal(s.uploader.bufferedMs,390)
  s.calls[0].resolve();await flush()
  assert.equal(s.calls.length,2);assert.equal(s.calls[1].bytes.length,13*960)
  for(let i=14;i<=26;i++){s.uploader.enqueue(frame(i));expected.push(Buffer.from(frame(i),'base64'))}
  s.calls[1].resolve();await flush();assert.equal(s.calls.length,3)
  s.calls[2].resolve();await flush()
  assert.deepEqual(Buffer.concat(s.calls.map(c=>c.bytes)),Buffer.concat(expected))
  assert.deepEqual(s.errors,[]);assert.equal(s.timers.size,0)
 }finally{s.uploader.stop()}
})
test('bounded batches preserve partial PCM chunks without gaps or duplication',async()=>{
 const s=setup(),expected=[]
 try{
  for(let i=0;i<70;i++){s.uploader.enqueue(frame(i));expected.push(Buffer.from(frame(i),'base64'))}
  await flush()
  for(let i=0;i<s.calls.length;i++){assert.ok(s.calls[i].bytes.length<=32000);s.calls[i].resolve();await flush()}
  assert.deepEqual(Buffer.concat(s.calls.map(c=>c.bytes)),Buffer.concat(expected));assert.equal(s.uploader.bufferedMs,0)
 }finally{s.uploader.stop()}
})
test('sustained congestion fails explicitly, aborts upload and prevents stale sends',async()=>{
 const s=setup();s.uploader.enqueue(frame(1));await flush()
 for(let i=0;i<100;i++)assert.equal(s.uploader.enqueue(frame(i)),true)
 assert.equal(s.uploader.enqueue(frame(1)),false)
 assert.match(s.errors[0],/拥塞/);assert.equal(s.errors.length,1)
 assert.equal(s.calls[0].signal.aborted,true);assert.equal(s.uploader.bufferedMs,0)
 s.calls[0].resolve();await flush();assert.equal(s.calls.length,1);assert.equal(s.uploader.enqueue(frame(1)),false)
})
test('HTTP errors and timeouts are visible rather than silently dropping audio',async()=>{
 const s=setup();s.uploader.enqueue(frame(1));await flush();s.calls[0].reject(Error('429'));await flush()
 assert.match(s.errors[0],/上传失败/)
 const t=setup();t.uploader.enqueue(frame(1));await flush();[...t.timers.values()][0]()
 assert.match(t.errors[0],/超时/);assert.equal(t.calls[0].signal.aborted,true)
})
test('local stop aborts old session without surfacing an error or uploading its queued PCM',async()=>{
 const s=setup();s.uploader.enqueue(frame(1));await flush();s.uploader.enqueue(frame(2));s.uploader.stop()
 s.calls[0].reject(Error('aborted'));await flush()
 assert.equal(s.calls.length,1);assert.equal(s.calls[0].signal.aborted,true);assert.deepEqual(s.errors,[])
})
