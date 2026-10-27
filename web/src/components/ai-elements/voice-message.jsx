import React,{useEffect,useState} from 'react'
import {AudioLines,FileText} from 'lucide-react'

export function VoiceMessage({message,recording=false}){
 const [now,setNow]=useState(Date.now)
 useEffect(()=>{
  if(!recording)return
  setNow(Date.now())
  const timer=setInterval(()=>setNow(Date.now()),250)
  return()=>clearInterval(timer)
 },[recording])
 const user=message.role==='user'
 const seconds=recording&&Number.isFinite(message.speechStartedAt)
  ? Math.max(0,(now-message.speechStartedAt)/1000):message.audioDurationSeconds
 const known=Number.isFinite(seconds)&&seconds>=0
 const duration=known?`${Math.ceil(seconds)}″`:'—″'
 return <div className={`voice-message ${user?'voice-message-user':''}`}>
  <div className={`voice-message-audio ${recording?'is-recording':''}`} role="group" aria-label={`语音消息，${known?`${Math.ceil(seconds)} 秒`:'时长未知'}${recording?'，正在录音':''}`} style={{width:`${Math.min(240,112+(known?seconds:0)*3)}px`}}>
   <AudioLines className="voice-message-wave size-5" aria-hidden="true"/>
   <span className="font-medium tabular-nums">{duration}</span>
  </div>
  <div className="voice-message-transcript" aria-label="语音转录">
   <span className="voice-message-caption"><FileText className="size-3" aria-hidden="true"/>转录</span>
   <p>{message.text||(recording?'正在听你说话…':message.status==='streaming'?'正在转录…':'暂无转录内容')}</p>
  </div>
 </div>
}
