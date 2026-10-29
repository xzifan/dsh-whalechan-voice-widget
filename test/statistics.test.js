import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAuditLog, sanitizeAuditRecord, percentile } from '../src/audit-log.js'
import { createService } from '../src/service.js'
import { audioDurationSeconds } from '../src/audio-duration.js'

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'voice-statistics-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const path = join(dir, 'voice-audit.jsonl')
  return { dir, path, log: createAuditLog({ path, ...options }) }
}

test('statistics aggregate all retained records, Unicode codepoints and inclusive timestamps', async t => {
  const { log, path } = await fixture(t)
  for (let i = 0; i < 205; i++) await log.append({ kind: 'transcription', text: '中 😀\t A\n', sessionId: i % 2 ? 'a' : 'b', at: 100 + i })
  await log.append({ kind: 'response', at: 90, audioOutput: false, usage: { total_tokens: 999 } })
  await log.append({ kind: 'response', at: 400, audioOutput: true, audioDurationSeconds: 1.25 })
  await log.append({ kind: 'synthesis', at: 400, audioDurationSeconds: 2, usage: { input_tokens: 3, prompt_tokens: 99, output_tokens: 4, completion_tokens: 99, input_tokens_details: { text_tokens: 3 } } })
  await log.append({ kind: 'usage', at: 300, usage: { total_tokens: 10, input_tokens: 8, output_tokens: 2, details: { audio_tokens: 8 } } })
  await log.append({ kind: 'tool', at: 200, status: 'error', usage: { total_tokens: 999 } })
  await log.append({ kind: 'error', at: 201, status: 'failed' })
  const s = await log.statistics()
  assert.equal((await log.query()).records.length, 100)
  // A legacy audioDurationSeconds is not a latency sample: no timings were recorded.
  assert.deepEqual(s, { total: 211, sessions: 2, transcriptionCharacters: 615, outputAudioSeconds: 3.25, audioKnown: 2, audioMissing: 0,
    counts: { transcription: 205, response: 2, synthesis: 1, usage: 1, tool: 1, error: 1 }, failed: 2, tokens: 1016, tokenKnown: 3, tokenMissing: 1, firstAt: 90, lastAt: 400,
    latency: { firstText: { samples: 0, p50: null, p95: null }, firstAudio: { samples: 0, p50: null, p95: null }, synthesis: { samples: 0, p50: null, p95: null } },
    interrupts: { count: 0, rate: 0 } })
  assert.equal((await log.statistics({ since: 400, until: 400 })).total, 2)
  assert.equal((await log.statistics({ since: 401 })).firstAt, null)
  assert.deepEqual(await createAuditLog({ path }).statistics(), s)
})

test('latency percentiles read recorded timings only, and only speech cuts count as interruptions', async t => {
  const { log } = await fixture(t)
  for (const ms of [100, 200, 300, 400]) await log.append({ kind: 'response', status: 'completed', at: 1000, firstTextMs: ms, firstAudioMs: ms * 2 })
  await log.append({ kind: 'response', status: 'cancelled', at: 1001, interrupted: true, playedMs: 900 })
  await log.append({ kind: 'synthesis', status: 'completed', at: 1002, durationMs: 1200, audioDurationSeconds: 9 })
  // 只有音频长度、没有墙钟耗时的合成不产生样本（否则会把 9 秒音频当成 9 秒等待）
  await log.append({ kind: 'synthesis', status: 'completed', at: 1003, audioDurationSeconds: 9 })
  const s = await log.statistics()
  assert.deepEqual(s.latency.firstText, { samples: 4, p50: 200, p95: 400 })
  assert.deepEqual(s.latency.firstAudio, { samples: 4, p50: 400, p95: 800 })
  assert.deepEqual(s.latency.synthesis, { samples: 1, p50: 1200, p95: 1200 })
  assert.deepEqual(s.interrupts, { count: 1, rate: 0.2 })
  // 时间范围同样约束延迟样本与打断率
  const narrowed = await log.statistics({ since: 1001 })
  assert.deepEqual(narrowed.latency.firstText, { samples: 0, p50: null, p95: null })
  assert.deepEqual(narrowed.interrupts, { count: 1, rate: 1 })
})

test('percentile is nearest rank, keeps the caller array and answers null for no samples', () => {
  assert.equal(percentile([], 50), null)
  assert.equal(percentile([7], 95), 7)
  const values = [10, 1, 4, 9, 2]
  assert.equal(percentile(values, 50), 4)
  assert.equal(percentile(values, 95), 10)
  assert.deepEqual(values, [10, 1, 4, 9, 2], '不得原地排序调用方的数组')
})

test('known zeros, missing usage/audio, aliases and legacy response policy are explicit', async t => {
  const { log } = await fixture(t)
  for (const r of [
    { kind: 'response' }, // Legacy unknown is excluded from audio, but counted as missing tokens.
    { kind: 'response', audioOutput: false },
    { kind: 'response', audioOutput: true },
    { kind: 'response', audioDurationSeconds: 0 },
    { kind: 'synthesis', usage: { characters: 100, details: { total_tokens: 100 } } },
    { kind: 'synthesis', audioDurationSeconds: 0, usage: { total_tokens: 0, input_tokens: 99 } },
    { kind: 'usage', usage: { prompt_tokens: 2, completion_tokens: 4 } },
    { kind: 'usage', usage: { input_tokens: 1 } },
    { kind: 'usage', usage: { completion_tokens: 5 } },
    { kind: 'usage' },
  ]) await log.append(r)
  const s = await log.statistics()
  assert.equal(s.audioKnown, 2); assert.equal(s.audioMissing, 2); assert.equal(s.outputAudioSeconds, 0)
  assert.equal(s.tokens, 6); assert.equal(s.tokenKnown, 2); assert.equal(s.tokenMissing, 8)
  assert.equal(s.sessions, 0)
  const empty = await log.statistics({ until: 0 })
  assert.equal(empty.tokens, null); assert.equal(empty.outputAudioSeconds, null); assert.equal(empty.lastAt, null)
  for (const value of [-1, NaN, Infinity, '2', null]) assert.equal(sanitizeAuditRecord({ kind: 'response', audioDurationSeconds: value }).audioDurationSeconds, undefined)
  assert.equal(sanitizeAuditRecord({ kind: 'response', audioOutput: 'true' }).audioOutput, undefined)
})

test('statistics honor retention and expose storage errors', async t => {
  const { log } = await fixture(t, { maxRecords: 2 })
  for (let i = 1; i <= 3; i++) await log.append({ kind: 'transcription', at: i, text: 'x' })
  assert.equal((await log.statistics()).total, 2)
  assert.equal((await log.statistics()).firstAt, 2)
  const { path } = await fixture(t)
  await mkdir(path)
  const broken = createAuditLog({ path })
  await broken.append({ kind: 'usage' })
  assert.ok((await broken.statistics()).storageError)
  assert.equal((await broken.statistics()).total, 1)
})

test('statistics service validates millisecond ranges, method and bodies', async t => {
  const { dir } = await fixture(t)
  const service = createService({ stateDir: dir }, {})
  t.after(() => service.dispose())
  for (const body of [null, [], 1, 'x', { since: -1 }, { until: 1.5 }, { since: '1' }, { until: Infinity }, { since: Number.MAX_SAFE_INTEGER + 1 }, { since: 2, until: 1 }]) {
    await assert.rejects(service.handle('POST', '/api/statistics', body), { status: 400 })
  }
  await assert.rejects(service.handle('GET', '/api/statistics'), { status: 405 })
  assert.equal((await service.handle('POST', '/api/statistics', { since: 0, until: 0 })).body.total, 0)
})

export function wav(bytes = 48000) {
  const data = Buffer.alloc(44 + bytes)
  data.write('RIFF'); data.writeUInt32LE(36 + bytes, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(24000, 24); data.writeUInt32LE(48000, 28)
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(bytes, 40)
  return data
}

test('duration reads actual WAV, MPEG VBR, FLAC and Ogg samples, rejects malformed input', () => {
  assert.equal(audioDurationSeconds(wav()), 1)
  assert.equal(audioDurationSeconds(wav(0)), 0)
  assert.equal(audioDurationSeconds(wav().subarray(0, 45)), null)
  const mp3 = Buffer.alloc(417 + 522)
  mp3.writeUInt32BE(0xfffb9000, 0); mp3.writeUInt32BE(0xfffba000, 417)
  assert.equal(audioDurationSeconds(mp3), 2304 / 44100)
  const flac = Buffer.alloc(42); flac.write('fLaC'); flac[7] = 34; flac.writeBigUInt64BE((48000n << 44n) | 96000n, 18)
  assert.equal(audioDurationSeconds(flac), 2)
  const ogg = Buffer.alloc(47); ogg.write('OggS'); ogg[5] = 6; ogg[26] = 1; ogg[27] = 19; ogg.write('OpusHead', 28); ogg.writeUInt16LE(312, 38); ogg.writeBigUInt64LE(48312n, 6)
  assert.equal(audioDurationSeconds(ogg), 1)
  for (const data of [Buffer.from('ID3fake'), Buffer.alloc(1), mp3.subarray(0, 500), ogg.subarray(0, 46)]) assert.equal(audioDurationSeconds(data), null)
})
