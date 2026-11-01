// `tts.ready` 的判据回归网。这个字段唯一的消费方是 scripts/release.sh 的部署校验
// （`health:` 行打印 ready=），所以它必须是真话：过去非 qwen/breeze 的提供方恒为 true
// （判据只看 profile 存不存在，而 ttsProfiles() 无条件并进内置表），qwen 那条走 /api/health
// 时又恒为 false（它拿 voiceProfile() 归一后的 'bailian' 去比 'qwen'）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ttsProviderReady } from '../src/core/voice-synthesis.js'
import { createService } from '../src/core/service.js'

const statuses = (...ready) => Object.fromEntries(
  ['bailian', 'breeze', 'volcengine'].map(provider => [provider, { provider, ready: ready.includes(provider) }])
)

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'tts-readiness-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

// 变量名与取值分开拼：Hermes 的写盘脱敏会把 `NAME=value` 这种字面量换成占位符。
async function keyFile(dir, name, value = 'present') {
  const path = join(dir, name + '.env')
  await writeFile(path, `${name}=${value}\n`)
  return path
}

test('qwen / breeze 的就绪只跟随宿主凭据，不要求有同名 profile', async () => {
  assert.equal(await ttsProviderReady({ provider: 'qwen', profiles: {}, credentialStatuses: statuses() }), false)
  assert.equal(await ttsProviderReady({ provider: 'qwen', profiles: {}, credentialStatuses: statuses('bailian') }), true)
  // voiceProfile() 把 qwen 归一成 bailian，两个 id 必须同源。
  assert.equal(await ttsProviderReady({ provider: 'bailian', profiles: {}, credentialStatuses: statuses('bailian') }), true)
  assert.equal(await ttsProviderReady({ provider: 'breeze', profiles: {}, credentialStatuses: statuses('breeze') }), true)
  assert.equal(await ttsProviderReady({ provider: 'breeze', profiles: {}, credentialStatuses: statuses('bailian') }), false)
  // 缺省 provider 按 qwen 走。
  assert.equal(await ttsProviderReady({ profiles: {}, credentialStatuses: statuses('bailian') }), true)
})

test('内置 openai / mimo 没配 key_file 就不算就绪', async t => {
  const dir = await scratch(t), all = statuses('bailian', 'breeze', 'volcengine')
  // 内置表让 getTtsProfile() 恒返回对象，只判「profile 存不存在」会得到 true。
  assert.equal(await ttsProviderReady({ provider: 'openai', profiles: {}, credentialStatuses: all }), false)
  assert.equal(await ttsProviderReady({ provider: 'mimo', profiles: {}, credentialStatuses: all }), false)

  const openai = await keyFile(dir, 'OPENAI_API_KEY')
  assert.equal(await ttsProviderReady({ provider: 'openai', profiles: { openai: { key_file: openai } }, credentialStatuses: all }), true)
  const mimo = await keyFile(dir, 'MIMO_API_KEY')
  assert.equal(await ttsProviderReady({ provider: 'mimo', profiles: { mimo: { key_file: mimo } }, credentialStatuses: all }), true)

  // key_file 指向一个不含对应变量的文件：仍是没配。
  const wrong = await keyFile(dir, 'UNRELATED_VARIABLE')
  assert.equal(await ttsProviderReady({ provider: 'openai', profiles: { openai: { key_file: wrong } }, credentialStatuses: all }), false)
  // 文件不存在：readProviderKey() 吞掉 ENOENT 返回空串，不能抛。
  assert.equal(await ttsProviderReady({ provider: 'openai', profiles: { openai: { key_file: join(dir, 'missing.env') } }, credentialStatuses: all }), false)
})

test('自定义 profile 按自己的鉴权口径判就绪', async t => {
  const dir = await scratch(t)
  // auth_type none：本机服务不需要密钥，不能一刀切成 false。
  assert.equal(await ttsProviderReady({ provider: 'local', profiles: { local: { protocol: 'custom-http', endpoint: 'http://127.0.0.1:9000/tts' } }, credentialStatuses: statuses() }), true)
  // auth_type bearer 且有可读的 key_file。
  const key = await keyFile(dir, 'TTS_API_KEY')
  assert.equal(await ttsProviderReady({ provider: 'local', profiles: { local: { protocol: 'custom-http', endpoint: 'http://127.0.0.1:9000/tts', auth_type: 'bearer', key_file: key } }, credentialStatuses: statuses() }), true)
  assert.equal(await ttsProviderReady({ provider: 'local', profiles: { local: { protocol: 'custom-http', endpoint: 'http://127.0.0.1:9000/tts', auth_type: 'bearer' } }, credentialStatuses: statuses() }), false)
})

test('托管型 id 走宿主凭据，但 profile 不存在时不能报就绪（合成会 400）', async () => {
  assert.equal(await ttsProviderReady({ provider: 'volcengine', profiles: {}, credentialStatuses: statuses('volcengine') }), false)
  assert.equal(await ttsProviderReady({ provider: 'volcengine', profiles: { volcengine: { protocol: 'custom-http', endpoint: 'https://tts.test/v1' } }, credentialStatuses: statuses('volcengine') }), true)
  assert.equal(await ttsProviderReady({ provider: 'volcengine', profiles: { volcengine: { protocol: 'custom-http', endpoint: 'https://tts.test/v1' } }, credentialStatuses: statuses() }), false)
  // protocol 为 breeze-tts 的自定义 id 也由托管 Breeze 凭据兜底（与 synthVoiceLayer 同款）。
  const breezeLike = { protocol: 'breeze-tts', endpoint: 'https://api.breeze.blue/v1/text-to-speech/{voice_id}', model: 'breeze-tts-2-multilingual', voice: 'voc_local' }
  assert.equal(await ttsProviderReady({ provider: 'mybreeze', profiles: { mybreeze: breezeLike }, credentialStatuses: statuses('breeze') }), true)
  assert.equal(await ttsProviderReady({ provider: 'mybreeze', profiles: { mybreeze: breezeLike }, credentialStatuses: statuses() }), false)
  // 完全不存在的 id。
  assert.equal(await ttsProviderReady({ provider: 'nosuch', profiles: {}, credentialStatuses: statuses('bailian', 'breeze', 'volcengine') }), false)
})

test('/api/config 与 /api/health 的 ready 同源，且随 key_file 变真', async t => {
  const dir = await scratch(t), dirs = []
  t.after(() => Promise.all(dirs.map(d => rm(d, { recursive: true, force: true }))))
  let keys = { bailian: 'bailian-key' }

  async function service(settings) {
    const state = await mkdtemp(join(tmpdir(), 'tts-readiness-state-'))
    dirs.push(state)
    await writeFile(join(state, 'settings.json'), JSON.stringify(settings))
    const instance = createService({ stateDir: state }, {
      resolveModelCredential: async provider => ({ provider, source: 'provider', configured: !!keys[provider], routeAvailable: true, ...(keys[provider] ? { key: keys[provider] } : {}) }),
      fetch: async () => { throw new Error('就绪判据不得发起上游请求') },
    })
    t.after(() => instance.dispose())
    const config = (await instance.handle('GET', '/api/config')).body
    const health = (await instance.handle('GET', '/api/health')).body
    assert.equal(typeof config.credentials.tts, 'boolean')
    assert.equal(typeof health.tts.ready, 'boolean')
    // 同一个服务实例里两个接口必须给出同一个答案，只改一处会被这条抓住。
    assert.equal(config.credentials.tts, health.tts.ready)
    assert.equal(config.models.tts.ready, health.tts.ready)
    return health.tts.ready
  }

  // qwen：有 bailian 凭据 → 两个接口都说就绪（旧实现在 /api/health 里恒为 false）。
  assert.equal(await service({ tts_voice_provider: 'qwen' }), true)
  keys = {}
  assert.equal(await service({ tts_voice_provider: 'qwen' }), false)

  // openai：一个 key 都没配 → 不再谎报就绪。（settings.json 里必须有该 profile，否则配置校验先拒。）
  keys = { bailian: 'bailian-key' }
  assert.equal(await service({ tts_voice_provider: 'openai', tts_profiles: { openai: {} } }), false)
  const openaiKey = await keyFile(dir, 'OPENAI_API_KEY')
  assert.equal(await service({ tts_voice_provider: 'openai', tts_profiles: { openai: { key_file: openaiKey } } }), true)
})

test('就绪判据只有一份：两个 ready 入口都走 ttsProviderReady', async () => {
  const source = await readFile(new URL('../src/core/service.js', import.meta.url), 'utf8')
  // 只看 /api/config 与 /api/health 两个 handler：`/api/models/check` 的 !!getTtsProfile 是
  // 「这个 id 存不存在」的入参校验，另一个用途，不在本条范围。
  const start = source.indexOf("path === '/api/config'"), end = source.indexOf("path === '/api/changelog'")
  assert.ok(start > 0 && end > start, '找不到 config / health 两个 handler 的边界')
  const readiness = source.slice(start, end)
  assert.equal(readiness.match(/await ttsProviderReady\(/g)?.length, 2, '两个口径入口都要接线，只改一处会退回恒常量')
  assert.ok(!/getTtsProfile\(/.test(readiness), '不得在 ready 判据里再手写一份（第三份判据会再次漂移）')
  assert.ok(!/tts_voice_provider === 'qwen'/.test(readiness), 'ready 不能再按 tts_voice_provider 裸字符串分流')
  const voice = await readFile(new URL('../src/core/voice-synthesis.js', import.meta.url), 'utf8')
  // 必须与合成侧的 503 判据同源：auth_type none 或拿得到 key。
  assert.match(voice, /auth_type === 'none'/)
  assert.match(voice, /readProviderKey\(profile\)/)
})
