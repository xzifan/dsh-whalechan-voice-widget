import {useEffect, useState} from 'react'
import {History, Search, RefreshCw, LoaderCircle, ArrowLeft, MessagesSquare, UserRound, Wrench, CircleAlert, ScrollText} from 'lucide-react'
import {Button} from './components/ui/button'
import {Input} from './components/ui/input'
import {Badge} from './components/ui/badge'
import {api} from './lib/core.js'
import {formatAuditTime, historyStatusBadge} from './lib/audit.js'
import {formatDuration} from './lib/statistics.js'

function Failure({error, retry}) {
  return <div role="alert" className="flex flex-wrap items-center gap-2 p-4 text-sm text-destructive"><span>{error}</span><Button variant="outline" size="sm" onClick={retry}>重试</Button></div>
}
function HistoryMessage({message, onInspectMessage}) {
  const user = message.kind === 'user', event = ['tool','error'].includes(message.kind)
  const badge = historyStatusBadge(message)
  const label = {user:'你',assistant:'小鲸鱼娘',tool:'工具调用',error:'错误记录'}[message.kind] || '记录'
  return <article aria-label={`${label}的历史记录`} className={`group flex min-w-0 flex-col gap-1 ${user ? 'items-end' : 'items-start'}`}>
    <div className="flex max-w-full flex-wrap items-center gap-2 text-xs text-muted-foreground">{user ? <UserRound className="size-4"/> : event ? message.kind==='tool' ? <Wrench className="size-4"/> : <CircleAlert className="size-4"/> : <img src="./avatar.webp" alt="" className="size-6 rounded-full"/>}<span>{label}</span><time>{formatAuditTime(message.at)}</time></div>
    <div className={`max-w-full whitespace-pre-wrap break-words rounded-xl px-3 py-2 text-sm leading-relaxed [overflow-wrap:anywhere] sm:max-w-[90%] ${user ? 'bg-primary text-primary-foreground' : event ? 'w-full border bg-muted/30' : 'border bg-card'}`}>{message.text || '此记录没有文本内容'}</div>
    <div className="flex max-w-full flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
      <Badge variant={badge.variant} className="text-[10px]">{badge.label}</Badge>
      {message.model && message.model !== 'unknown' && <span className="break-all">{message.model}</span>}
      {typeof message.audioDurationSeconds==='number' && <span>音频 {formatDuration(message.audioDurationSeconds)}</span>}
      {message.messageId && onInspectMessage && <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px]" onClick={()=>onInspectMessage(message.messageId)}><ScrollText className="size-3"/>查看审计</Button>}
    </div>
  </article>
}
function SessionMessages({sessionId, revision, onBack, onInspectMessage}) {
  const [result,setResult]=useState(null), [loading,setLoading]=useState(true), [error,setError]=useState(''), [retry,setRetry]=useState(0)
  useEffect(()=>{
    const controller=new AbortController();let current=true
    setLoading(true);setError('');setResult(null)
    api('history/messages',{sessionId,signal:controller.signal}).then(value=>{
      if(!current)return
      if(!Array.isArray(value.messages))throw new Error('会话消息格式无效，请重试')
      setResult(value)
    }).catch(cause=>{if(current&&cause.name!=='AbortError')setError(cause.message||'读取消息失败')}).finally(()=>{if(current)setLoading(false)})
    return()=>{current=false;controller.abort()}
  },[sessionId,revision,retry])
  return <section className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="会话消息" aria-busy={loading}>
    <header className="shrink-0 space-y-1 border-b px-3 py-2">
      <div className="flex items-start gap-2"><Button variant="ghost" size="icon" className="size-7 shrink-0 lg:hidden" aria-label="返回会话列表" onClick={onBack}><ArrowLeft/></Button><div className="min-w-0 flex-1"><h2 className="break-words font-semibold [overflow-wrap:anywhere]">{result?.session?.title || '会话消息'}</h2>{result?.session && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{formatAuditTime(result.session.firstAt)} · {result.session.messageCount} 条消息</p>}</div></div>
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">会话 ID</summary><p className="mt-1 break-all font-mono">{sessionId}</p></details>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pt-3 pb-2 sm:px-4">
      {loading && <p role="status" className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin"/>正在读取消息…</p>}
      {error && <Failure error={error} retry={()=>setRetry(v=>v+1)}/>}
      {result?.storageError && <p role="alert" className="mb-4 text-sm text-destructive">本地存储异常，部分历史消息可能未保存。</p>}
      {!loading&&!error&&result&&!result.messages.length && <p className="p-8 text-center text-sm text-muted-foreground">{result.session ? '此会话暂无可展示的文字消息。' : '会话记录已不在保留范围内，请刷新列表。'}</p>}
      <div className="space-y-3">{result?.messages.map(message=><HistoryMessage key={message.id} message={message} onInspectMessage={onInspectMessage}/>)}</div>
      {!!result?.messages.length && <p className="mt-3 text-center text-xs text-muted-foreground">以上为当前保留的消息 · 按时间顺序展示</p>}
    </div>
  </section>
}
export function HistoryView({onInspectMessage}) {
  const [search,setSearch]=useState(''),[query,setQuery]=useState(''),[revision,setRevision]=useState(0)
  const [result,setResult]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[selected,setSelected]=useState(null)
  useEffect(()=>{const timer=setTimeout(()=>setQuery(search.trim()),250);return()=>clearTimeout(timer)},[search])
  useEffect(()=>{
    const controller=new AbortController();let current=true
    setLoading(true);setError('');setResult(null)
    api('history/sessions',{search:query,signal:controller.signal}).then(value=>{
      if(!current)return
      if(!Array.isArray(value.sessions))throw new Error('会话列表格式无效，请重试')
      setResult(value)
    }).catch(cause=>{if(current&&cause.name!=='AbortError')setError(cause.message||'读取会话失败')}).finally(()=>{if(current)setLoading(false)})
    return()=>{current=false;controller.abort()}
  },[query,revision])
  return <div className="flex w-full min-h-0 min-w-0 flex-1 flex-col gap-2">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="flex items-center gap-2 text-lg font-semibold"><History className="size-5"/>会话记录</h1><p className="mt-1 text-xs text-muted-foreground">回看语音会话中的转录、回复与工具调用</p></div><Button variant="outline" disabled={loading} onClick={()=>setRevision(v=>v+1)}>{loading?<LoaderCircle className="animate-spin"/>:<RefreshCw/>}刷新记录</Button></div>
    <p className="text-xs leading-relaxed text-muted-foreground">展示本地保留日志中的会话；最多保留最近 2000 条 / 10 MiB，较早消息可能不完整。原始音频未保存，暂不支持历史回放。</p>
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden rounded-xl border bg-card">
      <aside aria-label="历史会话列表" className={`${selected?'hidden lg:flex':'flex'} w-full shrink-0 flex-col lg:w-72 lg:border-r xl:w-80`}>
        <div className="space-y-1.5 border-b p-2"><div className="relative"><Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground"/><Input aria-label="搜索会话记录" placeholder="搜索消息内容或会话 ID…" maxLength={200} value={search} className="pl-9" onChange={e=>{setSearch(e.target.value);setSelected(null)}}/></div><p className="text-xs text-muted-foreground" role="status">{loading?'正在读取会话…':result?`${result.total} 个会话`:'列表暂不可用'}</p></div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {error&&<Failure error={error} retry={()=>setRevision(v=>v+1)}/>}
          {result?.storageError&&<p role="alert" className="p-3 text-xs text-destructive">本地存储异常，会话历史可能不完整。</p>}
          {!loading&&!error&&result&&!result.sessions.length&&<p className="p-6 text-center text-sm text-muted-foreground">{query?'没有匹配的会话，试试其他关键词。':'暂无会话记录，开始语音对话后刷新查看。'}</p>}
          {result?.sessions.map(session=><button type="button" key={session.sessionId} aria-pressed={selected===session.sessionId} onClick={()=>setSelected(session.sessionId)} className={`mb-0.5 block w-full min-w-0 space-y-1 rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring ${selected===session.sessionId?'bg-accent text-accent-foreground':'hover:bg-muted/60'}`}><p className="truncate text-sm font-medium">{session.title}</p><p className="truncate text-xs text-muted-foreground">{session.preview||'暂无文字消息'}</p><div className="flex flex-wrap justify-between gap-1 text-[11px] text-muted-foreground"><time>{formatAuditTime(session.lastAt)}</time><span>{session.messageCount} 条消息</span></div></button>)}
        </div>
      </aside>
      {selected?<SessionMessages key={selected} sessionId={selected} revision={revision} onBack={()=>setSelected(null)} onInspectMessage={onInspectMessage}/>:<div className="hidden min-w-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground lg:flex"><MessagesSquare className="size-10 opacity-50"/><h2 className="text-sm font-medium">选择一场会话</h2><p className="text-xs">在左侧选择会话，查看其中的消息记录。</p></div>}
    </div>
  </div>
}
