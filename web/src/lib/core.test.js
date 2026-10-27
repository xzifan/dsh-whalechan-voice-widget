import test from 'node:test'
import assert from 'node:assert/strict'
import {bridgeRequest, createRequestGate, normalizeSettings, redistributeWeights, ENDPOINT_METHODS} from './core.js'

test('linked mix remains integral, bounded and totals 100 across zero and extreme weights', () => {
  for (const initial of [[60, 40, 0], [100, 0, 0], [0, 0, 0], [1, 1, 98]]) {
    for (let index = 0; index < 3; index++) for (let value = 0; value <= 100; value++) {
      const result = redistributeWeights(initial.map(weight => ({weight})), index, value)
      assert.equal(result[index].weight, value)
      assert.equal(result.reduce((sum, row) => sum + row.weight, 0), 100)
      assert.ok(result.every(row => Number.isInteger(row.weight) && row.weight >= 0 && row.weight <= 100))
    }
  }
})

test('realtime settings keep required keys and default the TTS voice layer on', () => {
  const value = normalizeSettings()
  assert.equal(value.realtime.use_tts_voice, true)
  assert.equal(value.tts_voice_provider, 'qwen')
  assert.equal(value.realtime.turn_mode, 'smart_turn')
  assert.ok(value.realtime.tools.includes('synth_tts'))
  assert.deepEqual(value.tts_profiles, {})
  assert.deepEqual(value.enabled_tools, [])
})

test('normalizeSettings coerces workspace, prompt, tools and merges partial realtime', () => {
  const value = normalizeSettings({workspace: '/test/project', system_prompt: '回答简短', enabled_tools: ['read', 'read'], realtime: {use_tts_voice: false}, tts_voice_provider: 'openai', tts_profiles: {openai: {voice: 'alloy'}}})
  assert.equal(value.workspace, '/test/project')
  assert.deepEqual(value.enabled_tools, ['read'])
  assert.equal(value.system_prompt, '回答简短')
  assert.equal(value.realtime.use_tts_voice, false)
  assert.equal(value.tts_voice_provider, 'openai')
  assert.equal(value.tts_profiles.openai.voice, 'alloy')
})

test('request generations reject late responses after replacement and cancellation', () => {
  const gate = createRequestGate(), first = gate.next(), second = gate.next()
  assert.equal(gate.current(first), false); assert.equal(gate.current(second), true)
  gate.invalidate(); assert.equal(gate.current(second), false)
})

test('realtime and config bridge routes stay narrowly method-scoped', () => {
  assert.deepEqual(ENDPOINT_METHODS['/api/realtime/start'], ['POST'])
  assert.deepEqual(ENDPOINT_METHODS['/api/realtime/events'], ['POST'])
  assert.deepEqual(ENDPOINT_METHODS['/api/realtime/playback'], ['POST'])
  assert.deepEqual(ENDPOINT_METHODS['/api/config'], ['GET', 'PUT'])
  assert.deepEqual(ENDPOINT_METHODS['/api/config/check'], ['POST'])
  assert.deepEqual(ENDPOINT_METHODS['/api/catalog'], ['POST'])
})

test('iframe bridge validates origin/source/id and abort removes listeners and informs parent', async () => {
  const messages = [], listeners = new Set()
  const parent = {postMessage: (message, origin) => messages.push({message, origin})}
  globalThis.window = {parent, location: {origin: 'http://localhost:3080'}, addEventListener: (type, handler) => listeners.add(handler), removeEventListener: (type, handler) => listeners.delete(handler)}
  const controller = new AbortController()
  const pending = bridgeRequest('/api/catalog', 'POST', {}, controller.signal)
  const id = messages[0].message.id
  const handler = [...listeners][0]
  handler({source: {}, origin: window.location.origin, data: {type: 'voice-workbench:response', id, status: 200, body: {}}})
  handler({source: parent, origin: 'https://untrusted.example', data: {type: 'voice-workbench:response', id, status: 200, body: {}}})
  assert.equal(listeners.size, 1)
  handler({source: parent, origin: window.location.origin, data: {type: 'voice-workbench:response', id, status: 200, body: {ok: true}}})
  assert.deepEqual(await pending, {status: 200, body: {ok: true}})
  assert.equal(listeners.size, 0)
  const controller2 = new AbortController()
  const aborted = bridgeRequest('/api/config/check', 'POST', {}, controller2.signal)
  controller2.abort()
  await assert.rejects(aborted, {name: 'AbortError'})
  assert.equal(listeners.size, 0)
  assert.equal(messages.at(-1).message.type, 'voice-workbench:abort')
  assert.equal(messages.at(-1).origin, window.location.origin)
  delete globalThis.window
})