import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dayKey, probeRealtime, probeTts, runNightlySmoke } from '../scripts/nightly-smoke.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/nightly-smoke.mjs', import.meta.url))
const NO_KEY = { DASHSCOPE_API_KEY: '', DASHSCOPE_KEY_FILE: '/nonexistent/bailian.env' }
const DAY = Date.parse('2026-10-29T12:00:00Z')
const mk = () => mkdtemp(join(tmpdir(), 'nightly-smoke-'))
const saved = cwd => readFile(join(cwd, 'artifacts', 'nightly-smoke', '2026-10-29.json'), 'utf8').then(JSON.parse)
/** 假百炼：SpeechSynthesizer 请求回合成结果，第二次（音频 URL）回音频字节。 */
const fakeFetch = ({ status = 200, data } = {}) => {
  const calls = []
  const fetcher = async url => {
    calls.push(String(url))
    const [s, body, bytes] = String(url).includes('SpeechSynthesizer') ? [status, data ?? { code: 'Success', output: { audio: { url: 'https://audio.test/a.wav' } } }, null] : [200, null, Buffer.from('RIFF')]
    return { ok: s >= 200 && s < 300, status: s, json: async () => body, arrayBuffer: async () => bytes ?? new ArrayBuffer(0) }
  }
  return { fetcher, calls }
}
/** 假 ws 客户端；auto=true 时收到首帧即回 session.created（模拟握手成功）。 */
const socket = auto => ({
  auto, handlers: {}, sent: [], terminated: 0, url: '', opts: {},
  on(name, fn) { this.handlers[name] = fn; if (this.auto && name === 'message') setTimeout(() => fn('{"type":"session.created"}'), 0) },
  send(raw) { this.sent.push(JSON.parse(raw)) },
  terminate() { this.terminated++ },
})
const ctorFor = sock => function (url, opts) { return Object.assign(sock, { url, opts }) }

test('dayKey 按上海时区切日；TTS 腿用默认模型合成并下载音频；401 只回授权分类', async () => {
  assert.deepEqual([dayKey(Date.parse('2026-10-29T15:59:00Z')), dayKey(Date.parse('2026-10-29T16:01:00Z'))], ['2026-10-29', '2026-10-30'])
  const ok = fakeFetch()
  const tts = await probeTts({ key: 'k1', fetcher: ok.fetcher })
  assert.deepEqual([tts.ok, tts.model, ok.calls.length, tts.bytes > 0], [true, 'qwen-audio-3.1-tts-plus', 2, true])
  const denied = fakeFetch({ status: 401, data: { code: 'InvalidApiKey', message: 'Invalid API-key provided' } })
  const bad = await probeTts({ key: 'k1', fetcher: denied.fetcher })
  assert.deepEqual([bad.ok, bad.status, bad.reason, bad.message], [false, 401, 'authorization', undefined])
  const report = await runNightlySmoke({ env: { DASHSCOPE_API_KEY: 'k1' }, cwd: await mk(), now: DAY, fetcher: denied.fetcher, ctor: ctorFor(socket(true)) })
  assert.deepEqual([report.ok, report.failing, report.realtime.ok], [false, ['tts'], true]) // TTS 失败不短路 Realtime 腿
})

test('Realtime 腿：无 ws 显式 skipped；无首帧即超时并释放句柄；首帧才算成功，error 帧算失败', async () => {
  assert.deepEqual(await probeRealtime({ key: 'k1', ctor: null }), { ok: true, skipped: 'no-websocket' })
  const idle = socket()
  const timedOut = await probeRealtime({ key: 'k1', ctor: ctorFor(idle), timeoutMs: 20 })
  assert.deepEqual([timedOut.reason, idle.terminated], ['handshake_timeout', 1])
  const live = socket()
  const pending = probeRealtime({ key: 'k1', ctor: ctorFor(live) })
  assert.deepEqual([live.opts.handshakeTimeout, Object.values(live.opts.headers)[0].endsWith(' k1')], [5000, true])
  assert.ok(live.url.endsWith('?model=qwen-audio-3.1-realtime-plus'))
  live.handlers.open({})
  assert.equal(live.sent[0].type, 'session.update')
  live.handlers.message('{"type":"session.created"}')
  assert.equal((await pending).ok, true)
  const errSock = socket()
  const errPending = probeRealtime({ key: 'k1', ctor: ctorFor(errSock), timeoutMs: 50 })
  errSock.handlers.message('{"type":"error","error":{"code":"ModelNotFound"}}')
  assert.deepEqual([(await errPending).reason, (await errPending).code], ['server_error', 'ModelNotFound'])
})

test('每日限流：同日第二次零请求，次日重跑，报告落 artifacts/；缺凭据优雅跳过', async () => {
  const cwd = await mk(), feed = fakeFetch()
  const opts = { env: { DASHSCOPE_API_KEY: 'k1' }, cwd, ctor: null, fetcher: feed.fetcher }
  assert.deepEqual([(await runNightlySmoke({ ...opts, now: DAY })).realtime.skipped], ['no-websocket'])
  const before = feed.calls.length
  assert.equal((await runNightlySmoke({ ...opts, now: DAY + 3600e3 })).skipped, 'already-ran-today')
  assert.equal(feed.calls.length, before) // 限流真的没打上游
  assert.equal((await runNightlySmoke({ ...opts, now: DAY + 86400e3 })).skipped, undefined)
  assert.equal((await saved(cwd)).tts.ok, true)
  assert.equal((await runNightlySmoke({ env: NO_KEY, cwd: await mk(), now: DAY, fetcher: feed.fetcher, ctor: null })).skipped, 'no-credential')
})

test('CLI 缺凭据时以 0 退出（失败只告警，不阻塞发版）', async () => {
  const stdout = execFileSync(process.execPath, [SCRIPT], { cwd: await mk(), env: { ...process.env, ...NO_KEY }, encoding: 'utf8' })
  assert.equal(JSON.parse(stdout.trim().split('\n').pop()).skipped, 'no-credential')
})
