import {useEffect,useState} from 'react'
import {Button} from './components/ui/button'
import {Badge} from './components/ui/badge'
import {Switch} from './components/ui/switch'
import {Label} from './components/ui/label'
import {Select,SelectTrigger,SelectValue,SelectContent,SelectItem} from './components/ui/select'
import {Conversation,ConversationContent,ConversationEmptyState,ConversationScrollButton} from './components/ai-elements/conversation'
import {Message,MessageContent} from './components/ai-elements/message'
import {VoiceMessage} from './components/ai-elements/voice-message'
import {useConversationDetails} from './hooks/use-conversation-motion'
import {realtimeTimeline} from './lib/realtime'
import {Mic,Square,LoaderCircle,AudioLines,Wrench,RefreshCw,SlidersHorizontal,ChevronDown,UserRound,Copy,Check,ScrollText} from 'lucide-react'

function ToolCall({tool,onInspect}){
 const detailsRef=useConversationDetails()
 const status={running:'执行中',completed:'已完成',failed:'失败',cancelled:'已取消'}[tool.status]||tool.status
 return <details ref={detailsRef} className="group min-w-0 rounded-xl border bg-background/70 px-3 py-2 text-xs text-muted-foreground" data-tool-call-id={tool.callId||tool.id}>
  <summary className="flex cursor-pointer list-none items-center gap-2"><Wrench className="size-3.5 shrink-0"/><span className="min-w-0 flex-1 break-all font-medium text-foreground">{tool.name}</span><span role="status" className={tool.status==='failed'?'text-destructive':''}>{status}</span>{tool.durationMs!==undefined&&<span className="tabular-nums">{tool.durationMs} ms</span>}{tool.status==='running'?<LoaderCircle className="size-3 shrink-0 animate-spin"/>:<ChevronDown className="size-3 shrink-0 group-open:rotate-180"/>}</summary>
  <div className="mt-3 space-y-2 border-t pt-2">
   <p className="break-all font-mono">Call ID: {tool.callId||'未提供'}</p>
   {tool.turnId&&<p className="break-all font-mono">Turn ID: {tool.turnId}</p>}
   {tool.startedAt!==undefined&&<p>开始时间：{new Date(tool.startedAt).toLocaleTimeString()}</p>}
   {tool.endedAt!==undefined&&<p>结束时间：{new Date(tool.endedAt).toLocaleTimeString()}</p>}
   {tool.errorSummary&&<p className="text-destructive">{tool.errorSummary}</p>}
   {tool.messageId&&<MessageIdentifier id={tool.messageId} onInspect={onInspect}/>}
  </div>
 </details>
}

function MessageIdentifier({id,onInspect}){
 const [copyState,setCopyState]=useState('')
 useEffect(()=>{if(!copyState)return;const timer=setTimeout(()=>setCopyState(''),2000);return()=>clearTimeout(timer)},[copyState])
 async function copy(){try{await navigator.clipboard.writeText(id);setCopyState('copied')}catch{setCopyState('failed')}}
 return <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100" data-message-id={id}>
  <span className="max-w-full break-all font-mono" title={id}>ID: {id}</span>
  <button type="button" className="rounded p-1 hover:bg-muted focus-visible:outline-2" onClick={copy} aria-label={`复制消息ID ${id}`}>{copyState==='copied'?<Check className="size-3"/>:<Copy className="size-3"/>}</button>
  {onInspect&&<button type="button" className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted" onClick={()=>onInspect(id)}><ScrollText className="size-3"/>查看审计</button>}
  {copyState&&<span role="status">{copyState==='copied'?'已复制':'复制失败，请选择ID文本复制'}</span>}
 </div>
}

function LevelMeter({level,active}){
 const pct=Math.max(0,Math.min(100,Math.round((level||0)*100)))
 return <div className="flex h-8 items-center justify-center gap-1" role="meter" aria-label="麦克风音量" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>{Array.from({length:19},(_,i)=><span key={i} className={`w-1 rounded-full transition-[height,opacity] duration-100 motion-reduce:transition-none ${active?'bg-primary/65':'bg-muted-foreground/20'}`} style={{height:`${active?Math.max(4,Math.min(30,(4+pct*.3)*(1-Math.abs(i-9)/14))):4}px`}}/>)}</div>
}
export function RealtimeView(p){
 const {rt,settings,change,audioInputs=[],audioDeviceId='default',setAudioDeviceId,refreshAudioInputs}=p
 const [showSettings,setShowSettings]=useState(false),[elapsed,setElapsed]=useState(0)
 useEffect(()=>{if(!rt.active){setElapsed(0);return}const since=Date.now();const timer=setInterval(()=>setElapsed(Math.floor((Date.now()-since)/1000)),1000);return()=>clearInterval(timer)},[rt.active])
 const useTtsVoice=!!settings?.realtime?.use_tts_voice
 const hasRunningTools=(rt.toolCalls||[]).some(tool=>tool.status==='running')
 const status=rt.starting?'正在准备声音并连接':!rt.active?(rt.error?'连接遇到问题':rt.closed?'对话已结束':'准备好就开始吧'):hasRunningTools?'正在帮你处理':rt.speaking?'小鲸鱼娘正在回应':rt.listening?'正在听你说话':'我在听，主人'
 const messages=rt.messages||[]
 const timeline=realtimeTimeline(rt)
 const clock=`${String(Math.floor(elapsed/60)).padStart(2,'0')}:${String(elapsed%60).padStart(2,'0')}`
 return <div className="mx-auto w-full max-w-5xl min-w-0">
  <section data-call-view={rt.active?'active':'idle'} className={`relative overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-sm ${rt.active?'flex h-[calc(100svh-6rem)] min-h-96 flex-col':''}`} aria-label={rt.active?'实时语音对话':'开始语音对话'}>
   <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-sky-500/8 via-transparent to-indigo-500/5"/>
   {rt.active?<header className="relative flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-6">
    <div className="flex min-w-0 items-center gap-3"><div className="relative shrink-0"><img src="./avatar.webp" alt="鲸鱼娘" className="size-10 rounded-full object-cover"/><span className="absolute bottom-0 right-0 size-3 rounded-full border-2 border-card bg-emerald-500"/></div><div className="min-w-0"><h1 className="text-sm font-semibold">和小鲸鱼娘对话中</h1><p className="mt-0.5 text-xs text-muted-foreground" role="status">{status}</p></div></div>
    <div className="flex items-center gap-3"><div className="hidden sm:block"><LevelMeter level={rt.level} active/></div><span className="font-mono text-xs tabular-nums text-muted-foreground">{clock}</span><Button size="sm" variant="destructive" className="rounded-full" onClick={p.rtStop}><Square className="size-3.5"/>结束对话</Button></div>
   </header>:<>
   <div className="relative flex flex-wrap items-center justify-between gap-3 px-5 pt-5 sm:px-7">
    <div className="flex items-center gap-2 text-sm font-medium"><AudioLines className="size-4 text-sky-600 dark:text-sky-400"/>实时语音<Badge variant="outline" className="font-normal">随时聊聊</Badge></div>
    <Button variant="ghost" size="sm" aria-expanded={showSettings} aria-controls="voice-device-settings" onClick={()=>setShowSettings(v=>!v)}><SlidersHorizontal className="size-4"/>声音与设备<ChevronDown className={`size-3.5 transition-transform ${showSettings?'rotate-180':''}`}/></Button>
   </div>
   <div className="relative flex flex-col items-center px-5 pb-10 pt-8 text-center">
    <div className="relative mb-4 grid size-24 place-items-center sm:size-28">
     {rt.active&&<div className="absolute inset-0 rounded-full border border-sky-400/40 bg-sky-400/5 motion-safe:animate-pulse"/>}
     <img src="./avatar.webp" alt="鲸鱼娘" className="relative size-20 rounded-full object-cover ring-4 ring-background shadow-sm sm:size-24"/>
     <span className={`absolute bottom-1 right-1 size-4 rounded-full border-[3px] border-card ${rt.active?'bg-emerald-500':rt.starting?'bg-amber-400':'bg-muted-foreground/40'}`}/>
    </div>
    <h1 className="text-xl font-semibold tracking-tight">和小鲸鱼娘聊一会儿</h1>
    <p className="mt-2 min-h-5 text-sm text-muted-foreground" role="status">{status}</p>
    <LevelMeter level={rt.level} active={rt.active}/>
    <div className="mt-3 flex flex-wrap items-center justify-center gap-3">
     <Button className="h-11 rounded-full px-8 shadow-sm" disabled={rt.starting} onClick={p.rtStart}>{rt.starting?<LoaderCircle className="size-4 animate-spin"/>:<Mic className="size-4"/>}{rt.starting?'准备声音并连接…':rt.closed?'再次开始':'开始对话'}</Button>
     {rt.starting&&<Button variant="outline" className="h-11 rounded-full px-5" onClick={p.rtStop}>取消连接</Button>}
    </div>
    <p className="mt-3 text-xs text-muted-foreground">{rt.closed?'本次对话已结束，可在会话记录中回看消息。':'第一次使用需要允许麦克风权限。准备好了，就点开始。'}</p>
   </div>
   </>}
   {rt.error&&<div className="mx-5 mb-5 rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-sm leading-relaxed text-destructive" role="alert">{rt.error}{!rt.active&&<button className="ml-2 underline underline-offset-4" onClick={()=>setShowSettings(true)}>检查声音与设备</button>}</div>}
   {rt.active&&rt.playbackError&&<div className="relative mx-5 mb-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm" role="alert">{rt.playbackError}<Button className="ml-2" size="sm" variant="outline" onClick={p.rtRetryPlayback}>重试播放</Button></div>}
    {showSettings&&!rt.active&&<div id="voice-device-settings" className="relative grid gap-4 border-t bg-muted/25 p-5 sm:grid-cols-2 sm:px-7">
    <div className="min-w-0 space-y-2"><div className="flex items-center justify-between gap-2"><Label htmlFor="mic-selector">输入设备</Label><Button variant="ghost" size="sm" disabled={rt.active||rt.starting} onClick={()=>refreshAudioInputs?.()}><RefreshCw className="size-3.5"/>刷新</Button></div><Select value={audioDeviceId} onValueChange={setAudioDeviceId} disabled={rt.active||rt.starting}><SelectTrigger id="mic-selector" aria-label="输入设备" className="w-full min-w-0"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="default">系统默认麦克风</SelectItem>{audioInputs.filter(d=>d.deviceId&&d.deviceId!=='default'&&d.deviceId!=='communications').map(d=><SelectItem key={d.deviceId} value={d.deviceId}>{d.label}</SelectItem>)}</SelectContent></Select><p className="text-xs text-muted-foreground">切换设备前先结束通话，连接设备后可刷新列表。</p></div>
    <div className="flex items-center justify-between gap-4 rounded-xl border bg-background/60 p-4"><div className="space-y-1"><Label htmlFor="realtime-tts">自定义语音（TTS）</Label><p className="text-xs leading-relaxed text-muted-foreground">开启后可自主设定音色，并使用 TTS 合成回复，可能产生额外 Token 消耗。关闭后使用 Realtime 自身语音。切换后需重新开始对话生效。</p></div><Switch id="realtime-tts" checked={useTtsVoice} onCheckedChange={checked=>change('realtime',{...(settings?.realtime||{}),use_tts_voice:checked})}/></div>
   </div>}
   {rt.active&&<div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-muted/15" aria-label="对话记录">
    <Conversation className="min-h-0 flex-1" aria-label="实时对话气泡">
    <ConversationContent>
     {!timeline.length?<ConversationEmptyState title="我在听，主人。" description="直接开口就好，你说的话和我的回应会显示在这里。想打断我时，直接说话。"><div className="grid size-12 place-items-center rounded-2xl border bg-background text-muted-foreground"><AudioLines className="size-6"/></div></ConversationEmptyState>:timeline.map(message=>message.kind==='tool'?<ToolCall key={message.id} tool={message} onInspect={p.onInspectMessage}/>:<Message key={`message:${message.id}`} from={message.role} tabIndex={0} aria-label={`${message.role==='user'?'你':'小鲸鱼娘'}的消息 ${message.id}`}><div className="flex items-center gap-2 text-xs text-muted-foreground">{message.role==='assistant'?<img src="./avatar.webp" alt="" className="size-6 rounded-full object-cover"/>:<UserRound className="size-4"/>}<span>{message.role==='user'?'你':'小鲸鱼娘'}</span>{message.status==='streaming'&&<span className="motion-safe:animate-pulse">{message.role==='user'?'正在转写…':'正在回应…'}</span>}{message.delivery==='failed'?<span className="text-destructive">语音合成失败，已显示文字</span>:message.status==='interrupted'&&<span>已打断</span>}</div>{message.delivery!=='failed'&&(message.role==='user'||message.voice)?<VoiceMessage message={message} recording={message.role==='user'&&rt.listening&&message.id===rt.activeUserMessageId}/>:<MessageContent>{message.text||'…'}</MessageContent>}<MessageIdentifier id={message.messageId||message.id} onInspect={p.onInspectMessage}/></Message>)}
     
    </ConversationContent><ConversationScrollButton/>
   </Conversation>
   <footer className="flex flex-wrap items-center justify-between gap-2 border-t bg-card px-5 py-3 text-xs text-muted-foreground"><span>直接说话即可打断 · {messages.length} 条消息</span>{rt.metrics&&<details><summary className="cursor-pointer">通话质量</summary><div className="mt-2 flex flex-wrap gap-3"><span>首字 {rt.metrics.firstAudioMs??'—'} ms</span><span>本轮 {rt.metrics.roundMs} ms</span><span>卡顿 {rt.metrics.underflows??0} 次</span></div></details>}</footer>
   </div>}
  </section>
 </div>
}
