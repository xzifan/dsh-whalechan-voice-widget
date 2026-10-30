import React,{useEffect,useRef,useState} from 'react'
import {Card,CardHeader,CardTitle,CardDescription,CardContent} from './components/ui/card'
import {Badge} from './components/ui/badge'
import {Button} from './components/ui/button'
import {Label} from './components/ui/label'
import {ValidationInput as Input} from './components/config-validation'
import {Textarea} from './components/ui/textarea'
import {Select,SelectTrigger,SelectValue,SelectContent,SelectItem} from './components/ui/select'
import {Switch} from './components/ui/switch'
import {BrainCircuit,Volume2,ChevronDown} from 'lucide-react'
import {VOICE_PROVIDERS,REALTIME_PROVIDERS} from './lib/voice-layer.js'
import {errorText} from './lib/core.js'
import {TTS_BUILTINS} from '../../src/core/tts-config.js'
import {BREEZE_PRESET_VOICES,BREEZE_ZH_VOICES} from '../../src/core/breeze-voices.js'
import {VoicePresetsEditor} from './voice-presets-editor.jsx'

function ProviderSelect({id,label,value,onChange,items}){return <div className="min-w-0 space-y-2"><Label htmlFor={id}>{label}</Label><Select value={value} onValueChange={onChange}><SelectTrigger id={id} aria-label={label} className="w-full min-w-0"><SelectValue/></SelectTrigger><SelectContent className="max-w-[calc(100vw-16px)]">{items.map(item=><SelectItem key={item.value} value={item.value} disabled={item.disabled} className="whitespace-normal break-words">{item.label}</SelectItem>)}</SelectContent></Select></div>}

function ProviderCredentials({provider,label,status,disabled,onCheck,onSave}){
  const [editing,setEditing]=useState(false),[busy,setBusy]=useState(''),[hasKey,setHasKey]=useState(false),[message,setMessage]=useState('')
  const input=useRef(null),request=useRef(null),active=useRef(true)
  const clear=()=>{if(input.current)input.current.value='';setHasKey(false)}
  useEffect(()=>{const field=input.current;active.current=true;return()=>{active.current=false;request.current?.abort();if(field)field.value=''}},[])
  const run=async(kind)=>{
    if(busy)return
    const key=kind==='save'?input.current?.value.trim():undefined
    if(kind==='save'&&!key)return
    const controller=new AbortController();request.current=controller
    setBusy(kind);setMessage('')
    if(kind==='save')clear()
    try{
      if(kind==='save')await onSave(provider,key,controller.signal)
      else await onCheck(controller.signal)
      if(!active.current||controller.signal.aborted)return
      if(kind==='save'){setEditing(false);setMessage('已保存到 DSH；未测试远端鉴权。')}
      else setMessage('状态已刷新；未发起模型请求。')
    }catch(error){
      if(active.current&&error.name!=='AbortError')setMessage(kind==='save'?errorText(error,'凭据保存失败，请重新输入后重试。'):'状态读取失败，请稍后重试。')
    }finally{if(active.current){setBusy('');request.current=null}}
  }
  const cancel=()=>{clear();setEditing(false);setMessage('')}
  const id=`${provider}-credentials`
  return <section id={id} tabIndex={-1} aria-label={`${label}凭据`} className="min-w-0 space-y-3 rounded-lg border bg-muted/20 p-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">{label}凭据</p><Badge variant="outline">{status?status.ready?'可读取':'未配置':'待检查'}</Badge></div>
    <p className="text-xs leading-relaxed text-muted-foreground">{status?.routeAvailable?'复用 DSH 中已有提供方的凭据。更新后，使用同一凭据的功能也会生效。':'保存到 DSH 共享凭据，无需另外添加对话模型。'}</p>
    {status?.routeAvailable&&status.writable===false&&<p className="text-xs leading-relaxed text-muted-foreground">请在 DSH 设置 → 模型 → 已有的{label}提供方中管理凭据，然后回来检查状态。</p>}
    {provider!=='volcengine'&&<details className="text-xs leading-relaxed text-muted-foreground"><summary className="cursor-pointer">如何获取凭据</summary><div className="mt-2 space-y-2"><p>已有 DSH 提供方且凭据可读取时，无需重复填写。首次使用时，在服务商创建 API Key，粘贴到此处的只写输入框并保存到 DSH，再检查状态。</p>{provider==='bailian'?<p><a className="underline underline-offset-2" href="https://bailian.console.aliyun.com/model/settings/api-key" target="_blank" rel="noopener noreferrer">百炼 API Key 控制台</a><span> · </span><a className="underline underline-offset-2" href="https://help.aliyun.com/zh/model-studio/get-api-key" target="_blank" rel="noopener noreferrer">官方获取说明</a></p>:<p><a className="underline underline-offset-2" href="https://docs.breezeblue.ai/authentication" target="_blank" rel="noopener noreferrer">Breeze 官方鉴权说明</a></p>}<p>“可读取”只确认 DSH 能获取凭据，不验证远端权限、额度或模型可用性。</p></div></details>}
    {status?.error&&!status.ready&&<p role="status" className="break-words text-xs text-muted-foreground">{status.error}</p>}
    {editing?<form className="space-y-3" onSubmit={event=>{event.preventDefault();void run('save')}}>
      <div className="space-y-2"><Label htmlFor={`${id}-key`}>{provider==='volcengine'?'火山引擎共享凭据':`${label} API Key`}</Label><input ref={input} className="h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" id={`${id}-key`} type={'pass'+'word'} autoComplete={'new-pass'+'word'} spellCheck={false} disabled={!!busy||disabled} onChange={event=>setHasKey(!!event.target.value.trim())} aria-describedby={`${id}-help`}/><p id={`${id}-help`} className="text-xs leading-relaxed text-muted-foreground">只写入，不回显原值。当前 DSH 使用本地凭据文件存储，并非系统钥匙串加密。</p></div>
      <div className="flex flex-wrap gap-2"><Button type="submit" size="sm" disabled={!!busy||disabled||!hasKey}>{busy==='save'?'保存中…':'保存到 DSH'}</Button><Button type="button" size="sm" variant="ghost" disabled={!!busy} onClick={cancel}>取消</Button></div>
    </form>:<div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" aria-expanded={false} disabled={!!busy||disabled||status?.writable===false} onClick={()=>{setMessage('');setEditing(true)}}>{status?.ready?'更新凭据':'配置凭据'}</Button><Button type="button" size="sm" variant="ghost" disabled={!!busy||disabled} onClick={()=>void run('check')}>{busy==='check'?'检查中…':'检查状态'}</Button></div>}
    {message&&<p role="status" className="text-xs text-muted-foreground">{message}</p>}
    <p className="text-xs text-muted-foreground">只检查凭据是否可读取，不测试远端鉴权。</p>
    {(status?.credentialRef||status?.recordKey)&&<details className="text-xs text-muted-foreground"><summary className="cursor-pointer">凭据绑定</summary><p className="mt-1 break-all font-mono">{status.recordKey||status.credentialRef}</p></details>}
  </section>
}

function JsonParameters({value,onChange,onError}){
  const serialized=JSON.stringify(value||{},null,2)
  const [draft,setDraft]=useState(serialized),[error,setError]=useState('')
  useEffect(()=>{setDraft(previous=>{try{if(JSON.stringify(JSON.parse(previous||'{}'),null,2)===serialized)return previous}catch{}return serialized});setError('');onError('')},[serialized,onError])
  useEffect(()=>()=>onError(''),[onError])
  const update=text=>{
    setDraft(text)
    try{
      const parsed=JSON.parse(text||'{}')
      if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error()
      setError('');onError('');onChange(parsed)
    }catch{const message='合成参数须为有效的 JSON 对象';setError(message);onError(message)}
  }
  return <div className="space-y-2"><Label htmlFor="tts-params">合成参数（JSON）</Label><Textarea id="tts-params" rows={4} value={draft} onChange={event=>update(event.target.value)} aria-invalid={!!error} aria-describedby={error?'tts-params-error':'tts-params-help'} className="font-mono text-xs" placeholder={'例如：{"speed":1.0}'}/>{error?<p id="tts-params-error" role="alert" className="text-xs text-destructive">{error}</p>:<p id="tts-params-help" className="text-xs text-muted-foreground">可选，按提供方文档填写额外参数；留空使用默认值。</p>}</div>
}

export function VoiceLayerView(p){
  const {settings,change,configBusy,onParameterError}=p
  const rt=settings.realtime||{}
  const updateRealtime=patch=>change('realtime',{...rt,...patch})
  const providerId=settings.tts_voice_provider||'qwen'
  const supported=VOICE_PROVIDERS.some(item=>item.value===providerId)
  const rawProfile={...TTS_BUILTINS[providerId],...settings.tts_profiles?.[providerId]}
  const {key_file:legacyKeyFile,api_key:legacyApiKey,...managedProfile}=rawProfile
  const profile=['breeze','qwen'].includes(providerId)?managedProfile:rawProfile
  const useTtsVoice=rt.use_tts_voice!==false
  const currentVoiceName=p.voicePresets?.presets?.some(preset=>preset.applied)?'自定义音色':settings.tts_profiles?.qwen?.voice||'系统默认音色'
  const setProfile=(field,value)=>change('tts_profiles',{...settings.tts_profiles,[providerId]:{...profile,[field]:value}})
  const setProvider=value=>{
    if(TTS_BUILTINS[value]){
      const selected={...TTS_BUILTINS[value],...settings.tts_profiles?.[value],...(value==='breeze'?{voice:BREEZE_PRESET_VOICES.zh}:{})}
      const {key_file,api_key,...managed}=selected
      change('tts_profiles',{...settings.tts_profiles,[value]:['breeze','qwen'].includes(value)?managed:selected})
    }
    change('tts_voice_provider',value)
  }
  return <div className="grid min-w-0 gap-4">
    <Card className="min-w-0">
      <CardHeader>
        <div className="flex items-center justify-between gap-4"><CardTitle className="flex items-center gap-2"><Volume2 className="size-4"/>自定义语音</CardTitle><Switch id="use-tts-voice" aria-label="启用自定义语音" checked={useTtsVoice} onCheckedChange={checked=>updateRealtime({use_tts_voice:checked})} disabled={!!configBusy} className="shrink-0"/></div>
        <CardDescription>{useTtsVoice?'使用独立 TTS 朗读回复，音色按提供方配置。':'当前使用实时模型自带的声音。开启后可使用独立 TTS 音色。'}切换后重新开始对话生效。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!useTtsVoice&&<p className="text-xs text-muted-foreground">下方保留自定义语音配置，可提前编辑，开启后使用。</p>}
        <ProviderSelect id="voice-provider" label="语音提供方" value={supported?providerId:''} onChange={setProvider} items={VOICE_PROVIDERS}/>
        {!supported&&<p role="status" className="text-xs text-muted-foreground">当前使用旧版提供方，请选择上方提供方继续配置。</p>}
        {supported&&<>
          {providerId==='breeze'&&<ProviderCredentials provider="breeze" label="Breeze" status={p.providerCredentials?.breeze} disabled={!!configBusy} onCheck={p.checkProviderCredentials} onSave={p.saveProviderCredential}/> }
          {providerId==='openai'&&<div className="grid min-w-0 gap-4 md:grid-cols-2"><div className="space-y-2"><Label htmlFor="tts-model">模型</Label><Input id="tts-model" value={profile.model||''} onChange={event=>setProfile('model',event.target.value)} placeholder="gpt-4o-mini-tts"/></div><div className="space-y-2"><Label htmlFor="tts-voice">音色</Label><Input id="tts-voice" value={profile.voice||''} onChange={event=>setProfile('voice',event.target.value)} placeholder="alloy"/></div></div>}
          {providerId==='qwen'&&<div className="space-y-3 border-t pt-4"><p className="text-xs text-muted-foreground">Qwen TTS 与音色设计复用下方「实时音频模型」中的百炼凭据。</p><p className="break-words text-xs text-muted-foreground">当前音色：<span className="font-medium text-foreground">{currentVoiceName}</span></p>{p.voicePresets&&<VoicePresetsEditor controls={p.voicePresets} disabled={!!configBusy}/>}</div>}
          {providerId==='breeze'&&<section aria-label="Breeze 预设音色" className="min-w-0 space-y-3 border-t pt-3"><p className="text-sm font-medium">预设音色</p><p className="text-xs leading-relaxed text-muted-foreground">中文可在两种情绪间切换，日语与英语使用固定预设；暂不支持提示词生成或音色复刻。</p><div className="min-w-0 space-y-2"><Label htmlFor="breeze-zh-voice">中文音色</Label><Select value={profile.zhVoice||BREEZE_ZH_VOICES[0].voiceId} onValueChange={value=>setProfile('zhVoice',value)}><SelectTrigger id="breeze-zh-voice" className="w-full min-w-0"><SelectValue/></SelectTrigger><SelectContent className="max-w-[calc(100vw-16px)]">{BREEZE_ZH_VOICES.map(voice=><SelectItem key={voice.voiceId} value={voice.voiceId} className="whitespace-normal break-words">{voice.name} · {voice.voiceId}</SelectItem>)}</SelectContent></Select></div><dl className="grid min-w-0 gap-x-3 gap-y-1 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">{[['ja','日语'],['en','英语']].map(([language,label])=><React.Fragment key={language}><dt className="text-muted-foreground">{label} · {language}</dt><dd className="min-w-0 break-all font-mono">{BREEZE_PRESET_VOICES[language]}</dd></React.Fragment>)}</dl></section>}
          <details className="group min-w-0 rounded-lg border p-3">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium">高级设置<ChevronDown className="size-4 transition-transform group-open:rotate-180"/></summary>
            <div className="mt-4 min-w-0 space-y-4">
              {providerId==='breeze'&&<div className="grid min-w-0 gap-4 md:grid-cols-2"><div className="space-y-2"><Label htmlFor="tts-model">模型</Label><Input id="tts-model" value={profile.model||''} onChange={event=>setProfile('model',event.target.value)}/></div><div className="space-y-2"><Label htmlFor="breeze-endpoint">合成接口</Label><Input id="breeze-endpoint" value={profile.endpoint||''} onChange={event=>setProfile('endpoint',event.target.value)}/></div></div>}
              <JsonParameters key={providerId} value={profile.extra} onChange={value=>setProfile('extra',value)} onError={onParameterError}/>
            </div>
          </details>
        </>}
      </CardContent>
    </Card>
    <Card className="min-w-0" id="realtime">
      <CardHeader><CardTitle className="flex items-center gap-2"><BrainCircuit className="size-4"/>实时音频模型</CardTitle><CardDescription>负责语音理解、回复与打断。凭据随所用模型配置。</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <ProviderSelect id="realtime-provider" label="实时模型" value="qwen" onChange={()=>{}} items={REALTIME_PROVIDERS}/>
        <p className="break-all text-xs text-muted-foreground">{rt.model||'qwen-audio-3.1-realtime-plus'}</p>
        <div className="flex flex-wrap gap-2"><Badge variant="secondary">说话即可打断</Badge><Badge variant="secondary">支持工具调用</Badge></div>
        <ProviderCredentials provider="bailian" label="百炼" status={p.providerCredentials?.bailian} disabled={!!configBusy} onCheck={p.checkProviderCredentials} onSave={p.saveProviderCredential}/>
        <details className="min-w-0 rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">高级设置：火山引擎凭据</summary><div className="mt-3 space-y-3"><p className="text-xs leading-relaxed text-muted-foreground">可选，仅保存共享凭据；实时音频接入尚未实现，所需鉴权以接入时为准。目前无需配置。</p><ProviderCredentials provider="volcengine" label="火山引擎" status={p.providerCredentials?.volcengine} disabled={!!configBusy} onCheck={p.checkProviderCredentials} onSave={p.saveProviderCredential}/></div></details>
      </CardContent>
    </Card>
  </div>
}
