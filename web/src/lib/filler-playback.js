import {previewAudioUrl} from './realtime.js'

// Reports transitions in order, even when a stop immediately follows a start.
// A reporter belongs to one session; never read a mutable session id in send().
export function createPlaybackReporter(send){
 const sources={main:new Set(),filler:new Set()}
 let tail=Promise.resolve()
 return {
  set(kind,source,active){
   const group=sources[kind],before=group.size>0
   if(active)group.add(source);else group.delete(source)
   const after=group.size>0
   if(before!==after)tail=tail.then(()=>send({kind,active:after})).catch(()=>{})
  },
  get settled(){return tail},
 }
}

// Fillers have no queue, retries, subtitles, or conversation-state side effects.
export function createFillerPlayer({createAudio=url=>new Audio(url),createUrl=previewAudioUrl,revokeUrl=url=>URL.revokeObjectURL(url),now=Date.now,isMainBusy=()=>false,onActive=()=>{}}={}){
 let current=null,listening=false,active=false
 const setActive=value=>{if(active!==value){active=value;onActive(value)}}
 function stop(id){
  if(!current||(id!=null&&current.id!==id))return
  const {audio,url}=current;current=null
  audio.onplaying=null;audio.onended=null;audio.onerror=null
  audio.pause();if(url?.startsWith('blob:'))revokeUrl(url)
  setActive(false)
 }
 function expired(event){
  if(event.expiresAt==null)return false
  const expiry=typeof event.expiresAt==='number'?event.expiresAt:Date.parse(event.expiresAt)
  return !Number.isFinite(expiry)||expiry<=now()
 }
 function start(event){
  if(listening||current||isMainBusy()||expired(event))return false
  let url,audio
  try{url=createUrl(event.data,event.mime);if(!url)return false;audio=createAudio(url)}
  catch{if(url?.startsWith('blob:'))revokeUrl(url);return false}
  const entry={id:event.id,audio,url};current=entry
  audio.onplaying=()=>{
   if(current!==entry)return
   if(listening||isMainBusy()||expired(event)){stop();return}
   setActive(true)
  }
  audio.onended=audio.onerror=()=>{if(current===entry)stop()}
  try{Promise.resolve(audio.play()).catch(()=>{if(current===entry)stop()})}catch{stop()}
  return true
 }
 function setListening(value){listening=value;if(value)stop()}
 function handleEvent(event){
  // ASR and assistant transcripts may arrive after VAD; only VAD owns this flag.
  if(event.type==='speech-started')setListening(true)
  else if(event.type==='speech-stopped')setListening(false)
  else if(event.type==='filler-audio'){start(event);return true}
  else if(event.type==='filler-cancel'){stop(event.id);return true}
  return false
 }
 return {start,stop,setListening,handleEvent,get hasAudio(){return !!current}}
}

// Count scheduled PCM sources, not individual ended events, to avoid false idle.
export function createPcmScheduler(ctx,{onBusy=()=>{},onActive=()=>{}}={}){
 let nextAt=ctx.currentTime,stopped=false,active=false
 const sources=new Set()
 function report(){
  if(stopped)return
  onBusy(sources.size>0)
  const value=sources.size>0&&ctx.state==='running'
  if(value!==active){active=value;onActive(value)}
 }
 ctx.addEventListener?.('statechange',report)
 return {
  schedule(samples,rate){
   if(stopped)return
   const buffer=ctx.createBuffer(1,samples.length,rate)
   buffer.getChannelData(0).set(samples)
   const src=ctx.createBufferSource();src.buffer=buffer;src.connect(ctx.destination)
   sources.add(src);src.onended=()=>{sources.delete(src);src.disconnect();report()}
   nextAt=Math.max(ctx.currentTime,nextAt)
   try{src.start(nextAt)}catch(error){sources.delete(src);src.disconnect();report();throw error}
   nextAt+=buffer.duration;report()
   if(ctx.state==='suspended')void ctx.resume().then(report).catch(()=>{})
  },
  stop(){
   stopped=true;ctx.removeEventListener?.('statechange',report)
   for(const src of sources){src.onended=null;try{src.stop();src.disconnect()}catch{}}
   sources.clear();onBusy(false)
   if(active){active=false;onActive(false)}
  },
 }
}
