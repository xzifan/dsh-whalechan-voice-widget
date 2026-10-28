import {useEffect, useRef, useState} from 'react'
import {api} from '../lib/core.js'
import {createPreviewPlayer} from '../lib/preview-playback.js'
import {presetPromptIssue,selectVoicePreset} from '../lib/voice-presets.js'

const candidateKey=preset=>JSON.stringify([preset?.prompt,preset?.candidate])
export function useVoicePresets({onApplied,provider='qwen'}) {
  const [presets,setPresets]=useState(null),[drafts,setDrafts]=useState({})
  const [editorPresetId,setEditorPresetId]=useState(null)
  const [busy,setBusy]=useState(null),[messages,setMessages]=useState({})
  const [playback,setPlayback]=useState({}),[greeting,setGreeting]=useState(null)
  const lock=useRef(false),mounted=useRef(true),player=useRef(null),playingId=useRef(null)
  const request=useRef(null),revision=useRef(0),activeProvider=useRef(provider)
  activeProvider.current=provider
  function clearAudio(){player.current?.stop();playingId.current=null;setGreeting(null);setPlayback({})}
  useEffect(()=>{
    // cleanup 里要读的是「卸载那一刻」的值，所以转发 ref 对象本身；直接写
    // revision.current 会被 exhaustive-deps 判为「该值可能已经变了」。
    const rev=revision,req=request,plr=player
    mounted.current=true
    return()=>{mounted.current=false;rev.current++;req.current?.abort();plr.current?.stop()}
  },[])
  useEffect(()=>{revision.current++;request.current?.abort();clearAudio()},[provider])
  function load(rows) {
    revision.current++;request.current?.abort();clearAudio()
    setPresets(Array.isArray(rows)?rows:null)
    setEditorPresetId(previous=>rows?.some(row=>row.id===previous)?previous:selectVoicePreset(rows||[])?.id)
    setDrafts({});setMessages({})
  }
  function message(id,kind,text){if(mounted.current)setMessages(previous=>({...previous,[id]:{kind,text}}))}
  function play(id,audio,key) {
    player.current?.stop()
    playingId.current=id
    if(!player.current)player.current=createPreviewPlayer({onState:state=>{
      if(mounted.current)setPlayback({presetId:playingId.current,...state})
    }})
    setGreeting({presetId:id,provider,candidateKey:key,...audio})
    player.current.start({data:audio.audio,mime:audio.mime})
  }
  async function run(id,action) {
    if(lock.current)return
    const preset=presets?.find(item=>item.id===id)
    if(!preset)return
    const prompt=(drafts[id]??preset.prompt).trim(),dirty=prompt!==preset.prompt
    if(action==='generate'&&presetPromptIssue(prompt)){message(id,'error',presetPromptIssue(prompt));return}
    if(action!=='generate'&&(dirty||!preset.candidate)){message(id,'error','请先保存并生成当前提示词对应的音色。');return}
    lock.current=true
    clearAudio()
    const token=++revision.current,controller=new AbortController();request.current=controller
    const current=()=>mounted.current&&!controller.signal.aborted&&revision.current===token&&activeProvider.current===provider
    const params={presetId:id,...(provider==='breeze'?{provider}:{}),signal:controller.signal}
    setBusy({id,action});message(id,'status','')
    try {
      let result
      if(action==='generate') {
        if(dirty){
          const saved=await api('voice-presets/save',{...params,prompt})
          if(!current())return
          setPresets(saved.voicePresets)
          setDrafts(previous=>({...previous,[id]:prompt}))
        }
        setBusy({id,action:'generating'})
        message(id,'status',preset.candidate&&!dirty?'正在准备试听…':'正在生成音色与试听…')
        result=await api('voice-presets/generate',params)
      } else result=await api(`voice-presets/${action}`,params)
      if(!current())return
      if(result.voicePresets)setPresets(result.voicePresets)
      const row=result.voicePresets?.find(item=>item.id===id)||{...preset,prompt,candidate:result.candidate||preset.candidate}
      if(action==='apply'&&result.settings)onApplied(result.settings)
      if(result.greeting?.audio){
        message(id,'success',action==='apply'?'音色已应用。':action==='generate'&&!row.applied?'音色已生成，正在试听；喜欢的话再应用。':'试听已准备好，正在播放。')
        play(id,result.greeting,candidateKey(row))
      }else message(id,'greetingError',`${action==='apply'?'音色已应用，试听暂不可用':'音色已生成，试听暂不可用'}。${result.greetingError||'请重试试听。'}`)
    } catch(error) {
      if(current()&&error.name!=='AbortError')message(id,action==='greeting'?'greetingError':'error',action==='greeting'?`音色已生成，试听暂不可用。${error.message}`:error.message)
    } finally {
      lock.current=false
      if(request.current===controller)request.current=null
      if(mounted.current)setBusy(null)
    }
  }
  function replay(id){
    const preset=presets?.find(row=>row.id===id)
    if(!preset||!preset.candidate||(drafts[id]??preset.prompt).trim()!==preset.prompt)return
    if(greeting?.presetId===id&&greeting.provider===provider&&greeting.candidateKey===candidateKey(preset))play(id,greeting,candidateKey(preset))
    else void run(id,'generate')
  }
  return {presets,editorPresetId,drafts,busy,messages,playback,greeting,load,
    sync(rows){if(Array.isArray(rows)){if(greeting&&candidateKey(rows.find(row=>row.id===greeting.presetId))!==greeting.candidateKey){revision.current++;request.current?.abort();clearAudio()}setPresets(rows)}},
    edit(id,value){revision.current++;request.current?.abort();clearAudio();setDrafts(previous=>({...previous,[id]:value}));message(id,'status','')},
    generate:id=>run(id,'generate'),apply:id=>run(id,'apply'),retryGreeting:id=>run(id,'greeting'),
    replay,
    retryPlayback(){if(greeting&&greeting.provider===provider&&greeting.candidateKey===candidateKey(presets?.find(row=>row.id===greeting.presetId)))void player.current?.retry()},
  }
}
