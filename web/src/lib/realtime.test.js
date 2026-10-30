import test from 'node:test'
import assert from 'node:assert'
import {
  float32ToPcm16Base64, pcm16Base64ToFloat32, pcm16BytesToFloat32,
  bytesToBase64, base64ToBytes, chunkFrames, resample,
  advanceCursor, applyRealtimeEvent, shouldStopPlayback, shouldSettleRealtime, createPlaybackQueue,
  finalizeRealtimeMessages, MAX_REALTIME_MESSAGES, MAX_REALTIME_TOOL_CALLS, realtimeTimeline,
} from './realtime.js'

test('float32<->pcm16 base64 round-trips within quantization', () => {
  const samples = new Float32Array([0, 1, -1, 0.5, -0.5, 0.25, 0.999])
  const b64 = float32ToPcm16Base64(samples)
  const back = pcm16Base64ToFloat32(b64)
  assert.equal(back.length, samples.length)
  for (let i = 0; i < samples.length; i++) {
    // 16-bit quantization: positive scale uses 32767 vs 32768, so error ≤ 2 steps.
    assert.ok(Math.abs(back[i] - samples[i]) <= 2 / 32768 + 1e-6)
  }
})

test('bytes<->base64 round-trips', () => {
  const bytes = new Uint8Array([0, 1, 2, 127, 128, 255, 254])
  const b64 = bytesToBase64(bytes)
  const back = base64ToBytes(b64)
  assert.deepEqual([...back], [...bytes])
})

test('chunkFrames emits 30ms frames at 16kHz and carries remainder', () => {
  // 16kHz * 0.03s = 480 samples per frame.
  const inputRate = 16000
  const total = 480 * 3 + 200 // 3 full frames + 200 leftover
  const samples = new Float32Array(total)
  for (let i = 0; i < total; i++) samples[i] = (i % 100) / 100 - 0.5
  const { frames, remainder } = chunkFrames(samples, inputRate, 30)
  assert.equal(frames.length, 3)
  assert.equal(remainder.length, 200)
  // each frame decodes to 480 samples
  for (const frame of frames) assert.equal(pcm16Base64ToFloat32(frame).length, 480)
})

test('resample halves sample count when downsampling 2x', () => {
  const samples = new Float32Array(1000)
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i)
  const out = resample(samples, 32000, 16000)
  assert.equal(out.length, 500)
})

test('advanceCursor takes max of seq values and preserves base', () => {
  const events = [{ seq: 3 }, { seq: 7 }, { seq: 5 }]
  assert.equal(advanceCursor(events, 2), 7)
  assert.equal(advanceCursor([{ seq: 1 }], 9), 9)
})

test('applyRealtimeEvent builds user and assistant text', () => {
  let state = {}
  state = applyRealtimeEvent(state, { type: 'user-transcript-delta', text: '你好' })
  state = applyRealtimeEvent(state, { type: 'user-transcript-delta', text: '主人' })
  state = applyRealtimeEvent(state, { type: 'transcript-delta', text: '我在' })
  state = applyRealtimeEvent(state, { type: 'transcript-delta', text: '呢' })
  assert.equal(state.userText, '你好主人')
  assert.equal(state.assistantText, '我在呢')
  assert.equal(state.speaking, true)
})

test('applyRealtimeEvent handles interruption and done', () => {
  let state = { speaking: true, assistantText: '正在说' }
  state = applyRealtimeEvent(state, { type: 'speech-started' })
  assert.equal(state.listening, true)
  assert.equal(state.speaking, false)
  assert.equal(state.interrupted, true)
  state = applyRealtimeEvent(state, { type: 'done' })
  assert.equal(state.done, true)
  assert.equal(state.speaking, false)
})

test('applyRealtimeEvent tracks tool lifecycle', () => {
  let state = {}
  state = applyRealtimeEvent(state, { type: 'tool-start', callId: 'c1', name: 'read' })
  assert.deepEqual(state.tool, { active: true, name: 'read', callId: 'c1' })
  state = applyRealtimeEvent(state, { type: 'tool-end', callId: 'c1', name: 'read', ok: true })
  assert.equal(state.tool.active, false)
  assert.equal(state.tool.ok, true)
})

test('applyRealtimeEvent surfaces error and closed', () => {
  assert.equal(applyRealtimeEvent({}, { type: 'error', message: 'boom' }).error, 'boom')
  const closed = applyRealtimeEvent({ speaking: true }, { type: 'closed' })
  assert.equal(closed.closed, true)
  assert.equal(closed.speaking, false)
})

test('applyRealtimeEvent records metrics and voice switch', () => {
  let state = applyRealtimeEvent({}, { type: 'metrics', firstAudioMs: 812, roundMs: 2100, audioDurationSeconds: 1.5, rtf: 1.4, underflows: 2 })
  assert.deepEqual(state.metrics, { firstAudioMs: 812, roundMs: 2100, audioDurationSeconds: 1.5, rtf: 1.4, underflows: 2 })
  state = applyRealtimeEvent(state, { type: 'voice-applied', voiceId: 'rt-9' })
  assert.equal(state.appliedVoiceId, 'rt-9')
  assert.equal(state.pendingVoiceSwitch, true)
  state = applyRealtimeEvent({}, { type: 'preview-audio', data: 'AAAA', mime: 'audio/wav' })
  assert.equal(state.previewAudio, 'AAAA')
  assert.equal(state.previewMime, 'audio/wav')
})

const reduceEvents = (events, state = {}) => events.reduce(applyRealtimeEvent, state)

test('continuous history retains two turns and updates final transcripts in place', () => {
  let state = reduceEvents([
    { type: 'speech-started' },
    { type: 'user-transcript-delta', text: 'hel' },
    { type: 'user-transcript-done', text: 'hello' },
    { type: 'speech-stopped' },
    { type: 'transcript-delta', text: 'hi' },
  ])
  const firstUser = state.messages[0].id
  const firstAssistant = state.messages[1].id
  const beforeDone = state
  state = applyRealtimeEvent(state, { type: 'transcript-done', text: 'hi there' })
  assert.equal(beforeDone.messages[1].text, 'hi', 'previous states remain immutable')
  assert.equal(state.messages[1].id, firstAssistant)
  state = reduceEvents([
    { type: 'done', status: 'completed' },
    { type: 'transcript-done', text: 'hi there' },
    { type: 'speech-started' },
  ], state)
  assert.equal(state.messages.length, 2)
  assert.equal(state.userText, '')
  assert.equal(state.assistantText, '')
  state = reduceEvents([
    { type: 'user-transcript-done', text: 'again' },
    { type: 'transcript-done', text: 'welcome back' },
    { type: 'done', status: 'completed' },
    { type: 'closed' },
  ], state)
  assert.deepEqual(state.messages.map(({ role, text, status }) => ({ role, text, status })), [
    { role: 'user', text: 'hello', status: 'complete' },
    { role: 'assistant', text: 'hi there', status: 'complete' },
    { role: 'user', text: 'again', status: 'complete' },
    { role: 'assistant', text: 'welcome back', status: 'complete' },
  ])
  assert.equal(state.messages[0].id, firstUser)
  assert.equal(state.messages[1].id, firstAssistant)
  assert.equal(new Set(state.messages.map(message => message.id)).size, 4)
})

test('speech interruption preserves partial response and accepts the next turn', () => {
  const state = reduceEvents([
    { type: 'user-transcript-done', text: 'question' },
    { type: 'transcript-delta', text: 'partial answer' },
    { type: 'speech-started' },
    { type: 'user-transcript-delta', text: 'wait' },
    { type: 'done', status: 'cancelled' },
    { type: 'user-transcript-done', text: 'wait please' },
    { type: 'transcript-delta', text: 'okay' },
    { type: 'done' },
  ])
  assert.equal(state.messages.length, 4)
  assert.deepEqual(state.messages.map(message => message.status), ['complete', 'interrupted', 'complete', 'complete'])
  assert.equal(state.messages[2].text, 'wait please')
  assert.equal(state.userText, 'wait please')
  assert.equal(state.assistantText, 'okay')
})

test('turns without speech-started reset legacy fields after done', () => {
  const state = reduceEvents([
    { type: 'user-transcript-done', text: 'one' },
    { type: 'transcript-done', text: 'first' },
    { type: 'done' },
    { type: 'user-transcript-delta', text: 'two' },
    { type: 'transcript-done', text: 'second' },
    { type: 'done' },
  ])
  assert.equal(state.messages.length, 4)
  assert.equal(state.userText, 'two')
  assert.equal(state.assistantText, 'second')
})

test('stop, close, errors and cancelled responses retain partial messages', () => {
  const active = reduceEvents([
    { type: 'user-transcript-done', text: 'hello' },
    { type: 'transcript-delta', text: 'partial' },
  ])
  for (const event of [{ type: 'closed' }, { type: 'error', message: 'lost connection' }, { type: 'done', status: 'cancelled' }, { type: 'interruption' }]) {
    const result = applyRealtimeEvent(active, event)
    assert.equal(result.messages.length, 2)
    assert.equal(result.messages[1].status, 'interrupted')
    assert.equal(result.messages[1].text, 'partial')
    assert.equal(result.speaking, false)
  }
  const stopped = finalizeRealtimeMessages(active)
  assert.equal(stopped.messages[0].status, 'complete')
  assert.equal(stopped.messages[1].status, 'interrupted')
  assert.equal(stopped.activeAssistantMessageId, null)
  assert.equal(active.messages[1].status, 'streaming')
})

test('synth_tts text joins assistant history and unrelated tools add no bubbles', () => {
  let state = reduceEvents([
    { type: 'user-transcript-done', text: 'speak' },
    { type: 'tool-start', name: 'read', callId: 'read-1' },
    { type: 'tool-end', name: 'read', callId: 'read-1', ok: true },
    { type: 'tool-start', name: 'synth_tts', callId: 'tts-1', text: 'hello' },
  ])
  assert.equal(state.messages.length, 1, 'tool arguments must not reveal undelivered speech')
  state = applyRealtimeEvent(state, { type: 'preview-audio', callId: 'tts-1', purpose: 'speech', data: 'AAAA' })
  state = applyRealtimeEvent(state, { type: 'tts-transcript', callId: 'tts-1', text: 'hello' })
  assert.equal(state.messages.length, 2)
  assert.equal(state.messages[1].status, 'streaming')
  state = applyRealtimeEvent(state, { type: 'tool-end', name: 'synth_tts', callId: 'wrong', ok: true })
  assert.equal(state.messages[1].status, 'streaming')
  state = applyRealtimeEvent(state, { type: 'tool-end', name: 'synth_tts', callId: 'tts-1', ok: true })
  assert.equal(state.messages[1].status, 'complete')
  assert.equal(state.assistantText, 'hello')
  const noText = applyRealtimeEvent({}, { type: 'tool-start', name: 'synth_tts', callId: 'tts-2' })
  assert.equal(noText.messages.length, 0)
})

test('dedicated TTS transcripts deduplicate calls and regular text in either order', () => {
  let state = reduceEvents([
    { type: 'user-transcript-done', text: 'say hello' },
    { type: 'tool-start', name: 'synth_tts', callId: 'tts-a' },
    { type: 'tts-transcript', callId: 'tts-a', text: 'hello' },
    { type: 'tts-transcript', callId: 'tts-a', text: 'hello' },
    { type: 'transcript-done', text: 'hello' },
    { type: 'tool-end', name: 'synth_tts', callId: 'tts-a', ok: true },
  ])
  assert.equal(state.messages.length, 2)
  assert.equal(state.messages[1].text, 'hello')
  assert.equal(state.messages[1].status, 'complete')
  state = reduceEvents([
    { type: 'done' },
    { type: 'speech-started' },
    { type: 'user-transcript-done', text: 'again' },
    { type: 'transcript-delta', text: 'hello' },
    { type: 'tts-transcript', callId: 'tts-b', text: 'hello again' },
  ], state)
  assert.equal(state.messages.length, 4)
  assert.equal(state.messages[3].text, 'hello again')
  const id = state.messages[3].id
  state = reduceEvents([
    { type: 'transcript-done', text: 'hello again' },
    { type: 'done' },
    { type: 'tts-transcript', callId: 'tts-c', text: 'hello again' },
  ], state)
  assert.equal(state.messages.length, 4)
  assert.equal(state.messages[3].id, id)
  assert.equal(state.messages[3].text, 'hello again')
})

test('history prunes oldest messages while retaining unique stable ids', () => {
  let state = {}
  for (let i = 0; i < 120; i++) state = reduceEvents([
    { type: 'speech-started' },
    { type: 'user-transcript-done', text: `question ${i}` },
    { type: 'transcript-done', text: `answer ${i}` },
    { type: 'done' },
  ], state)
  assert.equal(state.messages.length, MAX_REALTIME_MESSAGES)
  assert.equal(state.messages[0].text, 'question 20')
  assert.equal(state.messages.at(-1).text, 'answer 119')
  assert.equal(new Set(state.messages.map(message => message.id)).size, MAX_REALTIME_MESSAGES)
})

test('shouldStopPlayback stops on interruption/done/closed/error', () => {
  assert.equal(shouldStopPlayback({ type: 'speech-started' }), true)
  assert.equal(shouldStopPlayback({ type: 'interruption' }), true)
  assert.equal(shouldStopPlayback({ type: 'interrupted' }), true)
  assert.equal(shouldStopPlayback({ type: 'done' }), true)
  assert.equal(shouldStopPlayback({ type: 'closed' }), true)
  assert.equal(shouldStopPlayback({ type: 'error' }), true)
  assert.equal(shouldStopPlayback({ type: 'transcript-delta' }), false)
})

test('playback queue schedules chunks only while playing and stops on stop()', () => {
  const scheduled = []
  const scheduler = {
    schedule(samples, rate) { scheduled.push({ len: samples.length, rate }) },
    stop() { scheduled.push('stop') },
  }
  const queue = createPlaybackQueue(scheduler, 24000)
  queue.start()
  queue.enqueue(float32ToPcm16Base64(new Float32Array(480)))
  queue.enqueue(float32ToPcm16Base64(new Float32Array(960)))
  assert.equal(queue.isPlaying, true)
  assert.equal(scheduled.length, 2)
  assert.equal(queue.stats.underflows, 0)
  assert.equal(queue.stats.totalSamples, 480 + 960)
  queue.stop()
  assert.equal(queue.isPlaying, false)
  assert.equal(scheduled[scheduled.length - 1], 'stop')
  queue.enqueue(float32ToPcm16Base64(new Float32Array(100)))
  assert.equal(scheduled.length, 3) // nothing new scheduled after stop
})

test('pcm16BytesToFloat32 decodes raw bytes', () => {
  const view = new DataView(new ArrayBuffer(4))
  view.setInt16(0, 16384, true) // 0.5
  view.setInt16(2, -16384, true) // -0.5
  const out = pcm16BytesToFloat32(new Uint8Array(view.buffer))
  assert.equal(out.length, 2)
  assert.ok(Math.abs(out[0] - 0.5) < 1e-4)
  assert.ok(Math.abs(out[1] + 0.5) < 1e-4)
})

test('micErrorMessage maps DOMException names to friendly Chinese text', async () => {
  const {micErrorMessage} = await import('./realtime.js')
  assert.match(micErrorMessage({name: 'NotFoundError'}), /没有找到可用的麦克风/)
  assert.match(micErrorMessage({name: 'NotAllowedError'}), /权限被拒绝/)
  assert.match(micErrorMessage({name: 'NotReadableError'}), /被其他程序占用/)
  assert.match(micErrorMessage({name: 'OverconstrainedError'}), /不满足录音要求/)
  assert.match(micErrorMessage({}), /无法启动麦克风/)
  // never leaks raw English DOMException message
  assert.ok(!/Requested device not found/.test(micErrorMessage({name:'NotFoundError', message:'Requested device not found'})))
})

test('listAudioInputs returns [] without mediaDevices', async () => {
  const {listAudioInputs} = await import('./realtime.js')
  // node has no navigator.mediaDevices -> should be []
  const list = await listAudioInputs()
  assert.ok(Array.isArray(list))
})

test('server message ids correlate transcripts with audit and distinguish identical turns',()=>{
 let state={}
 for(const turnId of ['turn-a','turn-b']){
  state=applyRealtimeEvent(state,{type:'speech-started',turnId})
  state=applyRealtimeEvent(state,{type:'user-transcript-done',messageId:`${turnId}:user`,turnId,text:'你好'})
  state=applyRealtimeEvent(state,{type:'tts-transcript',messageId:`${turnId}:assistant`,turnId,callId:turnId,text:'主人，我在呢。',provider:'bailian',model:'qwen-audio-3.1-realtime-plus',sessionId:'s'})
  state=applyRealtimeEvent(state,{type:'transcript-done',messageId:`${turnId}:assistant`,turnId,text:'主人，我在呢。'})
  state=applyRealtimeEvent(state,{type:'done',status:'completed'})
 }
 assert.deepEqual(state.messages.map(m=>m.id),['turn-a:user','turn-a:assistant','turn-b:user','turn-b:assistant'])
 assert.equal(state.messages[1].text,'主人，我在呢。')
 assert.equal(state.messages[1].sessionId,'s')
 assert.equal(state.messages[3].provider,'bailian')
 state=applyRealtimeEvent(state,{type:'transcript-done',messageId:'turn-a:assistant',turnId:'turn-a',text:'迟到的第一轮最终字幕'})
 assert.equal(state.messages[1].text,'迟到的第一轮最终字幕')
 assert.equal(state.messages[3].text,'主人，我在呢。')
})


test('concurrent tools persist in shared timeline through done and finish in place', () => {
  let state = reduceEvents([
    { type: 'transcript-delta', messageId: 'm', turnId: 't', text: 'checking' },
    { type: 'tool-start', callId: 'a', messageId: 'm', turnId: 't', name: 'read', at: 1000 },
    { type: 'tool-start', callId: 'b', messageId: 'm', turnId: 't', name: 'synth_tts', at: 1100 },
    { type: 'tool-end', callId: 'a', name: 'read', ok: true, at: 1400 },
    { type: 'done' },
  ])
  assert.deepEqual(state.toolCalls.map(t => t.status), ['completed', 'running'])
  assert.equal(state.toolCalls[0].durationMs, 400)
  assert.equal(state.toolCalls[0].messageId, 'm')
  assert.equal(state.toolCalls[0].turnId, 't')
  assert.deepEqual(realtimeTimeline(state).map(t => t.id), ['m', 'tool:a', 'tool:b'])
  const original = state.toolCalls[1]
  state = applyRealtimeEvent(state, { type: 'tool-end', callId: 'b', name: 'synth_tts', ok: true, at: 1500 })
  assert.equal(state.toolCalls[1].id, original.id)
  assert.equal(state.toolCalls[1].order, original.order)
  assert.equal(state.toolCalls[1].status, 'completed')
  assert.equal(original.status, 'running')
})

test('repeated tool events neither duplicate nor reopen finished calls or reorder messages', () => {
  const state = reduceEvents([
    { type: 'tool-start', name: 'read', callId: 'a', seq: 1 },
    { type: 'tool-start', name: 'read', callId: 'a', seq: 1 },
    { type: 'transcript-delta', messageId: 'm', text: 'result' },
    { type: 'tool-end', name: 'read', callId: 'a', ok: true, seq: 3 },
    { type: 'tool-end', name: 'read', callId: 'a', ok: true, seq: 3 },
    { type: 'tool-start', name: 'read', callId: 'a', seq: 1 },
    { type: 'transcript-delta', messageId: 'm', text: ' continues' },
  ])
  assert.equal(state.toolCalls.length, 1)
  assert.equal(state.toolCalls[0].status, 'completed')
  assert.deepEqual(realtimeTimeline(state).map(t => t.id), ['tool:a', 'm'])
  assert.equal(state.messages[0].text, 'result continues')
  assert.equal(state.timelineOrder, 2)
})

test('backend tool failure is sanitized and stop cancels only running records', () => {
  const state = reduceEvents([
    { type: 'tool-start', callId: 'a', name: 'read', args: { token: 'secret' } },
    { type: 'tool-end', callId: 'a', status: 'failed', error: 'token=secret', name: 'read' },
    { type: 'tool-start', callId: 'b', name: 'search' },
    { type: 'tool-end', callId: 'c', name: 'write', status: 'cancelled' },
    { type: 'tool-end', callId: 'd', name: 'read', status: 'failed' },
  ])
  assert.deepEqual(state.toolCalls.map(t => t.status), ['failed', 'running', 'cancelled', 'failed'])
  assert.match(state.toolCalls[0].errorSummary, /执行失败/)
  assert.equal(state.toolCalls[3].errorSummary, undefined)
  assert.ok(!JSON.stringify(state.toolCalls).includes('secret'))
  for (const stopped of [finalizeRealtimeMessages(state), applyRealtimeEvent(state, { type: 'closed' }), applyRealtimeEvent(state, { type: 'error', message: 'connection lost' })]) {
    assert.deepEqual(stopped.toolCalls.map(t => t.status), ['failed', 'cancelled', 'cancelled', 'failed'])
    assert.equal(stopped.toolCalls[1].id, state.toolCalls[1].id)
  }
  assert.equal(state.toolCalls[1].status, 'running')
})

test('tool and correlated message histories remain bounded with monotonic order', () => {
  let state = {}
  for (let i = 0; i < MAX_REALTIME_TOOL_CALLS + 25; i++) state = reduceEvents([
    { type: 'transcript-done', messageId: `m-${i}`, turnId: `t-${i}`, text: 'answer' },
    { type: 'tool-start', name: 'synth_tts', callId: `c-${i}`, messageId: `m-${i}`, turnId: `t-${i}` },
    { type: 'tool-end', callId: `c-${i}`, status: 'completed' },
    { type: 'done' },
  ], state)
  assert.equal(state.toolCalls.length, MAX_REALTIME_TOOL_CALLS)
  assert.equal(state.messages.length, MAX_REALTIME_MESSAGES)
  assert.equal(state.toolCalls[0].callId, 'c-25')
  assert.equal(state.messages[0].id, 'm-25')
  const timeline = realtimeTimeline(state)
  assert.equal(new Set(timeline.map(t => t.order)).size, timeline.length)
  assert.ok(timeline.every((t, i) => i === 0 || t.order > timeline[i - 1].order))
})


test('tool appearances split assistant continuations while retaining audit identity', () => {
  let state = reduceEvents([
    { type: 'transcript-delta', messageId: 'm', text: 'before' },
    { type: 'tool-start', callId: 'a', name: 'read', messageId: 'm' },
    { type: 'transcript-delta', messageId: 'm', text: ' middle' },
    { type: 'tool-start', callId: 'a', name: 'read', messageId: 'm' },
    { type: 'tool-end', callId: 'a', name: 'read', ok: true },
    { type: 'transcript-delta', messageId: 'm', text: ' continues' },
    { type: 'tool-end', callId: 'b', name: 'search', ok: true },
    { type: 'transcript-delta', messageId: 'm', text: ' after' },
  ])
  assert.deepEqual(realtimeTimeline(state).map(item => item.kind === 'tool' ? item.callId : item.text),
    ['before', 'a', ' middle continues', 'b', ' after'])
  assert.deepEqual(state.messages.map(message => message.messageId), ['m', 'm', 'm'])
  assert.equal(new Set(state.messages.map(message => message.id)).size, 3)
  const ids = state.messages.map(message => message.id)
  const beforeDone = state
  state = applyRealtimeEvent(state, { type: 'transcript-done', messageId: 'm', text: 'before middle continues after!' })
  assert.deepEqual(state.messages.map(message => message.text), ['before', ' middle continues', ' after!'])
  assert.deepEqual(state.messages.map(message => message.status), ['complete', 'complete', 'complete'])
  assert.deepEqual(state.messages.map(message => message.id), ids)
  assert.equal(beforeDone.messages.at(-1).text, ' after')
  assert.equal(state.assistantText, 'before middle continues after!')
})

test('cumulative final text after a tool adds only its new suffix, including without server ids', () => {
  for (const correlation of [{ messageId: 'm' }, {}]) {
    let state = reduceEvents([
      { type: 'transcript-delta', ...correlation, text: 'before' },
      { type: 'tool-start', callId: 'a', name: 'read' },
      { type: 'transcript-done', ...correlation, text: 'before after' },
      { type: 'done' },
      { type: 'transcript-done', ...correlation, text: 'before after!' },
    ])
    assert.deepEqual(realtimeTimeline(state).map(item => item.kind === 'tool' ? item.callId : item.text), ['before', 'a', ' after!'])
    assert.equal(state.done, true)
    assert.equal(state.speaking, false)
    assert.equal(state.activeAssistantMessageId, null)
    state = applyRealtimeEvent(state, { type: 'transcript-done', ...correlation, text: 'before after!' })
    assert.equal(state.messages.length, 2)
  }
})

test('late cumulative done updates old segments without hijacking the current turn', () => {
  const state = reduceEvents([
    { type: 'transcript-delta', messageId: 'old', text: 'before' },
    { type: 'tool-start', callId: 'a', name: 'read' },
    { type: 'transcript-delta', messageId: 'old', text: ' after' },
    { type: 'done' },
    { type: 'speech-started' },
    { type: 'user-transcript-done', messageId: 'u', text: 'next' },
    { type: 'transcript-delta', messageId: 'new', text: 'current' },
  ])
  const updated = applyRealtimeEvent(state, { type: 'transcript-done', messageId: 'old', text: 'before corrected' })
  assert.deepEqual(updated.messages.map(message => message.text), ['before', ' corrected', 'next', 'current'])
  for (const key of ['activeAssistantMessageId', 'activeUserMessageId', 'assistantText', 'speaking', 'listening', 'done', 'interrupted']) {
    assert.equal(updated[key], state[key], key)
  }
  const continued = applyRealtimeEvent(updated, { type: 'transcript-delta', messageId: 'new', text: ' answer' })
  assert.equal(continued.messages.at(-1).text, 'current answer')
  const newerTool = applyRealtimeEvent(continued, { type: 'tool-start', callId: 'new-tool', name: 'search' })
  const lateExtension = applyRealtimeEvent(newerTool, { type: 'transcript-done', messageId: 'old', text: 'before corrected!' })
  assert.equal(lateExtension.messages.length, 4)
  assert.equal(lateExtension.messages[1].text, ' corrected!')
  assert.equal(lateExtension.messages.at(-1).text, 'current answer')
  assert.equal(lateExtension.activeAssistantMessageId, continued.activeAssistantMessageId)
})

test('responses sharing an audit message keep independent final transcripts', () => {
  let state = reduceEvents([
    { type: 'transcript-delta', messageId: 'm', responseId: 'r1', text: 'checking' },
    { type: 'tool-start', callId: 'a', name: 'read' },
    { type: 'transcript-done', messageId: 'm', responseId: 'r1', text: 'checking' },
    { type: 'transcript-delta', messageId: 'm', responseId: 'r2', text: 'result' },
    { type: 'transcript-done', messageId: 'm', responseId: 'r2', text: 'result found' },
  ])
  assert.deepEqual(state.messages.map(message => message.text), ['checking', 'result found'])
  const activeId = state.activeAssistantMessageId
  state = applyRealtimeEvent(state, { type: 'transcript-done', messageId: 'm', responseId: 'r1', text: 'checked' })
  assert.deepEqual(state.messages.map(message => message.text), ['checked', 'result found'])
  assert.equal(state.activeAssistantMessageId, activeId)
  assert.equal(state.assistantText, 'result found')
  assert.deepEqual(state.messages.map(message => message.messageId), ['m', 'm'])
})

test('continuations inherit correlation and a new response finalizes the previous bubble', () => {
  let state = reduceEvents([
    { type: 'transcript-delta', messageId: 'm', responseId: 'r1', text: 'first' },
    { type: 'tool-start', callId: 'a', name: 'read' },
    { type: 'transcript-delta', text: ' continued' },
  ])
  assert.deepEqual(state.messages.map(message => message.messageId), ['m', 'm'])
  assert.deepEqual(state.messages.map(message => message.responseId), ['r1', 'r1'])
  state = applyRealtimeEvent(state, { type: 'transcript-delta', messageId: 'm', responseId: 'r2', text: 'second' })
  assert.deepEqual(state.messages.map(message => message.status), ['complete', 'complete', 'streaming'])
  state = applyRealtimeEvent(state, { type: 'transcript-done', messageId: 'm', responseId: 'r1', text: 'first continued!' })
  assert.deepEqual(state.messages.map(message => message.text), ['first', ' continued!', 'second'])
  assert.equal(state.messages.at(-1).status, 'streaming')
})

test('TTS deduplicates full text and individual segments across tool boundaries', () => {
  let state = reduceEvents([
    { type: 'transcript-delta', messageId: 'm', text: 'before' },
    { type: 'tool-start', callId: 'read', name: 'read' },
    { type: 'transcript-delta', messageId: 'm', text: ' after' },
    { type: 'tool-start', callId: 'tts', messageId: 'm', name: 'synth_tts', text: 'before after' },
    { type: 'tts-transcript', callId: 'tts', messageId: 'm', text: 'before after' },
    { type: 'tts-transcript', callId: 'tts', messageId: 'm', text: 'before after' },
    { type: 'tts-transcript', callId: 'tts2', messageId: 'm', text: ' after' },
    { type: 'tool-start', callId: 'tts', messageId: 'm', name: 'synth_tts', text: 'before after' },
    { type: 'tool-end', callId: 'tts', name: 'synth_tts', ok: true },
  ])
  assert.deepEqual(state.messages.map(message => message.text), ['before', ' after'])
  assert.equal(state.messages.at(-1).status, 'complete')
  assert.equal(state.speaking, false)
  state = applyRealtimeEvent(state, { type: 'transcript-done', messageId: 'm', text: 'before after' })
  assert.deepEqual(state.messages.map(message => message.text), ['before', ' after'])
})

test('dedicated TTS transcript fills tool audit correlation without creating another call', () => {
  const state = reduceEvents([
    { type: 'tool-start', name: 'synth_tts', callId: 'tts' },
    { type: 'tts-transcript', callId: 'tts', messageId: 'assistant-id', turnId: 'turn-id', text: 'hello' },
    { type: 'tool-end', callId: 'tts', status: 'completed' },
  ])
  assert.equal(state.toolCalls.length, 1)
  assert.equal(state.toolCalls[0].messageId, state.messages[0].id)
  assert.equal(state.toolCalls[0].turnId, 'turn-id')
  assert.equal(state.toolCalls[0].status, 'completed')
})

test('下一轮开口清掉上一轮的错误横幅，但已结束的会话保留原因', () => {
  // 可恢复错误（audio_too_large 一类）之后用户继续说话：横幅必须消失，
  // 否则 UI 会一直挂着一条上游英文原文，而会话其实还在正常工作。
  const errored = reduceEvents([
    { type: 'user-transcript-done', text: '第一轮' },
    { type: 'transcript-delta', text: '在呢' },
    { type: 'error', message: 'Your session was closed because no response was generated for 180 seconds.' },
  ])
  assert.match(errored.error, /no response was generated/)
  // `closed` 只在真正结束/新一轮开始时置位，错误事件不动它
  assert.ok(!errored.closed)

  const resumed = applyRealtimeEvent(errored, { type: 'speech-started' })
  assert.equal(resumed.error, '')
  assert.equal(resumed.closed, false)
  assert.equal(resumed.done, false)
  assert.equal(resumed.listening, true)
  // 新一轮不得继承上一轮的流式消息状态
  assert.equal(resumed.messages.every(message => message.status !== 'streaming'), true)

  // 走 user-transcript 那条入口（push-to-talk 没有 speech-started）同样要清
  const viaTranscript = applyRealtimeEvent(errored, { type: 'user-transcript-done', text: '第二轮' })
  assert.equal(viaTranscript.error, '')

  // 致命收尾后 `closed` 已置位：错误是用户唯一能看到的结束原因，不得清掉
  const closed = applyRealtimeEvent(errored, { type: 'closed' })
  assert.equal(closed.closed, true)
  const afterClose = applyRealtimeEvent(closed, { type: 'speech-started' })
  // `closed` 的既有语义不动（新一轮仍会把它置回 false），要守的是错误不被吞掉
  assert.match(afterClose.error, /no response was generated/)
})

test('会话结束判据：done 与 closed 都算结束，单轮 done 与可恢复的 error 不算', () => {
  // 服务端 done：手动 end / 上游断连后的收尾
  assert.equal(shouldSettleRealtime({done: true}, []), true)
  // 上游只有 closed 事件、done 仍为 false —— 客户端必须自己认（本用例的核心）
  assert.equal(shouldSettleRealtime({done: false}, [{type: 'closed'}]), true)
  // 单轮回答完成不是会话结束
  assert.equal(shouldSettleRealtime({done: false}, [{type: 'done'}]), false)
  // audio_too_large / tts_failed 之后会话仍可继续：error 不得当终止信号
  assert.equal(shouldSettleRealtime({done: false}, [{type: 'error', code: 'audio_too_large'}]), false)
  // 缺字段/空响应不得误判为结束
  assert.equal(shouldSettleRealtime({}, undefined), false)
})
