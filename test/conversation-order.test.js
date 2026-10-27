import test from 'node:test'
import assert from 'node:assert/strict'
import { orderConversationRows } from '../src/conversation-order.js'
import { applyRealtimeEvent, realtimeTimeline } from '../web/src/lib/realtime.js'
import { createAuditLog } from '../src/audit-log.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const turnId = 'turn-4cfb85bf-1664-49b8-8866-59259f3334a0'
test('late ASR displays before TTS without moving tools across assistant segments', () => {
  const events = [
    { type: 'speech-started', turnId },
    { type: 'tool-start', turnId, messageId: `${turnId}:assistant`, callId: 'tts', name: 'synth_tts' },
    { type: 'user-transcript-done', turnId, messageId: `${turnId}:user`, text: '你在吗？' },
    { type: 'tts-transcript', turnId, messageId: `${turnId}:assistant`, callId: 'tts', text: '我在。' },
    { type: 'tool-end', turnId, callId: 'tts', name: 'synth_tts', ok: true },
  ]
  const state = events.reduce(applyRealtimeEvent, {})
  assert.deepEqual(realtimeTimeline(state).map(row => row.role || row.kind), ['user', 'tool', 'assistant'])
  assert.equal(state.toolCalls[0].order, 1)
  assert.equal(state.messages[0].order, 2)
})

test('late input from an older turn stays before that turn and preserves unrelated rows', () => {
  const rows = [
    { id: 'legacy', role: 'assistant' },
    { id: 'a1', turnId: 'a', role: 'assistant' },
    { id: 'tool', turnId: 'a', kind: 'tool' },
    { id: 'a2', turnId: 'a', role: 'assistant' },
    { id: 'ub', turnId: 'b', role: 'user' },
    { id: 'ua', turnId: 'a', role: 'user' },
    { id: 'b1', turnId: 'b', role: 'assistant' },
  ]
  assert.deepEqual(orderConversationRows(rows).map(row => row.id), ['legacy', 'ua', 'a1', 'tool', 'a2', 'ub', 'b1'])
  assert.deepEqual(orderConversationRows(orderConversationRows(rows)), orderConversationRows(rows))
})

test('history orders delayed transcription before response but audit retains original timestamps', async () => {
  const log = createAuditLog({ path: join(await mkdtemp(join(tmpdir(), 'voice-order-')), 'audit.jsonl') })
  await log.append({ id: 'a', sessionId: 's', turnId, kind: 'response', text: '我在。', at: 1000 })
  await log.append({ id: 'u', sessionId: 's', turnId, kind: 'transcription', text: '你在吗？', at: 1187 })
  await log.append({ id: 't', sessionId: 's', turnId, kind: 'tool', text: 'synth_tts', at: 2000 })
  const history = await log.historyMessages({ sessionId: 's' })
  assert.deepEqual(history.messages.map(row => row.id), ['u', 'a', 't'])
  assert.deepEqual(history.messages.map(row => row.at), [1187, 1000, 2000])
})
