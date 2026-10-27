import React, {useEffect, useRef, useState} from 'react'
import {createRoot} from 'react-dom/client'
import {api, createRequestGate, newId, normalizeSettings} from './lib/core.js'
import {CompanionView} from './companion-view.jsx'
import {configIssues,configurationContext,mergeConfigurationErrors} from './lib/configuration.js'
import {advanceCursor,applyRealtimeEvent,shouldStopPlayback,createPlaybackQueue,startRealtimeMic,listAudioInputs,finalizeRealtimeMessages} from './lib/realtime.js'
import {createMicUploader} from './lib/mic-upload.js'
import {createPreviewPlayer} from './lib/preview-playback.js'
import {createFillerPlayer,createPlaybackReporter,createPcmScheduler} from './lib/filler-playback.js'
import {useVoicePresets} from './hooks/use-voice-presets.js'
import {mergeAppliedVoice} from './lib/voice-presets.js'
import {mergeVoiceSettingsPatch} from './lib/voice-settings.js'
import {initializeToolSelection} from './lib/tool-selection.js'
import './shadcn.css'
import './companion-ui.css'

function App() {
  const [settings,setSettings]=useState(()=>normalizeSettings()), [saved,setSaved]=useState('')
  const [configBusy,setConfigBusy]=useState('加载中'), [notice,setNotice]=useState(null)
  const [providerCredentials,setProviderCredentials]=useState({})
  const [capabilities,setCapabilities]=useState({}), [models,setModels]=useState({})
  const [serverIssues,setServerIssues]=useState(null),[checkingConfig,setCheckingConfig]=useState(false)
  const [catalog,setCatalog]=useState(null),[catalogBusy,setCatalogBusy]=useState(false),[catalogError,setCatalogError]=useState('')
  // Realtime voice conversation state
  const [rt,setRt]=useState({active:false,starting:false,speaking:false,listening:false,level:0,userText:'',assistantText:'',tool:null,error:'',done:false,closed:false})
  const [audioInputs,setAudioInputs]=useState([]),[audioDeviceId,setAudioDeviceId]=useState('default')
  const rtSession=useRef(null),rtMic=useRef(null),rtEventsCursor=useRef(0),rtPollTimer=useRef(null),rtPollWake=useRef(null),rtMounted=useRef(false)
  const rtPlayback=useRef(null),rtAudioCtx=useRef(null),rtPcmRemainder=useRef(new Float32Array(0)),rtCaptureCtx=useRef(null)
  const rtPreviewAudio=useRef(null),rtPendingVoice=useRef('')
  const rtUploader=useRef(null),rtStartAttempt=useRef(null),rtStartGeneration=useRef(0)
  const rtFiller=useRef(null),rtReporter=useRef(null),rtPcmActive=useRef(false)
  const mounted=useRef(true), session=useRef(newId()), currentSettings=useRef(settings)
  currentSettings.current=settings
  function onVoiceApplied(applied){
    const next=mergeAppliedVoice(currentSettings.current,applied)
    currentSettings.current=next;setSettings(next)
    setSaved(previous=>JSON.stringify(mergeAppliedVoice(previous?JSON.parse(previous):normalizeSettings(applied),applied)))
    setServerIssues(null)
  }
  function onVoiceSettingsPatch(patch){
    currentSettings.current=mergeVoiceSettingsPatch(currentSettings.current,patch)
    setSettings(currentSettings.current)
    setSaved(previous=>previous?JSON.stringify(mergeVoiceSettingsPatch(JSON.parse(previous),patch)):previous)
    setServerIssues(null)
  }
  const voicePresets=useVoicePresets({onApplied:onVoiceApplied})
  const dirty=saved!==JSON.stringify(settings)
  const configContext=configurationContext(models,capabilities),contextKey=JSON.stringify(configContext)
  const fieldErrors=mergeConfigurationErrors(configIssues(settings,configContext),serverIssues,JSON.stringify(settings))
  const validationWarnings=serverIssues?.snapshot===JSON.stringify(settings)?Object.values(serverIssues.warnings||{}):[]
  const notify=(kind,message)=>{if(mounted.current)setNotice({kind,message})}

  function change(key,value) {
    const next={...currentSettings.current,[key]:value}
    currentSettings.current=next;setSettings(next)
  }
  async function loadConfig() {
    setConfigBusy('加载中')
    try {
      const result=await api('config',{},'GET')
      if(!mounted.current)return
      const original=normalizeSettings(result.settings)
      voicePresets.load(result.voicePresets)
      let value=original
      if(!original.tools_configured){
        try{const available=await api('catalog',{});if(!mounted.current)return;setCatalog(available);value=initializeToolSelection(original,available)}catch{}
      }
      setServerIssues(null);currentSettings.current=value;setSettings(value);setSaved(JSON.stringify(original));setCapabilities(result.capabilities||{});setModels(result.models||{});setProviderCredentials(result.credentials?.providers||{})
    }catch(error){notify('error',error.message)}finally{if(mounted.current)setConfigBusy('')}
  }
  async function checkProviderCredentials(signal) {
    const result=await api('credentials/status',{signal})
    if(mounted.current&&!signal?.aborted)setProviderCredentials(result.providers||{})
  }
  async function saveProviderCredential(provider,key,signal) {
    const result=await api('credentials/save',{provider,key,signal})
    if(mounted.current&&!signal?.aborted)setProviderCredentials(result.providers||{})
  }
  async function loadCatalog() {
    setCatalogBusy(true);setCatalogError('')
    try{const result=await api('catalog',{});if(mounted.current)setCatalog(result)}catch(error){if(mounted.current)setCatalogError(error.message)}finally{if(mounted.current)setCatalogBusy(false)}
  }
  async function validateConfiguration(snapshot=currentSettings.current,announce=true) {
    const key=JSON.stringify(snapshot),errors=configIssues(snapshot,configContext)
    if(Object.keys(errors).length){notify('error','请先修正配置页中标出的项目。');return false}
    setCheckingConfig(true)
    try{
      const result=await api('config/check',{settings:structuredClone(snapshot)})
      if(!mounted.current||JSON.stringify(currentSettings.current)!==key)return false
      setServerIssues({snapshot:key,errors:result.errors||{},warnings:result.warnings||{}})
      if(!result.valid){notify('error','配置检查发现问题，请查看标出的项目。');return false}
      if(announce)notify('success','全部配置检查通过。已检查服务端文件与工作区，未测试网络连通性或发起语音请求。')
      return true
    }catch(error){if(error.fields)setServerIssues({snapshot:key,errors:error.fields});notify('error',error.message);return false}
    finally{if(mounted.current)setCheckingConfig(false)}
  }
  const checkAllConfig=()=>validateConfiguration(structuredClone(currentSettings.current))
  async function saveConfig() {
    const snapshot=structuredClone(currentSettings.current)
    if(!await validateConfiguration(snapshot,false))return
    if(JSON.stringify(currentSettings.current)!==JSON.stringify(snapshot)){notify('error','检查期间配置已变化，请重新保存。');return}
    setConfigBusy('保存中')
    try{
      await api('config',{settings:snapshot},'PUT')
      if(mounted.current){setServerIssues(null);setSaved(JSON.stringify(snapshot));notify('success','设置已保存。')}
      const runtime=await api('config',{},'GET')
      if(mounted.current){voicePresets.sync(runtime.voicePresets);setCapabilities(runtime.capabilities||{});setModels(runtime.models||{});setProviderCredentials(runtime.credentials?.providers||{})}
    }catch(error){if(error.fields)setServerIssues({snapshot:JSON.stringify(snapshot),errors:error.fields});notify('error',error.message)}finally{if(mounted.current)setConfigBusy('')}
  }
  // ---- Realtime voice conversation ----------------------------------------
  function rtSet(patch) {setRt(previous=>({...previous,...patch}))}
  async function rtPoll() {
    const sessionId=rtSession.current
    if(!sessionId)return
    try{
      const result=await api('realtime/events',{sessionId,after:rtEventsCursor.current})
      if(rtSession.current!==sessionId)return
      const events=Array.isArray(result.events)?result.events:[]
      rtEventsCursor.current=advanceCursor(events,rtEventsCursor.current)
      for(const event of events){
        const underflows = rtPlayback.current?.stats?.underflows ?? 0
        if(shouldStopPlayback(event)&&(event.type!=='done'||event.status==='cancelled'))rtStopPlayback()
        if(rtFiller.current?.handleEvent(event))continue
        if(event.type==='audio')rtEnqueue(event.data)
        else if(event.type==='preview-audio'){
          rtFiller.current?.stop()
          if(!rtPreviewAudio.current){
            const reporter=rtReporter.current
            rtPreviewAudio.current=createPreviewPlayer({onState:patch=>{if(rtMounted.current)rtSet(patch)},onActive:active=>reporter?.set('main','preview',active)})
          }
          rtPreviewAudio.current.start(event)
        }
        else if(event.type==='voice-settings-changed'){
          onVoiceSettingsPatch(event.patch)
        }
        else if(event.type==='voice-applied'){rtPendingVoice.current=event.voiceId||''}
        else if(event.type==='metrics'){event.underflows=underflows}
        setRt(previous=>applyRealtimeEvent(previous,event))
      }
      if(rtPendingVoice.current){
        const voice=rtPendingVoice.current;rtPendingVoice.current=''
        currentSettings.current={...currentSettings.current,realtime:{...(currentSettings.current.realtime||{}),voice}}
        setSettings(currentSettings.current)
        void rtStop().then(()=>rtStart())
        return
      }
      if(result.done===true)rtSet({done:true})
    }catch(error){if(error.name!=='AbortError'&&rtSession.current===sessionId)rtSet({error:error.message})}
  }
  function rtStartPolling() {
    rtStopPolling()
    const loop=async()=>{
      while(rtSession.current&&rtMounted.current){
        await rtPoll()
        await new Promise(resolve=>{rtPollTimer.current=setTimeout(resolve,180);rtPollWake.current=resolve})
      }
    }
    void loop()
  }
  function rtStopPolling() {
    clearTimeout(rtPollTimer.current);rtPollTimer.current=null
    rtPollWake.current?.();rtPollWake.current=null
  }
  function rtStopPlayback() {rtFiller.current?.stop();rtPlayback.current?.stop();rtPlayback.current=null;rtPreviewAudio.current?.stop()}
  function rtRetryPlayback(){rtFiller.current?.stop();void rtPreviewAudio.current?.retry()}
  function rtEnqueue(base64) {rtFiller.current?.stop();if(!rtPlayback.current)rtBeginPlayback();rtPlayback.current.enqueue(base64)}
  function rtBeginPlayback() {
    if(!rtAudioCtx.current)rtAudioCtx.current=new AudioContext()
    const ctx=rtAudioCtx.current
    const reporter=rtReporter.current
    const scheduler=createPcmScheduler(ctx,{onBusy:value=>{rtPcmActive.current=value},onActive:active=>reporter?.set('main','pcm',active)})
    rtPlayback.current=createPlaybackQueue(scheduler,24000)
    rtPlayback.current.start()
  }
  async function rtStart() {
    if(rtSession.current||rtStartAttempt.current||!rtMounted.current)return
    const attempt={generation:++rtStartGeneration.current,controller:new AbortController()}
    rtStartAttempt.current=attempt
    const current=()=>rtMounted.current&&!attempt.controller.signal.aborted&&rtStartAttempt.current===attempt&&rtStartGeneration.current===attempt.generation
    rtSet({starting:true,error:'',userText:'',assistantText:'',tool:null,done:false,closed:false})
    let startedSession=null
    try{
      // Keep the response observable after a local cancel so any server session
      // created by this request can be ended, rather than becoming an orphan.
      const result=await api('realtime/start',{settings:structuredClone(currentSettings.current)})
      startedSession=result.sessionId
      if(!current()){
        if(startedSession)void api('realtime/end',{sessionId:startedSession}).catch(()=>{})
        return
      }
      if(result.voiceSettingsPatch)onVoiceSettingsPatch(result.voiceSettingsPatch)
      rtSession.current=result.sessionId;rtEventsCursor.current=0
      const sessionId=result.sessionId
      const reporter=createPlaybackReporter(state=>api('realtime/playback',{sessionId,...state}))
      rtReporter.current=reporter;rtPreviewAudio.current=null
      rtFiller.current=createFillerPlayer({isMainBusy:()=>rtPcmActive.current||!!rtPreviewAudio.current?.hasAudio,onActive:active=>reporter.set('filler','filler',active)})
      rtBeginPlayback()
      rtSet({active:true,starting:false,messages:[],voiceDurations:{},activeUserMessageId:null,activeAssistantMessageId:null,ttsTranscriptCallIds:[],metrics:null,toolCalls:[],timelineOrder:0,playbackError:''})
      rtStartPolling()
      const uploader=createMicUploader({
        send:(audio,signal)=>api('realtime/audio',{sessionId,audio,signal}),
        onError:error=>{if(rtSession.current!==sessionId)return;void rtStop();rtSet({error:error.message})},
      })
      rtUploader.current=uploader
      const mic=await startRealtimeMic({
        deviceId:audioDeviceId,
        onLevel:value=>{if(rtMounted.current&&rtSession.current===sessionId)rtSet({level:value})},
        onFrame:frame=>{if(rtSession.current===sessionId)uploader.enqueue(frame)},
        onEnded:()=>{if(rtMounted.current&&rtSession.current===sessionId)void rtStop()},
      })
      if(!current()||rtSession.current!==sessionId){uploader.stop();mic.stop();return}
      rtMic.current=mic
      // Refresh labels/devices now that permission is granted.
      void refreshAudioInputs()
    }catch(error){
      if(current()){
        rtSet({starting:false,active:false,error:error.message})
        rtSession.current=null;rtStopPolling();rtUploader.current?.stop();rtUploader.current=null;rtStopPlayback();rtMic.current?.stop();rtMic.current=null
      }
      if(startedSession)void api('realtime/end',{sessionId:startedSession}).catch(()=>{})
    }finally{
      if(rtStartAttempt.current===attempt)rtStartAttempt.current=null
    }
  }
  async function refreshAudioInputs(){const list=await listAudioInputs();if(rtMounted.current)setAudioInputs(list)}
  async function rtStop() {
    rtStartGeneration.current++;rtStartAttempt.current?.controller.abort();rtStartAttempt.current=null
    const sessionId=rtSession.current
    rtSession.current=null;rtStopPolling();rtUploader.current?.stop();rtUploader.current=null;rtStopPlayback()
    rtMic.current?.stop();rtMic.current=null
    setRt(previous=>({...finalizeRealtimeMessages(previous),active:false,starting:false,listening:false,speaking:false,level:0,closed:true}))
    if(sessionId)void api('realtime/end',{sessionId}).catch(()=>{})
  }
  // Theme adaptation: follow the host/system color scheme. Apply `.dark` on the
  // document root so shadcn tokens switch; never fight an explicit ancestor class.
  useEffect(()=>{
    const root=document.documentElement
    const mq=window.matchMedia?window.matchMedia('(prefers-color-scheme: dark)'):null
    const apply=()=>{
      // If an ancestor (DSH host) already sets .dark explicitly, respect whether it is present.
      const hostDark=!!document.querySelector('.dsh-dark, [data-theme="dark"], .theme-dark')
      const dark=hostDark||(mq?mq.matches:false)
      root.classList.toggle('dark',dark)
      root.style.colorScheme=dark?'dark':'light'
    }
    apply()
    if(mq){if(mq.addEventListener)mq.addEventListener('change',apply);else mq.addListener?.(apply)}
    return()=>{if(mq){if(mq.removeEventListener)mq.removeEventListener('change',apply);else mq.removeListener?.(apply)}}
  },[])
  useEffect(()=>{
    mounted.current=true;rtMounted.current=true;void loadConfig();void loadCatalog();void refreshAudioInputs()
    if(globalThis.navigator?.mediaDevices?.addEventListener)globalThis.navigator.mediaDevices.addEventListener('devicechange',refreshAudioInputs)
    return()=>{
      mounted.current=false;rtMounted.current=false
      rtStartGeneration.current++;rtStartAttempt.current?.controller.abort();rtStartAttempt.current=null
      const rsid=rtSession.current;rtSession.current=null;rtStopPolling();rtUploader.current?.stop();rtUploader.current=null;rtStopPlayback();rtMic.current?.stop();rtMic.current=null;void rtAudioCtx.current?.close().catch(()=>{})
      if(rsid)void api('realtime/end',{sessionId:rsid}).catch(()=>{})
    }
  },[])
  return <CompanionView {...{voicePresets,providerCredentials,checkProviderCredentials,saveProviderCredential,settings,change,fieldErrors,validationWarnings,checkingConfig,checkAllConfig,dirty,saved,configBusy:configBusy||(voicePresets.busy?'处理音色中':''),catalog,catalogBusy,catalogError,loadCatalog,notice,setNotice,saveConfig,loadConfig,rt,rtStart,rtStop,rtRetryPlayback,audioInputs,audioDeviceId,setAudioDeviceId,refreshAudioInputs}}/>
}
createRoot(document.getElementById('root')).render(<App/> )