import { resolveBreezeLanguage } from './breeze-voices.js'
import { createFillerCoordinator } from './filler-coordinator.js'
import { spokenText } from './voice-candidate.js'
import { appendRequiredRules } from './persona.js'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { toolOutcome } from './tool-outcome.js'
import { audioDurationSeconds } from './audio-duration.js'
import { createResponseBookkeeping } from './realtime-response-bookkeeping.js'

const require = createRequire(import.meta.url)
let WebSocket
try { WebSocket = require('ws') } catch {
  try { WebSocket = createRequire('/Applications/DSH Desktop.app/Contents/Resources/app/package.json')('ws') } catch {}
}

import {
  MODEL, DEFAULT_HOST, SYSTEM_VOICE, DEFAULT_TOOLS, MAX_AUDIO_BYTES, safeCode,
  toolDefinitions, realtimeInstructions,
} from './realtime-protocol.js'

// 握手完成（上游 `session.created`）之前，任何出站消息都可能被吞：socket 还没 OPEN 时 `send()` 什么都不做，
// 而 OPEN 但 `session.update` 还没送达时上游会按默认音色处理音频。所以未 ready 期间的消息先入队。
// 只有音频帧按累计 base64 长度封顶（约 2 s：24 kHz PCM16 的 20 ms 帧 ≈ 1.3 KB base64 / 64 帧）；commit 与
// response.create 体积极小，丢它们等于让「整句不上行」变成静默失败，所以不参与淘汰。
const AUDIO_BACKLOG_LIMIT = 86 * 1024
// 会真正改动账号级资源（百炼配额/已保存音色）的三个音色工具：被 response 结束打断时，
// 除了工具行还要留一条 kind:error 伴生行，否则失败原因彻底丢失。
const VOICE_SIDE_EFFECT_TOOLS = new Set(['design_voice', 'delete_voice', 'apply_voice'])

/**
 * Manage one Qwen Audio Realtime WebSocket session.
 * `emit(event)` pushes sanitized events to the frontend buffer; `executeTool` runs DSH tools.
 * `WebSocketCtor` is injectable for tests.
 */
export function createRealtimeSession({ settings, key, executeTool, emit, nativeTools = [], voiceState, generateFiller, synthesizeFiller, fillerOptions, confirmationTimeoutMs = 1500, WebSocketCtor = WebSocket }) {
  let socket, disposed = false, generation = 0, blocked = false
  // 握手期出站队列：session.created 之前的 append/commit/response.create 暂存于此，见 outbound()/flushPending()。
  const pending = []
  let pendingAudio = 0, ready = false, backlogNotified = false
  let audioTotal = 0
  let controller = new AbortController(), voiceQueue = Promise.resolve()
  const ttsActive = () => useTts || !!voiceState?.get()
  const useTts = !!settings.use_tts_voice
  const tools = toolDefinitions(settings.tools, nativeTools)
  const allowedTools = new Set(tools.map(tool => tool.function.name))
  const responses = new Map(), items = new Map(), calls = new Map(), userFinals = new Set()
  let turn = null, activeResponse = null
  const requestedOutputModes = []
  // Same queue discipline as requestedOutputModes: the timestamp belongs to the
  // response it produced, not to whatever arrives later.
  const requestedAtQueue = []
  let turnStartedAt = 0, firstAudioAt = 0, audioBytes = 0
  let mainPlaying = false, userSpeaking = false
  const {
    history, remember, context, transcriptContext, redactError, audit,
    assistantContext, finalizeResponseAudit, captureResponseUsage, finalizeText, itemText,
  } = createResponseBookkeeping({
    emit, key,
    isDisposed: () => disposed,
    isLive: live,
    currentTurn,
    getSettings: () => settings,
  })
  const fillers = createFillerCoordinator({
    ...fillerOptions, generate: generateFiller, synthesize: synthesizeFiller, emit,
    context: () => ({ history: [...history], persona: settings.instructions || realtimeInstructions(useTts), language: settings.language || 'zh' }),
  })

  const host = settings.api_host && !settings.api_host.includes('dashscope.aliyuncs.com')
    ? `wss://${settings.api_host}/api-ws/v1/realtime`
    : DEFAULT_HOST
  const url = `${host}?model=${encodeURIComponent(settings.model || MODEL)}`

  function send(value) { if (!disposed && socket?.readyState === 1) socket.send(JSON.stringify(value)) }
  // `send()` 保持不变（真发才发）。三个业务入口走 outbound()：ready 之前入队，避免开局几十到几百毫秒的帧被静默丢掉。
  function queueOutbound(value, audioChars = 0) {
    pending.push({ value, audioChars })
    pendingAudio += audioChars
    while (pendingAudio > AUDIO_BACKLOG_LIMIT) {
      const oldest = pending.findIndex(item => item.audioChars)
      if (oldest < 0) break
      pendingAudio -= pending[oldest].audioChars
      pending.splice(oldest, 1)
      // 丢帧不静默：一次积压只报一次，避免每帧刷一条 error。
      if (!backlogNotified) {
        backlogNotified = true
        emit({ type: 'error', code: 'audio_backlog_dropped', message: '通话建立前的录音积压过多，开头一小段已丢弃' })
      }
    }
  }
  function outbound(value, audioChars = 0) {
    if (disposed) return
    if (ready && socket?.readyState === 1) send(value)
    else queueOutbound(value, audioChars)
  }
  // 只在 session.created（即 session.update 已发出）之后放行，不能在 socket.on('open') 就 flush。
  function flushPending() {
    ready = true
    while (!disposed && pending.length && socket?.readyState === 1) send(pending.shift().value)
    if (disposed || socket?.readyState !== 1) clearPending()
    else pendingAudio = 0
  }
  function clearPending() { pending.length = 0; pendingAudio = 0 }
  function voiceId() { return (settings.voice || '').trim() || SYSTEM_VOICE }
  function modalities() { return ttsActive() ? ['text'] : ['text', 'audio'] }
  function currentTurn() { if (!turn) { turn = { id: `turn-${randomUUID()}`, generation }; fillers.newTurn(turn.id) }; return turn }
  function live(response) { return !disposed && !blocked && !response.cancelled && response.turn.generation === generation }
  function responseFor(event) {
    const id = event.response_id || event.response?.id
    const itemId = event.item_id || event.item?.id
    let response = (id && responses.get(id)) || (itemId && items.get(itemId)?.response)
    if (!response && !id) response = activeResponse
    if (!response) {
      response = { tts: requestedOutputModes.shift() ?? ttsActive(), requestedAt: requestedAtQueue.shift() ?? Date.now(), firstTextAt: 0, firstAudioAt: 0, id: id || null, turn: currentTurn(), pending: new Set(), done: false, continued: false, terminal: false, cancelled: blocked, text: '', finalized: false }
      if (id) responses.set(id, response)
      activeResponse = response
    }
    if (itemId) {
      response.itemId = itemId
      items.set(itemId, { turn: response.turn, response })
    }
    return response
  }
  function finishTool(call, status, detail, outcome = status === 'completed' ? 'ok' : status === 'failed' ? 'error' : 'cancelled', exitCode) {
    if (call.finished) return
    call.finished = true
    // `ok`/`status` stay the call lifecycle; `outcome`/`exitCode` carry the
    // result itself, so a call that completed but ran a failing command (e.g.
    // `exit_code:2`) cannot be rendered as plain "已完成".
    emit({ type: 'tool-end', ...call.context, name: call.name, ok: status === 'completed', status,
      outcome, ...(Number.isInteger(exitCode) ? { exitCode } : {}) })
    audit('tool', call.context, status, { outcome, ...(detail ? { resultSummary: detail } : {}),
      ...(Number.isInteger(exitCode) ? { exitCode } : {}), text: redactError(`${call.name}${detail && status !== 'completed' ? ': ' + detail : ''}`) })
  }
  function invalidate(clearCandidate = false, interrupted = false) {
    fillers.cancel()
    controller.abort()
    controller = new AbortController()
    voiceQueue = Promise.resolve()
    requestedOutputModes.length = 0
    requestedAtQueue.length = 0
    // 会话结束/取消后不得再补发握手期的积压帧：上游已经不认这些音频了。
    if (clearCandidate) clearPending()
    if (clearCandidate) voiceState?.clear()
    generation++
    blocked = true
    for (const response of new Set([...responses.values(), activeResponse])) {
      if (!response) continue
      response.cancelled = true
      if (response.text || response.speechText || response.audioBytes) finalizeResponseAudit(response, 'cancelled', undefined, undefined, interrupted ? { interruptedAt: Date.now() } : undefined)
    }
    for (const call of calls.values()) if (!call.finished) finishTool(call, 'cancelled')
    audioTotal = 0; audioBytes = 0; firstAudioAt = 0; turnStartedAt = 0
  }
  function requestResponse() {
    fillers.schedule('thinking')
    requestedOutputModes.push(ttsActive())
    requestedAtQueue.push(Date.now())
    outbound({ type: 'response.create', response: { modalities: modalities() } })
  }
  function deliverDone(response) {
    if (!response.deliveryDone || response.deliveryFinished || !live(response)) return
    if (response.pending.size && (response.tts || [...response.pending].some(id => calls.get(id)?.name === 'synth_tts'))) return
    response.deliveryFinished = true
    if (!response.pending.size && (!response.hasTools || response.terminal)) fillers.cancel()
    emit(response.deliveryDone)
  }
  function continueResponse(response) {
    // Qwen closes the generating response separately from async tool execution.
    // Wait for BOTH boundaries so a fast first tool cannot start a second response.
    if (!live(response) || !response.done || response.pending.size || response.continued || response.terminal || !response.hasTools) return
    response.continued = true
    activeResponse = null
    fillers.cancel()
    fillers.schedule('transition')
    requestResponse()
  }

  function sessionUpdate() {
    const turnMode = settings.turn_mode === 'push-to-talk' ? null : settings.turn_mode === 'server_vad' ? 'server_vad' : 'smart_turn'
    const session = {
      modalities: modalities(), voice: voiceId(),
      input_audio_transcription: { language: settings.language || 'zh' },
      output_audio: { language: settings.language || 'zh' }, output_audio_format: 'pcm', enable_speech_emotion: true,
      turn_detection: turnMode === 'server_vad'
        ? { type: 'server_vad', threshold: 0.5, silence_duration_ms: 800 }
        : turnMode === 'smart_turn' ? { type: 'smart_turn' } : null,
    }
    if (session.turn_detection === null) delete session.turn_detection
    session.instructions = appendRequiredRules(settings.instructions?.trim() || realtimeInstructions(useTts))
    if (tools.length) session.tools = tools
    send({ type: 'session.update', session })
  }

  function waitForFinalTranscript(owner, signal) {
    signal.throwIfAborted()
    if (owner.finalTranscript) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const waiters = owner.finalWaiters ||= new Set()
      const finish = error => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        waiters.delete(ready)
        if (error) reject(error); else resolve()
      }
      const ready = () => finish()
      const abort = () => finish(new Error('音色确认等待已取消'))
      const timer = setTimeout(() => finish(new Error('尚未收到本轮完整的语音确认，请再明确说一次是否使用这个声音')), confirmationTimeoutMs)
      signal.addEventListener('abort', abort, { once: true })
      waiters.add(ready)
    })
  }

  function queueTool(call, args) {
    call.signal = controller.signal
    if (['design_voice', 'synth_tts', 'apply_voice', 'delete_voice', 'set_tts_provider', 'set_tts_profile'].includes(call.name)) {
      voiceQueue = voiceQueue.then(() => { if (live(call.response) && !call.finished) return runTool(call, args) }).catch(() => {})
    } else void runTool(call, args)
  }

  async function runTool(call, rawArgs) {
    const { name, response } = call
    let output, ok = true, speechText, errorText, evidence
    try {
      if (!allowedTools.has(name) && !(call.automatic && (response.tts || ttsActive()) && name === 'synth_tts')) throw new Error('该工具未在本次会话中启用或已不可用。')
      const args = typeof rawArgs === 'string' ? (rawArgs.trim() ? JSON.parse(rawArgs) : {}) : (rawArgs || {})
      if (name === 'apply_voice' && voiceState) {
        const candidate = voiceState.get()
        if (candidate && candidate.turnId !== response.turn.id) await waitForFinalTranscript(response.turn, call.signal)
        if (!voiceState.confirmed(args.voice_id, response.turn.id)) throw new Error('尚未收到本轮用户明确同意使用这个候选音色，音色未应用')
      }
      let result
      if (name === 'synth_tts' && typeof args.text === 'string') {
        args.text = spokenText(args.text)
        speechText = args.text
        response.speechText = speechText
        response.speechContext ||= call.context
        const syntheses = response.turn.syntheses ||= new Map()
        if (call.automatic && (!speechText.trim() || speechText.length > 2000)) throw new Error('自动语音合成需要 1 到 2000 字的最终回复，请缩短回复后重试。')
        const signature = JSON.stringify([speechText.trim(), settings.tts_provider === 'breeze' && useTts ? resolveBreezeLanguage(speechText, args.language) : args.language || settings.language || 'zh', settings.tts_provider || 'qwen', settings.tts_provider === 'breeze' && useTts ? 'preset' : voiceState?.get()?.designVoiceId || 'saved'])
        let synthesis = syntheses.get(signature)
        call.speechDuplicate = !!synthesis
        if (!synthesis) {
          synthesis = Promise.resolve().then(() => live(response) && !call.finished ? executeTool(name, args, { ...call.context, signal: call.signal }) : null)
          syntheses.set(signature, synthesis)
          const forget = () => { if (syntheses.get(signature) === synthesis) syntheses.delete(signature) }
          synthesis.then(result => { if (!result?.__previewData || result?.error || result?.ok === false || result?.isError) forget() }, forget)
        }
        result = await synthesis
      } else result = await executeTool(name, args, { ...call.context, signal: call.signal })
      if (!live(response) || call.finished) return
      if (name === 'synth_tts' && (!result || typeof result !== 'object')) throw new Error('语音合成未返回可播放音频，请重试。')
      if (result && typeof result === 'object') {
        ok = !result.error && result.ok !== false && !result.isError
        if (ok && name === 'design_voice') response.terminal = false
        const { __previewData, __previewMime, __applyVoiceId, __voiceSettingsPatch, ...rest } = result
        if (ok && __voiceSettingsPatch) {
          if (__voiceSettingsPatch.tts_voice_provider) settings.tts_provider = __voiceSettingsPatch.tts_voice_provider
          emit({ type: 'voice-settings-changed', ...call.context, patch: __voiceSettingsPatch })
        }
        if (name === 'synth_tts' && ok && !__previewData) throw new Error('语音合成未返回可播放音频，请重试。')
        if (__previewData && !call.speechDuplicate && ok) {
          fillers.mainOutput()
          if (speechText) remember('assistant', speechText)
          emit({ type: 'preview-audio', ...call.context, ...(name === 'synth_tts' ? { purpose: 'speech', source: call.automatic ? 'automatic' : 'model' } : {}), data: __previewData, mime: __previewMime || 'audio/wav', audioDurationSeconds: audioDurationSeconds(Buffer.from(__previewData, 'base64')) })
          if (name === 'synth_tts' && speechText) emit({ type: 'tts-transcript', ...transcriptContext(call.context), text: speechText })
        }
        if (__applyVoiceId && !call.speechDuplicate) emit({ type: 'voice-applied', ...call.context, voiceId: __applyVoiceId })
        result = rest
      }
      output = JSON.stringify(result) ?? 'null'
      // Success comes from the result itself; `completed` is only the call lifecycle.
      evidence = toolOutcome(result)
    } catch (error) {
      if (!live(response) || call.finished) return
      ok = false
      errorText = redactError(error?.message || error)
      evidence = { outcome: 'error' }
      output = JSON.stringify({ error: errorText })
    }
    if (!live(response) || call.finished) return
    if (!ok && name === 'synth_tts' && speechText) {
      emit({ type: 'tts-transcript', ...transcriptContext(call.context), text: speechText, delivery: 'failed' })
    }
    response.pending.delete(call.context.callId)
    if (name !== 'synth_tts') {
      fillers.cancel()
      const remaining = [...response.pending].map(id => calls.get(id)).find(other => other && other.name !== 'synth_tts' && !other.finished)
      if (remaining) fillers.schedule('tool-wait', { toolName: remaining.name })
    }
    finishTool(call, ok ? 'completed' : 'failed', errorText || evidence?.summary,
      ok ? evidence?.outcome : 'error', evidence?.exitCode)
    if (ok && name === 'synth_tts') {
      if (!call.prelude) response.terminal = true
      if (speechText) finalizeResponseAudit(response, 'completed', speechText, call.context)
    }
    if (!ok && name === 'synth_tts') {
      const message = redactError(JSON.parse(output)?.error || '语音合成失败，请检查语音设置后重试。')
      const code = call.automatic ? 'automatic_tts_failed' : 'tts_failed'
      emit({ type: 'error', ...call.context, code, message })
      audit('error', call.context, 'failed', { text: message, code })
    }
    deliverDone(response)
    if (call.automatic) {
      continueResponse(response)
      return
    }
    send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: call.context.callId, output } })
    continueResponse(response)
  }
  function synthesizeFinalText(response, prelude = false) {
    if (!(response.tts || ttsActive()) || !live(response) || (!prelude && response.hasTools) || response.textQueued || !response.text?.trim()) return
    response.textQueued = true
    const callId = `auto-tts-${response.id || randomUUID()}`
    const call = { name: 'synth_tts', response, context: { ...assistantContext(response), callId }, automatic: true, prelude, finished: false }
    calls.set(callId, call)
    response.pending.add(callId)
    emit({ type: 'tool-start', ...call.context, name: call.name })
    queueTool(call, { text: response.text, language: settings.tts_provider === 'breeze' && useTts ? '' : settings.language || 'zh' })
  }
  function startTool(response, item) {
    const callId = String(item.call_id || ''), name = String(item.name || '')
    if (!callId || !name || calls.has(callId) || !live(response)) return
    if (name === 'design_voice') response.suppressNative = true
    if (name !== 'synth_tts') synthesizeFinalText(response, true)
    if (name !== 'synth_tts' && !response.text?.trim()) {
      fillers.cancel()
      fillers.schedule('tool-wait', { toolName: name })
    }
    const call = { name, response, context: context(response.turn, 'assistant', response.id, item.id, callId), finished: false }
    calls.set(callId, call)
    response.pending.add(callId)
    response.hasTools = true
    emit({ type: 'tool-start', ...call.context, name })
    queueTool(call, item.arguments)
  }

  function onMessage(raw) {
    if (disposed) return
    let event
    try { event = JSON.parse(raw.toString()) } catch { return }
    const type = event?.type
    if (typeof type !== 'string') return
    if (type === 'session.created') { sessionUpdate(); flushPending() }
    else if (type === 'error') {
      fillers.cancel()
      const message = redactError(event.error?.message || '').slice(0, 200)
      const code = safeCode(event.error?.code)
      emit({ type: 'error', code, message })
      // 码同时进审计字段：只写在文案里时，审计页分不清 401 凭据失效 / 429 配额耗尽 / 模型下架。
      audit('error', context(), 'failed', { text: message, code })
    } else if (type === 'input_audio_buffer.speech_started') {
      const interrupted = mainPlaying || !!(activeResponse && live(activeResponse) && (!activeResponse.done || activeResponse.pending.size))
      userSpeaking = true
      mainPlaying = false
      invalidate(false, interrupted)
      blocked = false
      turn = { id: `turn-${randomUUID()}`, generation }
      fillers.newTurn(turn.id)
      fillers.userStarted({ interrupted })
      activeResponse = null
      if (event.item_id) items.set(event.item_id, { turn })
      emit({ type: 'speech-started', ...context(turn, 'user', undefined, event.item_id), audioStartMs: event.audio_start_ms })
    } else if (type === 'input_audio_buffer.committed') {
      if (event.item_id && !items.has(event.item_id)) items.set(event.item_id, { turn: currentTurn() })
    } else if (type === 'input_audio_buffer.speech_stopped') {
      userSpeaking = false
      if (event.item_id && !items.has(event.item_id)) items.set(event.item_id, { turn: currentTurn() })
      if (!turnStartedAt) turnStartedAt = Date.now()
      emit({ type: 'speech-stopped', ...context(items.get(event.item_id)?.turn || currentTurn(), 'user', undefined, event.item_id), audioEndMs: event.audio_end_ms, reason: event.reason || null })
      fillers.userStopped()
    } else if (type === 'conversation.item.created' && event.item?.role === 'user') {
      if (event.item.id && !items.has(event.item.id)) items.set(event.item.id, { turn: currentTurn() })
    } else if (type === 'conversation.item.input_audio_transcription.delta' || type === 'conversation.item.input_audio_transcription.completed') {
      const owner = items.get(event.item_id)?.turn || currentTurn()
      if (event.item_id && !items.has(event.item_id)) items.set(event.item_id, { turn: owner })
      const ctx = context(owner, 'user', undefined, event.item_id)
      const final = type.endsWith('.completed')
      const text = final ? event.transcript || '' : event.text || event.delta || ''
      if (final && userFinals.has(ctx.itemId || ctx.messageId)) return
      emit({ type: final ? 'user-transcript-done' : 'user-transcript-delta', ...transcriptContext(ctx), text })
      if (final) {
        if (owner.generation === generation) remember('user', text)
        if (owner.generation === generation && !blocked && !owner.finalTranscript) {
          owner.finalTranscript = true
          voiceState?.user(text, owner.id)
          for (const ready of [...(owner.finalWaiters || [])]) ready()
        }
        userFinals.add(ctx.itemId || ctx.messageId)
        audit('transcription', ctx, 'completed', { text })
      }
    } else if (type.startsWith('response.')) {
      const response = responseFor(event)
      if (type === 'response.done') {
        // A repeated terminal event may be the first one carrying usage.
        captureResponseUsage(response, event.response?.usage)
        if (response.done) return
        const status = event.response?.status || 'completed'
        const cancelled = status === 'cancelled' || !live(response)
        // Some providers place tool output before the spoken message. Collect
        // final speech first so startTool can enqueue its preamble before design.
        if (!cancelled && status === 'completed') {
          const messages = (event.response?.output || []).filter(item => item.type !== 'function_call')
          const spoken = messages.map(itemText).filter(Boolean).join('')
          if (spoken) finalizeText(response, spoken, { item_id: messages[0]?.id })
        }
        // Some Qwen responses include complete function calls/text only in output.
        if (!cancelled && status === 'completed') for (const item of event.response?.output || []) {
          if (item.id) {
            response.itemId = item.id
            items.set(item.id, { turn: response.turn, response })
          }
          if (item.type === 'function_call') startTool(response, item)
          else finalizeText(response, itemText(item), { item_id: item.id })
        }
        if (!cancelled && status === 'completed') finalizeText(response, response.text)
        response.done = true
        if (status !== 'completed') {
          if (!cancelled) fillers.cancel()
          response.cancelled = true
          // 兜底必须带原因：少了 detail，审计里就只剩工具名（本机实测 5 条
          // `design_voice`/`apply_voice` 失败行无法排障）。status 仍只按
          // `status === 'cancelled'` 分流，outcome 显式给出，不新增状态值。
          const ended = status === 'cancelled' ? 'cancelled' : 'failed'
          const reason = `所在响应在工具完成前结束（${status}）`
          for (const callId of response.pending) {
            const call = calls.get(callId)
            if (!call || call.finished) continue
            finishTool(call, ended, reason, ended === 'cancelled' ? 'cancelled' : 'error')
            // 音色工具动的是账号级真资源（配额/已保存音色），失败必须留一条可追的错误行，
            // 与 voice-tool-bridge 里 delete_voice/design_voice 的分支同构。取消不算失败。
            if (ended === 'failed' && VOICE_SIDE_EFFECT_TOOLS.has(call.name)) audit('error', call.context, 'failed', { text: `音色工具 ${call.name} 未完成：${reason}` })
          }
          response.pending.clear()
        }
        const ctx = assistantContext(response)
        const auditStatus = cancelled || status === 'cancelled' ? 'cancelled' : status === 'completed' ? 'completed' : 'failed'
        finalizeResponseAudit(response, auditStatus)
        if (!cancelled && status === 'completed') synthesizeFinalText(response)
        if (!cancelled) {
          if (status === 'completed') {
            response.deliveryDone = { type: 'done', ...ctx, status }
            deliverDone(response)
          } else emit({ type: 'done', ...ctx, status })
          if (turnStartedAt) {
            const roundMs = Date.now() - turnStartedAt
            const audioDurationSeconds = audioBytes / (24000 * 2)
            const rtf = audioDurationSeconds > 0 ? roundMs / 1000 / audioDurationSeconds : null
            emit({ type: 'metrics', ...ctx, firstAudioMs: firstAudioAt ? firstAudioAt - turnStartedAt : null, roundMs, audioDurationSeconds: Math.round(audioDurationSeconds * 100) / 100, rtf: rtf == null ? null : Math.round(rtf * 100) / 100, bytes: audioBytes })
          }
          audioTotal = 0; audioBytes = 0; turnStartedAt = 0; firstAudioAt = 0
        }
        continueResponse(response)
        return
      }
      if (!live(response)) return
      if (type === 'response.created' && !userSpeaking) fillers.schedule('thinking')
      const ctx = assistantContext(response, event)
      if (type === 'response.audio.delta') {
        if (response.tts || ttsActive() || response.suppressNative || response.done || response.auditFinalized) return
        const delta = event.delta || ''
        const bytes = Buffer.from(delta, 'base64').length
        audioTotal += bytes
        if (audioTotal > MAX_AUDIO_BYTES) { emit({ type: 'error', code: 'audio_too_large', message: '语音输出过大，已停止。' }); return }
        if (!firstAudioAt) firstAudioAt = Date.now()
        response.firstAudioAt ||= firstAudioAt
        audioBytes += bytes
        response.audioBytes = (response.audioBytes || 0) + bytes
        fillers.mainOutput()
        emit({ type: 'audio', ...ctx, data: delta })
      } else if (type === 'response.audio_transcript.delta' || type === 'response.text.delta') {
        if (response.finalized || !event.delta) return
        const source = type === 'response.text.delta' ? 'text' : 'audio_transcript'
        response.transcriptSource ||= source
        if (response.transcriptSource !== source) return
        response.text += event.delta
        response.firstTextAt ||= Date.now()
        const chunk = spokenText((response.transcriptPending || '') + event.delta)
        let held = 0
        for (const name of DEFAULT_TOOLS) for (let n = 1; n < name.length; n++) if (chunk.toLowerCase().endsWith(name.slice(0, n))) held = Math.max(held, n)
        response.transcriptPending = held ? chunk.slice(-held) : ''
        const safe = held ? chunk.slice(0, -held) : chunk
        if (safe && !response.tts) emit({ type: 'transcript-delta', ...transcriptContext(ctx), text: safe })
      } else if (type === 'response.audio_transcript.done' || type === 'response.text.done') {
        finalizeText(response, event.transcript || event.text || response.text, event)
      } else if (type === 'response.output_item.done') {
        const item = event.item || {}
        if (item.type === 'function_call') startTool(response, item)
        else finalizeText(response, itemText(item), event)
      }
    }
  }

  // 连不上也必须结束会话：error 只给用户看原因，closed 才是「dispose + 释放并发额度 + 前端停麦」的信号。
  // 走到这里的两条失败路径（没有 WebSocketCtor、构造抛错）都不可能有 socket，所以都走同一个出口。
  function connectionFailed(message) {
    emit({ type: 'error', code: 'connection', message })
    emit({ type: 'closed' })
  }
  function connect() {
    if (disposed) return
    if (!WebSocketCtor) return connectionFailed('实时语音组件未加载，无法连接')
    try {
      socket = new WebSocketCtor(url, { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 20000 })
    } catch { return connectionFailed('实时语音连接失败') }
    socket.on('message', onMessage)
    socket.on('error', () => { if (!disposed) emit({ type: 'error', code: 'connection', message: '实时语音连接失败' }) })
    // 握手被拒（401/403、模型或地址写错）不会自己收尾：ws 8.22 只要注册了 unexpected-response 监听，
    // websocket.js:943 的 `!websocket.emit('unexpected-response', …)` 即为假，abortHandshake 被跳过，
    // readyState 永远停在 CONNECTING、close 事件不触发（握手超时也只有 socket 空闲时才轮到）。
    // 所以这里既排空响应体、又主动 destroy 请求，并补发 closed —— 否则服务端把这具死会话当活会话占额度。
    socket.on('unexpected-response', (req, res) => {
      res?.resume?.()
      if (!disposed) emit({ type: 'error', code: 'handshake_' + (res?.statusCode || 'error'), message: '实时语音鉴权或握手失败' })
      if (!disposed) emit({ type: 'closed' })
      req?.destroy?.()
    })
    socket.on('close', () => { if (!disposed) { invalidate(true); emit({ type: 'closed' }) } })
  }

  return {
    connect,
    appendAudio(base64) {
      // 体积超限是「拒绝」，握手未完成是「暂存」——两者不能混成同一个早退。
      if (typeof base64 !== 'string' || !base64.length || base64.length > 3 * 1024 * 1024) return
      outbound({ type: 'input_audio_buffer.append', audio: base64 }, base64.length)
    },
    commit() { userSpeaking = false; fillers.userStopped(); outbound({ type: 'input_audio_buffer.commit' }) },
    playback({ kind, active }) {
      if (kind !== 'main') return
      mainPlaying = active
      fillers.playback(active)
      if (!active && !userSpeaking && activeResponse && live(activeResponse) && activeResponse.pending.size) {
        const tool = [...activeResponse.pending].map(id => calls.get(id)).find(call => call && call.name !== 'synth_tts' && !call.finished)
        if (tool) fillers.schedule('tool-wait', { toolName: tool.name })
      }
    },
    createResponse() {
      if (blocked) { blocked = false; turn = { id: `turn-${randomUUID()}`, generation }; activeResponse = null }
      requestResponse()
    },
    cancel() { invalidate(true); send({ type: 'response.cancel' }) },
    dispose() { if (disposed) return; invalidate(true); fillers.dispose(); disposed = true; try { socket?.close() } catch {} },
  }
}

export { toolDefinitions, MODEL, DEFAULT_TOOLS, SYSTEM_VOICE, REALTIME_INSTRUCTIONS, realtimeInstructions } from './realtime-protocol.js'
export { realtimeDefaults, readEnvKey } from './realtime-protocol.js'
