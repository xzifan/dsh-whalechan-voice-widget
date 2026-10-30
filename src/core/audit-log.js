import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { orderConversationRows } from './conversation-order.js'
import { createAuditArchive } from './audit-archive.js'

const KINDS = new Set(['transcription', 'response', 'synthesis', 'usage', 'tool', 'error'])
const OUTCOMES = new Set(['ok', 'error', 'cancelled'])
const sensitive = /(?:api.?key|authorization|headers?|cookies?|pass.?word|secret|credential|access.?token|refresh.?token|audio|base64|url|endpoint|__proto__|constructor|prototype)/i
// Latency samples are wall-clock durations in milliseconds; a record without a
// timing contributes no sample at all (an unknown latency is not a zero one).
const LATENCIES = ['firstTextMs', 'firstAudioMs', 'playedMs', 'durationMs']

/** Nearest-rank percentile (no interpolation): p95 of 4 samples is the largest. */
export function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))]
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Keep only provider-reported numeric usage, including nested token breakdowns. */
export function numericUsage(value, depth = 0, budget = { left: 500 }) {
  if (!object(value) || depth > 5 || --budget.left < 0) return null
  const result = {}
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    if (--budget.left < 0) break
    if (/(?:api.?key|authorization|headers?|cookies?|pass.?word|secret|credential|access.?token|refresh.?token|base64|url|endpoint|audio_data|__proto__|constructor|prototype)/i.test(key)) continue
    if (!/^[\w.-]{1,80}$/.test(key)) continue
    if (typeof item === 'number' && Number.isFinite(item) && item >= 0) result[key] = item
    else { const child = numericUsage(item, depth + 1, budget); if (child) result[key] = child }
  }
  return Object.keys(result).length ? result : null
}

export function sanitizeAuditValue(value, secrets = [], depth = 0, budget = { left: 500 }) {
  if (depth > 5 || --budget.left < 0) return undefined
  if (typeof value === 'string') {
    let text = value
    for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]')
    return text.replace(/data:[^\s"']+/gi, '[redacted]')
      .replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, '[redacted-url]')
      .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
      .replace(/\b(?:sk-|sk_)[A-Za-z0-9_-]+/g, '[redacted]')
      .replace(/\b(?:[\w-]*(?:api[_-]?key|pass.?word|secret|token)|authorization|cookie|set-cookie)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[redacted]')
      .replace(/[A-Za-z0-9+/=_-]{128,}/g, '[redacted-data]').slice(0, 16000)
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (value === null || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.slice(0, 40).map(item => sanitizeAuditValue(item, secrets, depth + 1, budget)).filter(item => item !== undefined)
  if (!object(value)) return undefined
  return Object.fromEntries(Object.entries(value).slice(0, 80).filter(([key]) => !sensitive.test(key)).map(([key, item]) => [key.slice(0, 80), sanitizeAuditValue(item, secrets, depth + 1, budget)]).filter(([, item]) => item !== undefined))
}

export function sanitizeAuditRecord(input = {}, secrets = []) {
  if (!KINDS.has(input.kind)) return null
  const record = { id: randomUUID(), at: Date.now() }
  for (const key of ['id', 'sessionId', 'messageId', 'turnId', 'responseId', 'callId', 'role', 'provider', 'model', 'status', 'requestId']) {
    if (typeof input[key] === 'string') record[key] = sanitizeAuditValue(input[key], secrets).slice(0, 200)
  }
  if (Number.isFinite(input.at) && input.at >= 0) record.at = input.at
  record.kind = input.kind
  if (typeof input.text === 'string') record.text = sanitizeAuditValue(input.text, secrets)
  if (['zh', 'ja', 'en'].includes(input.language)) record.language = input.language
  if (input.voice !== undefined) {
    const voice = sanitizeAuditValue(input.voice, secrets)
    record.voice = voice !== undefined && Buffer.byteLength(JSON.stringify(voice)) <= 4096 ? voice : '[content truncated]'
  }
  record.provider ??= 'unknown'
  record.model ??= 'unknown'
  record.status ??= 'unreported'
  if (input.kind === 'tool') {
    // `status` only describes the call lifecycle, so the outcome must be stated
    // explicitly. Legacy rows without a writer-supplied outcome get one only
    // when the status itself proves failure — a bare `completed` stays unknown.
    const outcome = OUTCOMES.has(input.outcome) ? input.outcome
      : ['failed', 'error'].includes(record.status) ? 'error'
        : ['cancelled', 'canceled'].includes(record.status) ? 'cancelled' : undefined
    if (outcome) record.outcome = outcome
    const summary = typeof input.resultSummary === 'string' ? sanitizeAuditValue(input.resultSummary, secrets) : undefined
    const line = typeof summary === 'string' ? summary.replace(/\s+/g, ' ').trim() : ''
    if (line) record.resultSummary = Array.from(line).slice(0, 200).join('')
    if (Number.isInteger(input.exitCode) && Math.abs(input.exitCode) <= 255) record.exitCode = input.exitCode
  }
  record.usage = numericUsage(input.usage)
  record.usageAvailable = record.usage !== null
  if (typeof input.audioOutput === 'boolean') record.audioOutput = input.audioOutput
  if (typeof input.audioDurationSeconds === 'number' && Number.isFinite(input.audioDurationSeconds) && input.audioDurationSeconds >= 0) record.audioDurationSeconds = input.audioDurationSeconds
  // Timings are flat scalars on purpose: `audio`/`url` keys are stripped from
  // nested objects, so a `metrics: {}` sub-object would be silently dropped.
  for (const key of LATENCIES) if (Number.isFinite(input[key]) && input[key] >= 0) record[key] = Math.round(input[key])
  if (input.interrupted === true) record.interrupted = true
  return record
}

// Normalize legacy usage rows and late response updates before filtering/paging.
// Match legacy usage only by exact response identity, never by message/turn alone:
// a tool round-trip may generate several responses for the same assistant message.
function responseRecords(records) {
  const result = [], byId = new Map(), byResponse = new Map(), omitted = new Set()
  const identity = record => record.sessionId && record.responseId
    ? JSON.stringify([record.sessionId, record.responseId, record.provider, record.model]) : null
  for (const record of records) {
    if (record.kind !== 'response') { result.push(record); continue }
    const id = JSON.stringify([record.sessionId, record.id])
    const previous = byId.get(id)
    if (previous) {
      // The first event owns cursor/time/text/status; a late final event fills usage.
      if (record.usage) { previous.usage = record.usage; previous.usageAvailable = true }
      continue
    }
    const copy = {...record}
    byId.set(id, copy); result.push(copy)
    const key = identity(copy)
    if (key) byResponse.set(key, byResponse.has(key) ? null : copy)
  }
  for (const record of result) {
    if (record.kind !== 'usage') continue
    const response = byResponse.get(identity(record))
    if (!response) continue // Orphan/ambiguous usage remains visible and countable.
    if (!response.usage && record.usage) { response.usage = record.usage; response.usageAvailable = true }
    omitted.add(record)
  }
  return result.filter(record => !omitted.has(record))
}

/** Ordered, failure-isolated JSONL storage. `before` is an exclusive numeric seq cursor.
 * Queries sort newest first; total counts every retained record matching the filters,
 * before applying the cursor. `search` matches content fields only (text, identifiers,
 * role, provider, model, status, voice and usage) — never JSON keys or the kind name.
 * `columnFilters` intersects field-specific substring matches (case insensitive),
 * except status which matches exactly; empty column filters are inactive.
 * `since`/`until` bound `at` in epoch milliseconds (both inclusive); `failed` keeps
 * failure records — error kind, failed status, or a completed call whose outcome is
 * `error` (a manual cancel is not a failure). Retention defaults to 2000 records / 10 MiB; rows evicted by that cap
 * are appended to a per-ISO-week archive when `archiveDir` is given.
 */
export function createAuditLog({ path, maxRecords = 2000, maxBytes = 10 * 1024 * 1024, archiveDir = null, archiveWeeks = 8 } = {}) {
  if (!path) throw new TypeError('Audit path is required')
  maxRecords = Math.max(1, Math.floor(maxRecords))
  maxBytes = Math.max(1024, Math.floor(maxBytes))
  const secrets = new Set()
  const haystacks = new WeakMap()
  const failedStatuses = new Set(['failed', 'error'])
  // 「失败」只有一种口径，查询筛选与统计共用：错误记录、失败状态，或调用完成但结果报错
  // （`completed` + `outcome:'error'` 即命令真失败）。`cancelled` 不算失败（手动取消），
  // 单独的 `completed` 也不推导成功——两条路径分叉时，勾「只看失败」的用户会看不到红点行。
  const failedRecord = record => record.kind === 'error' || failedStatuses.has(record.status) || record.outcome === 'error'
  const searchableText = record => [
    record.text, record.id, record.sessionId, record.messageId, record.turnId, record.responseId, record.callId, record.role, record.provider, record.model, record.status, record.requestId,
    record.outcome, record.resultSummary, record.exitCode === undefined ? '' : String(record.exitCode),
    record.voice === undefined ? '' : JSON.stringify(record.voice),
    record.usage == null ? '' : JSON.stringify(record.usage),
  ].filter(value => typeof value === 'string' && value).join('\n').toLowerCase()
  const records = []
  // Only a *live* eviction is archived. At load time an evicted row may already sit in a
  // week file written by the run that compacted it, and nothing on disk tells the two
  // cases apart — so load-time bounding keeps the old behaviour (drop, no archive).
  const archive = archiveDir ? createAuditArchive({ dir: archiveDir, keepWeeks: archiveWeeks }) : null
  const pendingArchive = []
  let bytes = 0, sequence = 0, storageError, normalized
  const visibleRecords = () => normalized ??= responseRecords(records)
  const lineSize = record => Buffer.byteLength(JSON.stringify(record)) + 1
  function bound(collect = false) {
    while (records.length > maxRecords || bytes > maxBytes) {
      const record = records.shift()
      bytes -= lineSize(record)
      if (collect && archive) pendingArchive.push(record)
    }
  }
  function failed() { storageError = 'Audit storage is unavailable; records may only be retained in memory.' }
  async function compact() {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = path + '.tmp'
    await writeFile(temporary, records.map(record => JSON.stringify(record) + '\n').join(''), { mode: 0o600 })
    await rename(temporary, path)
  }
  const loaded = (async () => {
    let pending = '', skipping = false, dirty = false
    function accept(line) {
      try {
        const input = JSON.parse(line), record = sanitizeAuditRecord(input, secrets)
        if (!record) { dirty = true; return }
        const seq = Number.isSafeInteger(input.seq) && input.seq > sequence ? input.seq : sequence + 1
        sequence = seq; record.seq = seq
        if (JSON.stringify(input) !== JSON.stringify(record)) dirty = true
        records.push(record); bytes += lineSize(record)
        if (records.length > maxRecords || bytes > maxBytes) dirty = true
        bound()
      } catch { dirty = true }
    }
    try {
      for await (const chunk of createReadStream(path, { encoding: 'utf8' })) {
        const parts = (pending + chunk).split('\n'); pending = parts.pop()
        for (const line of parts) { if (!skipping && Buffer.byteLength(line) <= 128 * 1024) accept(line); else dirty = true; skipping = false }
        if (pending.length > 128 * 1024) { pending = ''; skipping = true; dirty = true }
      }
      // An unterminated tail may be a torn append: discard it before the next write.
      if (pending || skipping) dirty = true
      if (dirty) await compact()
    } catch (error) { if (error.code !== 'ENOENT') failed() }
  })()
  let queue = loaded
  function append(input) {
    const record = sanitizeAuditRecord(input, secrets)
    if (!record) return Promise.resolve(null)
    const operation = queue.then(async () => {
      normalized = undefined
      record.seq = ++sequence
      records.push(record); bytes += lineSize(record)
      const overflow = records.length > maxRecords || bytes > maxBytes
      bound(true)
      const evicted = pendingArchive.splice(0)
      // Archive first, compact second: a crash in between leaves those rows in the main
      // file (dropped on load, never re-archived) instead of losing them outright.
      // A failing archive must NOT set storageError — the live log is still writable, and
      // that flag forces a full-file rewrite on every later append.
      if (evicted.length) {
        try { if (!(await archive.write(evicted))) pendingArchive.length = 0 } catch { pendingArchive.push(...evicted) }
      }
      try {
        if (overflow || storageError) await compact()
        else { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await appendFile(path, JSON.stringify(record) + '\n', { mode: 0o600 }) }
        storageError = undefined
      } catch { failed() }
      return structuredClone(record)
    })
    queue = operation.then(() => undefined, () => { failed() })
    return operation.catch(() => null)
  }
  async function query({ limit = 100, before, search = '', kind, sessionId, since, until, failed, columnFilters = {} } = {}) {
    await queue
    const count = Number.isSafeInteger(limit) ? Math.max(1, Math.min(200, limit)) : 100
    const needle = String(search).slice(0, 500).toLowerCase()
    const columns = Object.entries(columnFilters).filter(([, value]) => value !== '')
      .map(([key, value]) => [key, key === 'status' ? value : value.toLowerCase()])
    const page = []
    let total = 0, eligible = 0
    const visible = visibleRecords()
    for (let index = visible.length - 1; index >= 0; index--) {
      const record = visible[index]
      if ((kind && record.kind !== kind) || (sessionId && record.sessionId !== sessionId)) continue
      if ((since !== undefined && record.at < since) || (until !== undefined && record.at > until)) continue
      if (columns.some(([key, value]) => key === 'status'
        ? record[key] !== value
        : typeof record[key] !== 'string' || !record[key].toLowerCase().includes(value))) continue
      if (failed && !failedRecord(record)) continue
      if (needle) {
        let haystack = haystacks.get(record)
        if (haystack === undefined) { haystack = searchableText(record); haystacks.set(record, haystack) }
        if (!haystack.includes(needle)) continue
      }
      total++
      if (before !== undefined && record.seq >= before) continue
      eligible++
      if (page.length < count) page.push({ ...sanitizeAuditRecord(record, secrets), seq: record.seq })
    }
    return { records: page, total, hasMore: eligible > page.length, nextBefore: page.length ? page.at(-1).seq : null, ...(storageError ? { storageError } : {}) }
  }
  // Statistics cover the retained log, independently of audit pagination/search.
  // Legacy responses without audio metadata are excluded: text-only and audio
  // responses cannot be distinguished. Legacy synthesis remains audio-eligible.
  async function statistics({ since, until } = {}) {
    await queue
    const result = { total: 0, sessions: 0, transcriptionCharacters: 0, outputAudioSeconds: null, audioKnown: 0, audioMissing: 0,
      counts: Object.fromEntries([...KINDS].map(kind => [kind, 0])), failed: 0, tokens: null, tokenKnown: 0, tokenMissing: 0, firstAt: null, lastAt: null }
    const sessions = new Set()
    const buckets = { firstText: [], firstAudio: [], synthesis: [] }
    let interrupts = 0
    for (const record of visibleRecords()) {
      if ((since !== undefined && record.at < since) || (until !== undefined && record.at > until)) continue
      result.total++; result.counts[record.kind]++
      if (record.kind === 'response') {
        if (Number.isFinite(record.firstTextMs)) buckets.firstText.push(record.firstTextMs)
        if (Number.isFinite(record.firstAudioMs)) buckets.firstAudio.push(record.firstAudioMs)
        if (record.interrupted === true) interrupts++
      }
      if (record.kind === 'synthesis' && Number.isFinite(record.durationMs)) buckets.synthesis.push(record.durationMs)
      if (record.sessionId) sessions.add(record.sessionId)
      result.firstAt = result.firstAt === null ? record.at : Math.min(result.firstAt, record.at)
      result.lastAt = result.lastAt === null ? record.at : Math.max(result.lastAt, record.at)
      if (failedRecord(record)) result.failed++
      if (record.kind === 'transcription') result.transcriptionCharacters += Array.from((record.text || '').replace(/\s/gu, '')).length
      const duration = record.audioDurationSeconds
      if (record.kind === 'synthesis' || (record.kind === 'response' && record.audioOutput !== false && (record.audioOutput === true || duration !== undefined))) {
        if (duration !== undefined) { result.audioKnown++; result.outputAudioSeconds = (result.outputAudioSeconds ?? 0) + duration }
        else result.audioMissing++
      }
      if (record.kind === 'usage' || record.kind === 'response' || record.kind === 'synthesis') {
        const usage = record.usage || {}
        const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
        const input = numeric(usage.input_tokens) ?? numeric(usage.prompt_tokens)
        const output = numeric(usage.output_tokens) ?? numeric(usage.completion_tokens)
        const tokens = numeric(usage.total_tokens) ?? (input !== undefined && output !== undefined ? input + output : undefined)
        if (tokens !== undefined) { result.tokenKnown++; result.tokens = (result.tokens ?? 0) + tokens }
        else result.tokenMissing++
      }
    }
    result.sessions = sessions.size
    result.latency = Object.fromEntries(Object.entries(buckets).map(([key, values]) => [key, { samples: values.length, p50: percentile(values, 50), p95: percentile(values, 95) }]))
    // A manual cancel is not an interruption: only speech-started cuts the rate.
    result.interrupts = { count: interrupts, rate: result.counts.response ? Math.round(interrupts / result.counts.response * 10000) / 10000 : null }
    return { ...result, ...(storageError ? { storageError } : {}) }
  }
  // History shares audit/statistics normalization. Legacy rows without a session
  // identity stay in audit, never pooled into an invented session.
  function historyGroups() {
    const groups = new Map()
    for (const record of visibleRecords()) {
      if (!record.sessionId) continue
      if (!groups.has(record.sessionId)) groups.set(record.sessionId, [])
      groups.get(record.sessionId).push(record)
    }
    for (const rows of groups.values()) rows.sort((a, b) => a.at - b.at || a.seq - b.seq)
    return groups
  }
  const clean = value => sanitizeAuditValue(value, secrets)
  const clip = (value, length) => Array.from(value).slice(0, length).join('')
  function historyView(sessionId, rows) {
    const responses = rows.filter(row => row.kind === 'response' && row.text?.trim())
    const messages = []
    for (const row of orderConversationRows(rows)) {
      if (row.kind === 'usage') continue
      if (!['tool', 'error'].includes(row.kind) && !row.text?.trim()) continue
      // Only shared identity proves TTS duplicates a response; text alone must
      // never remove repeated speech, including legacy rows lacking identities.
      if (row.kind === 'synthesis' && responses.some(response => response.text === row.text &&
        ((row.messageId && row.messageId === response.messageId) || (row.responseId && row.responseId === response.responseId)))) continue
      const kind = row.kind === 'transcription' ? 'user' : ['response', 'synthesis'].includes(row.kind) ? 'assistant' : row.kind
      const message = { id: clean(row.id), kind, role: kind === 'error' ? clean(row.role || 'system') : kind,
        text: clean(row.text || ''), at: row.at, status: clean(row.status) }
      // `outcome`/`exitCode` travel with the row so the session view can tell a
      // completed call apart from a command that actually failed.
      for (const key of ['messageId', 'responseId', 'callId', 'model', 'provider', 'audioDurationSeconds', 'outcome', 'exitCode']) {
        if (row[key] !== undefined) message[key] = clean(row[key])
      }
      messages.push(message)
    }
    const dialogue = messages.filter(message => ['user', 'assistant'].includes(message.kind) && message.text.trim())
    const title = dialogue.find(message => message.kind === 'user')?.text || dialogue.find(message => message.kind === 'assistant')?.text || '语音会话'
    return { session: { sessionId: clean(sessionId), title: clip(title.trim(), 80), preview: clip(dialogue.at(-1)?.text.trim() || '', 120),
      firstAt: rows[0].at, lastAt: rows.at(-1).at, messageCount: messages.length, recordCount: rows.length }, messages }
  }
  async function historySessions({ search = '' } = {}) {
    await queue
    const needle = search.toLowerCase(), sessions = []
    for (const [sessionId, rows] of historyGroups()) {
      // Search full sessions, including tool/error and suppressed TTS text.
      // Re-sanitize so credentials registered after append cannot leak.
      if (needle && ![clean(sessionId), ...rows.map(row => clean(row.text || ''))].some(text => text.toLowerCase().includes(needle))) continue
      sessions.push(historyView(sessionId, rows).session)
    }
    sessions.sort((a, b) => b.lastAt - a.lastAt)
    return { sessions, total: sessions.length, ...(storageError ? { storageError: clean(storageError) } : {}) }
  }
  async function historyMessages({ sessionId }) {
    await queue
    const rows = historyGroups().get(sessionId)
    return { ...(rows ? historyView(sessionId, rows) : { session: null, messages: [] }), ...(storageError ? { storageError: clean(storageError) } : {}) }
  }
  return { append, query, statistics, historySessions, historyMessages, flush: () => queue, addSecret(value) { if (typeof value === 'string' && value) secrets.add(value) } }
}
