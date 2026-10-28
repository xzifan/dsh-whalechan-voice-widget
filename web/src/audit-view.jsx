import {useCallback, useEffect, useRef, useState} from 'react'
import {Table, TableHeader, TableBody, TableHead, TableRow, TableCell, TableCaption} from './components/ui/table'
import {Popover, PopoverTrigger, PopoverContent} from './components/ui/popover'
import {Copy, FileText, LoaderCircle, RefreshCw, Search, X, ListFilter, ChevronRight, Hash, MessagesSquare, Server} from 'lucide-react'
import {Button, buttonVariants} from './components/ui/button'
import {Input} from './components/ui/input'
import {Badge} from './components/ui/badge'
import {Switch} from './components/ui/switch'
import {Select, SelectTrigger, SelectValue, SelectContent, SelectItem} from './components/ui/select'
import {Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription} from './components/ui/sheet'
import {api} from './lib/core.js'
import {auditUsage, formatAuditTime, formatAuditNumber, summarizeAuditUsage, mergeAuditRecords, auditRangeStart} from './lib/audit.js'

const kinds = {transcription: '语音转写', response: '模型回复', synthesis: '语音合成', usage: '历史独立用量', tool: '工具调用', error: '错误'}
const statuses = {pending: '等待中', running: '进行中', streaming: '生成中', completed: '已完成', complete: '已完成', success: '成功', done: '已完成', failed: '失败', error: '错误', cancelled: '已取消', canceled: '已取消'}
const timeRanges = {all: '全部时间', hour: '最近1小时', day: '最近24小时', week: '最近7天'}
const emptyPage = {records: [], total: 0, hasMore: false, nextBefore: null, storageError: null}

function RecordBadges({record}) {
  const failed = record.kind === 'error' || ['error', 'failed'].includes(record.status)
  return <>
    <Badge variant={record.kind === 'error' ? 'destructive' : 'secondary'} className="shrink-0">{kinds[record.kind] || record.kind || '记录'}</Badge>
    <Badge variant={failed ? 'destructive' : 'outline'} className="max-w-full break-all">{statuses[record.status] || record.status || '状态未返回'}</Badge>
  </>
}

function AuditRecord({record, onCopy}) {
  const [copyNotice, setCopyNotice] = useState('')
  const usage = auditUsage(record)
  return <Sheet onOpenChange={() => setCopyNotice('')}>
    <SheetTrigger type="button" className={buttonVariants({variant: 'ghost', size: 'sm'})} aria-label={`查看${kinds[record.kind] || '记录'}详情`}><ChevronRight className="size-4"/></SheetTrigger>
    <SheetContent className="flex h-full w-full min-w-0 flex-col gap-0 p-0 sm:max-w-xl">
      <SheetHeader className="shrink-0 border-b p-5 pr-12 text-left">
        <SheetTitle>审计记录详情</SheetTitle>
        <SheetDescription>{kinds[record.kind] || record.kind || '记录'} · {formatAuditTime(record.at)}</SheetDescription>
      </SheetHeader>
      <div className="min-h-0 min-w-0 flex-1 space-y-6 overflow-y-auto overscroll-contain p-5">
        <div className="flex flex-wrap items-center gap-2"><RecordBadges record={record}/>{record.role && <span className="break-all text-xs text-muted-foreground">{record.role}</span>}</div>
        <section className="min-w-0 space-y-2">
          <h3 className="text-sm font-medium">文本内容</h3>
          <p className="whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-sm leading-relaxed [overflow-wrap:anywhere]">{record.text || '此记录没有文本内容'}</p>
        </section>
        <section className="min-w-0 space-y-2">
          <h3 className="text-sm font-medium">模型与音色</h3>
          <dl className="grid min-w-0 gap-2 text-xs">{[['提供方', record.provider], ['模型', record.model], ['音色', record.voice]].map(([label, value]) => <div key={label} className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] gap-2"><dt className="text-muted-foreground">{label}</dt><dd className="break-all">{typeof value === 'object' && value !== null ? JSON.stringify(value) : value || '未返回'}</dd></div>)}</dl>
        </section>
        <section className="min-w-0 space-y-2">
          <h3 className="text-sm font-medium">用量</h3>
          <div className="flex flex-wrap gap-x-5 gap-y-2 rounded-md bg-muted/50 p-3 text-xs">
            <span>输入 tokens：{formatAuditNumber(usage.input)}</span>
            <span>输出 tokens：{formatAuditNumber(usage.output)}</span>
            <span>总 tokens：{formatAuditNumber(usage.total)}</span>
          </div>
          <p className="text-xs text-muted-foreground">提供方返回的用量；字符、音频等指标保留原单位。</p>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/50 p-3 text-xs">{record.usage == null ? '未返回' : JSON.stringify(record.usage, null, 2)}</pre>
        </section>
        <section className="min-w-0 space-y-2">
          <h3 className="text-sm font-medium">完整标识</h3>
          {copyNotice && <p role="status" className="text-xs text-muted-foreground">{copyNotice}</p>}
          <dl className="grid min-w-0 gap-3 text-xs">{['id', 'seq', 'sessionId', 'messageId', 'turnId', 'responseId', 'callId'].map(key => <div key={key} className="grid min-w-0 gap-1 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-2"><dt className="text-muted-foreground">{key}</dt><dd className="flex min-w-0 items-start gap-1"><span className="min-w-0 flex-1 break-all font-mono">{record[key] ?? '未返回'}</span>{key === 'messageId' && record.messageId && <Button type="button" variant="ghost" size="icon" className="size-6 shrink-0" aria-label="复制消息 ID" onClick={async () => setCopyNotice(await onCopy(record.messageId))}><Copy className="size-3.5"/></Button>}</dd></div>)}</dl>
        </section>
      </div>
    </SheetContent>
  </Sheet>
}

function HeaderFilter({label, active, children, icon: Icon = ListFilter}) {
  return <Popover>
    <PopoverTrigger className={buttonVariants({variant: 'ghost', size: 'icon-sm', className: `relative size-6 ${active ? 'text-primary bg-primary/5' : 'text-muted-foreground'}`})} aria-label={`${label}筛选菜单`} title={`筛选${label}`}>
      <Icon className="size-3.5"/>{active && <span className="absolute right-0.5 top-0.5 size-1 rounded-full bg-primary"/>}
    </PopoverTrigger>
    <PopoverContent align="start" className="w-64 space-y-3 p-3"><p className="text-sm font-medium">筛选{label}</p>{children}</PopoverContent>
  </Popover>
}
function HeaderSelect({label, value, onChange, options}) {
  const active = value !== 'all'
  return <Select value={value} onValueChange={onChange}>
    <SelectTrigger aria-label={`${label}表头筛选`} title={`筛选${label}：${options[value]}`} size="sm" className={`relative size-6 h-6! w-6 justify-center border-0 p-0 shadow-none hover:bg-accent [&>svg:last-child]:hidden ${active ? 'bg-primary/5 text-primary' : 'text-muted-foreground'}`}>
      <span><ListFilter className="size-3.5"/></span>{active && <span className="absolute right-0.5 top-0.5 size-1 rounded-full bg-primary"/>}
    </SelectTrigger>
    <SelectContent position="popper" align="start">{Object.entries(options).map(([key, name]) => <SelectItem key={key} value={key}>{name}</SelectItem>)}</SelectContent>
  </Select>
}
const fieldLabels = {text: '内容', provider: '提供方', model: '模型', sessionId: '会话 ID', messageId: '消息 ID', status: '状态'}
const defaults = {search: '', kind: 'all', range: 'all', failed: false, columnFilters: {}}

function FilterSelect({label, value, onChange, options}) {
  return <Select value={value} onValueChange={onChange}>
    <SelectTrigger className="h-8 w-full min-w-0 text-xs" aria-label={label}><SelectValue/></SelectTrigger>
    <SelectContent>{Object.entries(options).map(([key, name]) => <SelectItem key={key} value={key}>{name}</SelectItem>)}</SelectContent>
  </Select>
}

export function AuditView({initialMessageId = '', onClearMessageFilter} = {}) {
  const [search, setSearch] = useState(initialMessageId)
  const [columnFilters, setColumnFilters] = useState([])
  const [query, setQuery] = useState({...defaults, search: initialMessageId.trim()})
  const [page, setPage] = useState(emptyPage)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const controller = useRef(null)
  const busy = useRef(false)
  const rangeStart = useRef(null)
  const retryBefore = useRef(undefined)

  const load = useCallback(async (filters, before) => {
    const request = ++generation.current
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    busy.current = true
    retryBefore.current = before
    setLoading(true)
    setError('')
    if (before == null) {setPage(emptyPage); rangeStart.current = auditRangeStart(filters.range)}
    try {
      const result = await api('audit', {limit: 100, ...(before != null ? {before} : {}), ...(filters.search ? {search: filters.search} : {}), ...(filters.kind !== 'all' ? {kind: filters.kind} : {}), ...(rangeStart.current !== null ? {since: rangeStart.current} : {}), ...(filters.failed ? {failed: true} : {}), columnFilters: filters.columnFilters, signal: abort.signal})
      if (request !== generation.current) return
      if (!Array.isArray(result.records)) throw new Error('审计服务返回了无效记录，请刷新重试')
      setPage(previous => ({records: before != null ? mergeAuditRecords(previous.records, result.records) : result.records, total: result.total ?? result.records.length, hasMore: !!result.hasMore, nextBefore: result.nextBefore, storageError: result.storageError || null}))
    } catch (cause) {
      if (request === generation.current && cause?.name !== 'AbortError') setError(cause?.message || '读取审计记录失败')
    } finally {
      if (request === generation.current) {busy.current = false; setLoading(false)}
    }
  }, [])

  useEffect(() => {setSearch(initialMessageId)}, [initialMessageId])
  useEffect(() => {
    const timer = setTimeout(() => {
      const next = Object.fromEntries(columnFilters.filter(item => String(item.value).trim()).map(item => [item.id, String(item.value).trim()]))
      setQuery(previous => previous.search === search.trim() && JSON.stringify(previous.columnFilters) === JSON.stringify(next) ? previous : {...previous, search: search.trim(), columnFilters: next})
    }, 300)
    return () => clearTimeout(timer)
  }, [search, columnFilters])
  useEffect(() => {load(query)}, [query, load])
  useEffect(() => () => {generation.current++; controller.current?.abort()}, [])

  const reset = () => {setSearch(''); setColumnFilters([]); setQuery({...defaults}); onClearMessageFilter?.()}
  const copyMessageId = async id => {
    try {
      await navigator.clipboard.writeText(id)
      return '消息 ID 已复制'
    } catch {return '复制失败，请手动选择并复制消息 ID。'}
  }
  const fieldValue = key => columnFilters.find(item => item.id === key)?.value || ''
  const setField = (key, value) => setColumnFilters(previous => [...previous.filter(item => item.id !== key), ...(value ? [{id: key, value}] : [])])
  const fieldInput = key => <label className="block space-y-1.5 text-xs text-muted-foreground">{fieldLabels[key]}<Input maxLength={200} aria-label={`${fieldLabels[key]}表头筛选`} placeholder={`筛选${fieldLabels[key]}…`} value={fieldValue(key)} onChange={event => setField(key, event.target.value)}/></label>
  const summary = summarizeAuditUsage(page.records)
  const active = query.search || query.kind !== 'all' || query.range !== 'all' || query.failed || columnFilters.length > 0
  return <div className="w-full min-w-0 space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="flex items-center gap-2 text-lg font-semibold"><FileText className="size-5"/>日志审计</h1><p className="mt-1 text-xs text-muted-foreground">浏览对话、调用与用量记录</p></div>
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" onClick={reset}><X/>重置筛选</Button>
        <Button type="button" variant="outline" disabled={loading} onClick={() => load(query)}>{loading ? <LoaderCircle className="animate-spin"/> : <RefreshCw/>}刷新</Button>
      </div>
    </div>
    <div className="grid min-w-0 gap-4 lg:grid-cols-[8rem_minmax(0,1fr)]">
      <aside className="min-w-0 lg:border-r lg:pr-3 lg:self-start" aria-label="日志类型筛选">
        <h2 className="px-2 py-2 text-xs font-medium text-muted-foreground">记录类型</h2>
        <div className="flex flex-wrap gap-1 lg:flex-col">{Object.entries({all: '全部类型', ...kinds}).map(([kind, label]) => <Button key={kind} type="button" variant={query.kind === kind ? 'secondary' : 'ghost'} className="h-8 justify-start text-xs" aria-pressed={query.kind === kind} onClick={() => setQuery(previous => ({...previous, kind}))}>{label}</Button>)}</div>
      </aside>
      <section className="min-w-0 space-y-3" aria-label="日志表格与筛选">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-48 flex-1 sm:max-w-md"><Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground"/><Input className="pl-9" maxLength={500} aria-label="搜索审计记录" placeholder="搜索全部日志内容、ID、模型…" value={search} onChange={event => setSearch(event.target.value)}/></div>
          <div className="w-36"><FilterSelect label="时间范围" value={query.range} onChange={range => setQuery(previous => ({...previous, range}))} options={timeRanges}/></div>
          <label className="flex items-center gap-2 whitespace-nowrap text-sm"><Switch checked={query.failed} onCheckedChange={failed => setQuery(previous => ({...previous, failed}))}/>只看失败</label>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground" aria-live="polite"><span>匹配 <strong className="text-foreground">{loading ? '…' : page.total}</strong> 条</span><span>已加载 {page.records.length} 条</span><span>已加载记录的已知 tokens：{formatAuditNumber(summary.total)}</span></div>
        {page.storageError && <p role="alert" className="text-sm text-destructive">本地日志存储异常，部分记录可能未保存。</p>}
        {error && <div role="alert" className="flex items-center gap-3 text-sm text-destructive"><p>{error}</p><Button variant="outline" disabled={loading} onClick={() => load(query, retryBefore.current)}>重试</Button></div>}
        {columnFilters.length > 0 && <div className="flex flex-wrap gap-2">{columnFilters.map(({id,value}) => <Button key={id} variant="secondary" size="sm" className="h-7 max-w-64 gap-2 text-xs" onClick={() => setField(id, '')} aria-label={`清除${fieldLabels[id]}筛选`}><span className="truncate">{fieldLabels[id]}：{id === 'status' ? statuses[value] || value : value}</span><X className="size-3 shrink-0"/></Button>)}</div>}
        <div className="min-w-0 overflow-hidden rounded-lg border bg-card [&_[data-slot=table-container]]:max-h-[68vh] [&_[data-slot=table-container]]:overflow-auto" aria-busy={loading}>
          <Table className="min-w-[1000px] table-fixed">
            <TableCaption className="sr-only">审计日志，按列筛选全部保留记录</TableCaption>
            <TableHeader className="sticky top-0 z-10 bg-muted/70 backdrop-blur-md">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-36 pl-4"><div className="flex items-center gap-1 text-xs text-muted-foreground"><span>时间</span><HeaderSelect label="时间" value={query.range} onChange={range => setQuery(previous => ({...previous, range}))} options={timeRanges}/></div></TableHead>
                <TableHead className="w-24"><div className="flex items-center gap-1 text-xs text-muted-foreground"><span>类型</span><HeaderSelect label="类型" value={query.kind} onChange={kind => setQuery(previous => ({...previous, kind}))} options={{all: '全部类型', ...kinds}}/></div></TableHead>
                <TableHead><div className="flex items-center gap-1 text-xs text-muted-foreground"><span className="mr-1">内容</span>{['text', 'sessionId', 'messageId'].map(key => <HeaderFilter key={key} icon={{sessionId: MessagesSquare, messageId: Hash, provider: Server}[key] || ListFilter} label={fieldLabels[key]} active={!!fieldValue(key)}>{fieldInput(key)}</HeaderFilter>)}</div></TableHead>
                <TableHead className="w-24"><div className="flex items-center gap-1 text-xs text-muted-foreground"><span>状态</span><HeaderSelect label="状态" value={fieldValue('status') || 'all'} onChange={value => setField('status', value === 'all' ? '' : value)} options={{all: '全部状态', ...statuses, unreported: '未返回'}}/></div></TableHead>
                <TableHead className="w-44"><div className="flex items-center gap-1 text-xs text-muted-foreground"><span className="mr-1">模型</span>{['model', 'provider'].map(key => <HeaderFilter key={key} icon={{sessionId: MessagesSquare, messageId: Hash, provider: Server}[key] || ListFilter} label={fieldLabels[key]} active={!!fieldValue(key)}>{fieldInput(key)}</HeaderFilter>)}</div></TableHead>
                <TableHead className="w-20 text-right text-xs text-muted-foreground">Tokens</TableHead>
                <TableHead className="w-12"><span className="sr-only">详情</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>{page.records.map(record => <TableRow key={record.id}>
              <TableCell className="pl-4 text-xs tabular-nums text-muted-foreground">{formatAuditTime(record.at)}</TableCell>
              <TableCell className="text-xs">{kinds[record.kind] || record.kind}</TableCell>
              <TableCell className="whitespace-normal py-3"><p className="truncate text-sm" title={record.text || ''}>{record.text || (record.kind === 'usage' ? '模型用量统计' : '无文本内容')}</p><p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={record.messageId || record.sessionId}>{record.messageId || record.sessionId || '未关联消息'}</p></TableCell>
              <TableCell><span className="inline-flex items-center gap-1.5 text-xs"><span className={`size-1.5 rounded-full ${record.kind === 'error' || ['failed','error'].includes(record.status) ? 'bg-destructive' : ['completed','complete','success','done'].includes(record.status) ? 'bg-emerald-500' : 'bg-muted-foreground/50'}`}/>{statuses[record.status] || record.status || '未返回'}</span></TableCell>
              <TableCell className="text-xs"><p className="truncate" title={record.model}>{record.model || '未返回'}</p><p className="mt-0.5 truncate text-[10px] text-muted-foreground">{record.provider || '未返回'}</p></TableCell>
              <TableCell className="text-right text-xs tabular-nums text-muted-foreground">{formatAuditNumber(auditUsage(record).total)}</TableCell>
              <TableCell className="px-1"><AuditRecord record={record} onCopy={copyMessageId}/></TableCell>
            </TableRow>)}</TableBody>
          </Table>
          {loading && <p role="status" className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin"/>正在读取日志…</p>}
          {!loading && !error && !page.records.length && <p className="p-10 text-center text-sm text-muted-foreground">{active ? '没有匹配的日志，请放宽表头筛选或重置条件。' : '暂无日志，开始对话后刷新查看。'}</p>}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-2xl text-xs text-muted-foreground">保留最近 2000 条 / 10 MiB。Tokens 汇总已加载的模型回复、合成及未关联的历史用量记录；缺失用量不计为 0。</p>
          {page.hasMore && page.nextBefore != null && <Button type="button" variant="outline" disabled={loading} onClick={() => {if (!busy.current) load(query, page.nextBefore)}}>加载更早记录</Button>}
        </div>
      </section>
    </div>
  </div>
}
