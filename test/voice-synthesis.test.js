// 合成层接缝测试：不打真 HTTP，直接构造注入依赖（拆分步骤 3 的回归网）。
// 重点锁：①provider/profile 快照与三套凭据来源；②合成审计的字段集合与取消/失败语义；
// ③凭据值不得出现在返回体与审计文本里。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVoiceSynthesis, readProviderKey } from '../src/core/voice-synthesis.js'
import { RequestError } from '../src/core/service.js'
import { MODEL_TTS, MODEL_TTS_SYNTH, synthesisFailureText } from '../src/core/voice-design.js'
import { BREEZE_PRESET_VOICES } from '../src/core/breeze-voices.js'

const requireValue = (ok, message, status = 400) => { if (!ok) throw new RequestError(message, status) }
const emptyVoiceState = () => ({ get: () => null, list: () => [], set: () => {}, confirmed: () => null, forget: () => {}, find: () => null })

// 44 字节 PCM WAV 头 + N 秒静音：让 audioDurationSeconds 走真实解析路径而不是恒 null。
function wav(seconds = 2, rate = 24000) {
  const data = Buffer.alloc(rate * seconds)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8)
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22)
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34)
  head.write('data', 36); head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

function fixture({ settings, reply, credentialKey = 'bailian-secret-key' } = {}) {
  const audit = [], secrets = [], calls = [], managed = [], credentials = []
  let current = settings
  const synth = createVoiceSynthesis({
    getSettings: () => current,
    credential: async () => { credentials.push(credentialKey); return { key: credentialKey } },
    modelCredential: async provider => { managed.push(provider); return { provider, key: 'managed-' + provider + '-key' } },
    audit: { append: async record => audit.push(record), addSecret: value => { if (value) secrets.push(value) } },
    fetcher: async (url, options = {}) => { calls.push({ url: String(url), options }); return reply(url, options) },
    requireValue,
  })
  return { synth, audit, secrets, calls, managed, credentials, set: next => { current = next } }
}

const qwenReply = async url => String(url).includes('SpeechSynthesizer')
  ? Response.json({ output: { audio: { url: 'https://cdn.test/a.wav' } }, usage: { characters: 12 }, request_id: 'req-1' })
  : new Response(wav(), { headers: { 'content-type': 'audio/wav' } })

test('一次 qwen 合成只落 1 条 synthesis，字段集合与凭据不外泄', async () => {
  const h = fixture({ settings: { tts_voice_provider: 'qwen', tts_profiles: {} }, reply: qwenReply })
  const result = await h.synth.synthVoiceLayer('主人，我在呢。', '', {}, { use_tts_voice: true }, emptyVoiceState())
  assert.equal(result.provider, 'bailian')
  assert.equal(result.model, MODEL_TTS_SYNTH)
  assert.equal(result.voice, 'longanhuan_v3.1')
  assert.equal(result.usageAvailable, true)
  assert.equal(h.audit.length, 1)
  assert.deepEqual(Object.keys(h.audit[0]).sort(), [
    'audioDurationSeconds', 'audioOutput', 'durationMs', 'kind', 'model', 'provider', 'requestId', 'role', 'status', 'text', 'usage', 'voice',
  ])
  assert.equal(h.audit[0].kind, 'synthesis')
  assert.equal(h.audit[0].status, 'completed')
  assert.equal(h.audit[0].requestId, 'req-1')
  assert.equal(h.audit[0].audioDurationSeconds, 2)
  // 墙钟耗时与音频时长是两个量：2 秒的音频不是 2 秒的等待。
  assert.ok(Number.isInteger(h.audit[0].durationMs) && h.audit[0].durationMs >= 0)
  assert.deepEqual(h.credentials, ['bailian-secret-key'], 'qwen 必须取百炼凭据（addSecret 由 modelCredential 负责）')
  assert.ok(!JSON.stringify(result).includes('bailian-secret-key'))
  assert.ok(!JSON.stringify(h.audit).includes('bailian-secret-key'))
})

test('voiceProfile 读 live settings：qwen 默认音色与 model 二选一不变', () => {
  const h = fixture({ settings: { tts_voice_provider: 'qwen', tts_profiles: {} }, reply: qwenReply })
  assert.deepEqual(h.synth.voiceProfile(), { provider: 'bailian', model: MODEL_TTS_SYNTH, voice: 'longanhuan_v3.1' })
  h.set({ tts_voice_provider: 'qwen', tts_profiles: { qwen: { model: MODEL_TTS, voice: '  designed-voice  ' } } })
  assert.deepEqual(h.synth.voiceProfile(), { provider: 'bailian', model: MODEL_TTS, voice: 'designed-voice' })
})

test('失败语义：abort 不留痕，上游失败留 1 条 synthesis + 1 条 error', async () => {
  const controller = new AbortController()
  controller.abort()
  const aborted = fixture({ settings: { tts_voice_provider: 'qwen', tts_profiles: {} }, reply: async () => { throw Object.assign(new Error('取消'), { status: 499 }) } })
  await assert.rejects(aborted.synth.synthVoiceLayer('文本', '', { signal: controller.signal }, { use_tts_voice: true }, emptyVoiceState()))
  assert.equal(aborted.audit.length, 0, '已 abort 的请求不应写审计')

  const failed = fixture({ settings: { tts_voice_provider: 'qwen', tts_profiles: {} }, reply: async () => new Response('upstream down', { status: 500 }) })
  await assert.rejects(failed.synth.synthVoiceLayer('文本', '', { turnId: 'turn-1' }, { use_tts_voice: true }, emptyVoiceState()), error => error.status === 500)
  assert.equal(failed.audit.length, 2)
  assert.equal(failed.audit[0].kind, 'synthesis')
  assert.equal(failed.audit[0].status, 'failed')
  assert.equal(failed.audit[0].usage, null)
  assert.equal(failed.audit[1].kind, 'error')
  assert.equal(failed.audit[1].turnId, 'turn-1')
  // 纯文本响应没法当 JSON 解析 → problem(500,{code:'NonJsonResponse'}) → 未分类=upstream
  assert.equal(failed.audit[1].text, 'Speech synthesis failed (HTTP 500, upstream, NonJsonResponse)')
  // 注：`status:'cancelled'` 分支目前只有「错误自带 499 且 signal 未 abort」才会走到，
  // 而两个上游合成器（synthesizeTts / synthesizeHttpTts）都把非 abort 失败映射成 502/402，
  // abort 又在 catch 开头直接 rethrow，所以该分支现状不可达。重构保留原样，不改审计语义。
})

// 三类「重试永远不会成功」的失败必须能事后从审计里分辨出来：此前两处写入点都只写
// `Speech synthesis failed (HTTP n)`，运维在 535 条审计里看到的是同一条。
const SYNTH_FAILURES = [
  [{ status: 429, body: { code: 'Throttling.AllocationQuota', message: 'insufficient quota' } }, 'HTTP 429, quota-or-balance, Throttling.AllocationQuota', 'insufficient quota'],
  [{ status: 401, body: { code: 'InvalidApiKey', message: 'Invalid API-key provided' } }, 'HTTP 401, authorization, InvalidApiKey', 'Invalid API-key provided'],
  [{ status: 400, body: { code: 'ModelNotFound', message: 'model not exist' } }, 'HTTP 400, model-unavailable, ModelNotFound', 'model not exist'],
]

test('合成失败审计按分类写明原因，且不回显上游原文', async () => {
  for (const [reply, detail, upstream] of SYNTH_FAILURES) {
    const h = fixture({ settings: { tts_voice_provider: 'qwen', tts_profiles: {} }, reply: async () => Response.json(reply.body, { status: reply.status }) })
    const error = await h.synth.synthVoiceLayer('文本', '', {}, { use_tts_voice: true }, emptyVoiceState()).then(() => null, e => e)
    assert.ok(error, '合成必须失败')
    assert.equal(h.audit.length, 2)
    assert.equal(h.audit[1].kind, 'error')
    assert.equal(h.audit[1].text, `Speech synthesis failed (${detail})`)
    assert.equal(h.audit[1].text, synthesisFailureText(error))
    // 上游 message 只用于分类，绝不进审计文本（可能带账号与请求细节）。
    assert.doesNotMatch(h.audit[1].text, new RegExp(upstream))
  }
  // 连 safe 都没有的错误（例如第三方代码抛的裸 Error）退化成 `HTTP n, upstream`：
  // 仍比只有一个状态码多一层「上游失败」。非百炼提供方现在由 tts-http.js 的 failure()
  // 带上 safe，见下一条用例。
  assert.equal(synthesisFailureText(Object.assign(new Error('上游挂了'), { status: 502 })), 'Speech synthesis failed (HTTP 502, upstream)')
})

// 非百炼提供方（这里走 Breeze 托管凭据）的失败以前 safe 为空：审计只能写
// `HTTP 502, upstream`，与模型侧同一轮透传的 `语音服务返回 HTTP 401` 互相矛盾，
// UI 也把 Key 失效当成可重试。现在真实码与分类都进 safe。
test('非百炼提供方 401 的审计文本写明真实码与分类，不再退化成 502/upstream', async () => {
  const h = fixture({ settings: { tts_voice_provider: 'breeze', tts_profiles: { breeze: { voice: BREEZE_PRESET_VOICES.zh } } }, reply: async () => Response.json({ code: 'InvalidApiKey', message: 'Invalid API-key provided' }, { status: 401 }) })
  const error = await h.synth.synthVoiceLayer('文本', '', {}, { use_tts_voice: true }, emptyVoiceState()).then(() => null, e => e)
  assert.ok(error, '合成必须失败')
  assert.equal(error.status, 502, '对外状态码不变')
  assert.equal(error.safe.status, 401)
  assert.equal(error.safe.category, 'authorization')
  assert.deepEqual(h.managed, ['breeze'])
  assert.equal(h.audit.length, 2)
  assert.equal(h.audit[1].kind, 'error')
  assert.equal(h.audit[1].text, 'Speech synthesis failed (HTTP 401, authorization, InvalidApiKey)')
  assert.equal(h.audit[1].text, synthesisFailureText(error))
  assert.doesNotMatch(h.audit[1].text, /Invalid API-key provided/)
})

test('Breeze 走托管凭据并按文本归一语言，不用中文预设覆盖日语', async () => {
  const h = fixture({ settings: { tts_voice_provider: 'breeze', tts_profiles: { breeze: { voice: BREEZE_PRESET_VOICES.zh } } }, reply: async () => new Response(wav(), { headers: { 'content-type': 'audio/mpeg' } }) })
  const result = await h.synth.synthVoiceLayer('主人、おはよう。', '', {}, { use_tts_voice: true }, emptyVoiceState())
  assert.deepEqual(h.managed, ['breeze'])
  assert.equal(result.language, 'ja')
  assert.equal(result.voice, BREEZE_PRESET_VOICES.ja)
  assert.equal(h.audit[0].provider, 'breeze')
  assert.match(h.calls[0].url, /output_format=mp3$/)
})

test('自定义提供方从 key_file 读凭据，key 不进返回体与审计', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voice-synth-'))
  const keyFile = join(dir, 'tts.env')
  await writeFile(keyFile, 'export TTS_API_KEY=custom-secret-value\n')
  const h = fixture({ settings: { tts_voice_provider: 'custom', tts_profiles: { custom: {
    protocol: 'custom-http', endpoint: 'https://tts.test/v1/speech', model: 'm', voice: 'v',
    key_file: keyFile, auth_type: 'bearer', format: 'wav', mime: 'audio/wav', response_type: 'binary',
  } } }, reply: async () => new Response(wav(1), { headers: { 'content-type': 'audio/wav' } }) })
  const result = await h.synth.synthVoiceLayer('文本', '', {}, { use_tts_voice: true }, emptyVoiceState())
  assert.equal(result.provider, 'custom')
  assert.deepEqual(h.managed, [], '自定义提供方不得走托管凭据')
  assert.ok(JSON.stringify(h.calls[0].options.headers).includes('custom-secret-value'), 'key_file 的凭据必须随请求发出')
  assert.deepEqual(h.secrets, ['custom-secret-value'], '非托管凭据必须登记到审计脱敏表')
  assert.ok(!JSON.stringify(result).includes('custom-secret-value'))
  assert.ok(!JSON.stringify(h.audit).includes('custom-secret-value'))
  assert.equal(h.audit[0].audioDurationSeconds, 1)
})

test('readProviderKey：按协议优先级取值，缺文件或缺 key_file 一律空串不抛', async () => {
  assert.equal(await readProviderKey(), '')
  assert.equal(await readProviderKey({}), '')
  assert.equal(await readProviderKey({ key_file: '/nonexistent/tts.env' }), '')
  const dir = await mkdtemp(join(tmpdir(), 'voice-synth-'))
  const file = join(dir, 'p.env')
  await writeFile(file, 'API_KEY=fallback\nBREEZE_API_KEY=breeze-wins\nOPENAI_API_KEY=openai-wins\n')
  assert.equal(await readProviderKey({ key_file: file, protocol: 'breeze-tts' }), 'breeze-wins')
  assert.equal(await readProviderKey({ key_file: file, protocol: 'openai-speech' }), 'openai-wins')
  assert.equal(await readProviderKey({ key_file: file }), 'fallback')
})

test('源码守卫：service.js 只注入工厂，不再自带合成层', async () => {
  const source = await readFile(new URL('../src/core/service.js', import.meta.url), 'utf8')
  assert.match(source, /import \{ createVoiceSynthesis \} from '\.\/voice-synthesis\.js'/)
  assert.ok(!source.includes('async function synthVoiceLayer'), 'service.js 不应再定义 synthVoiceLayer')
  assert.ok(!source.includes('function voiceProfile'), 'service.js 不应再定义 voiceProfile')
  assert.ok(!source.includes('async function readProviderKey'), 'service.js 不应再定义 readProviderKey')
  // 合成失败的审计文本必须由同一处构造：两个写入点各抄一份字面量正是这条 bug 的成因，
  // 改一处就漂移成两种格式，而两边的用例只会红一条。
  for (const file of ['service.js', 'voice-synthesis.js']) {
    const text = await readFile(new URL('../src/core/' + file, import.meta.url), 'utf8')
    assert.match(text, /text: synthesisFailureText\(error\)/, `${file} 的合成审计文本必须走共用构造`)
    assert.ok(!text.includes('Speech synthesis failed'), `${file} 不得再自带审计文案字面量`)
  }
})
