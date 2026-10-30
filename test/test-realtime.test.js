import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createService } from '../src/core/service.js'
import { createRealtimeSession, readEnvKey, realtimeDefaults, toolDefinitions } from '../src/core/realtime-service.js'

const readSchema = { name: 'read', description: 'Native read', parameters: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', maximum: 2000 } }, required: ['file_path'], additionalProperties: false } }

// A fake WebSocket that records sends and lets the test inject server events.
function makeFakeSocket() {
  const instances = []
  class FakeSocket {
    constructor(url, opts) {
      this.url = url; this.opts = opts; this.readyState = 1
      this.handlers = {}; this.sent = []
      instances.push(this)
    }
    on(event, fn) { this.handlers[event] = fn }
    send(data) { this.sent.push(JSON.parse(data)) }
    close() { this.readyState = 3; this.handlers.close?.() }
    emit(event) { this.handlers.message?.(Buffer.from(JSON.stringify(event))) }
    emitRaw(type, payload) { this.emit({ type, ...payload }) }
  }
  FakeSocket.instances = instances
  return FakeSocket
}

test('native audio audit waits for response.done, counts exact decoded bytes and isolates responses', () => {
  const FakeSocket = makeFakeSocket(), emitted = []
  const session = createRealtimeSession({ settings: { ...realtimeDefaults(), use_tts_voice: false }, key: 'k', executeTool: async () => ({}), emit: e => emitted.push(e), WebSocketCtor: FakeSocket })
  session.connect()
  const socket = FakeSocket.instances[0]
  const audit = () => emitted.filter(e => e.type === 'audit' && e.record.kind === 'response').map(e => e.record)
  socket.emitRaw('response.created', { response: { id: 'a' } })
  socket.emitRaw('response.audio_transcript.done', { response_id: 'a', transcript: 'hello' })
  assert.equal(audit().length, 0)
  // 48002 is padded base64: encoded length * 3/4 would overcount.
  socket.emitRaw('response.audio.delta', { response_id: 'a', delta: Buffer.alloc(48002).toString('base64') })
  socket.emitRaw('response.done', { response: { id: 'a', status: 'completed' } })
  socket.emitRaw('response.done', { response: { id: 'a', status: 'completed' } })
  socket.emitRaw('response.audio.delta', { response_id: 'a', delta: Buffer.alloc(48000).toString('base64') })
  assert.equal(audit().length, 1); assert.equal(audit()[0].audioDurationSeconds, 48002 / 48000)
  assert.equal(audit()[0].audioOutput, true)
  socket.emitRaw('response.created', { response: { id: 'b' } })
  socket.emitRaw('response.text.done', { response_id: 'b', text: 'text only' })
  socket.emitRaw('response.done', { response: { id: 'b', status: 'completed' } })
  assert.equal(audit()[1].audioOutput, false); assert.equal(audit()[1].audioDurationSeconds, undefined)
  socket.emitRaw('response.created', { response: { id: 'c' } })
  socket.emitRaw('response.audio.delta', { response_id: 'c', delta: Buffer.alloc(24000).toString('base64') })
  session.cancel()
  assert.equal(audit()[2].status, 'cancelled'); assert.equal(audit()[2].audioDurationSeconds, 0.5)
  session.dispose()
  assert.equal(audit().length, 3)
})

test('readEnvKey reads DASHSCOPE_API_KEY without ever exposing it elsewhere', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whale-rt-key-'))
  const keyFile = join(dir, 'bailian.env')
  await writeFile(keyFile, 'export DASHSCOPE_API_KEY="sk-test-1234567890abcdef"\nBAILIAN_REGION=cn-beijing\n', 'utf8')
  const key = await readEnvKey(keyFile)
  assert.equal(key, 'sk-test-1234567890abcdef')
  await rm(dir, { recursive: true, force: true })
})

test('session.update payload carries voice, tools and smart_turn; start returns no key', () => {
  const FakeSocket = makeFakeSocket()
  const emitted = []
  const session = createRealtimeSession({
    settings: { ...realtimeDefaults(), enabled: true, voice: 'voc_abc', turn_mode: 'smart_turn', instructions: '自然口语', language: 'ja' },
    nativeTools: [readSchema], key: 'sk-secret-key', executeTool: async () => ({}), emit: e => emitted.push(e), WebSocketCtor: FakeSocket,
  })
  session.connect()
  const socket = FakeSocket.instances[0]
  assert.match(socket.url, /model=qwen-audio-3\.1-realtime-plus/)
  assert.equal(socket.opts.headers.Authorization, 'Bearer sk-secret-key')
  socket.emitRaw('session.created', {})
  const update = socket.sent.find(m => m.type === 'session.update')
  assert.ok(update)
  assert.equal(update.session.voice, 'voc_abc')
  assert.deepEqual(update.session.turn_detection, { type: 'smart_turn' })
  assert.equal(update.session.output_audio.language, 'ja')
  assert.ok(update.session.tools.some(t => t.function.name === 'read'))
  assert.deepEqual(update.session.tools.find(t => t.function.name === 'read').function.parameters, readSchema.parameters)
  assert.ok(update.session.tools.some(t => t.function.name === 'synth_tts'))
  assert.ok(update.session.instructions.startsWith('自然口语'))
  assert.match(update.session.instructions, /只有主人下一轮明确肯定/)
  // Custom instructions must still carry the honesty rule (failed tool != success).
  assert.match(update.session.instructions, /工具结果是唯一证据/)
  assert.equal(update.session.instructions.split('工具结果是唯一证据').length - 1, 1)
  // No raw key ever emitted to frontend.
  assert.ok(emitted.every(e => JSON.stringify(e).includes('sk-secret-key') === false))
})

test('default (no custom) instructions also carry the honesty rule', () => {
  const FakeSocket = makeFakeSocket()
  const session = createRealtimeSession({ settings: { ...realtimeDefaults(), enabled: true }, key: 'k', executeTool: async () => ({}), emit: () => {}, WebSocketCtor: FakeSocket })
  session.connect()
  const socket = FakeSocket.instances[0]
  socket.emitRaw('session.created', {})
  const update = socket.sent.find(m => m.type === 'session.update')
  assert.match(update.session.instructions, /工具结果是唯一证据/)
  assert.match(update.session.instructions, /结果为空/)
  assert.match(update.session.instructions, /只有主人下一轮明确肯定/)
})

test('audio delta, transcripts, done and closed events are sanitized and forwarded', () => {
  const FakeSocket = makeFakeSocket()
  const emitted = []
  const session = createRealtimeSession({ settings: { ...realtimeDefaults(), use_tts_voice: false }, key: 'k', executeTool: async () => ({}), emit: e => emitted.push(e), WebSocketCtor: FakeSocket })
  session.connect()
  const socket = FakeSocket.instances[0]
  socket.emitRaw('response.audio.delta', { delta: 'aGVsbG8=' })
  socket.emitRaw('response.audio_transcript.delta', { delta: 'こん' })
  socket.emitRaw('response.audio_transcript.done', { transcript: 'こんにちは' })
  socket.emitRaw('conversation.item.input_audio_transcription.delta', { text: '主人' })
  socket.emitRaw('input_audio_buffer.speech_started', {})
  socket.emitRaw('input_audio_buffer.speech_stopped', { reason: null })
  socket.emitRaw('response.done', { response: { status: 'completed' } })
  socket.close()
  assert.ok(emitted.some(e => e.type === 'audio' && e.data === 'aGVsbG8='))
  assert.ok(emitted.some(e => e.type === 'transcript-delta' && e.text === 'こん'))
  assert.ok(emitted.some(e => e.type === 'transcript-done' && e.text === 'こんにちは'))
  assert.ok(emitted.some(e => e.type === 'user-transcript-delta' && e.text === '主人'))
  assert.ok(emitted.some(e => e.type === 'speech-started'))
  assert.ok(emitted.some(e => e.type === 'done' && e.status === 'completed'))
  assert.ok(emitted.some(e => e.type === 'closed'))
})

test('function_call triggers executeTool and writes back function_call_output then response.create', async () => {
  const FakeSocket = makeFakeSocket()
  const emitted = []
  let executed = null
  const session = createRealtimeSession({
    settings: { ...realtimeDefaults(), tools: [] }, nativeTools: [readSchema], key: 'k',
    executeTool: async (name, args) => { executed = { name, args }; return { content: '文件内容' } },
    emit: e => emitted.push(e), WebSocketCtor: FakeSocket,
  })
  session.connect()
  const socket = FakeSocket.instances[0]
  socket.emitRaw('response.output_item.done', { item: { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"file_path":"/a/b.txt"}' } })
  socket.emitRaw('response.done', { response: { status: 'completed' } })
  // runTool is async; give it a tick.
  await new Promise(r => setTimeout(r, 10))
  assert.deepEqual(executed, { name: 'read', args: { file_path: '/a/b.txt' } })
  assert.ok(emitted.some(e => e.type === 'tool-start' && e.callId === 'call_1' && e.name === 'read'))
  assert.ok(emitted.some(e => e.type === 'tool-end' && e.callId === 'call_1' && e.ok === true))
  const output = socket.sent.find(m => m.type === 'conversation.item.create' && m.item?.type === 'function_call_output')
  assert.ok(output)
  assert.equal(output.item.call_id, 'call_1')
  assert.ok(socket.sent.some(m => m.type === 'response.create'))
})

test('tool errors are sanitized and marked not-ok without leaking raw content', async () => {
  const FakeSocket = makeFakeSocket()
  const emitted = []
  const session = createRealtimeSession({
    settings: { ...realtimeDefaults(), tools: [] }, nativeTools: [readSchema], key: 'k',
    executeTool: async () => { throw new Error('Authorization: Bearer sk-topsecret should be hidden') },
    emit: e => emitted.push(e), WebSocketCtor: FakeSocket,
  })
  session.connect()
  const socket = FakeSocket.instances[0]
  socket.emitRaw('response.output_item.done', { item: { type: 'function_call', call_id: 'c', name: 'read', arguments: '{}' } })
  await new Promise(r => setTimeout(r, 10))
  const end = emitted.find(e => e.type === 'tool-end')
  assert.equal(end.ok, false)
  const output = socket.sent.find(m => m.type === 'conversation.item.create' && m.item?.type === 'function_call_output')
  // The thrown message should be wrapped in {error:...} (not the raw thrown string).
  assert.doesNotMatch(output.item.output, /sk-topsecret/)
})

test('audio append forwards input_audio_buffer.append with base64 and bounds size', () => {
  const FakeSocket = makeFakeSocket()
  const session = createRealtimeSession({ settings: realtimeDefaults(), key: 'k', executeTool: async () => ({}), emit: () => {}, WebSocketCtor: FakeSocket })
  session.connect()
  const socket = FakeSocket.instances[0]
  session.appendAudio('AAAA')
  assert.ok(socket.sent.some(m => m.type === 'input_audio_buffer.append' && m.audio === 'AAAA'))
  // Oversized base64 rejected.
  session.appendAudio('x'.repeat(3 * 1024 * 1024 + 1))
  assert.equal(socket.sent.filter(m => m.type === 'input_audio_buffer.append').length, 1)
})

test('cancel, response.create, commit, and dispose emit correct client events', () => {
  const FakeSocket = makeFakeSocket()
  const session = createRealtimeSession({ settings: realtimeDefaults(), key: 'k', executeTool: async () => ({}), emit: () => {}, WebSocketCtor: FakeSocket })
  session.connect()
  const socket = FakeSocket.instances[0]
  session.createResponse(); session.commit(); session.cancel()
  assert.ok(socket.sent.some(m => m.type === 'response.create'))
  assert.ok(socket.sent.some(m => m.type === 'input_audio_buffer.commit'))
  assert.ok(socket.sent.some(m => m.type === 'response.cancel'))
  session.dispose()
  assert.equal(socket.readyState, 3)
})

test('toolDefinitions never fabricates native schemas and preserves provided parameters', () => {
  assert.deepEqual(toolDefinitions(['read', 'glob', 'bash', 'run_code', 'constructor']), [])
  const native = { name: 'custom_tool', description: 'Native custom tool', parameters: { type: 'object', properties: { mode: { enum: ['a', 'b'] } }, required: ['mode'], additionalProperties: false } }
  const defs = toolDefinitions(['synth_tts'], [native, { name: 'missing_schema' }])
  assert.deepEqual(defs.map(d => d.function.name), ['synth_tts', 'custom_tool'])
  assert.deepEqual(defs[1].function.parameters, native.parameters)
  defs[1].function.parameters.required.push('other')
  assert.deepEqual(native.parameters.required, ['mode'])
})

test('Realtime rejects unknown and unselected calls before invoking the executor', async () => {
  const FakeSocket = makeFakeSocket()
  const executed = []
  const session = createRealtimeSession({ settings: { ...realtimeDefaults(), tools: [] }, nativeTools: [readSchema], key: 'k', executeTool: async name => executed.push(name), emit() {}, WebSocketCtor: FakeSocket })
  session.connect()
  const socket = FakeSocket.instances[0]
  for (const name of ['write', 'unknown', 'synth_tts']) socket.emitRaw('response.output_item.done', { item: { type: 'function_call', name, call_id: name, arguments: '{}' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(executed, [])
  assert.equal(socket.sent.filter(m => m.item?.type === 'function_call_output' && JSON.parse(m.item.output).error).length, 3)
  session.dispose()
})

test('service exposes selected schemas and snapshots each session allowlist and workspace', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'whale-rt-selection-'))
  const keyFile = join(dir, 'test.env')
  await writeFile(keyFile, 'DASHSCOPE_API_KEY=test-key')
  const FakeSocket = makeFakeSocket(), executed = []
  const writeSchema = { name: 'write', description: 'Native write', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } }
  const service = createService({ stateDir: dir }, {
    realtimeWebSocket: FakeSocket,
    resolveModelCredential: async provider => ({ key: 'test-key', source: 'provider', provider }),
    catalog: async () => ({ tools: [readSchema, writeSchema], currentWorkspace: process.cwd(), toolExecutionAvailable: true }),
    runTool: async (name, args, options) => { executed.push({ name, args, workspace: options.workspace }); return { ok: true } },
  })
  t.after(async () => {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  const initial = (await service.handle('GET', '/api/config')).body.settings
  assert.equal(initial.tools_configured, false)
  const settings = { ...initial, tts_profiles: { ...initial.tts_profiles, qwen: { ...initial.tts_profiles?.qwen, voice: 'longanhuan_v3.1' } }, enabled_tools: ['read'], tools_configured: true, workspace: dir, realtime: { ...initial.realtime, key_file: keyFile, instructions: 'Test' } }
  const catalog = (await service.handle('POST', '/api/catalog')).body
  assert.deepEqual(catalog.tools[0].parameters, readSchema.parameters)
  assert.equal(catalog.toolExecutionAvailable, true)
  await service.handle('PUT', '/api/config', { settings })
  const started = await service.handle('POST', '/api/realtime/start', { settings })
  const sessionId = started.body.sessionId
  assert.deepEqual((await service.handle('POST', '/api/realtime/playback', { sessionId, kind: 'main', active: true })).body, { ok: true })
  for (const patch of [{ kind: 'unknown', active: true }, { kind: 'main', active: 'true' }]) {
    await assert.rejects(service.handle('POST', '/api/realtime/playback', { sessionId, ...patch }), error => error.status === 400)
  }
  await assert.rejects(service.handle('POST', '/api/realtime/playback', { sessionId: 'missing', kind: 'main', active: true }), error => error.status === 404)
  const first = FakeSocket.instances[0]
  first.emitRaw('session.created', {})
  const defs = first.sent.find(m => m.type === 'session.update').session.tools
  assert.deepEqual(defs.find(d => d.function.name === 'read').function.parameters, readSchema.parameters)
  assert.ok(!defs.some(d => d.function.name === 'write'))
  assert.ok(defs.some(d => d.function.name === 'synth_tts'))
  await service.handle('PUT', '/api/config', { settings: { ...settings, workspace: process.cwd(), enabled_tools: ['write'] } })
  await service.handle('POST', '/api/realtime/start')
  const second = FakeSocket.instances[1]
  second.emitRaw('session.created', {})
  assert.ok(second.sent.find(m => m.type === 'session.update').session.tools.some(d => d.function.name === 'write'))
  const invoke = (socket, name, callId, args = {}) => socket.emitRaw('response.output_item.done', { item: { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) } })
  invoke(first, 'write', 'first-write')
  invoke(first, 'read', 'first-read', { file_path: '/test', offset: 7 })
  invoke(second, 'read', 'second-read')
  invoke(second, 'write', 'second-write', { file_path: '/test', content: 'test' })
  invoke(second, 'unknown', 'unknown')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(executed, [
    { name: 'read', args: { file_path: '/test', offset: 7 }, workspace: dir },
    { name: 'write', args: { file_path: '/test', content: 'test' }, workspace: process.cwd() },
  ])
  await service.handle('PUT', '/api/config', { settings: { ...settings, enabled_tools: [] } })
  await service.handle('POST', '/api/realtime/start')
  const third = FakeSocket.instances[2]
  third.emitRaw('session.created', {})
  assert.ok(third.sent.find(m => m.type === 'session.update').session.tools.every(d => !['read', 'write'].includes(d.function.name)))
  invoke(third, 'read', 'third-read')
  invoke(third, 'get_voice_config', 'internal')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(executed.length, 2)
  assert.equal(JSON.parse(third.sent.find(m => m.item?.call_id === 'internal').item.output).provider, 'qwen')
  assert.equal((await service.handle('GET', '/api/config')).body.settings.tools_configured, true)
  await assert.rejects(service.handle('POST', '/api/realtime/start', { settings: { ...settings, enabled_tools: ['missing_tool'] } }), error => error.status === 400)
})

test('a completed tool call whose result failed is audited with outcome, exit code and summary', async () => {
  const FakeSocket = makeFakeSocket(), emitted = []
  const session = createRealtimeSession({
    settings: { ...realtimeDefaults(), tools: [] }, nativeTools: [readSchema], key: 'k',
    executeTool: async () => ({ stdout: '', stderr: 'ls: /private: Permission denied\nsecond line', exit_code: 2 }),
    emit: e => emitted.push(e), WebSocketCtor: FakeSocket,
  })
  session.connect()
  const socket = FakeSocket.instances[0]
  socket.emitRaw('response.output_item.done', { item: { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' } })
  socket.emitRaw('response.done', { response: { status: 'completed' } })
  await new Promise(resolve => setTimeout(resolve, 10))
  const end = emitted.find(e => e.type === 'tool-end' && e.callId === 'call_1')
  // `completed` stays the call lifecycle: the model still received the output.
  assert.equal(end.status, 'completed')
  const record = emitted.find(e => e.type === 'audit' && e.record.kind === 'tool').record
  assert.equal(record.status, 'completed')
  assert.equal(record.outcome, 'error')
  assert.equal(record.exitCode, 2)
  assert.equal(record.resultSummary, 'ls: /private: Permission denied second line')
  session.dispose()
})

test('a successful tool call records an ok outcome with the first line of its output', async () => {
  const FakeSocket = makeFakeSocket(), emitted = []
  const session = createRealtimeSession({
    settings: { ...realtimeDefaults(), tools: [] }, nativeTools: [readSchema], key: 'k',
    executeTool: async () => ({ content: [{ type: 'text', text: '文件内容\n第二行' }], exit_code: 0 }),
    emit: e => emitted.push(e), WebSocketCtor: FakeSocket,
  })
  session.connect()
  const socket = FakeSocket.instances[0]
  socket.emitRaw('response.output_item.done', { item: { type: 'function_call', call_id: 'call_2', name: 'read', arguments: '{}' } })
  socket.emitRaw('response.done', { response: { status: 'completed' } })
  await new Promise(resolve => setTimeout(resolve, 10))
  const record = emitted.find(e => e.type === 'audit' && e.record.kind === 'tool').record
  assert.equal(record.outcome, 'ok')
  assert.equal(record.exitCode, 0)
  assert.equal(record.resultSummary, '文件内容 第二行')
  assert.equal(record.text, 'read')
  session.dispose()
})

test('上游断开 socket 后服务端自行收尾：事件仍可取、额度释放、写接口 404', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'whale-rt-close-'))
  const keyFile = join(dir, 'test.env')
  await writeFile(keyFile, 'DASHSCOPE_API_KEY=test-key')
  const FakeSocket = makeFakeSocket(), released = []
  const service = createService({ stateDir: dir }, {
    realtimeWebSocket: FakeSocket,
    resolveModelCredential: async provider => ({ key: 'test-key', source: 'provider', provider }),
    catalog: async () => ({ tools: [readSchema], currentWorkspace: process.cwd(), toolExecutionAvailable: true }),
    runTool: async () => ({ ok: true }),
    releaseToolSession: async sid => released.push(sid),
  })
  t.after(async () => {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  const initial = (await service.handle('GET', '/api/config')).body.settings
  const settings = { ...initial, tts_voice_provider: 'qwen', tts_profiles: { ...initial.tts_profiles, qwen: { ...initial.tts_profiles?.qwen, voice: 'longanhuan_v3.1' } }, enabled_tools: [], tools_configured: true, workspace: dir, realtime: { ...initial.realtime, key_file: keyFile, instructions: 'Test' } }
  await service.handle('PUT', '/api/config', { settings })
  const sessionId = (await service.handle('POST', '/api/realtime/start', { settings })).body.sessionId
  assert.equal((await service.handle('GET', '/api/health')).body.realtime.activeSessions, 1)

  // 上游断连：socket 关闭是客户端唯一的信号，客户端可能再也不来轮询
  FakeSocket.instances[0].close()

  const polled = (await service.handle('POST', '/api/realtime/events', { sessionId })).body
  assert.equal(polled.done, true, '上游断连后会话必须标记结束，否则轮询永远空转')
  assert.equal(polled.events.filter(event => event.type === 'closed').length, 1, 'closed 事件仍要能被取到，收尾不得早于 push')
  // 工具 agent 必须释放，且重入只释放一次
  assert.deepEqual(released, [sessionId])
  FakeSocket.instances[0].close()
  assert.deepEqual(released, [sessionId])
  // 健康度按活会话计；已结束会话不接受写请求
  assert.equal((await service.handle('GET', '/api/health')).body.realtime.activeSessions, 0)
  await assert.rejects(service.handle('POST', '/api/realtime/audio', { sessionId, audio: 'AAAA' }), error => error.status === 404)

  // 额度必须随断连释放：1 个死会话 + 3 个活会话若仍算 4，第 4 次 start 会 429
  for (let i = 0; i < 4; i++) await service.handle('POST', '/api/realtime/start', { settings })
  assert.equal((await service.handle('GET', '/api/health')).body.realtime.activeSessions, 4)
})

// 「连不上」的三条路径共用一个脚手架：stateDir + key_file + enabled_tools: [] 就够，不需要 catalog。
// 注意 dependencies.realtimeWebSocket 必须显式给值——默认参数只在 undefined 时回退到模块级 ws，
// 本机 Desktop bundle 里有 ws，所以传 undefined 等于「能连上」，测不到失败路径。
async function unconnectable(t, dependencies) {
  const dir = await mkdtemp(join(tmpdir(), 'whale-rt-nosocket-'))
  const keyFile = join(dir, 'test.env')
  await writeFile(keyFile, 'DASHSCOPE_API_KEY=test-key')
  const released = []
  const service = createService({ stateDir: dir }, {
    resolveModelCredential: async provider => ({ key: 'test-key', source: 'provider', provider }),
    runTool: async () => ({ ok: true }),
    releaseToolSession: async sid => released.push(sid),
    ...dependencies,
  })
  t.after(async () => {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  const initial = (await service.handle('GET', '/api/config')).body.settings
  const settings = { ...initial, tts_voice_provider: 'qwen', tts_profiles: { ...initial.tts_profiles, qwen: { ...initial.tts_profiles?.qwen, voice: 'longanhuan_v3.1' } }, enabled_tools: [], tools_configured: true, workspace: dir, realtime: { ...initial.realtime, key_file: keyFile, instructions: 'Test' } }
  await service.handle('PUT', '/api/config', { settings })
  return { service, settings, released }
}

// 三条路径的公共验收：立刻 done、不占额度、工具 agent 释放、写接口 404、/end 仍幂等
async function assertSettles(t, service, settings, released) {
  const sessionId = (await service.handle('POST', '/api/realtime/start', { settings })).body.sessionId
  assert.equal((await service.handle('GET', '/api/health')).body.realtime.activeSessions, 0, '连不上的会话不得占并发额度（否则连续试 4 次后新会话一律 429）')
  const polled = (await service.handle('POST', '/api/realtime/events', { sessionId })).body
  assert.equal(polled.done, true, 'connect 从未建立也必须标记结束，否则前端轮询永远空转、UI 停在「我在听，主人」')
  const signals = polled.events.filter(event => event.type === 'error' || event.type === 'closed').map(event => (event.type === 'error' ? `error:${event.code}` : 'closed'))
  assert.deepEqual(signals, ['error:connection', 'closed'], 'error 只是提示，closed 必须紧随其后——服务端收尾与前端停麦都只认 closed')
  assert.deepEqual(released, [sessionId], '工具 agent 必须释放，且只释放一次')
  await assert.rejects(service.handle('POST', '/api/realtime/audio', { sessionId, audio: 'AAAA' }), error => error.status === 404)
  assert.equal((await service.handle('POST', '/api/realtime/end', { sessionId })).body.ok, true, '客户端收尾时的 /end 仍须幂等成功（墓碑上也不例外）')
  // 额度不得被连续失败吃满
  for (let i = 0; i < 5; i++) await service.handle('POST', '/api/realtime/start', { settings })
  assert.equal((await service.handle('GET', '/api/health')).body.realtime.activeSessions, 0)
}

test('没有 WebSocketCtor（ws 解析失败）时 /start 立刻收尾，不再静默占额度', async t => {
  const { service, settings, released } = await unconnectable(t, { realtimeWebSocket: null })
  await assertSettles(t, service, settings, released)
})

test('WebSocket 构造抛错时同样发 closed，不只是 error', async t => {
  class BoomSocket { constructor() { throw new Error('boom') } }
  const { service, settings, released } = await unconnectable(t, { realtimeWebSocket: BoomSocket })
  await assertSettles(t, service, settings, released)
})

// 握手被拒（401/403、模型名或地址写错）：ws 8.22 注册了 unexpected-response 监听后就不 abortHandshake，
// readyState 停在 CONNECTING、close 永不触发——不自己 destroy 并补发 closed，这具死会话会被当成活会话占额度。
function handshakeSocket() {
  const instances = []
  class HandshakeSocket {
    constructor(url, opts) {
      this.url = url; this.opts = opts; this.readyState = 0
      this.handlers = {}; this.closed = false
      instances.push(this)
    }
    on(event, fn) { this.handlers[event] = fn }
    close() { this.closed = true }
    reject(statusCode = 401) {
      const req = { destroyed: false, destroy() { this.destroyed = true } }
      const res = { statusCode, resumed: false, resume() { this.resumed = true } }
      this.handlers['unexpected-response'](req, res)
      return { req, res }
    }
    static get last() { return instances[instances.length - 1] }
  }
  return HandshakeSocket
}

test('握手被拒（401）时 /start 的会话同样收尾，不占并发额度', async t => {
  const HandshakeSocket = handshakeSocket()
  const { service, settings, released } = await unconnectable(t, { realtimeWebSocket: HandshakeSocket })
  const sessionId = (await service.handle('POST', '/api/realtime/start', { settings })).body.sessionId
  const { req, res } = HandshakeSocket.last.reject(401)
  assert.equal(res.resumed, true, '必须排空响应体，否则请求永不释放')
  assert.equal(req.destroyed, true, '必须真的 abort 请求：只发事件而不 destroy 会让 readyState 永远停在 CONNECTING')
  assert.equal((await service.handle('GET', '/api/health')).body.realtime.activeSessions, 0, '握手失败不得占并发额度（否则连撞 4 次后新会话一律 429）')
  const polled = (await service.handle('POST', '/api/realtime/events', { sessionId })).body
  assert.equal(polled.done, true, '握手失败也必须标记结束，否则前端轮询空转、UI 停在「我在听，主人」')
  const signals = polled.events.filter(event => event.type === 'error' || event.type === 'closed').map(event => (event.type === 'error' ? `error:${event.code}` : 'closed'))
  assert.deepEqual(signals, ['error:handshake_401', 'closed'], 'error 说明是握手被拒，closed 才是收尾信号')
  assert.deepEqual(released, [sessionId], '工具 agent 必须释放，且只释放一次')
  await assert.rejects(service.handle('POST', '/api/realtime/audio', { sessionId, audio: 'AAAA' }), error => error.status === 404)
  assert.equal((await service.handle('POST', '/api/realtime/end', { sessionId })).body.ok, true, '客户端收尾时的 /end 仍须幂等成功')
  // 连续握手失败不得吃满额度（403 与 401 走同一条路径）
  for (let i = 0; i < 5; i++) {
    await service.handle('POST', '/api/realtime/start', { settings })
    HandshakeSocket.last.reject(403)
  }
  assert.equal((await service.handle('GET', '/api/health')).body.realtime.activeSessions, 0)
})

test('会话级：缺组件时自行发 error→closed，dispose 之后 connect 不再发事件', () => {
  const emitted = []
  const session = createRealtimeSession({ settings: realtimeDefaults(), key: 'k', executeTool: async () => ({}), emit: event => emitted.push(event), WebSocketCtor: null })
  session.connect()
  assert.deepEqual(emitted.map(event => (event.type === 'error' ? `error:${event.code}` : event.type)), ['error:connection', 'closed'])
  assert.ok(emitted[0].message, '缺组件要有可读文案，不能只给 code')
  session.dispose()
  const settled = emitted.length
  session.connect()
  assert.equal(emitted.length, settled, 'dispose 之后 connect() 不许再发 closed（会话已收尾，重复 closed 会重复收尾）')
})

test('会话级：握手被拒时自行 abort 请求并补发 closed，不等 close 事件', () => {
  const emitted = []
  const instances = []
  class RejectedSocket {
    constructor() { this.readyState = 0; this.handlers = {}; this.closed = false; instances.push(this) }
    on(event, fn) { this.handlers[event] = fn }
    close() { this.closed = true }
  }
  const session = createRealtimeSession({ settings: realtimeDefaults(), key: 'k', executeTool: async () => ({}), emit: event => emitted.push(event), WebSocketCtor: RejectedSocket })
  session.connect()
  const socket = instances[0]
  assert.equal(socket.readyState, 0, '前提：握手尚未完成（CONNECTING）')
  const req = { destroyed: false, destroy() { this.destroyed = true } }
  const res = { statusCode: 401, resumed: false, resume() { this.resumed = true } }
  socket.handlers['unexpected-response'](req, res)
  assert.equal(res.resumed, true, '必须排空响应体')
  assert.equal(req.destroyed, true, '必须真的 abort——ws 注册了该监听就不再 abortHandshake')
  assert.deepEqual(emitted.map(event => (event.type === 'error' ? `error:${event.code}` : event.type)), ['error:handshake_401', 'closed'])
  assert.ok(emitted[0].message, '握手失败要有可读文案，不能只给 code')
  // 迟到的重入（socket 随后才真正 close）不得再发事件
  session.dispose()
  const settled = emitted.length
  socket.handlers['unexpected-response'](req, res)
  assert.equal(emitted.length, settled, 'dispose 之后不得再发 error/closed')
})

test('源码守卫：connect() 的两条失败路径都必须经 connectionFailed 同时发 error 与 closed', () => {
  const source = readFileSync(new URL('../src/core/realtime-service.js', import.meta.url), 'utf8')
  const bodyOf = name => {
    const at = source.indexOf(`function ${name}(`)
    assert.ok(at > 0, `找不到 ${name}()`)
    // 函数体内嵌套块缩进 4 空格，首个 "\n  }" 即函数收尾
    return source.slice(at, source.indexOf('\n  }', at + 1))
  }
  const connect = bodyOf('connect')
  const returns = (connect.match(/return\b[^\n]*/g) || []).map(line => line.trim())
  assert.equal(returns.length, 3, 'connect() 只允许三条 return：已 dispose、缺 ctor、构造抛错')
  assert.ok(returns.includes('return'), '「已 dispose」是唯一允许的裸早退')
  for (const line of returns.filter(line => line !== 'return')) assert.match(line, /connectionFailed\('/, '失败路径必须走 connectionFailed——只发 error 不发 closed 正是本 bug 的形态')
  const failed = bodyOf('connectionFailed')
  assert.match(failed, /emit\(\{ type: 'error', code: 'connection', message \}\)/, 'error 事件不能丢：前端要显示原因')
  assert.match(failed, /emit\(\{ type: 'closed' \}\)/, 'closed 事件不能丢：服务端收尾与前端停麦都只认它')
  assert.ok(failed.indexOf("type: 'error'") < failed.indexOf("type: 'closed'"), 'error 必须先于 closed（closed 会同步触发 settle/dispose）')

  // 第四条失败路径：握手被拒。ws 8.22 只要注册了 unexpected-response 监听就不再 abortHandshake
  // （websocket.js:943 `!emit(...)` 为假），readyState 停在 CONNECTING、close 不触发，所以必须自己 destroy + 发 closed。
  const rejectedAt = connect.indexOf("'unexpected-response'")
  // 只取这一个监听块（到下一个 socket.on 为止）——否则块外的 close 处理器里的 emit closed 会让断言空转。
  const rejected = connect.slice(rejectedAt, connect.indexOf("socket.on('close'", rejectedAt))
  assert.ok(rejected.length > 0, '找不到 unexpected-response 监听')
  assert.match(rejected, /res\?\.resume\?\.\(\)/, '握手被拒要先排空响应体，否则请求永不释放')
  assert.match(rejected, /code: 'handshake_' \+/, 'error 仍要说明是握手被拒（带上游状态码）')
  assert.match(rejected, /emit\(\{ type: 'closed' \}\)/, '握手被拒也必须发 closed——只发 error 正是本 bug 的形态')
  assert.match(rejected, /req\?\.destroy\?\.\(\)/, '必须主动 abort 请求：只发事件会让 readyState 永远停在 CONNECTING')
  assert.ok(rejected.indexOf("type: 'error'") < rejected.indexOf("type: 'closed'"), 'error 必须先于 closed（closed 会同步触发 settle/dispose）')
})
