import {previewAudioUrl} from './realtime.js'

export function playbackErrorMessage(error){
 return error?.name==='NotAllowedError'?'浏览器阻止了语音播放，请点击「重试播放」允许出声。':'TTS 音频未能播放，请重试并检查浏览器或系统音量。'
}

// Preview events can arrive in one poll while earlier clips are still playing.
// Only ended advances the FIFO; blocked/failed audio stays available for retry.
export function createPreviewPlayer({createAudio=url=>new Audio(url),createUrl=previewAudioUrl,revokeUrl=url=>URL.revokeObjectURL(url),onState=()=>{},onActive=()=>{}}={}){
 let current=null,generation=0,active=false
 function setActive(value){if(active!==value){active=value;onActive(value)}}
 const pending=[]
 function release(){if(!current)return;const {audio,url}=current;current=null;audio.onplaying=null;audio.onended=null;audio.onerror=null;audio.pause();if(url?.startsWith('blob:'))revokeUrl(url)}
 function stop(){generation++;pending.length=0;release();setActive(false);onState({speaking:false,playbackError:''})}
 async function play(entry){
  const token=generation,attempt=++entry.attempt
  onState({playbackError:''})
  try{await entry.audio.play()}catch(error){if(current===entry&&generation===token&&entry.attempt===attempt){setActive(false);onState({speaking:false,playbackError:playbackErrorMessage(error)})}}
 }
 function advance(){
  if(current)return
  while(pending.length){
   const event=pending.shift()
   let url,audio
   try{
    url=createUrl(event.data,event.mime)
    if(!url){onState({speaking:false,playbackError:'收到的 TTS 音频无效，无法播放。'});continue}
    audio=createAudio(url)
   }catch(error){if(url?.startsWith('blob:'))revokeUrl(url);onState({speaking:false,playbackError:playbackErrorMessage(error)});continue}
   const entry={audio,url,attempt:0};current=entry
   audio.onplaying=()=>{if(current===entry){setActive(true);onState({speaking:true,playbackError:''})}}
   audio.onerror=()=>{if(current===entry){setActive(false);onState({speaking:false,playbackError:playbackErrorMessage()})}}
   audio.onended=()=>{if(current===entry){release();onState({speaking:false,playbackError:''});advance()}}
   void play(entry)
   return
  }
  setActive(false)
 }
 function start(event){pending.push({data:event.data,mime:event.mime});advance()}
 return {start,stop,retry(){if(current)return play(current)},get hasAudio(){return !!current||pending.length>0}}
}
