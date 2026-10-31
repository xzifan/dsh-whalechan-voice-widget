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
  await assert.rejects(h.bridge.dispatchRealtimeTool('design_voice', { description: '温柔的女声' }, { use_tts_voice: true }, new Set(['design_voice']), '/w', context, emptyVoiceState()), error => {
    // 模型侧拿到的是同一条 message：必须说明哪一类失败，不能只有 HTTP 码。
    assert.match(error.message, /上游返回错误/)
    assert.match(error.message, /NonJsonResponse/)
    return true
  })
  assert.equal(h.audit.length, 1)
  assert.equal(h.audit[0].kind, 'error')
  assert.match(h.audit[0].text, /^Voice design failed \(HTTP 500, upstream, NonJsonResponse\)$/)
  assert.equal(h.audit[0].code, 'NonJsonResponse', '码要作为字段落盘')
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

// 打断后 bash/edit/write 必须真的停：上下文里有取消信号时必须透传给执行器，
// 没有信号时不得凭空塞一个 `signal: undefined`（那会把既有 options 断言弄脏）。
test('原生工具转发带上会话的取消信号，没有信号时不凭空塞字段', async () => {
  const calls = []
  const h = fixture({ runTool: async (name, args, workspace, options) => { calls.push({ workspace, ...options }); return { ok: true } } })
  const rt = { use_tts_voice: true }
  const controller = new AbortController()
  await h.bridge.dispatchRealtimeTool('wait', { ms: 1 }, rt, new Set(['wait']), '/w', { sessionId: 's-1', signal: controller.signal }, emptyVoiceState())
  assert.equal(calls[0].signal, controller.signal, '取消信号必须透传，否则打断后命令仍会跑到自然结束')
  controller.abort()
  assert.equal(calls[0].signal.aborted, true)
})

// --- delete_voice：删除失败必须如实返回，且不能提前丢掉候选 -------------------
// 旧实现先 forget 再逐个 try/catch 空吞，失败后候选消失（无法重试）而模型仍收到
// {deleted:true} +「已释放配额」——百炼音色配额是账号级真资源。
const deleteCandidate = { designVoiceId: 'design-9', realtimeVoiceId: 'native-9', name: '候选' }
function voiceStateWith(candidate = deleteCandidate) {
  let current = { ...candidate }
  return {
    get: () => null,
    list: () => (current ? [current] : []),
    find: voiceId => (current && [current.designVoiceId, current.realtimeVoiceId].includes(voiceId) ? current : null),
    forget: target => { if (current && target && target.designVoiceId === current.designVoiceId) current = null },
    set: () => {},
    confirmed: () => null,
  }
}
// 按 voice_id 决定删除结果：ok / gone（上游 400 ResourceNotExist，实测形状）/ gone404 / boom500
function deleteFetch(behavior = {}) {
  return async (url, options) => {
    const id = JSON.parse(options.body).input.voice_id
    const mode = behavior[id] || 'ok'
    if (mode === 'ok') return { ok: true, json: async () => ({ code: 'Success', output: {} }) }
    if (mode === 'gone') return { ok: false, status: 400, json: async () => ({ code: 'BadRequest.ResourceNotExist', message: 'The Required resource not exist' }) }
    if (mode === 'gone404') return { ok: false, status: 404, json: async () => ({}) }
    return { ok: false, status: 500, json: async () => ({ code: 'InternalError', message: 'boom' }) }
  }
}

test('delete_voice 两个 id 都成功才 forget，结果逐 id 收集', async () => {
  const h = fixture({ fetch: deleteFetch() })
  const state = voiceStateWith()
  const result = await h.bridge.runVoiceTool('delete_voice', { voice_id: 'native-9' }, { use_tts_voice: true }, {}, state)
  assert.equal(result.deleted, true)
  assert.deepEqual(result.deletedIds, ['design-9', 'native-9'])
  assert.deepEqual(result.alreadyGone, [])
  assert.equal(state.find('native-9'), null, '两个 id 都删掉后才 forget')
})

test('delete_voice 失败如实报错、保留候选可重试、只写一条上游审计', async () => {
  const behavior = { 'native-9': 'boom500' }
  const h = fixture({ fetch: deleteFetch(behavior) })
  const state = voiceStateWith()
  const context = { turnId: 'turn-1', sessionId: 's-1' }
  await assert.rejects(
    h.bridge.dispatchRealtimeTool('delete_voice', { voice_id: 'native-9' }, { use_tts_voice: true }, new Set(['delete_voice']), '/w', context, state),
    error => error.status === 500 && /native-9/.test(error.message) && /HTTP 500/.test(error.message) && /配额尚未释放/.test(error.message),
  )
  assert.equal(state.find('native-9')?.designVoiceId, 'design-9', '失败后候选必须保留')
  assert.deepEqual(state.list().map(c => c.designVoiceId), ['design-9'])
  assert.equal(h.audit.length, 1)
  assert.equal(h.audit[0].kind, 'error')
  assert.match(h.audit[0].text, /^Voice delete failed \(HTTP 500, upstream, InternalError\)$/)
  assert.equal(h.audit[0].sessionId, 's-1')

  // 修好上游后重试：候选还在，所以重试能真的删掉并释放配额。
  behavior['native-9'] = 'ok'
  const retried = await h.bridge.dispatchRealtimeTool('delete_voice', { voice_id: 'native-9' }, { use_tts_voice: true }, new Set(['delete_voice']), '/w', context, state)
  assert.equal(retried.deleted, true)
  assert.equal(state.find('native-9'), null)
  assert.equal(h.audit.length, 1, '第二次成功不再追加失败审计')
})

test('delete_voice 部分失败会点名失败的那一半，并保留候选', async () => {
  const h = fixture({ fetch: deleteFetch({ 'native-9': 'boom500' }) })
  const state = voiceStateWith()
  await assert.rejects(
    h.bridge.runVoiceTool('delete_voice', { voice_id: 'design-9' }, { use_tts_voice: true }, {}, state),
    error => /native-9/.test(error.message) && !error.message.includes('design-9') && error.failed.length === 1 && error.failed[0] === 'native-9',
  )
  assert.equal(state.find('design-9')?.designVoiceId, 'design-9')
})

test('delete_voice 把上游「已不存在」按幂等成功处理（400 ResourceNotExist / 404）', async () => {
  for (const mode of ['gone', 'gone404']) {
    const h = fixture({ fetch: deleteFetch({ 'design-9': mode, 'native-9': mode }) })
    const state = voiceStateWith()
    const result = await h.bridge.dispatchRealtimeTool('delete_voice', { voice_id: 'native-9' }, { use_tts_voice: true }, new Set(['delete_voice']), '/w', { sessionId: 's-1' }, state)
    assert.equal(result.deleted, true, mode)
    assert.deepEqual(result.alreadyGone, ['design-9', 'native-9'], mode)
    assert.equal(state.find('native-9'), null, `${mode}: 已不存在也算删干净，不能永远卡在重试`)
    assert.equal(h.audit.length, 0, `${mode}: 幂等成功不是失败`)
  }
})

test('delete_voice 的本地 400（无候选）不写审计', async () => {
  const h = fixture({ fetch: deleteFetch() })
  await assert.rejects(
    h.bridge.dispatchRealtimeTool('delete_voice', { voice_id: 'ghost' }, { use_tts_voice: true }, new Set(['delete_voice']), '/w', { sessionId: 's-1' }, voiceStateWith()),
    error => error.status === 400,
  )
  assert.equal(h.audit.length, 0, '「没找到候选」不是上游失败，不该记成配额问题')
})
