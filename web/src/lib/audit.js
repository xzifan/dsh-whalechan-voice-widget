const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const firstNumeric = (...values) => values.map(numeric).find(value => value !== null) ?? null

// Token detail fields (cached/audio/text) overlap the input/output totals.
// Keep them in the original JSON, never add them into the displayed total.
export function auditUsage(record = {}) {
  const usage = record.usage
  if (!usage || typeof usage !== 'object' || Array.isArray(usage) || record.usageAvailable === false) {
    return {input: null, output: null, total: null}
  }
  const input = firstNumeric(usage.input_tokens, usage.prompt_tokens)
  const output = firstNumeric(usage.output_tokens, usage.completion_tokens)
  const total = firstNumeric(usage.total_tokens) ?? (input !== null && output !== null ? input + output : null)
  return {input, output, total}
}

export function formatAuditNumber(value) {
  return numeric(value) === null ? '未返回' : value.toLocaleString('zh-CN')
}

export function summarizeAuditUsage(records = []) {
  let total = 0, known = 0, missing = 0
  for (const record of records) {
    if (record.kind !== 'usage' && record.kind !== 'response' && record.kind !== 'synthesis') continue
    const tokens = auditUsage(record).total
    if (tokens === null) missing++
    else { total += tokens; known++ }
  }
  return {total: known ? total : null, known, missing}
}

// 工具调用状态只说明「调用结束」，`outcome` 才是结果成败（成功 / 报错 / 取消）。
const outcomeLabels = {ok: '工具成功', error: '工具报错', cancelled: '工具取消'}

export function auditOutcomeLabel(record = {}) {
  if (record.kind !== 'tool') return ''
  return outcomeLabels[record.outcome] || ''
}

export function auditResultSummary(record = {}) {
  if (record.kind !== 'tool') return ''
  return typeof record.resultSummary === 'string' ? record.resultSummary.trim() : ''
}

// 会话记录徽章：`status` 只说明调用生命周期，`outcome` 才是结果成败。
// 与审计页红点、失败筛选同一口径——失败可叠加，成功不可覆盖。
const historyStatusLabels = {completed:'已完成',complete:'已完成',success:'成功',done:'已完成',failed:'失败',error:'错误',cancelled:'已取消',canceled:'已取消',interrupted:'已打断',running:'进行中',streaming:'生成中',unreported:'状态未返回'}

export function historyStatusBadge(message = {}) {
  if (['failed', 'error'].includes(message.status)) return {variant:'destructive', label:historyStatusLabels[message.status]}
  if (message.kind === 'tool' && message.outcome === 'error') return {variant:'destructive', label:'工具报错'}
  return {variant:'outline', label:historyStatusLabels[message.status] || message.status || '状态未返回'}
}

export function auditTimestamp(value) {
  if (value === null || value === undefined || value === '') return null
  // Providers use both Unix seconds and JavaScript milliseconds.
  const milliseconds = typeof value === 'number' ? (Math.abs(value) < 1e11 ? value * 1000 : value) : value
  const date = new Date(milliseconds)
  return Number.isFinite(date.getTime()) ? date : null
}

export function formatAuditTime(value) {
  return auditTimestamp(value)?.toLocaleString('zh-CN', {hour12: false}) ?? '时间未返回'
}

export function mergeAuditRecords(previous, incoming) {
  const seen = new Set(previous.map(record => record.id))
  return [...previous, ...incoming.filter(record => {
    if (seen.has(record.id)) return false
    seen.add(record.id)
    return true
  })]
}

// 时间范围键 → 查询起点（毫秒，含起点）。未知或 all 返回 null 表示不限时间。
export function auditRangeStart(range, now = Date.now()) {
  const spans = {hour: 3600_000, day: 24 * 3600_000, week: 7 * 24 * 3600_000}
  return spans[range] === undefined ? null : Math.max(0, now - spans[range])
}
