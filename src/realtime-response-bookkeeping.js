// 响应簿记：会话 history、上下文标识、审计记录与文本收尾。纯记账——不碰 socket、不发网络请求、不改 settings。
import { randomUUID } from 'node:crypto'
import { numericUsage } from './audit-log.js'
import { MODEL, redactText } from './realtime-protocol.js'
import { spokenText } from './voice-candidate.js'

/**
 * 三个不可替换的契约（换成「更干净」的写法会静默改行为，见 test/realtime-response-bookkeeping.test.js）：
 * - `history` 返回的是**同一个数组实例**。fillers 的 `context()` 每次 spread 它，拿到副本就永远是空历史。
 * - `currentTurn` 必须传**函数引用**：`context()` 的默认参数在调用时求值，值快照会把整个 turn 塌成一个。
 * - `getSettings` 是 live getter：settings 对象会被原地改（如 `tts_provider`），也可能被整体重赋值。
 */
export function createResponseBookkeeping({ emit, isDisposed, isLive, currentTurn, getSettings, key }) {
  const model = () => getSettings().model || MODEL
  const history = []
  const redactError = value => redactText(key ? String(value ?? '').split(key).join('[已隐藏]') : value)
  function remember(role, text) {
    if (!text?.trim()) return
    if (history.at(-1)?.role === role && history.at(-1)?.text === text) return
    history.push({ role, text: redactError(text).slice(0, 700) })
    if (history.length > 12) history.shift()
  }
  function context(owner = currentTurn(), role = 'assistant', responseId, itemId, callId) {
    return { messageId: `${owner.id}:${role}`, turnId: owner.id, ...(responseId ? { responseId } : {}), ...(itemId ? { itemId } : {}), ...(callId ? { callId } : {}) }
  }
  function transcriptContext(ctx) { return { ...ctx, provider: 'bailian', model: model() } }
  function audit(kind, ctx, status, extra = {}) {
    if (!isDisposed()) emit({ type: 'audit', record: { id: randomUUID(), kind, ...ctx, provider: 'bailian', model: model(), status, ...extra } })
  }
  function assistantContext(response, event = {}) { return context(response.turn, 'assistant', response.id, event.item_id || event.item?.id || response.itemId) }
  function finalizeResponseAudit(response, status, text = response.speechText || response.text, ctx = response.speechContext || assistantContext(response)) {
    if (response.auditFinalized) return
    response.auditFinalized = true
    const bytes = response.audioBytes || 0
    response.auditRecord = { id: randomUUID(), at: Date.now(), kind: 'response', ...ctx, provider: 'bailian', model: model(), status,
      ...(text ? { text } : {}), audioOutput: bytes > 0, ...(bytes > 0 ? { audioDurationSeconds: bytes / (24000 * 2) } : {}),
      ...(response.usage ? { usage: response.usage } : {}) }
    if (!isDisposed()) emit({ type: 'audit', record: response.auditRecord })
  }
  function captureResponseUsage(response, value) {
    const usage = numericUsage(value)
    if (!usage || JSON.stringify(usage) === JSON.stringify(response.usage)) return
    response.usage = usage
    if (!response.auditRecord) return
    // Cancellation or fast TTS can finalize before provider usage arrives. The
    // append-only log receives an immutable same-ID snapshot; its projection
    // folds this into the original response without changing status or timing.
    response.auditRecord = { ...response.auditRecord, usage }
    if (!isDisposed()) emit({ type: 'audit', record: response.auditRecord })
  }
  function finalizeText(response, text, event = {}) {
    if (!isLive(response) || response.finalized || !text) return
    response.finalized = true
    text = spokenText(text)
    response.text = text
    remember('assistant', text)
    const ctx = assistantContext(response, event)
    if (!response.tts) emit({ type: 'transcript-done', ...transcriptContext(ctx), text })
    // Text may finish before audio. Audit only at response.done/cancellation.
    response.speechContext = ctx
  }
  function itemText(item) {
    const content = item?.content || []
    const text = content.map(part => part.text || '').join('')
    return text || content.map(part => part.transcript || '').join('')
  }
  return { history, remember, context, transcriptContext, redactError, audit, assistantContext, finalizeResponseAudit, captureResponseUsage, finalizeText, itemText }
}