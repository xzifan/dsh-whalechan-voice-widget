// Realtime voice conversation helpers: PCM encode/decode, frame chunking,
// event cursor/polling state machine, interruption transitions, playback queue.
// Pure logic only; audio hardware (AudioContext) injected for testability.

const FRAME_MS = 30 // capture frame duration
const INPUT_RATE = 16000
const OUTPUT_RATE = 24000

// ---- PCM base64 -----------------------------------------------------------
// Float32 samples [-1,1] -> 16-bit little-endian PCM -> base64.
export function float32ToPcm16Base64(samples) {
  const view = new DataView(new ArrayBuffer(samples.length * 2))
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(i * 2, Math.round(s * (s < 0 ? 32768 : 32767)), true)
  }
  return bytesToBase64(new Uint8Array(view.buffer))
}
// base64 PCM16 -> Float32 samples (for tests / playback preprocessing).
export function pcm16Base64ToFloat32(base64) {
  const bytes = base64ToBytes(base64)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = Math.floor(bytes.byteLength / 2)
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true) / 32768
  return out
}
// Raw 16-bit PCM bytes -> Float32 (for playback).
export function pcm16BytesToFloat32(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const count = Math.floor(bytes.byteLength / 2)
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true) / 32768
  return out
}
export function bytesToBase64(bytes) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
export function base64ToBytes(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// ---- capture frame chunking ----------------------------------------------
// Given a Float32 input at `inputRate`, produce base64 PCM16 frames of
// `FRAME_MS` each, resampled to INPUT_RATE. Returns {frames:[base64], remainder:Float32}.
export function chunkFrames(samples, inputRate = INPUT_RATE, frameMs = FRAME_MS) {
  const frameSize = Math.floor(inputRate * frameMs / 1000)
  const resampled = resample(samples, inputRate, INPUT_RATE)
  const frames = []
  for (let i = 0; i + frameSize <= resampled.length; i += frameSize) {
    frames.push(float32ToPcm16Base64(resampled.subarray(i, i + frameSize)))
  }
  const used = frames.length * frameSize
  const remainder = resampled.length > used ? resampled.subarray(used) : new Float32Array(0)
  return { frames, remainder }
}
// Linear resample Float32 samples from `fromRate` to `toRate`.
export function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples.slice()
  const ratio = fromRate / toRate
  const count = Math.floor(samples.length / ratio)
  const out = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const start = i * ratio, end = Math.min((i + 1) * ratio, samples.length)
    let sum = 0
    for (let j = Math.floor(start); j < Math.ceil(end); j++) sum += samples[j] * (Math.min(j + 1, end) - Math.max(j, start))
    out[i] = end > start ? sum / (end - start) : 0
  }
  return out
}

// ---- event cursor / polling state machine --------------------------------
export function advanceCursor(events, currentCursor) {
  let cursor = currentCursor || 0
  for (const event of events) cursor = Math.max(cursor, Number(event.seq) || 0)
  return cursor
}
export const MAX_REALTIME_MESSAGES = 200
export const MAX_REALTIME_TOOL_CALLS = 200

import { orderConversationRows } from '../../../src/core/conversation-order.js'

// One local clock orders output first appearances; correlated user input comes first.
// Assistant continuations get a new bubble after a tool first appears.
export function realtimeTimeline(state) {
  return orderConversationRows([
    ...(state.messages || []).map(message => ({ ...message, kind: 'message' })),
    ...(state.toolCalls || []).map(tool => ({ ...tool, kind: 'tool' })),
  ].sort((a, b) => (a.order || 0) - (b.order || 0)))
}

function eventTime(event) {
  const value = event.at ?? event.timestamp
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return Date.parse(value)
  return undefined
}

function boundedHistory(state) {
  return {
    ...state,
    messages: (state.messages || []).slice(-MAX_REALTIME_MESSAGES),
    toolCalls: (state.toolCalls || []).slice(-MAX_REALTIME_TOOL_CALLS),
  }
}

// Also called by the host on local stop; completed history is retained.
export function finalizeRealtimeMessages(state, status = 'interrupted') {
  return {
    ...state,
    messages: (state.messages || []).slice(-MAX_REALTIME_MESSAGES).map(message => message.status === 'streaming'
      ? { ...message, status } : message),
    activeUserMessageId: null,
    activeAssistantMessageId: null,
    listening: false,
    speaking: false,
    tool: state.tool ? { ...state.tool, active: false } : state.tool,
    toolCalls: (state.toolCalls || []).slice(-MAX_REALTIME_TOOL_CALLS).map(tool => tool.status === 'running'
      ? { ...tool, status: 'cancelled' } : tool),
  }
}

// messages: [{id, role: 'user'|'assistant', text,
// status: 'streaming'|'complete'|'interrupted'}]. Legacy text is per turn.
export function applyRealtimeEvent(state, event) {
  let next = { ...state, messages: [...(state.messages || [])], toolCalls: [...(state.toolCalls || [])] }
  const order = () => {
    next.timelineOrder = Math.max(next.timelineOrder || 0, ...next.messages.map(item => item.order || 0), ...next.toolCalls.map(item => item.order || 0)) + 1
    return next.timelineOrder
  }
  const updateTool = (ending = false) => {
    const index = next.toolCalls.findIndex(tool => event.callId
      ? tool.callId === event.callId
      : tool.name === event.name && tool.messageId === event.messageId && tool.turnId === event.turnId)
    const previous = next.toolCalls[index]
    const status = !ending ? (previous?.status || 'running')
      : event.status === 'cancelled' ? 'cancelled'
        : event.status === 'failed' || event.status === 'error' || event.ok === false ? 'failed' : 'completed'
    const at = eventTime(event)
    const position = previous?.order ?? order()
    const tool = {
      ...(previous || { id: event.callId ? `tool:${event.callId}` : `tool:local-${position}`, order: position }),
      status,
    }
    for (const key of ['callId', 'messageId', 'turnId', 'name']) {
      if (typeof event[key] === 'string' && event[key]) tool[key] = event[key]
    }
    tool.name ||= '工具'
    if (at !== undefined && !ending && tool.startedAt === undefined) tool.startedAt = at
    if (at !== undefined && ending && tool.endedAt === undefined) tool.endedAt = at
    if (ending && Number.isFinite(event.durationMs) && event.durationMs >= 0) tool.durationMs = event.durationMs
    else if (tool.startedAt !== undefined && tool.endedAt !== undefined) tool.durationMs = Math.max(0, tool.endedAt - tool.startedAt)
    // Backend errors can contain credentials/arguments. Retain only a safe summary.
    if (status === 'failed' && (event.error || event.errorSummary || event.message || event.code)) tool.errorSummary = '工具执行失败，请查看审计记录。'
    if (index < 0) next.toolCalls.push(tool)
    else next.toolCalls[index] = tool
    return { tool, previous }
  }
  const finish = (role, status = 'complete', clear = true) => {
    const key = role === 'user' ? 'activeUserMessageId' : 'activeAssistantMessageId'
    next.messages = next.messages.map(message => message.id === next[key]
      ? { ...message, status } : message)
    if (clear) next[key] = null
  }
  const beginUserTurn = () => {
    finish('user')
    finish('assistant', next.speaking ? 'interrupted' : 'complete')
    next.userText = ''
    next.assistantText = ''
    next.done = false
    next.closed = false
    next.interrupted = false
  }
  const segments = (role) => {
    const key = role === 'user' ? 'activeUserMessageId' : 'activeAssistantMessageId'
    const active = next.messages.find(message => message.id === next[key])
    const group = event.messageId || active?.messageId || active?.segmentGroup || active?.id
    return next.messages.filter(message => message.role === role &&
      (message.messageId || message.segmentGroup || message.id) === group &&
      (!event.responseId || message.responseId === event.responseId))
  }
  const write = (role, text, replace = false, historical = false) => {
    if (typeof text !== 'string' || (!text && event.type !== 'speech-started')) return
    const key = role === 'user' ? 'activeUserMessageId' : 'activeAssistantMessageId'
    const field = role === 'user' ? 'userText' : 'assistantText'
    const correlatedId = typeof event.messageId === 'string' && event.messageId ? event.messageId : null
    const parts = segments(role)
    let message = parts.at(-1)
    const fullText = parts.map(part => part.text).join('')
    const metadata = Object.fromEntries(['messageId','turnId','responseId','callId','sessionId','provider','model','delivery'].filter(k=>event[k]!==undefined).map(k=>[k,event[k]]))
    // A cumulative final transcript replaces its logical message, not just the
    // latest bubble. Fixed offsets retain the tool boundaries even on correction.
    if (replace && parts.length) {
      const extension = text.startsWith(fullText) ? text.slice(fullText.length) : ''
      if (!historical && extension && role === 'assistant' && next.toolCalls.some(tool => tool.order > message.order)) {
        write(role, extension)
        return
      }
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]
        const start = part.textOffset || 0
        const end = parts[i + 1]?.textOffset
        const index = next.messages.findIndex(item => item.id === part.id)
        next.messages[index] = { ...part, ...metadata, text: text.slice(start, end), status: 'streaming' }
      }
      next[key] = message.id
      next[field] = text
      return
    }
    const split = role === 'assistant' && message && next.toolCalls.some(tool => tool.order > message.order)
    if (!message || split) {
      if (!message && role === 'assistant') finish('assistant')
      next.nextMessageId = (next.nextMessageId || 0) + 1
      let id = !message && correlatedId ? correlatedId : `realtime-${next.nextMessageId}`
      while (next.messages.some(item => item.id === id)) id = `realtime-${++next.nextMessageId}`
      if (split) {
        const index = next.messages.findIndex(item => item.id === message.id)
        next.messages[index] = { ...message, status: 'complete' }
      }
      message = { ...message, ...(split ? { voice: false, audioDurationSeconds: undefined } : {}), id, role, text: '', status: 'streaming', order: order(),
        segmentGroup: message?.segmentGroup || message?.id || id, textOffset: (parts[0]?.textOffset || 0) + fullText.length }
      next.messages.push(message)
    }
    next[key] = message.id
    const index = next.messages.findIndex(item => item.id === message.id)
    next.messages[index] = { ...message, ...metadata, text: message.text + text, status: 'streaming' }
    next[field] = fullText + text
  }
  const writeTts = (text) => {
    const current = segments('assistant').map(message => message.text).join('')
    if (!current.includes(text)) write('assistant', text, !!current && text.startsWith(current))
  }
  switch (event.type) {
    case 'user-transcript-delta':
    case 'user-transcript-done':
      // Push-to-talk and some providers omit speech-started.
      if ((event.type === 'user-transcript-delta' && (next.activeAssistantMessageId || next.assistantText)) ||
          (!next.activeUserMessageId && (next.done || next.activeAssistantMessageId || next.assistantText))) beginUserTurn()
      write('user', event.text, event.type === 'user-transcript-done')
      if (event.type === 'user-transcript-done') finish('user', 'complete', false)
      else next.listening = true
      break
    case 'transcript-delta':
    case 'transcript-done':
      if (event.type === 'transcript-done') {
        const activeId = next.activeAssistantMessageId
        const assistantText = next.assistantText
        if (!event.messageId && next.done && !activeId && next.messages.at(-1)?.role === 'assistant') {
          next.activeAssistantMessageId = next.messages.at(-1).id
        }
        const parts = segments('assistant')
        if (parts.length && !parts.some(part => part.id === activeId)) {
          write('assistant', event.text, true, true)
          const group = parts[0].messageId || parts[0].segmentGroup || parts[0].id
          next.messages = next.messages.map(message => (message.messageId || message.segmentGroup || message.id) === group &&
            (!event.responseId || message.responseId === event.responseId)
            ? { ...message, status: 'complete' } : message)
          next.activeAssistantMessageId = activeId
          if (activeId || next.listening || parts.at(-1).id !== state.messages?.at(-1)?.id) next.assistantText = assistantText
          break
        }
      }
      finish('user', 'complete', false)
      next.listening = false
      next.done = false
      next.interrupted = false
      write('assistant', event.text, event.type === 'transcript-done')
      if (event.type === 'transcript-done') {
        const ids = new Set(segments('assistant').map(message => message.id))
        next.messages = next.messages.map(message => ids.has(message.id) ? { ...message, status: 'complete' } : message)
      }
      next.speaking = true
      break
    case 'speech-started':
      beginUserTurn()
      if (event.messageId) write('user', '')
      next.messages = next.messages.map(message => message.id === next.activeUserMessageId
        ? { ...message, voice: true, speechStartedAt: eventTime(event), audioStartMs: event.audioStartMs } : message)
      next.listening = true
      next.speaking = false
      next.interrupted = true // host discards queued audio
      break
    case 'speech-stopped':
      next.listening = false
      next.messages = next.messages.map(message => message.role === 'user' && (event.messageId ? message.messageId === event.messageId : message.id === next.activeUserMessageId)
        ? { ...message, audioDurationSeconds: Number.isFinite(event.audioEndMs) && Number.isFinite(message.audioStartMs)
          ? Math.max(0, (event.audioEndMs - message.audioStartMs) / 1000)
          : eventTime(event) !== undefined && message.speechStartedAt !== undefined
            ? Math.max(0, (eventTime(event) - message.speechStartedAt) / 1000) : undefined } : message)
      break
    case 'tts-transcript': {
      if (!event.text || typeof event.text !== 'string' ||
          (event.callId && next.ttsTranscriptCallIds?.includes(event.callId))) break
      if (event.callId) next.ttsTranscriptCallIds = [...(next.ttsTranscriptCallIds || []), event.callId].slice(-MAX_REALTIME_MESSAGES)
      finish('user', 'complete', false)
      const activeId = next.activeAssistantMessageId
      if (!event.messageId && !activeId && next.messages.at(-1)?.role === 'assistant') next.activeAssistantMessageId = next.messages.at(-1).id
      writeTts(event.text)
      if (!activeId && next.done) next.activeAssistantMessageId = activeId
      next.done = false
      next.speaking = true
      next.listening = false
      break
    }
    case 'tool-start': {
      finish('user', 'complete', false)
      const { tool } = updateTool()
      if (event.name === 'synth_tts') next.done = false
      next.tool = { active: tool.status === 'running', name: tool.name, callId: tool.callId }
      break
    }
    case 'tool-end': {
      const { tool, previous } = updateTool(true)
      if (next.tool?.callId === event.callId) next.tool = { active: false, name: tool.name, ok: tool.status === 'completed' }
      if (previous?.status === 'running' && tool.name === 'synth_tts') {
        const active = next.messages.find(message => message.id === next.activeAssistantMessageId)
        if (!tool.messageId || (active?.messageId || active?.id) === tool.messageId) {
          finish('assistant', tool.status === 'completed' ? 'complete' : 'interrupted')
          next.speaking = false
        } else {
          next.messages = next.messages.map(message => (message.messageId || message.id) === tool.messageId
            ? { ...message, status: tool.status === 'completed' ? 'complete' : 'interrupted' } : message)
        }
      }
      break
    }
    case 'done':
      finish('assistant', event.status === 'cancelled' || event.status === 'failed' ? 'interrupted' : 'complete')
      if (!next.listening) finish('user')
      next.done = true
      next.speaking = false
      break
    case 'interruption':
    case 'interrupted':
      finish('assistant', 'interrupted')
      next.speaking = false
      next.interrupted = true
      break
    case 'metrics':
      next.metrics = { firstAudioMs: event.firstAudioMs, roundMs: event.roundMs, audioDurationSeconds: event.audioDurationSeconds, rtf: event.rtf, underflows: event.underflows ?? 0 }
      break
    case 'preview-audio':
      next.previewAudio = event.data || ''
      next.previewMime = event.mime || 'audio/wav'
      break
    case 'voice-applied':
      next.appliedVoiceId = event.voiceId || ''
      next.pendingVoiceSwitch = true
      break
    case 'error':
      next = finalizeRealtimeMessages(next)
      next.error = event.message || event.code || '实时对话出错'
      break
    case 'closed':
      next = finalizeRealtimeMessages(next)
      next.closed = true
      break
    default:
      break
  }
  // Dedicated transcripts may carry correlation before the matching tool-end.
  if (event.callId && (event.messageId || event.turnId)) {
    next.toolCalls = next.toolCalls.map(tool => tool.callId === event.callId ? {
      ...tool,
      ...(typeof event.messageId === 'string' && event.messageId ? { messageId: event.messageId } : {}),
      ...(typeof event.turnId === 'string' && event.turnId ? { turnId: event.turnId } : {}),
    } : tool)
  }
  // Audio may arrive before its transcript; retain only bounded duration metadata.
  const audioEvent = event.type === 'audio' || (event.type === 'preview-audio' && event.purpose === 'speech')
  if (audioEvent) {
    const matching = next.messages.filter(message => message.role === 'assistant' &&
      (event.messageId ? (message.messageId || message.id) === event.messageId : message.id === next.activeAssistantMessageId) &&
      (!event.responseId || message.responseId === event.responseId))
    const id = matching.at(-1)?.id || (event.messageId ? `pending:${event.messageId}:${event.responseId || ''}` : null)
    if (id) {
      const previous = next.voiceDurations?.[id]
      const seconds = event.type === 'audio'
        ? (previous?.audioDurationSeconds || 0) + base64ToBytes(event.data || '').byteLength / (24000 * 2)
        : Number.isFinite(event.audioDurationSeconds) && event.audioDurationSeconds >= 0 ? (previous?.audioDurationSeconds || 0) + event.audioDurationSeconds : undefined
      next.voiceDurations = Object.fromEntries(Object.entries({ ...next.voiceDurations, [id]: { voice: true, audioDurationSeconds: seconds } }).slice(-MAX_REALTIME_MESSAGES))
    }
  }
  next.messages = next.messages.map(message => {
    const pendingKey = `pending:${message.messageId || message.id}:${message.responseId || ''}`
    const metadata = next.voiceDurations?.[message.id] || next.voiceDurations?.[pendingKey]
    if (!metadata) return message
    if (next.voiceDurations[pendingKey]) {
      next.voiceDurations = { ...next.voiceDurations, [message.id]: metadata }
      delete next.voiceDurations[pendingKey]
    }
    return { ...message, ...metadata }
  })
  return boundedHistory(next)
}
// Decide whether to stop playback on a speech-started (interruption).
export function shouldStopPlayback(event) {
  return event.type === 'speech-started' || event.type === 'interruption' || event.type === 'interrupted' || event.type === 'done' || event.type === 'closed' || event.type === 'error'
}

// Whether the session itself is over: the server's done flag (manual end or upstream close) or an
// upstream `closed` event. `error` deliberately does not count — audio_too_large / tts_failed are
// recoverable and the conversation continues.
export function shouldSettleRealtime(result, events) {
  return result?.done === true || (events || []).some(event => event.type === 'closed')
}

// ---- playback queue (Web Audio) ------------------------------------------
// A minimal ring of queued PCM chunks; play via injected AudioContext-like API.
// The host passes a `scheduler` with {schedule(buffer, rate): void, stop(): void}.
// Tracks underflow (gaps where playback starves before the reply finishes).
export function createPlaybackQueue(scheduler, outputRate = OUTPUT_RATE) {
  let playing = false
  let stopped = false
  let totalSamples = 0          // cumulative scheduled samples
  let firstScheduleAt = 0       // wall-clock (ms) of first schedule in this reply
  let underflows = 0            // times playback starved (gap > threshold)
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
  return {
    start() { playing = true; stopped = false; totalSamples = 0; underflows = 0; firstScheduleAt = 0 },
    stop() { stopped = true; playing = false; scheduler.stop() },
    get isPlaying() { return playing && !stopped },
    get stats() { return { underflows, totalSamples, outputRate } },
    enqueue(base64) {
      if (!playing || stopped) return
      const samples = pcm16Base64ToFloat32(base64)
      if (!samples.length) return
      const nowMs = now()
      if (!firstScheduleAt) firstScheduleAt = nowMs
      // Audio already scheduled should have played by now; if the queue is
      // starved (elapsed play time exceeds what we've scheduled), it's a gap.
      const expectedPlayed = (nowMs - firstScheduleAt) / 1000 * outputRate
      if (totalSamples > 0 && expectedPlayed > totalSamples) {
        underflows++
      }
      totalSamples += samples.length
      scheduler.schedule(samples, outputRate)
    },
  }
}

// ---- raw PCM capture (host injects getUserMedia + AudioContext) -----------
// Friendly Chinese message for a getUserMedia failure (DOMException names).
export function micErrorMessage(error) {
  const name = error && error.name
  switch (name) {
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '没有找到可用的麦克风。请连接麦克风或耳机，或在上方选择其他输入设备后重试。'
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return '麦克风权限被拒绝。请在浏览器地址栏的站点设置里允许使用麦克风后重试。'
    case 'NotReadableError':
    case 'TrackStartError':
      return '麦克风被其他程序占用或无法读取。请关闭占用麦克风的应用后重试。'
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return '所选麦克风不满足录音要求。请换一个输入设备后重试。'
    case 'SecurityError':
      return '当前页面无法使用麦克风。请在本机（localhost）或 HTTPS 页面打开。'
    case 'AbortError':
      return '麦克风启动被中断，请重试。'
    default:
      return '无法启动麦克风。请检查设备连接与浏览器权限后重试。'
  }
}

// List available audio input devices (labels may be empty before permission granted).
export async function listAudioInputs() {
  if (!globalThis.navigator?.mediaDevices?.enumerateDevices) return []
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter(d => d.kind === 'audioinput').map((d, index) => ({
      deviceId: d.deviceId,
      label: d.label || `麦克风 ${index + 1}`,
    }))
  } catch { return [] }
}

// Returns a mic controller that calls onFrame(base64Pcm16) per ~30ms of 16k audio,
// and onLevel(0..1). Cleanup stops tracks/context. `deviceId` selects a mic.
export async function startRealtimeMic({ onFrame, onLevel, onEnded, deviceId } = {}) {
  if (!globalThis.navigator?.mediaDevices?.getUserMedia) throw new Error('请在 HTTPS 或本机页面打开，并允许使用麦克风。')
  const audioConstraints = {channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true}
  // Only pin a specific device when one is explicitly chosen ("default" = system default).
  if (deviceId && deviceId !== 'default') audioConstraints.deviceId = {exact: deviceId}
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({audio: audioConstraints, video: false})
  } catch (error) {
    const friendly = new Error(micErrorMessage(error))
    friendly.name = error?.name || 'MicError'
    throw friendly
  }
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext
  const context = new Ctx()
  await context.resume()
  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(2048, 1, 1)
  const mute = context.createGain(); mute.gain.value = 0
  let remainder = new Float32Array(0)
  let stopped = false
  const release = () => {
    if (stopped) return
    stopped = true
    try { processor.onaudioprocess = null } catch {}
    try { source.disconnect(); processor.disconnect(); mute.disconnect() } catch {}
    stream.getTracks().forEach(track => track.stop())
    void context.close().catch(() => {})
  }
  processor.onaudioprocess = event => {
    if (stopped) return
    const samples = event.inputBuffer.getChannelData(0)
    const srcRate = context.sampleRate
    onLevel?.(Math.min(1, rmsForRealtime(samples) * 8))
    // resample input to 16kHz then prepend remainder for exact 30ms frames
    let down = resample(samples, srcRate, INPUT_RATE)
    if (remainder.length) { const merged = new Float32Array(remainder.length + down.length); merged.set(remainder); merged.set(down, remainder.length); down = merged }
    const { frames, remainder: rem } = chunkFrames(down, INPUT_RATE, FRAME_MS)
    remainder = rem
    for (const frame of frames) onFrame?.(frame)
  }
  source.connect(processor); processor.connect(mute); mute.connect(context.destination)
  for (const track of stream.getTracks()) track.addEventListener('ended', () => { if (!stopped) { release(); onEnded?.() } })
  return { stop: release }
}
function rmsForRealtime(samples) {
  if (!samples.length) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

// ---- preview audio (WAV) playback -----------------------------------------
// Convert a base64 WAV/MP3 preview into an object URL for <audio> playback.
export function previewAudioUrl(base64, mime = 'audio/wav') {
  if (!base64) return ''
  const bytes = base64ToBytes(base64)
  const blob = new Blob([bytes], { type: mime })
  return URL.createObjectURL(blob)
}

export const realtimeDefaults = Object.freeze({
  frameMs: FRAME_MS,
  inputRate: INPUT_RATE,
  outputRate: OUTPUT_RATE,
})
