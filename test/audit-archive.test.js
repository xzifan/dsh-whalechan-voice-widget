import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, stat, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuditLog } from '../src/core/audit-log.js'
import { createAuditArchive, isoWeekKey } from '../src/core/audit-archive.js'

const WEEK = 7 * 86400000
const BASE = Date.parse('2026-10-28T00:00:00Z') // 2026-W44
const entry = (index, at = BASE + index * 1000) => ({ kind: 'response', provider: 'bailian', model: 'm', sessionId: 's1', text: `line ${index}`, status: 'completed', at })
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'voice-audit-archive-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
const lines = async file => (await readFile(file, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
const listing = async dir => (await readdir(dir)).sort()

test('isoWeekKey 用 UTC ISO-8601 周：周一起算、跨年归属周四所在年、2026 有 53 周', () => {
  assert.equal(isoWeekKey(Date.parse('2025-12-28T23:59:59Z')), '2025-W52')
  assert.equal(isoWeekKey(Date.parse('2025-12-29T00:00:00Z')), '2026-W01')
  assert.equal(isoWeekKey(Date.parse('2027-01-01T00:00:00Z')), '2026-W53')
  assert.equal(isoWeekKey(Date.parse('2026-10-20T00:00:00Z')), '2026-W43')
  assert.equal(new Set(Array.from({ length: 365 }, (_, i) => isoWeekKey(Date.UTC(2026, 0, 1) + i * 86400000))).size, 53)
  for (const bad of [NaN, undefined, Infinity]) assert.equal(isoWeekKey(bad), null)
})

test('归档按记录 at 的 ISO 周分文件，记录原样落盘（含 seq），目录 0700 文件 0600', async t => {
  const dir = await tempDir(t)
  await createAuditArchive({ dir }).write([
    { id: 'a', at: Date.parse('2026-10-20T00:00:00Z'), seq: 1 },
    { id: 'b', at: Date.parse('2026-10-21T00:00:00Z'), seq: 2 },
    { id: 'c', at: Date.parse('2026-10-28T00:00:00Z'), seq: 3 },
  ])
  assert.deepEqual(await listing(dir), ['2026-W43.jsonl', '2026-W44.jsonl'])
  assert.deepEqual(await lines(join(dir, '2026-W43.jsonl')), [
    { id: 'a', at: Date.parse('2026-10-20T00:00:00Z'), seq: 1 },
    { id: 'b', at: Date.parse('2026-10-21T00:00:00Z'), seq: 2 },
  ])
  assert.deepEqual(await lines(join(dir, '2026-W44.jsonl')), [{ id: 'c', at: Date.parse('2026-10-28T00:00:00Z'), seq: 3 }])
  assert.equal((await stat(dir)).mode & 0o777, 0o700)
  assert.equal((await stat(join(dir, '2026-W43.jsonl'))).mode & 0o777, 0o600)
  // 只认周键名：脏时间戳与空批次都不落盘，也不建目录之外的垃圾文件
  assert.equal(await createAuditArchive({ dir }).write([{ id: 'd', at: NaN }]), false)
  assert.deepEqual(await listing(dir), ['2026-W43.jsonl', '2026-W44.jsonl'])
  assert.throws(() => createAuditArchive({}), TypeError)
})

test('保留最近 keepWeeks 周：更早的周文件被删除，非周文件名不碰', async t => {
  const dir = await tempDir(t)
  const now = Date.parse('2026-10-29T00:00:00Z') // 2026-W44
  const archive = createAuditArchive({ dir, keepWeeks: 3, now: () => now })
  const at = key => Date.parse(`${key}T00:00:00Z`)
  await archive.write([
    { id: 'w40', at: at('2026-09-28') }, { id: 'w41', at: at('2026-10-05') },
    { id: 'w42', at: at('2026-10-12') }, { id: 'w43', at: at('2026-10-19') }, { id: 'w44', at: at('2026-10-26') },
  ])
  await writeFile(join(dir, 'notes.txt'), 'keep me')
  await writeFile(join(dir, '2026-W01.jsonl.bak'), 'keep me too')
  await archive.write([{ id: 'w44b', at: at('2026-10-27') }])
  // cutoff = now - (3-1) 周 = W42；W40/W41 出界。两个诱饵文件不匹配周文件名格式。
  assert.deepEqual(await listing(dir), ['2026-W42.jsonl', '2026-W43.jsonl', '2026-W44.jsonl', '2026-W01.jsonl.bak', 'notes.txt'].sort())
  assert.deepEqual((await lines(join(dir, '2026-W44.jsonl'))).map(row => row.id), ['w44', 'w44b'])
})

test('回填的旧周记录不会被自己那次写入删掉，等下一次周切换才清理', async t => {
  const dir = await tempDir(t)
  const now = Date.parse('2026-10-29T00:00:00Z')
  const archive = createAuditArchive({ dir, keepWeeks: 2, now: () => now })
  const old = now - 20 * WEEK
  await archive.write([{ id: 'backfilled', at: old }])
  assert.deepEqual(await listing(dir), [`${isoWeekKey(old)}.jsonl`])
  await archive.write([{ id: 'current', at: now }])
  assert.deepEqual(await listing(dir), ['2026-W44.jsonl'])
})

test('超出条数上限时把最旧的一批写进周归档，seq 连续且不重复 sanitize', async t => {
  const dir = await tempDir(t)
  const path = join(dir, 'voice-audit.jsonl'), archiveDir = join(dir, 'audit-archive')
  const store = createAuditLog({ path, archiveDir, maxRecords: 3 })
  for (let i = 1; i <= 5; i++) await store.append(entry(i))
  const retained = await lines(path)
  const archived = await lines(join(archiveDir, `${isoWeekKey(BASE)}.jsonl`))
  assert.deepEqual(retained.map(row => row.text), ['line 3', 'line 4', 'line 5'])
  assert.deepEqual(archived.map(row => row.text), ['line 1', 'line 2'])
  // 归档必须原样保存内存记录：再跑一次 sanitizeAuditRecord 会换掉 id 并丢掉 seq
  assert.deepEqual(archived.map(row => row.seq), [1, 2])
  assert.equal(Math.max(...archived.map(row => row.seq)) + 1, Math.min(...retained.map(row => row.seq)))
  assert.deepEqual((await store.query()).records.map(row => row.seq), [5, 4, 3])
})

test('字节上限触发时同样归档（不只是条数上限）', async t => {
  const dir = await tempDir(t)
  const path = join(dir, 'voice-audit.jsonl'), archiveDir = join(dir, 'audit-archive')
  const store = createAuditLog({ path, archiveDir, maxRecords: 100, maxBytes: 700 })
  const padding = 'p'.repeat(60)
  for (let i = 1; i <= 8; i++) await store.append({ ...entry(i), text: `chunk ${padding} #${i}` })
  const archived = await lines(join(archiveDir, `${isoWeekKey(BASE)}.jsonl`)).catch(() => [])
  const retained = (await store.query({ limit: 200 })).records
  // 条数上限远未触及（maxRecords=100），所以归档只能来自字节上限。
  assert.ok(archived.length > 0, '字节上限必须也触发归档')
  assert.deepEqual([...archived, ...retained].map(row => row.seq).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(Math.max(...archived.map(row => row.seq)) + 1, Math.min(...retained.map(row => row.seq)))
  assert.match(retained[0].text, /#8$/)
})

test('加载期削减不归档：磁盘上的旧行按原行为丢弃，之后追加也不会把旧行补写进归档', async t => {
  const dir = await tempDir(t)
  const path = join(dir, 'voice-audit.jsonl'), archiveDir = join(dir, 'audit-archive')
  const seeded = createAuditLog({ path })
  for (let i = 1; i <= 6; i++) await seeded.append(entry(i))
  const reloaded = createAuditLog({ path, archiveDir, maxRecords: 2 })
  assert.deepEqual((await reloaded.query()).records.map(row => row.seq), [6, 5])
  await assert.rejects(listing(archiveDir), { code: 'ENOENT' })
  // 再追加时只归档这一次真实挤出的那条；加载期丢掉的 1–4 不得被“顺手补全”。
  await reloaded.append(entry(7))
  assert.deepEqual((await lines(join(archiveDir, `${isoWeekKey(BASE)}.jsonl`))).map(row => row.seq), [5])
})

test('归档目录不可写时不谎报 storageError，主日志照常按上限收敛，修好后补写积压的一批', async t => {
  const dir = await tempDir(t)
  const path = join(dir, 'voice-audit.jsonl'), archiveDir = join(dir, 'audit-archive')
  await writeFile(archiveDir, 'not a directory')
  const store = createAuditLog({ path, archiveDir, maxRecords: 2 })
  for (let i = 1; i <= 4; i++) assert.ok(await store.append(entry(i)))
  const result = await store.query()
  assert.equal(result.storageError, undefined)
  assert.deepEqual(result.records.map(row => row.text), ['line 4', 'line 3'])
  assert.deepEqual((await lines(path)).map(row => row.text), ['line 3', 'line 4'])
  // 归档失败的那批留在内存里，最多一批；目录恢复后随下一次追加补写，不丢也不重复。
  await rm(archiveDir)
  await store.append(entry(5))
  assert.deepEqual((await lines(join(archiveDir, `${isoWeekKey(BASE)}.jsonl`))).map(row => row.seq), [1, 2, 3])
  assert.deepEqual((await store.query()).records.map(row => row.seq), [5, 4])
})

test('开归档不改变 query / statistics / 会话历史的对外行为', async t => {
  const plain = await tempDir(t), archived = await tempDir(t)
  const build = dir => createAuditLog({ path: join(dir, 'voice-audit.jsonl'), maxRecords: 3, ...(dir === archived ? { archiveDir: join(dir, 'audit-archive') } : {}) })
  const a = build(plain), b = build(archived)
  for (const [index, kind] of [['1', 'transcription'], ['2', 'response'], ['3', 'tool'], ['4', 'synthesis'], ['5', 'error']]) {
    const row = { ...entry(Number(index)), kind, status: index === '5' ? 'failed' : 'completed', audioDurationSeconds: 1.5, messageId: 'msg-1', turnId: 'turn-1' }
    await a.append(row); await b.append(row)
  }
  const shape = ({ records, total, hasMore, nextBefore }) => ({ total, hasMore, nextBefore, records: records.map(row => [row.seq, row.kind, row.text, row.at, row.status]) })
  assert.deepEqual(shape(await b.query({ limit: 200 })), shape(await a.query({ limit: 200 })))
  assert.deepEqual(await b.statistics(), await a.statistics())
  assert.deepEqual((await b.historySessions()).sessions, (await a.historySessions()).sessions)
  const messages = view => view.messages.map(message => [message.kind, message.text, message.at])
  assert.deepEqual(messages(await b.historyMessages({ sessionId: 's1' })), messages(await a.historyMessages({ sessionId: 's1' })))
})

test('接线守卫：service 用状态目录下的 audit-archive，core 公共导出不扩大', async () => {
  const service = await readFile(new URL('../src/core/service.js', import.meta.url), 'utf8')
  assert.match(service, /archiveDir: join\(stateDir, 'audit-archive'\)/)
  const barrel = await readFile(new URL('../src/core/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(barrel, /createAuditArchive|isoWeekKey/, '归档模块只写不读，暂不扩散到 core 公共 API')
})
