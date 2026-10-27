import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuditLog, sanitizeAuditRecord, sanitizeAuditValue, numericUsage } from '../src/audit-log.js'

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'voice-audit-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'audit.jsonl')
  return { path, store: createAuditLog({ path, ...options }) }
}
const entry = index => ({ id: `id-${index}`, kind: index % 2 ? 'response' : 'transcription', provider: 'bailian', model: 'real-model', sessionId: index % 2 ? 's1' : 's2', text: `line ${index}`, status: 'completed' })

test('concurrent appends remain ordered and cursor pages/filter query all retained records', async t => {
  const { store, path } = await fixture(t)
  await Promise.all(Array.from({ length: 15 }, (_, i) => store.append(entry(i))))
  const first = await store.query({ limit: 4 })
  assert.deepEqual(first.records.map(r => r.seq), [15, 14, 13, 12])
  assert.equal(first.total, 15); assert.equal(first.hasMore, true); assert.equal(first.nextBefore, 12)
  const second = await store.query({ limit: 4, before: first.nextBefore })
  assert.deepEqual(second.records.map(r => r.seq), [11, 10, 9, 8])
  assert.equal(second.total, 15)
  assert.equal((await store.query({ search: 'line 0', kind: 'transcription', sessionId: 's2' })).total, 1)
  const reloaded = createAuditLog({ path })
  assert.equal((await reloaded.query()).total, 15)
  assert.equal((await reloaded.append(entry(16))).seq, 16)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
})

test('column filters match individual fields and combine with existing query filters', async t => {
  const { store } = await fixture(t)
  await store.append({ ...entry(0), text: 'Hello World', provider: 'Acme Cloud', model: 'Voice-Pro', sessionId: 'Session-AbC', messageId: 'Message-XyZ', status: 'failed', at: 0 })
  await store.append({ ...entry(1), text: 'Acme Cloud Voice-Pro Session-AbC Message-XyZ Hello', status: 'completed', at: 1 })
  await store.append({ kind: 'usage', at: 2 })
  for (const [key, value] of Object.entries({ text: 'LO WOR', provider: 'ME CLO', model: 'CE-PR', sessionId: 'ION-AB', messageId: 'AGE-XY', status: 'failed' })) {
    const result = await store.query({ columnFilters: { [key]: value } })
    assert.deepEqual(result.records.map(r => r.id), ['id-0'], key)
  }
  for (const status of ['fail', 'FAILED']) assert.equal((await store.query({ columnFilters: { status } })).total, 0)
  assert.equal((await store.query({ columnFilters: { text: '', status: '' } })).total, 3)
  const combined = { columnFilters: { text: 'hello', provider: 'ACME', status: 'failed' }, search: 'WORLD', kind: 'transcription', sessionId: 'Session-AbC', since: 0, until: 0, failed: true }
  assert.equal((await store.query(combined)).total, 1)
  assert.equal((await store.query({ ...combined, columnFilters: { ...combined.columnFilters, model: 'missing' } })).total, 0)
  assert.equal((await store.query({ since: 0, until: 0 })).total, 1)
  assert.equal((await store.query({ since: 0 })).total, 3)
  assert.equal((await store.query({ since: 1, until: 1 })).total, 1)
})

test('column filters find matches beyond the first page and preserve total and exclusive cursor semantics', async t => {
  const { store } = await fixture(t)
  for (let i = 0; i < 8; i++) await store.append({ ...entry(i), text: i < 3 ? 'Older Match' : 'Newer noise' })
  assert.ok((await store.query({ limit: 2 })).records.every(r => r.text === 'Newer noise'))
  const query = { limit: 2, columnFilters: { text: 'MATCH' } }
  const first = await store.query(query)
  assert.deepEqual(first.records.map(r => r.seq), [3, 2])
  assert.equal(first.total, 3); assert.equal(first.hasMore, true); assert.equal(first.nextBefore, 2)
  const second = await store.query({ ...query, before: first.nextBefore })
  assert.deepEqual(second.records.map(r => r.seq), [1])
  assert.equal(second.total, 3); assert.equal(second.hasMore, false); assert.equal(second.nextBefore, 1)
  const exhausted = await store.query({ ...query, before: second.nextBefore })
  assert.deepEqual(exhausted.records, [])
  assert.equal(exhausted.total, 3); assert.equal(exhausted.hasMore, false); assert.equal(exhausted.nextBefore, null)
})

test('retention atomically bounds both file count and UTF8 bytes across restart', async t => {
  const { store, path } = await fixture(t, { maxRecords: 3, maxBytes: 1500 })
  for (let i = 0; i < 10; i++) await store.append({ ...entry(i), text: '语'.repeat(80) })
  const page = await store.query()
  assert.ok(page.total <= 3); assert.ok(page.total > 0)
  assert.ok((await stat(path)).size <= 1500)
  const loaded = createAuditLog({ path, maxRecords: 3, maxBytes: 1500 })
  assert.deepEqual((await loaded.query()).records, page.records)
  assert.equal((await loaded.append(entry(11))).seq, 11)
})

test('reload drops malformed and torn lines, and compacts oversized history', async t => {
  const { store, path } = await fixture(t)
  await store.flush()
  const lines = Array.from({ length: 6 }, (_, i) => JSON.stringify({ ...entry(i), seq: i + 1 }) + '\n').join('')
  await writeFile(path, lines + 'broken\n{"torn":')
  const loaded = createAuditLog({ path, maxRecords: 2 })
  assert.deepEqual((await loaded.query()).records.map(r => r.seq), [6, 5])
  await loaded.append(entry(7))
  const content = await readFile(path, 'utf8')
  assert.equal(content.trim().split('\n').length, 2)
  for (const line of content.trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line))
})

test('storage failure never rejects append and query reports safe error state', async t => {
  const { store, path } = await fixture(t)
  await store.flush()
  await writeFile(path + '-block', 'a file')
  const unavailable = createAuditLog({ path: join(path + '-block', 'audit.jsonl') })
  await assert.doesNotReject(unavailable.append(entry(1)))
  const page = await unavailable.query()
  assert.equal(page.total, 1)
  assert.match(page.storageError, /unavailable/)
  assert.ok(!page.storageError.includes(path))
})

test('audit whitelists fields, recursively sanitizes secrets, bounds content and never invents usage', async t => {
  const { store, path } = await fixture(t)
  store.addSecret('private-provider-credential')
  const input = { ...entry(1), text: 'hello private-provider-credential Bearer abc https://audio.test/a?secret=b data:audio/wav;base64,AAAA sk-sensitive', audio: 'AAAA', headers: { Authorization: 'secret' }, voice: { id: 'v1', nested: { api_key: 'secret', cookie: 'secret', url: 'https://private.test', safe: 'ok' } }, usage: { input_tokens: 0, total_tokens: 7, details: { text_tokens: 5, audio_tokens: 2, authorization: 99 }, fake: '99', bad: -1, infinity: Infinity } }
  await store.append(input)
  const r = (await store.query()).records[0]
  assert.deepEqual(r.usage, { input_tokens: 0, total_tokens: 7, details: { text_tokens: 5, audio_tokens: 2 } })
  assert.equal(r.usageAvailable, true)
  assert.deepEqual(r.voice, { id: 'v1', nested: { safe: 'ok' } })
  assert.doesNotMatch(await readFile(path, 'utf8'), /private-provider-credential|abc|audio\.test|sk-sensitive|AAAA|Authorization/)
  assert.equal(sanitizeAuditRecord(entry(2)).usage, null)
  assert.equal(sanitizeAuditRecord(entry(2)).usageAvailable, false)
  assert.ok(sanitizeAuditRecord({ ...entry(3), text: '中'.repeat(20000) }).text.length <= 16000)
  assert.deepEqual(numericUsage({ total_tokens: 0 }), { total_tokens: 0 })
  assert.equal(numericUsage({ tokens: 'estimated' }), null)
  const circular = {}; circular.self = circular
  assert.doesNotThrow(() => sanitizeAuditValue(circular))
})

test('search matches content fields only and supports time range and failure filters', async t => {
  const { store } = await fixture(t)
  const base = Date.now()
  await store.append({ ...entry(0), at: base - 3600_000 }) // transcription / s2 / "line 0"
  await store.append({ ...entry(1), kind: 'error', status: 'failed', text: 'boom', at: base - 60_000 }) // s1
  await store.append({ ...entry(2), text: 'kind word response here line', at: base }) // transcription / s2
  assert.equal((await store.query({ search: 'response' })).total, 1)
  assert.equal((await store.query({ search: 'transcription' })).total, 0)
  assert.equal((await store.query({ search: 'LINE 0' })).total, 1)
  assert.equal((await store.query({ search: 's1' })).total, 1)
  assert.equal((await store.query({ search: 'line' })).total, 2)
  assert.equal((await store.query({ since: base - 120_000 })).total, 2)
  assert.equal((await store.query({ until: base - 120_000 })).total, 1)
  assert.equal((await store.query({ since: base - 120_000, until: base - 60_000 })).total, 1)
  assert.equal((await store.query({ failed: true })).total, 1)
  assert.equal((await store.query({ failed: true, kind: 'transcription' })).total, 0)
  assert.equal((await store.query({ search: 'boom', failed: true, since: base - 120_000 })).total, 1)
  const page = await store.query({ limit: 1, failed: true })
  assert.equal(page.total, 1); assert.equal(page.hasMore, false)
})


test('legacy response usage merges before filtering, cursor paging and statistics without changing disk', async t => {
  const {store, path} = await fixture(t)
  const ctx = {sessionId: 'session', responseId: 'response', provider: 'bailian', model: 'realtime', messageId: 'shared'}
  await store.append({...ctx, id: 'reply', kind: 'response', text: 'spoken answer', at: 100, status: 'completed'})
  await store.append({...ctx, kind: 'usage', usage: {total_tokens: 17}, at: 200})
  await store.append({...ctx, responseId: 'tool-response', kind: 'response', at: 300, usage: {total_tokens: 3}})
  const raw = await readFile(path, 'utf8')
  const first = await store.query({limit: 1})
  assert.equal(first.total, 2)
  const second = await store.query({limit: 1, before: first.nextBefore})
  assert.equal(second.records[0].id, 'reply')
  assert.equal(second.records[0].usage.total_tokens, 17)
  assert.equal(second.records[0].at, 100)
  assert.equal((await store.query({kind: 'usage'})).total, 0)
  assert.equal((await store.query({until: 100, search: '17', columnFilters: {text: 'spoken'}})).total, 1)
  assert.equal((await store.statistics()).tokens, 20)
  assert.equal((await store.statistics()).tokenKnown, 2)
  assert.equal(await readFile(path, 'utf8'), raw)
  assert.equal((await createAuditLog({path}).query()).total, 2)
  assert.deepEqual((await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse), raw.trim().split('\n').map(JSON.parse))
})

test('late response snapshots merge by ID while preserving cursor and original cancellation metadata', async t => {
  const {store} = await fixture(t)
  const response = {id: 'cancelled', kind: 'response', sessionId: 's', status: 'cancelled', text: 'partial', at: 100}
  await store.append(response)
  const before = (await store.query()).records[0]
  await store.append({...response, status: 'completed', at: 200, usage: {total_tokens: 9}})
  const result = await store.query()
  assert.equal(result.total, 1)
  assert.equal(result.records[0].seq, before.seq)
  assert.equal(result.records[0].at, 100)
  assert.equal(result.records[0].status, 'cancelled')
  assert.equal((await store.statistics()).tokens, 9)
  assert.equal((await store.query({search: '9'})).total, 1)
})

test('orphan usage remains visible and session/provider identity prevents incorrect merging', async t => {
  const {store} = await fixture(t)
  const base = {sessionId: 's', responseId: 'r', provider: 'bailian', model: 'm'}
  await store.append({...base, kind: 'response', usage: {total_tokens: 8}})
  await store.append({...base, kind: 'usage', usage: {total_tokens: 8}})
  await store.append({...base, sessionId: 'other', kind: 'usage', usage: {total_tokens: 2}})
  await store.append({...base, provider: 'other', kind: 'usage', usage: {total_tokens: 3}})
  await store.append({...base, responseId: undefined, kind: 'usage', usage: {total_tokens: 4}})
  assert.equal((await store.query()).total, 4)
  assert.equal((await store.query({kind: 'usage'})).total, 3)
  assert.equal((await store.statistics()).tokens, 17)
})
