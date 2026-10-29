import {useCallback, useEffect, useRef, useState} from 'react'
import {BarChart3, RefreshCw, LoaderCircle, FileText, AudioLines, MessagesSquare, Hash} from 'lucide-react'
import {Button} from './components/ui/button'
import {Card, CardContent, CardHeader, CardTitle} from './components/ui/card'
import {Select, SelectTrigger, SelectValue, SelectContent, SelectItem} from './components/ui/select'
import {api} from './lib/core.js'
import {auditRangeStart, formatAuditNumber, formatAuditTime} from './lib/audit.js'
import {formatDuration, formatLatency} from './lib/statistics.js'

const ranges = {all: '全部保留记录', hour: '最近 1 小时', day: '最近 24 小时', week: '最近 7 天'}
const kinds = {transcription: '语音转录', response: '模型回复', synthesis: '语音合成', usage: '历史独立用量', tool: '工具调用', error: '错误记录'}
function Metric({title, value, detail, icon: Icon}) {
  return <Card className="min-w-0 gap-3 py-5 shadow-none"><CardHeader className="flex flex-row items-center justify-between gap-2 px-5"><h2 className="text-sm text-muted-foreground">{title}</h2><Icon className="size-4 shrink-0 text-muted-foreground"/></CardHeader><CardContent className="space-y-2 px-5"><p className="break-words text-3xl font-semibold tracking-tight tabular-nums">{value}</p><p className="text-xs leading-relaxed text-muted-foreground">{detail}</p></CardContent></Card>
}
export function StatisticsView() {
  const [range, setRange] = useState('all'), [data, setData] = useState(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [updatedAt, setUpdatedAt] = useState(null)
  const generation = useRef(0), controller = useRef(null)
  const load = useCallback(async () => {
    const request = ++generation.current
    controller.current?.abort()
    const abort = new AbortController(); controller.current = abort
    setLoading(true); setError(''); setData(null)
    try {
      const since = auditRangeStart(range)
      const result = await api('statistics', {...(since !== null ? {since} : {}), until: Date.now(), signal: abort.signal})
      if (request !== generation.current) return
      if (!Number.isSafeInteger(result.total) || !result.counts) throw new Error('统计服务返回了无效数据，请刷新重试')
      setData(result); setUpdatedAt(Date.now())
    } catch (cause) {
      if (request === generation.current && cause.name !== 'AbortError') setError(cause.message || '读取统计失败')
    } finally {if (request === generation.current) setLoading(false)}
  }, [range])
  useEffect(() => {const gen = generation, ctl = controller; void load(); return () => {gen.current++; ctl.current?.abort()}}, [load])
  const number = value => data ? formatAuditNumber(value) : '—'
  const latencyRow = (title, key) => <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{title}</dt><dd className="text-right tabular-nums"><span>{formatLatency(data?.latency?.[key]?.p50)} / {formatLatency(data?.latency?.[key]?.p95)}</span><span className="block text-xs text-muted-foreground">{data?.latency?.[key]?.samples ?? 0} 条样本</span></dd></div>
  const maxCount = data ? Math.max(1, ...Object.values(data.counts)) : 1
  return <div className="w-full min-w-0 space-y-5" aria-busy={loading}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="flex items-center gap-2 text-lg font-semibold"><BarChart3 className="size-5"/>使用统计</h1><p className="mt-1 text-xs text-muted-foreground">查看对话数量、转录与语音输出用量</p></div>
      <div className="flex flex-wrap items-center gap-2"><Select value={range} onValueChange={setRange}><SelectTrigger className="w-40" aria-label="统计时间范围"><SelectValue/></SelectTrigger><SelectContent>{Object.entries(ranges).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectContent></Select><Button variant="outline" disabled={loading} onClick={load}>{loading ? <LoaderCircle className="animate-spin"/> : <RefreshCw/>}刷新</Button></div>
    </div>
    {error && <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 p-4 text-sm text-destructive"><p>{error}</p><Button variant="outline" onClick={load}>重试</Button></div>}
    {data?.storageError && <p role="alert" className="text-sm text-destructive">本地日志存储异常，统计可能不完整。</p>}
    <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric title="记录总数" icon={Hash} value={number(data?.total)} detail="所选时间内的全部保留记录"/>
      <Metric title="对话会话" icon={MessagesSquare} value={number(data?.sessions)} detail="按会话 ID 去重，有记录的会话"/>
      <Metric title="转录字数" icon={FileText} value={number(data?.transcriptionCharacters)} detail={data ? `${number(data.counts.transcription)} 条转录 · 不含空白，含标点` : '统计语音识别返回的文本'}/>
      <Metric title="输出语音时长" icon={AudioLines} value={data ? formatDuration(data.outputAudioSeconds) : '—'} detail={data ? `${number(data.audioKnown)} 条已知时长 · ${number(data.audioMissing)} 条时长未知` : '统计生成的音频时长'}/>
    </div>
    <div role="status" className="text-xs text-muted-foreground">{loading ? '正在汇总全部保留记录…' : data?.total === 0 ? '所选时间内暂无记录，开始对话后刷新查看。' : data ? `更新于 ${formatAuditTime(updatedAt)}` : '统计暂不可用'}</div>
    <div className="grid min-w-0 gap-4 lg:grid-cols-2">
      <Card className="min-w-0 shadow-none"><CardHeader><CardTitle className="text-base">记录类型分布</CardTitle></CardHeader><CardContent className="space-y-4">{Object.entries(kinds).map(([key, label]) => <div key={key} className="space-y-2"><div className="flex items-center justify-between gap-3 text-sm"><span>{label}</span><span className="tabular-nums text-muted-foreground">{number(data?.counts[key])}</span></div><div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true"><div className="h-full rounded-full bg-primary/75 transition-[width]" style={{width: `${data ? (data.counts[key] || 0) / maxCount * 100 : 0}%`}}/></div></div>)}</CardContent></Card>
      <div className="min-w-0 space-y-4">
        <Card className="shadow-none"><CardHeader><CardTitle className="text-base">延迟与打断</CardTitle></CardHeader><CardContent><dl className="space-y-4 text-sm">
          {latencyRow('首字延迟', 'firstText')}
          {latencyRow('首帧延迟', 'firstAudio')}
          {latencyRow('合成耗时', 'synthesis')}
          <div className="flex justify-between gap-3"><dt className="text-muted-foreground">追问打断</dt><dd className="text-right tabular-nums">{number(data?.interrupts?.count)} 次<span className="block text-xs text-muted-foreground">{data?.interrupts?.rate == null ? '暂无回复记录' : `占回复 ${Math.round(data.interrupts.rate * 100)}%`}</span></dd></div>
        </dl></CardContent></Card>
        <Card className="shadow-none"><CardHeader><CardTitle className="text-base">其他用量</CardTitle></CardHeader><CardContent><dl className="space-y-4 text-sm"><div className="flex justify-between gap-3"><dt className="text-muted-foreground">已知 Tokens</dt><dd className="tabular-nums">{number(data?.tokens)}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted-foreground">用量完整性</dt><dd className="text-right">{data ? `${number(data.tokenKnown)} 条已知 / ${number(data.tokenMissing)} 条未返回` : '—'}</dd></div><div className="flex justify-between gap-3"><dt className="text-muted-foreground">失败记录</dt><dd className="tabular-nums">{number(data?.failed)}</dd></div></dl></CardContent></Card>
        <Card className="shadow-none"><CardHeader><CardTitle className="text-base">统计口径</CardTitle></CardHeader><CardContent className="space-y-3 text-xs leading-relaxed text-muted-foreground">
          <p>基于本地全部保留日志汇总，不受日志页分页影响。最多保留最近 2000 条 / 10 MiB，因此这里不是历史累计账单。</p>
          <p>转录字数按 Unicode 字符计数，排除空白、保留标点；一场会话可以产生多条转录、回复和工具记录。</p>
          <p>语音时长为已知的生成音频长度，不代表实际播放或收听时长。未提供时长的合成记录标为未知；历史模型回复无法确定是否含音频，不计入时长覆盖数。</p>
          <p>Tokens 汇总模型回复、合成与未关联历史用量的已知总量；已关联用量并入对应回复，不重复累加明细。失败记录包含错误日志，同一次操作可能产生多条记录。</p>
          <p>延迟按最近秩分位（非插值）统计，只覆盖带时间戳的新记录：首字/首帧以发起回复为锚，合成耗时是请求的墙钟时间、不是音频时长。打断只计用户开口抢话，手动取消不计入；TTS 模式下没有原生首帧。</p>
          {data?.firstAt != null && <p className="border-t pt-3">当前范围记录时间：<br/>{formatAuditTime(data.firstAt)} 至 {formatAuditTime(data.lastAt)}</p>}
        </CardContent></Card>
      </div>
    </div>
  </div>
}
