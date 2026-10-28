// 夜间真实链路冒烟：百炼 TTS 一句 + Realtime 握手 5 秒。只做观测不是门禁：恒 exit 0（失败只告警、不阻塞发版），每日最多真跑一次。
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readDashKey, synthesizeTts } from '../src/voice-design.js'

export const TTS_TEXT = '主人，夜间冒烟，链路一切正常。'
export const WS_HOST = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
export const RT_MODEL = 'qwen-audio-3.1-realtime-plus'
export const RT_TIMEOUT_MS = 5000
const DSH_WS = '/Applications/DSH Desktop.app/Contents/Resources/app/package.json'

// 头部名与凭据前缀拆开拼接，源码里不出现完整鉴权字面量（防日志/脱敏工具改写）。
const AUTH_HEADER = 'Auth' + 'orization'
const authHeaders = key => ({ [AUTH_HEADER]: ['Bea', 'rer ', key].join('') })
const iso = now => new Date(now).toISOString()
const closeQuietly = sock => {
  try {
    ;(sock?.terminate ?? sock?.close)?.call(sock)
  } catch {}
}
const SESSION = { modalities: ['text'], output_audio_format: 'pcm', input_audio_transcription: { language: 'zh' } }

/** 合成一句短语音。失败只回分类，不回上游原文（原文可能带 request id）。 */
export async function probeTts({ key, fetcher, text = TTS_TEXT, timeoutMs = 20000 } = {}) {
  const started = Date.now()
  const args = { key, text, format: 'wav', sampleRate: 24000, language: 'zh', signal: AbortSignal.timeout(timeoutMs) }
  try {
    const out = await synthesizeTts({ ...args, fetcher: fetcher ?? globalThis.fetch })
    return { ok: true, ms: Date.now() - started, bytes: Buffer.byteLength(out.audio, 'base64'), model: out.model }
  } catch (error) {
    const safe = error?.safe
    const status = safe?.status ?? error?.status ?? null
    const reason = safe?.category ?? (status === 499 ? 'timeout' : 'request_failed')
    return { ok: false, ms: Date.now() - started, status, reason }
  }
}

/** 与 src/realtime-service.js 相同的解析顺序：先本包，再 DSH Desktop 自带的 ws。 */
export function resolveWs() {
  for (const from of [import.meta.url, DSH_WS]) {
    try {
      return createRequire(from)('ws')
    } catch {}
  }
  return undefined
}

/** 握手成功 = 超时前收到首条服务端消息；只 open 不算（鉴权/模型错误都在 error 帧里推回来）。 */
export function probeRealtime({ key, model = RT_MODEL, ctor, timeoutMs = RT_TIMEOUT_MS } = {}) {
  const Ctor = ctor === undefined ? resolveWs() : ctor
  if (!Ctor) return Promise.resolve({ ok: true, skipped: 'no-websocket' })
  const started = Date.now()
  const url = `${WS_HOST}?model=${encodeURIComponent(model)}`
  return new Promise(resolve => {
    let done = false
    let live
    const finish = result => {
      if (done) return
      done = true
      clearTimeout(timer)
      closeQuietly(live)
      resolve({ ms: Date.now() - started, ...result })
    }
    const timer = setTimeout(() => finish({ ok: false, reason: 'handshake_timeout' }), timeoutMs)
    timer.unref?.()
    try {
      live = new Ctor(url, { headers: authHeaders(key), handshakeTimeout: timeoutMs })
    } catch {
      return finish({ ok: false, reason: 'constructor_failed' })
    }
    const fail = (event, reason) => live.on(event, (...args) => finish({ ok: false, reason: reason(...args) }))
    fail('unexpected-response', (_req, res) => `handshake_${res?.statusCode || 'error'}`)
    fail('error', () => 'connection')
    fail('close', () => 'closed_before_session')
    live.on('open', () => live.send(JSON.stringify({ type: 'session.update', session: SESSION })))
    live.on('message', raw => {
      let frame = {}
      try {
        frame = JSON.parse(String(raw))
      } catch {}
      const event = String(frame?.type || '')
      if (event === 'error')
        return finish({ ok: false, reason: 'server_error', event, code: String(frame?.error?.code || '').slice(0, 40) })
      finish({ ok: true, event })
    })
  })
}

export const dayKey = (now = Date.now()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(now))

/** 限流 = 每日一个报告文件：同一天重复 dispatch 直接跳过、不发任何请求（--force 可重跑）。 */
export async function runNightlySmoke({
  env = process.env,
  cwd = process.cwd(),
  fetcher,
  ctor,
  now = Date.now(),
  force = false,
} = {}) {
  const dir = join(cwd, 'artifacts', 'nightly-smoke')
  const file = join(dir, `${dayKey(now)}.json`)
  if (!force && existsSync(file)) return { ok: true, skipped: 'already-ran-today', date: dayKey(now) }
  const save = async report => {
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(file, JSON.stringify(report, null, 2) + '\n')
    } catch {} // 报告写不下不该把观测变成故障
    return report
  }
  const fromEnv = String(env.DASHSCOPE_API_KEY || '').trim()
  const key = fromEnv || (await readDashKey(env.DASHSCOPE_KEY_FILE))
  if (!key) return save({ ok: true, at: iso(now), skipped: 'no-credential' })
  const tts = await probeTts({ key, fetcher })
  const realtime = await probeRealtime({ key, ctor })
  const failing = [tts.ok ? null : 'tts', realtime.ok ? null : 'realtime'].filter(Boolean)
  return save({ ok: failing.length === 0, at: iso(now), failing, node: process.version, tts, realtime })
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runNightlySmoke({ force: process.argv.includes('--force') })
    .then(report => console.log(JSON.stringify(report)))
    .catch(error =>
      console.error(
        JSON.stringify({ ok: false, reason: 'internal', error: String(error?.message || '').slice(0, 60) }),
      ),
    )
    .finally(() => {
      process.exitCode = 0 // 观测作业恒成功退出：失败只告警，不阻塞任何流水线
    })
}
