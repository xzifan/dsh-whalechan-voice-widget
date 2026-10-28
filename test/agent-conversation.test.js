import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgentConversation, conversationWorkspace, safeToolValue } from '../src/agent-conversation.js'

function harness() {
  const state = { created: 0, disposed: 0, restricted: null, executed: null, schemas: [] }
  const ctx = {
    get(name) {
      return {
        agentDefaultModel: { currentSelection: () => ({ provider: 'provider', model: 'model' }) },
        agentPresets: { resolve: async () => ({ id: 'normal' }), mount: async () => {} },
        agents: {
          async create(options) {
            state.created++
            const listeners = new Map()
            const agent = { id: options.sessionId, cancel() {} }
            const scope = {
              on(name, cb) { const cbs = listeners.get(name) || []; cbs.push(cb); listeners.set(name, cbs) },
              systemPrompt: { section() {} },
              tools: {
                presentAs() {},
                schemas() { return state.schemas.map(n => typeof n === 'string' ? { name: n, description: n, parameters: { type: 'object', properties: {} } } : n) },
                restrict(filter) { state.restricted = filter },
                guard() {},
                async execute(payload) { state.executed = payload; return { value: { ok: true, echo: payload.arguments } } },
              },
            }
            await options.setup(scope, agent)
            return { agent, async dispose() { state.disposed++ } }
          },
        },
      }[name]
    },
  }
  return { native: createAgentConversation(ctx), state }
}

test('catalog reflects actual scoped tools and never executes', async () => {
  const { native, state } = harness()
  state.schemas = ['read', 'write', 'subagent', 'run_code']
  const a = await native.catalog()
  assert.deepEqual(a.tools.map(t => t.name), ['read', 'write'])
  assert.equal(a.toolExecutionAvailable, true)
  assert.deepEqual(a.interruption, { manual: true, voice: false })
  assert.equal(state.created, 1)
  await native.dispose()
  const unavailable = createAgentConversation({})
  assert.equal((await unavailable.catalog()).toolExecutionAvailable, false)
  await unavailable.dispose()
})

test('runTool executes a single named tool through the full policy pipeline', async () => {
  const { native, state } = harness()
  state.schemas = ['read', 'glob']
  const result = await native.runTool('read', { file_path: '/a/b.txt' }, { workspace: process.cwd(), signal: new AbortController().signal })
  assert.deepEqual(result, { ok: true, echo: { file_path: '/a/b.txt' } })
  assert.deepEqual(state.restricted, { allow: ['read'] })
  assert.equal(state.executed.name, 'read')
  assert.equal(state.disposed, 1)
  await native.dispose()
})

test('runTool rejects excluded and unknown tools before dispatch', async () => {
  const { native, state } = harness()
  state.schemas = ['read', 'subagent']
  await assert.rejects(native.runTool('subagent', {}, { workspace: process.cwd(), signal: new AbortController().signal }), e => e.status === 400)
  await assert.rejects(native.runTool('not-a-real-tool', {}, { workspace: process.cwd(), signal: new AbortController().signal }), e => e.status === 400)
  assert.equal(state.executed, null)
  await native.dispose()
})

test('conversationWorkspace requires an absolute existing directory', async () => {
  assert.equal(await conversationWorkspace(process.cwd()), await import('node:fs/promises').then(fs => fs.realpath(process.cwd())).then(p => p))
  await assert.rejects(conversationWorkspace('relative/path'), e => e.status === 400)
  await assert.rejects(conversationWorkspace('/nonexistent-whale-workspace-xyz'), e => e.status === 400)
})

test('tool summaries redact common credentials and bound output', () => {
  const value = safeToolValue({ authorization: 'Bearer private', nested: { api_key: 'private', text: 'token=private\nhello' }, output: 'x'.repeat(20000) })
  assert.ok(!JSON.stringify(value).includes('private'))
  assert.equal(value.output.length, 6000)
})

test('catalog preserves native parameter schemas and detaches cached results', async () => {
  const { native, state } = harness()
  const parameters = { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } }, required: ['paths'], additionalProperties: false, $defs: { item: { type: 'string' } } }
  state.schemas = [{ name: 'custom_tool', description: 'native description', parameters }]
  const first = await native.catalog()
  assert.deepEqual(first.tools[0].parameters, parameters)
  first.tools[0].parameters.required.push('other')
  assert.deepEqual((await native.catalog()).tools[0].parameters, parameters)
  assert.equal(state.executed, null)
  await native.dispose()
})
