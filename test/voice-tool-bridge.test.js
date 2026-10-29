// 语音工具桥接层的接缝测试：不打 HTTP、不开 socket，直接构造注入依赖。
// 重点锁两件事：①settings 是 live getter（传快照会静默打挂 voice-settings 系列）；
// ②语音工具的准入集合与 realtime-protocol 的 DEFAULT_TOOLS 同源。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createVoiceToolBridge, breezeDisabled, breezePresets, voiceToolNames } from '../src/core/voice-tool-bridge.js'
import { DEFAULT_TOOLS } from '../src/core/realtime-protocol.js'
import { RequestError } from '../src/core/service.js'
import { BREEZE_PRESET_VOICES } from '../src/core/breeze-voices.js'

// 与 service.js 里的私有 requireValue 同形（它是注入依赖，测试照同样语义提供）。
const requireValue = (ok, message, status = 400) => { if (!ok) throw new RequestError(message, status) }
const emptyVoiceState = () => ({ get: () => null, list: () => [], set: () => {}, confirmed: () => null, forget: () => {}, find: () => null })

function fixture({ settings = { tts_voice_provider: 'qwen', tts_profiles: {}, realtime: {} }, fetch, runTool } = {}) {
  const audit = []
  const bridge = createVoiceToolBridge({
    getSettings: () => settings,
    // 模拟 commitSettings 的「整体重赋值」：快照式注入在这里必然读到旧对象。
    persistSettings: async patch => { settings = { ...settings, ...patch }; return settings },
    credential: async () => ({ key: 'test-key' }),
    synthVoiceLayer: async () => ({ provider: 'bailian', model: 'm', voice: 'v', usage: null, usageAvailable: false }),
    voiceProfile: () => ({ voice: 'current-voice' }),
    runSingleTool: runTool || (async (name, args, options) => ({ name, args, options })),
    fetcher: fetch,
    audit: { append: async record => audit.push(record), addSecret: () => {} },
    requireValue, RequestError,
  })
  return { bridge, audit, current: () => settings }
}

test('语音工具准入集合与 realtime-protocol 的 DEFAULT_TOOLS 同源，不再硬编码第二份清单', () => {
  assert.deepEqual([...voiceToolNames], DEFAULT_TOOLS)
  assert.equal(DEFAULT_TOOLS.length, 8)
  // 源码守卫：service.js 不能再自带 runVoiceTool，否则抽出的模块成了死代码。
  return readFile(new URL('../src/core/service.js', import.meta.url), 'utf8').then(source => {
    assert.match(source, /import \{ createVoiceToolBridge, breezeDisabled \} from '\.\/voice-tool-bridge\.js'/)
    assert.ok(!source.includes('async function runVoiceTool'), 'service.js 不应再定义 runVoiceTool')
    assert.ok(!source.includes("'set_tts_profile'].includes(name)"), 'service.js 不应再硬编码语音工具名清单')
  })
})

test('settings 是 live getter：set_tts_provider 整体重赋值后 get_voice_config 立即反映', async () => {
  const h = fixture()
  const switched = await h.bridge.runVoiceTool('set_tts_provider', { provider: 'mimo' }, { use_tts_voice: true }, {}, emptyVoiceState())
  assert.equal(switched.provider, 'mimo')
  assert.equal(switched.__settingsChanged, true)
  assert.deepEqual(switched.__voiceSettingsPatch, { tts_voice_provider: 'mimo', tts_profiles: { mimo: {} } })
  assert.equal(h.current().tts_voice_provider, 'mimo')
  const config = await h.bridge.runVoiceTool('get_voice_config', {}, { use_tts_voice: true }, {}, emptyVoiceState())
  assert.equal(config.provider, 'mimo', '传值快照会在这里读到 qwen')
  assert.equal(config.presetsAvailable, false)
  assert.deepEqual(config.presets, [])
})

test('Breeze 模式用固定三语预设：生成/应用/删除全部 400，列表不落到百炼', async () => {
  const h = fixture({ settings: { tts_voice_provider: 'breeze', tts_profiles: { breeze: { voice: BREEZE_PRESET_VOICES.zh } }, realtime: {} } })
  const rt = { use_tts_voice: true }
  for (const [name, args] of [['design_voice', { description: '温柔的女声' }], ['apply_voice', { voice_id: 'voc_x' }], ['delete_voice', { voice_id: 'voc_x' }]]) {
    await assert.rejects(h.bridge.runVoiceTool(name, args, rt, {}, emptyVoiceState()), error => error.status === 400 && error.message === breezeDisabled)
  }
  assert.equal(h.audit.length, 0, 'Breeze 拒绝路径不应写审计')
  const list = await h.bridge.runVoiceTool('list_voice_presets', {}, rt, {}, emptyVoiceState())
  assert.equal(list.provider, 'breeze')
  assert.deepEqual(list.presets, breezePresets())
  assert.deepEqual(list.candidates, [])
})

test('非 qwen 提供方取预设返回三键空表；design_voice 失败只写一条 kind:error', async () => {
  const h = fixture({ settings: { tts_voice_provider: 'mimo', tts_profiles: { mimo: { voice: 'x', model: 'y' } }, realtime: {} }, fetch: async () => new Response('upstream down', { status: 500 }) })
  const list = await h.bridge.runVoiceTool('list_voice_presets', {}, { use_tts_voice: true }, {}, emptyVoiceState())
  assert.deepEqual(Object.keys(list).sort(), ['candidates', 'note', 'presets'])
  assert.deepEqual(list.presets, [])

  h.current().tts_voice_provider = 'qwen'
  const context = { turnId: 'turn-1', sessionId: 's-1' }
  // Voice design failed 的审计记录写在 dispatchRealtimeTool 的 catch 里（runVoiceTool 只抛）。
  await assert.rejects(h.bridge.dispatchRealtimeTool('design_voice', { description: '温柔的女声' }, { use_tts_voice: true }, new Set(['design_voice']), '/w', context, emptyVoiceState()))
  assert.equal(h.audit.length, 1)
  assert.equal(h.audit[0].kind, 'error')
  assert.match(h.audit[0].text, /^Voice design failed \(HTTP \d+\)$/)
  assert.equal(h.audit[0].sessionId, 's-1')
})

test('dispatchRealtimeTool：语音工具直通，未启用的原生工具 400，启用的转给 runSingleTool', async () => {
  const calls = []
  const h = fixture({ runTool: async (name, args, workspace, options) => { calls.push({ name, args, options: { workspace, ...options } }); return { ok: true } } })
  const rt = { use_tts_voice: true }
  const allowed = new Set(['wait'])
  const config = await h.bridge.dispatchRealtimeTool('get_voice_config', {}, rt, allowed, '/w', { sessionId: 's-1' }, emptyVoiceState())
  assert.equal(config.provider, 'qwen')
  assert.equal(calls.length, 0, '语音工具不得落到原生工具执行器')

  await assert.rejects(h.bridge.dispatchRealtimeTool('edit', {}, rt, allowed, '/w', { sessionId: 's-1' }, emptyVoiceState()), error => error.status === 400 && error.message === '该工具未在本次会话中启用。')
  assert.deepEqual(await h.bridge.dispatchRealtimeTool('wait', { ms: 1 }, rt, allowed, '/w', { sessionId: 's-1' }, emptyVoiceState()), { ok: true })
  assert.deepEqual(calls, [{ name: 'wait', args: { ms: 1 }, options: { workspace: '/w', sessionKey: 's-1', allow: ['wait'] } }])
})
