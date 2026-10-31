import {useEffect,useMemo,useState} from 'react'
import {api} from './lib/core.js'
import {Button} from './components/ui/button'
import {Badge} from './components/ui/badge'
import {History,X,LoaderCircle} from 'lucide-react'

// 控制台右下角的常驻入口：点开是更新日志。
// 懒加载——只有第一次打开才请求 /api/changelog，之后复用同一份数据。
export function ChangelogCorner(){
  const [open,setOpen]=useState(false)
  const [data,setData]=useState(null)
  const [error,setError]=useState('')
  const [busy,setBusy]=useState(false)
  const [expanded,setExpanded]=useState(()=>new Set())

  // 注意：不要在依赖里带 busy 又用 cancelled 取消——setBusy(true) 会立刻触发重跑，
  // 上一轮的 Promise 结果会被 cleanup 丢掉，界面永远停在“读取中”。用 error 兜住重试。
  useEffect(()=>{
    if(!open||data||busy||error)return
    setBusy(true)
    api('changelog',{},'GET')
      .then(setData)
      .catch(cause=>setError(cause?.message||'更新日志读取失败'))
      .finally(()=>setBusy(false))
  },[open,data,busy,error])

  useEffect(()=>{
    if(!open)return
    const onKey=event=>{if(event.key==='Escape')setOpen(false)}
    window.addEventListener('keydown',onKey)
    return()=>window.removeEventListener('keydown',onKey)
  },[open])

  const entries=useMemo(()=>data?.entries||[],[data])
  const version=data?.version

  function toggle(key){
    setExpanded(previous=>{
      const next=new Set(previous)
      if(next.has(key))next.delete(key);else next.add(key)
      return next
    })
  }

  return <>
    {open&&<div className="fixed inset-0 z-40 bg-black/20" aria-hidden="true" onClick={()=>setOpen(false)}/>}
    {open&&<section role="dialog" aria-label="更新日志" className="fixed right-3 bottom-16 z-50 flex max-h-[70vh] w-[min(420px,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-xl border bg-background shadow-2xl">
      <header className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <History className="size-4 text-muted-foreground"/>
          <span className="text-sm font-medium">更新日志</span>
          {version&&<Badge variant="outline" className="text-[11px]">v{version}</Badge>}
        </div>
        <Button variant="ghost" size="icon" className="size-7" aria-label="关闭更新日志" onClick={()=>setOpen(false)}><X/></Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {busy&&!data&&<p className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="size-3 animate-spin"/>读取中…</p>}
        {error&&<p className="text-sm text-destructive">{error}</p>}
        {!busy&&!error&&entries.length===0&&<p className="text-sm text-muted-foreground">这个版本没有可显示的记录。</p>}
        {entries.map(entry=>{
          const key=entry.version
          const isOpen=expanded.has(key)
          const itemCount=entry.sections.reduce((sum,section)=>sum+section.items.length,0)
          return <article key={key} className="border-b py-2.5 last:border-b-0">
            <button type="button" className="flex w-full items-center justify-between gap-2 text-left" onClick={()=>toggle(key)} aria-expanded={isOpen}>
              <span className="flex min-w-0 items-center gap-2">
                <span className="text-sm font-semibold">{entry.version==='Unreleased'?'未发布':`v${entry.version}`}</span>
                {entry.date&&<span className="text-xs text-muted-foreground">{entry.date}</span>}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{itemCount} 条 · {isOpen?'收起':'展开'}</span>
            </button>
            {isOpen&&<div className="mt-2 space-y-2.5">
              {entry.sections.map(section=><div key={section.title}>
                <p className="mb-1 text-xs font-medium text-muted-foreground">{section.title}</p>
                <ul className="space-y-1.5">
                  {section.items.map((item,index)=><li key={index} className="text-sm leading-relaxed break-words">{item}</li>)}
                </ul>
              </div>)}
            </div>}
          </article>
        })}
      </div>
      <footer className="border-t px-4 py-2 text-[11px] text-muted-foreground">
        数据来自包内 CHANGELOG.md · 共 {data?.total??0} 个版本
      </footer>
    </section>}
    <Button
      variant="outline"
      size="sm"
      className="fixed right-3 bottom-3 z-50 gap-1.5 rounded-full shadow-lg"
      aria-label={open?'收起更新日志':'查看更新日志'}
      onClick={()=>setOpen(value=>!value)}
    >
      <History className="size-3.5"/>
      <span className="text-xs">更新日志</span>
    </Button>
  </>
}