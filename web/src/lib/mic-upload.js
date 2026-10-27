import {base64ToBytes,bytesToBase64} from './realtime.js'

// Preserve PCM order while limiting both HTTP concurrency and capture latency.
export function createMicUploader({send,onError=()=>{},maxBufferedMs=3000,maxBatchMs=1000,timeoutMs=5000,setTimer=setTimeout,clearTimer=clearTimeout}={}){
 const bytesPerMs=16000*2/1000,maxBytes=Math.floor(maxBufferedMs*bytesPerMs),batchBytes=Math.floor(maxBatchMs*bytesPerMs)
 let queue=[],buffered=0,active=null,stopped=false
 function stop(){stopped=true;queue=[];buffered=0;if(active){clearTimer(active.timer);active.controller.abort();active=null}}
 function fail(message){if(stopped)return;stop();onError(new Error(message))}
 function drain(){
  if(stopped||active||!buffered)return
  const size=Math.min(buffered,batchBytes),bytes=new Uint8Array(size)
  let offset=0
  while(offset<size){const head=queue[0],count=Math.min(head.length,size-offset);bytes.set(head.subarray(0,count),offset);offset+=count;if(count===head.length)queue.shift();else queue[0]=head.subarray(count)}
  buffered-=size
  const item={controller:new AbortController(),timer:null};active=item
  item.timer=setTimer(()=>fail('麦克风上传超时，语音对话已停止。请检查连接后重新开始。'),timeoutMs)
  Promise.resolve().then(()=>{if(stopped||active!==item)return;return send(bytesToBase64(bytes),item.controller.signal)}).then(()=>{
   if(stopped||active!==item)return
   clearTimer(item.timer);active=null;drain()
  },()=>{if(!stopped&&active===item)fail('麦克风音频上传失败，语音对话已停止。请检查连接后重新开始。')})
 }
 function enqueue(base64){
  if(stopped)return false
  let bytes
  try{bytes=base64ToBytes(base64);if(!bytes.length||bytes.length%2)throw new Error('invalid PCM')}catch{fail('麦克风音频格式无效，语音对话已停止。请重新开始。');return false}
  if(buffered+bytes.length>maxBytes){fail('麦克风上传持续拥塞，语音对话已停止，避免漏听。请检查连接后重新开始。');return false}
  queue.push(bytes);buffered+=bytes.length;drain();return true
 }
 return {enqueue,stop,get bufferedMs(){return buffered/bytesPerMs}}
}
