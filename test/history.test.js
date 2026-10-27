import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuditLog } from '../src/audit-log.js'
import { createService } from '../src/service.js'

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'voice-history-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'voice-audit.jsonl')
  return { dir, path, log: createAuditLog({ path, ...options }) }
}

test('history sorts messages by time then sequence and sessions stably by last time', async t => {
  const { log, path } = await fixture(t)
  for (const row of [
    { id: 'a-late', sessionId: 'a', kind: 'response', text: 'last answer', at: 30 },
    { id: 'b', sessionId: 'b', kind: 'response', text: 'fallback reply', at: 30 },
    { id: 'a-user', sessionId: 'a', kind: 'transcription', text: 'first question', at: 10 },
    { id: 'a-tie', sessionId: 'a', kind: 'transcription', text: 'tie question', at: 30 },
    { id: 'c', sessionId: 'c', kind: 'tool', text: 'tool only', at: 40 },
  ]) await log.append(row)
  const sessions = await log.historySessions()
  assert.deepEqual(sessions.sessions.map(s => s.sessionId), ['c', 'a', 'b'])
  assert.equal(sessions.total, 3)
  assert.deepEqual(sessions.sessions[1], { sessionId: 'a', title: 'first question', preview: 'tie question', firstAt: 10, lastAt: 30, messageCount: 3, recordCount: 3 })
  assert.equal(sessions.sessions[0].title, '语音会话')
  assert.equal(sessions.sessions[0].preview, '')
  assert.equal(sessions.sessions[2].title, 'fallback reply')
  const messages = await log.historyMessages({ sessionId: 'a' })
  assert.deepEqual(messages.messages.map(m => m.id), ['a-user', 'a-late', 'a-tie'])
  assert.deepEqual(messages.messages.map(m => [m.kind, m.role]), [['user', 'user'], ['assistant', 'assistant'], ['user', 'user']])
  assert.deepEqual(messages.session, sessions.sessions[1])
  const restarted = createAuditLog({ path })
  assert.deepEqual(await restarted.historySessions(), sessions)
  assert.deepEqual(await restarted.historyMessages({ sessionId: 'a' }), messages)
})

test('history searches whole sessions beyond audit pagination without filtering their content', async t => {
  const { log } = await fixture(t)
  await log.append({ kind: 'transcription', sessionId: 'Session-AbC', text: 'needle old question', at: 1 })
  for (let i = 0; i < 205; i++) await log.append({ kind: 'response', sessionId: 'Session-AbC', text: `answer ${i}`, at: i + 2 })
  await log.append({ kind: 'tool', sessionId: 'other', text: 'unique tool text', at: 300 })
  await log.append({ kind: 'error', sessionId: 'other', text: 'unique error text', at: 301 })
  for (const search of ['NEEDLE', 'sIoN-AbC']) {
    const result = await log.historySessions({ search })
    assert.equal(result.total, 1)
    assert.equal(result.sessions[0].messageCount, 206)
    assert.equal(result.sessions[0].preview, 'answer 204')
  }
  for (const search of ['unique tool', 'unique error']) assert.equal((await log.historySessions({ search })).sessions[0].sessionId, 'other')
  assert.equal((await log.historyMessages({ sessionId: 'Session-AbC' })).messages.length, 206)
  assert.deepEqual(await log.historySessions({ search: 'not found' }), { sessions: [], total: 0 })
})

test('TTS dedup requires same session, matching identity and exact text; repeats and legacy speech survive', async t => {
  const { log } = await fixture(t)
  const rows = [
    { id: 'response', kind: 'response', messageId: 'm1', responseId: 'r1', text: 'hello' },
    { id: 'tts-message', kind: 'synthesis', messageId: 'm1', text: 'hello' },
    { id: 'tts-response', kind: 'synthesis', responseId: 'r1', text: 'hello' },
    { id: 'tts-different', kind: 'synthesis', messageId: 'm1', text: 'different text' },
    { id: 'tts-repeat', kind: 'synthesis', messageId: 'm2', responseId: 'r2', text: 'hello' },
    { id: 'response-repeat', kind: 'response', messageId: 'm3', responseId: 'r3', text: 'hello' },
    { id: 'legacy-tts', kind: 'synthesis', text: 'hello' },
    { id: 'legacy-tts-repeat', kind: 'synthesis', text: 'hello' },
    { id: 'empty-response', kind: 'response', text: '  ' },
    { id: 'empty-transcription', kind: 'transcription', text: '' },
    { id: 'empty-synthesis', kind: 'synthesis' },
    { id: 'tool', kind: 'tool', callId: 'call', text: 'tool result', status: 'completed' },
    { id: 'empty-tool', kind: 'tool' },
    { id: 'error', kind: 'error', text: 'failed', status: 'failed' },
    { id: 'empty-error', kind: 'error' },
  ]
  for (const [i, row] of rows.entries()) await log.append({ ...row, sessionId: 'a', at: i })
  await log.append({ id: 'other-tts', kind: 'synthesis', sessionId: 'b', messageId: 'm1', responseId: 'r1', text: 'hello', audioDurationSeconds: 1.5 })
  const result = await log.historyMessages({ sessionId: 'a' })
  assert.deepEqual(result.messages.map(m => m.id), ['response', 'tts-different', 'tts-repeat', 'response-repeat', 'legacy-tts', 'legacy-tts-repeat', 'tool', 'empty-tool', 'error', 'empty-error'])
  assert.equal(result.session.recordCount, rows.length)
  assert.equal(result.session.messageCount, 10)
  assert.equal(result.messages.find(m => m.id === 'tool').callId, 'call')
  assert.equal(result.messages.find(m => m.id === 'error').kind, 'error')
  const other = await log.historyMessages({ sessionId: 'b' })
  assert.equal(other.messages[0].id, 'other-tts')
  assert.equal(other.messages[0].audioDurationSeconds, 1.5)
})

test('history preserves visibleRecords usage merging and handles missing legacy IDs and empty sessions', async t => {
  const { log } = await fixture(t)
  assert.deepEqual(await log.historySessions(), { sessions: [], total: 0 })
  assert.deepEqual(await log.historyMessages({ sessionId: 'missing' }), { session: null, messages: [] })
  await log.append({ kind: 'transcription', text: 'no session' })
  await log.append({ kind: 'response', text: 'no session either' })
  assert.equal((await log.historySessions()).total, 0)
  const base = { sessionId: 'a', responseId: 'r', kind: 'response', id: 'reply', at: 1, text: 'answer', status: 'cancelled' }
  await log.append(base)
  await log.append({ ...base, at: 2, status: 'completed', usage: { total_tokens: 7 } })
  await log.append({ ...base, id: 'usage', kind: 'usage', at: 3, usage: { total_tokens: 7 } })
  const result = await log.historyMessages({ sessionId: 'a' })
  assert.equal(result.session.recordCount, 1)
  assert.equal(result.messages[0].status, 'cancelled')
  assert.equal(result.session.lastAt, 1)
  await log.append({ kind: 'usage', sessionId: 'empty', at: 10 })
  await log.append({ kind: 'response', sessionId: 'empty', at: 11 })
  const empty = await log.historyMessages({ sessionId: 'empty' })
  assert.deepEqual(empty.messages, [])
  assert.equal(empty.session.title, '语音会话')
  assert.equal(empty.session.recordCount, 2)
})

test('history sanitizes all returned fields with newly registered secrets without truncating message arrays', async t => {
  const { log } = await fixture(t)
  const secret = 'private-value'
  for (let i = 0; i < 45; i++) await log.append({ kind: 'response', sessionId: 'a', id: `${secret}-${i}`, text: `answer ${secret}`, messageId: secret, responseId: secret, callId: secret, model: secret, provider: secret, status: secret, at: i })
  await log.append({ kind: 'error', sessionId: secret, id: secret, role: secret, text: secret, status: secret, at: 50 })
  log.addSecret(secret)
  const messages = await log.historyMessages({ sessionId: 'a' })
  assert.equal(messages.messages.length, 45)
  assert.doesNotMatch(JSON.stringify(messages), /private-value/)
  assert.doesNotMatch(JSON.stringify(await log.historySessions()), /private-value/)
  assert.doesNotMatch(JSON.stringify(await log.historyMessages({ sessionId: secret })), /private-value/)
  assert.equal((await log.historySessions({ search: secret })).total, 0)
  await log.append({ kind: 'transcription', sessionId: 'unicode', text: '😀'.repeat(90), at: 1 })
  await log.append({ kind: 'response', sessionId: 'unicode', text: '中'.repeat(130), at: 2 })
  const unicode = (await log.historyMessages({ sessionId: 'unicode' })).session
  assert.equal(Array.from(unicode.title).length, 80)
  assert.equal(Array.from(unicode.preview).length, 120)
})

test('history reads all 2000 retained records and reports storage failure', async t => {
  const { log, path } = await fixture(t)
  await log.flush()
  await writeFile(path, Array.from({ length: 2005 }, (_, i) => JSON.stringify({ kind: 'transcription', sessionId: 'a', text: `line ${i}`, at: i, id: `id-${i}`, seq: i + 1 }) + '\n').join(''))
  const restarted = createAuditLog({ path })
  const result = await restarted.historyMessages({ sessionId: 'a' })
  assert.equal(result.messages.length, 2000)
  assert.equal(result.session.recordCount, 2000)
  assert.equal(result.session.firstAt, 5)
  assert.equal(result.session.lastAt, 2004)
  const brokenPath = join(path + '-directory')
  await mkdir(brokenPath)
  const broken = createAuditLog({ path: brokenPath })
  await broken.append({ kind: 'transcription', sessionId: 'a', text: 'retained in memory' })
  assert.match((await broken.historySessions()).storageError, /unavailable/)
  assert.match((await broken.historyMessages({ sessionId: 'a' })).storageError, /unavailable/)
  assert.match((await broken.historyMessages({ sessionId: 'missing' })).storageError, /unavailable/)
})

test('history service strictly validates request bodies and session IDs and works after restart', async t => {
  const { dir, log } = await fixture(t)
  await log.append({ kind: 'transcription', sessionId: 'saved-session', text: 'saved question', at: 1 })
  const service = createService({ stateDir: dir })
  t.after(() => service.dispose())
  for (const path of ['/api/history/sessions', '/api/history/messages']) {
    for (const body of [null, [], 1, 'x', true, new Date(), { unknown: true }, Object.create({ search: 'x' })]) await assert.rejects(service.handle('POST', path, body), { status: 400 })
    await assert.rejects(service.handle('GET', path), { status: 405 })
  }
  for (const search of [null, 1, {}, [], undefined, 'x'.repeat(201)]) await assert.rejects(service.handle('POST', '/api/history/sessions', { search }), { status: 400 })
  for (const sessionId of [null, undefined, '', 1, {}, [], '../a', 'with space', 'x'.repeat(101)]) await assert.rejects(service.handle('POST', '/api/history/messages', { sessionId }), { status: 400 })
  await assert.rejects(service.handle('POST', '/api/history/messages', {}), { status: 400 })
  assert.equal((await service.handle('POST', '/api/history/sessions', { search: 'SAVED' })).body.total, 1)
  assert.equal((await service.handle('POST', '/api/history/messages', { sessionId: 'saved-session' })).body.messages[0].text, 'saved question')
  assert.deepEqual((await service.handle('POST', '/api/history/messages', { sessionId: 'missing' })).body, { session: null, messages: [] })
  assert.equal((await service.handle('POST', '/api/history/sessions', { search: 'x'.repeat(200) })).body.total, 0)
})
