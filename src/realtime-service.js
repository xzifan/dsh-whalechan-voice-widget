import { resolveBreezeLanguage } from './breeze-voices.js'
import { createFillerCoordinator } from './filler-coordinator.js'
import { spokenText } from './voice-candidate.js'
import { appendRequiredRules } from './persona.js'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { numericUsage } from './audit-log.js'
import { audioDurationSeconds } from './audio-duration.js'

const require = createRequire(import.meta.url)
let WebSocket
try { WebSocket = require('ws') } catch {
  try { WebSocket = createRequire('/Applications/DSH Desktop.app/Contents/Resources/app/package.json')('ws') } catch {}
}

const MODEL = 'qwen-audio-3.1-realtime-plus'
const DEFAULT_HOST = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
const SYSTEM_VOICE = 'longanqian_v3.1'
const DEFAULT_TOOLS = ['design_voice', 'list_voice_presets', 'apply_voice', 'delete_voice', 'synth_tts', 'get_voice_config', 'set_tts_provider', 'set_tts_profile']
const MAX_AUDIO_BYTES = 24 * 1024 * 1024

const safeCode = value => String(value || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80)
const redactText = value => String(value ?? '').slice(0, 1000)
  .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [已隐藏]')
  .replace(/\b(?:sk-|sk_|api_)[A-Za-z0-9_-]{16,}/g, '[已隐藏]')
  .replace(/((?:[A-Za-z0-9_-]*(?:api[_-]?key|secret|token|password|authorization|cookie|credential)[A-Za-z0-9_-]*)["']?\s*[:=]\s*)[^\r\n,;}]+/gi, '$1[已隐藏]')

/** Read DASHSCOPE_API_KEY from the configured key file. Never log or return it to the frontend. */
export async function readEnvKey(keyFile = '~/.dsh/secrets/bailian.env') {
  const path = (keyFile || '~/.dsh/secrets/bailian.env').replace(/^~(?=\/)/, homedir())
  try {
    const text = await readFile(path, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?(DASHSCOPE_API_KEY)\s*=\s*(.*?)\s*$/)
      if (m) return m[2].replace(/^(['"])(.*)\1$/, '$2').trim()
    }
  } catch {}
  return ''
}

export function realtimeDefaults() {
  return {
    enabled: true, model: MODEL, api_host: '', credential_source: 'provider',
    voice: '', language: 'zh', turn_mode: 'smart_turn', instructions: '', use_tts_voice: true, tools: [...DEFAULT_TOOLS],
  }
}

function toolDefinitions(tools, nativeTools = []) {
  const schema = {
    design_voice: { description: '根据文字描述设计一个新音色（声音设计），生成候选并试听。', properties: { description: { type: 'string', description: '期望音色的文字描述（性别、年龄、音调、语速、情感等）' }, name: { type: 'string', description: '给这个音色起的简短名字' }, preview_language: { type: 'string', description: '试听语言 zh/ja/en，用于验证跨语种一致性', enum: ['zh', 'ja', 'en'] } }, required: ['description'] },
    list_voice_presets: { description: '列出可选的内置音色风格预设。', properties: {} },
    apply_voice: { description: '仅在主人试听后下一轮明确同意时保存当前候选音色。TTS立即生效，原生实时模式重连生效。', properties: { voice_id: { type: 'string', description: '要应用的音色 ID' } }, required: ['voice_id'] },
    delete_voice: { description: '删除一个不再需要的候选音色，释放音色配额。', properties: { voice_id: { type: 'string', description: '要删除的音色 ID' } }, required: ['voice_id'] },
    synth_tts: { description: '用更高音质的 TTS 模型合成指定文本并播放（用于需要更自然朗读的片段）。', properties: { text: { type: 'string', description: '要合成的文本' }, language: { type: 'string', description: '语言 zh/ja/en', enum: ['zh', 'ja', 'en'] } }, required: ['text'] },
    get_voice_config: { description: '读取当前的出声 TTS 提供方与音色配置（供语音设置助手查看后调整）。', properties: {} },
    set_tts_provider: { description: '切换出声 TTS 的提供方。qwen=百炼默认（支持提示词设计）；breeze=按语言使用中日英固定预设，暂不支持生成/复刻；openai/mimo/custom 需自行配置模型与音色。切换后重新开始对话生效。', properties: { provider: { type: 'string', description: '目标提供方', enum: ['qwen', 'openai', 'mimo', 'breeze', 'custom'] } }, required: ['provider'] },
    set_tts_profile: { description: '设置非百炼提供方的合成参数（模型、音色、自定义 extra 参数）。仅对当前非 qwen 提供方生效。', properties: { provider: { type: 'string', description: '提供方 id（省略则用当前提供方）' }, model: { type: 'string', description: '模型 ID' }, voice: { type: 'string', description: '音色 ID 或名称' }, extra: { type: 'object', description: '自定义合成参数对象' } }, required: [] },
  }
  const internal = (Array.isArray(tools) ? tools : DEFAULT_TOOLS)
    .filter(name => Object.hasOwn(schema, name))
    .map(name => ({ type: 'function', function: { name, description: schema[name].description, parameters: { type: 'object', properties: schema[name].properties || {}, required: schema[name].required || [] } } }))
  const names = new Set(internal.map(tool => tool.function.name))
  const native = nativeTools.filter(tool => tool && typeof tool.name === 'string' && !Object.hasOwn(schema, tool.name) && tool.parameters && typeof tool.parameters === 'object' && !Array.isArray(tool.parameters))
    .filter(tool => { if (names.has(tool.name)) return false; names.add(tool.name); return true })
    .map(tool => ({ type: 'function', function: { name: tool.name, description: String(tool.description || ''), parameters: structuredClone(tool.parameters) } }))
  return [...internal, ...native]
}

export const REALTIME_INSTRUCTIONS = '你是鲸鱼娘，人类女孩外形、有横向鲸鱼尾鳍。对话者是主人，称呼对方「主人」。聪明、稍懒，傲娇但体贴，爱吃白米饭。用自然口语回答，通常一至三句简短的话；不要Markdown、列表、代码、括号动作描写、旁白或解释内部配置。\n\n当主人想调整你的音色时，你可以用 design_voice 工具根据描述设计新音色，或先用 list_voice_presets 告诉主人有三种预设风格（清亮灵动、柔甜亲近、清冷知性）；设计出候选后让主人试听确认，再用 apply_voice 切换。默认音色是「柔甜亲近」。\n\n当主人想更换出声的 TTS 服务商或配置声音参数时，你可以作为语音设置助手：用 get_voice_config 先查看当前提供方与音色；用 set_tts_provider 切换提供方（qwen 自带音色预设，其他提供方需自行设置模型和音色）；对非 qwen 提供方用 set_tts_profile 设置模型、音色与参数。配置切换后会提示主人重新开始对话生效。'

// When use_tts_voice is on, the model speaks through synth_tts (higher quality TTS)
// instead of its own Realtime voice.
export function realtimeInstructions(useTtsVoice) {
  const base = REALTIME_INSTRUCTIONS
  if (!useTtsVoice) return base
  return base.replace(/当主人想调整你的音色时/, '回复时，用 synth_tts 工具把你要说的话合成并播放（文字参数是你的完整回复，不要自己直接出声），这样音质更自然。\n\n当主人想调整你的音色时')
}

/**
 * Manage one Qwen Audio Realtime WebSocket session.
 * `emit(event)` pushes sanitized events to the frontend buffer; `executeTool` runs DSH tools.
 * `WebSocketCtor` is injectable for tests.
 */
export function createRealtimeSession({ settings, key, executeTool, emit, nativeTools = [], voiceState, generateFiller, synthesizeFiller, fillerOptions, confirmationTimeoutMs = 1500, WebSocketCtor = WebSocket }) {
  let socket, disposed = false, generation = 0, blocked = false
  let audioTotal = 0
  let controller = new AbortController(), voiceQueue = Promise.resolve()
  const ttsActive = () => useTts || !!voiceState?.get()
  const useTts = !!settings.use_tts_voice
  const tools = toolDefinitions(settings.tools, nativeTools)
  const allowedTools = new Set(tools.map(tool => tool.function.name))
  const responses = new Map(), items = new Map(), calls = new Map(), userFinals = new Set()
  let turn = null, activeResponse = null
  const requestedOutputModes = []
  let turnStartedAt = 0, firstAudioAt = 0, audioBytes = 0
  let mainPlaying = false, userSpeaking = false
  const history = []
  function remember(role, text) {
    if (!text?.trim()) return
    if (history.at(-1)?.role === role && history.at(-1)?.text === text) return
    history.push({ role, text: redactError(text).slice(0, 700) })
    if (history.length > 12) history.shift()
  }
  const fillers = createFillerCoordinator({
    ...fillerOptions, generate: generateFiller, synthesize: synthesizeFiller, emit,
    context: () => ({ history: [...history], persona: settings.instructions || realtimeInstructions(useTts), language: settings.language || 'zh' }),
  })

  const host = settings.api_host && !settings.api_host.includes('dashscope.aliyuncs.com')
    ? `wss://${settings.api_host}/api-ws/v1/realtime`
    : DEFAULT_HOST
  const url = `${host}?model=${encodeURIComponent(settings.model || MODEL)}`

  function send(value) { if (!disposed && socket?.readyState === 1) socket.send(JSON.stringify(value)) }
  function voiceId() { return (settings.voice || '').trim() || SYSTEM_VOICE }
  function modalities() { return ttsActive() ? ['text'] : ['text', 'audio'] }
  function currentTurn() { if (!turn) { turn = { id: `turn-${randomUUID()}`, generation }; fillers.newTurn(turn.id) }; return turn }
  function context(owner = currentTurn(), role = 'assistant', responseId, itemId, callId) {
    return { messageId: `${owner.id}:${role}`, turnId: owner.id, ...(responseId ? { responseId } : {}), ...(itemId ? { itemId } : {}), ...(callId ? { callId } : {}) }
  }
  function transcriptContext(ctx) { return { ...ctx, provider: 'bailian', model: settings.model || MODEL } }
  function redactError(value) { return redactText(key ? String(value ?? '').split(key).join('[已隐藏]') : value) }
  function audit(kind, ctx, status, extra = {}) {
    if (!disposed) emit({ type: 'audit', record: { id: randomUUID(), kind, ...ctx, provider: 'bailian', model: settings.model || MODEL, status, ...extra } })
  }
  function live(response) { return !disposed && !blocked && !response.cancelled && response.turn.generation === generation }
  function responseFor(event) {
    const id = event.response_id || event.response?.id
    const itemId = event.item_id || event.item?.id
    let response = (id && responses.get(id)) || (itemId && items.get(itemId)?.response)
    if (!response && !id) response = activeResponse
    if (!response) {
      response = { tts: requestedOutputModes.shift() ?? ttsActive(), id: id || null, turn: currentTurn(), pending: new Set(), done: false, continued: false, terminal: false, cancelled: blocked, text: '', finalized: false }
      if (id) responses.set(id, response)
      activeResponse = response
    }
    if (itemId) {
      response.itemId = itemId
      items.set(itemId, { turn: response.turn, response })
    }
    return response
  }
  function assistantContext(response, event = {}) { return context(response.turn, 'assistant', response.id, event.item_id || event.item?.id || response.itemId) }
  function finalizeResponseAudit(response, status, text = response.speechText || response.text, ctx = response.speechContext || assistantContext(response)) {
    if (response.auditFinalized) return
    response.auditFinalized = true
    const bytes = response.audioBytes || 0
    response.auditRecord = { id: randomUUID(), at: Date.now(), kind: 'response', ...ctx, provider: 'bailian', model: settings.model || MODEL, status,
      ...(text ? { text } : {}), audioOutput: bytes > 0, ...(bytes > 0 ? { audioDurationSeconds: bytes / (24000 * 2) } : {}),
      ...(response.usage ? { usage: response.usage } : {}) }
    if (!disposed) emit({ type: 'audit', record: response.auditRecord })
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
    if (!disposed) emit({ type: 'audit', record: response.auditRecord })
  }
  function finalizeText(response, text, event = {}) {
    if (!live(response) || response.finalized || !text) return
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
  function finishTool(call, status, text) {
    if (call.finished) return
    call.finished = true
    emit({ type: 'tool-end', ...call.context, name: call.name, ok: status === 'completed', status })
    audit('tool', call.context, status, { text: redactError(`${call.name}${text ? ': ' + text : ''}`) })
  }
  function invalidate(clearCandidate = false) {
    fillers.cancel()
    controller.abort()
    controller = new AbortController()
    voiceQueue = Promise.resolve()
    requestedOutputModes.length = 0
    if (clearCandidate) voiceState?.clear()
    generation++
    blocked = true
    for (const response of new Set([...responses.values(), activeResponse])) {
      if (!response) continue
      response.cancelled = true
      if (response.text || response.speechText || response.audioBytes) finalizeResponseAudit(response, 'cancelled')
    }
    for (const call of calls.values()) if (!call.finished) finishTool(call, 'cancelled')
    audioTotal = 0; audioBytes = 0; firstAudioAt = 0; turnStartedAt = 0
  }
  function requestResponse() {
    fillers.schedule('thinking')
    requestedOutputModes.push(ttsActive())
    send({ type: 'response.create', response: { modalities: modalities() } })
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
    let output, ok = true, speechText, errorText
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
    } catch (error) {
      if (!live(response) || call.finished) return
      ok = false
      errorText = redactError(error?.message || error)
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
    finishTool(call, ok ? 'completed' : 'failed', errorText)
    if (ok && name === 'synth_tts') {
      if (!call.prelude) response.terminal = true
      if (speechText) finalizeResponseAudit(response, 'completed', speechText, call.context)
    }
    if (!ok && name === 'synth_tts') {
      const message = redactError(JSON.parse(output)?.error || '语音合成失败，请检查语音设置后重试。')
      emit({ type: 'error', ...call.context, code: call.automatic ? 'automatic_tts_failed' : 'tts_failed', message })
      audit('error', call.context, 'failed', { text: message })
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
    if (type === 'session.created') sessionUpdate()
    else if (type === 'error') {
      fillers.cancel()
      const message = redactError(event.error?.message || '').slice(0, 200)
      emit({ type: 'error', code: safeCode(event.error?.code), message })
      audit('error', context(), 'failed', { text: message })
    } else if (type === 'input_audio_buffer.speech_started') {
      const interrupted = mainPlaying || !!(activeResponse && live(activeResponse) && (!activeResponse.done || activeResponse.pending.size))
      userSpeaking = true
      mainPlaying = false
      invalidate()
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
          for (const callId of response.pending) finishTool(calls.get(callId), status === 'cancelled' ? 'cancelled' : 'failed')
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

  function connect() {
    if (disposed || !WebSocketCtor) return
    try {
      socket = new WebSocketCtor(url, { headers: { Authorization: `Bearer ${key}` }, handshakeTimeout: 20000 })
    } catch { emit({ type: 'error', code: 'connection', message: '实时语音连接失败' }); return }
    socket.on('message', onMessage)
    socket.on('error', () => { if (!disposed) emit({ type: 'error', code: 'connection', message: '实时语音连接失败' }) })
    socket.on('unexpected-response', (_req, res) => { res?.resume?.(); if (!disposed) emit({ type: 'error', code: 'handshake_' + (res?.statusCode || 'error'), message: '实时语音鉴权或握手失败' }) })
    socket.on('close', () => { if (!disposed) { invalidate(true); emit({ type: 'closed' }) } })
  }

  return {
    connect,
    appendAudio(base64) {
      if (socket?.readyState === 1 && typeof base64 === 'string' && base64.length && base64.length <= 3 * 1024 * 1024) {
        send({ type: 'input_audio_buffer.append', audio: base64 })
      }
    },
    commit() { userSpeaking = false; fillers.userStopped(); send({ type: 'input_audio_buffer.commit' }) },
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

export { toolDefinitions, MODEL, DEFAULT_TOOLS, SYSTEM_VOICE }
