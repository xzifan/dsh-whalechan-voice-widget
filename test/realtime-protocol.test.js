import test from 'node:test'
import assert from 'node:assert/strict'
import * as protocol from '../src/realtime-protocol.js'
import * as realtime from '../src/realtime-service.js'

// 拆分自 realtime-service.js 的纯常量/提示词/Schema 层：只允许「入参 → 返回值」，
// 因此这里既锁行为，也锁「没有两份各自演化的实现」。

test('realtime-service 与 realtime-protocol 暴露的是同一批绑定，不是副本', () => {
  for (const name of ['toolDefinitions', 'realtimeDefaults', 'realtimeInstructions', 'readEnvKey']) {
    assert.equal(typeof protocol[name], 'function', `${name} 必须是函数`)
    assert.equal(realtime[name], protocol[name], `${name} 必须是同一引用`)
  }
  assert.equal(realtime.REALTIME_INSTRUCTIONS, protocol.REALTIME_INSTRUCTIONS)
  assert.equal(realtime.DEFAULT_TOOLS, protocol.DEFAULT_TOOLS)
  assert.equal(realtime.MODEL, protocol.MODEL)
  assert.equal(realtime.SYSTEM_VOICE, protocol.SYSTEM_VOICE)
})

test('realtimeDefaults 键集与顺序固定，且每次返回新的 tools 数组', () => {
  const defaults = protocol.realtimeDefaults()
  assert.deepEqual(Object.keys(defaults), [
    'enabled', 'model', 'api_host', 'credential_source', 'voice',
    'language', 'turn_mode', 'instructions', 'use_tts_voice', 'tools',
  ])
  assert.notEqual(defaults.tools, protocol.realtimeDefaults().tools)
  defaults.tools.push('leaked')
  assert.equal(protocol.realtimeDefaults().tools.includes('leaked'), false)
})

test('DEFAULT_TOOLS 恰好 8 项且顺序不变', () => {
  assert.deepEqual(protocol.DEFAULT_TOOLS, [
    'design_voice', 'list_voice_presets', 'apply_voice', 'delete_voice',
    'synth_tts', 'get_voice_config', 'set_tts_provider', 'set_tts_profile',
  ])
})

test('toolDefinitions 区分「空数组」与「未传」，原生工具去重且参数深拷贝', () => {
  assert.deepEqual(protocol.toolDefinitions([]), [])
  assert.equal(protocol.toolDefinitions(undefined).length, 8)
  const native = [
    { name: 'read', description: 'native', parameters: { type: 'object', properties: { p: { type: 'string' } } } },
    { name: 'synth_tts', description: 'shadowed', parameters: { type: 'object' } },
    { name: 'bad', description: 'array params', parameters: [] },
  ]
  const defs = protocol.toolDefinitions([], native)
  assert.deepEqual(defs.map(d => d.function.name), ['read'])
  defs[0].function.parameters.properties.p.type = 'number'
  assert.equal(native[0].parameters.properties.p.type, 'string')
})

test('realtimeInstructions 只在 use_tts_voice 时注入 synth_tts 引导', () => {
  const off = protocol.realtimeInstructions(false)
  const on = protocol.realtimeInstructions(true)
  assert.equal(off, protocol.REALTIME_INSTRUCTIONS)
  assert.equal(off.includes('synth_tts 工具把你要说的话合成'), false)
  assert.equal(on.split('synth_tts 工具把你要说的话合成').length - 1, 1)
  assert.ok(on.includes('鲸鱼娘'))
})

test('readEnvKey 在文件缺失或不可读时返回空串而不是抛出', async () => {
  assert.equal(await protocol.readEnvKey('/nonexistent/bailian.env'), '')
  assert.equal(await protocol.readEnvKey('/etc'), '')
})

test('safeCode 与 redactText 的脱敏契约', () => {
  assert.equal(protocol.safeCode('bad credential'), 'badcredential')
  assert.equal(protocol.safeCode(''), 'unknown')
  assert.equal(protocol.safeCode('x'.repeat(200)).length, 80)
  assert.equal(protocol.redactText('Bearer sk-abcdefghijklmnop'), 'Bearer [已隐藏]')
  assert.equal(protocol.redactText('api_key=secret-value').includes('secret-value'), false)
})
