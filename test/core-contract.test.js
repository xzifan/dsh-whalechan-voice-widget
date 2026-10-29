import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createService } from '../src/core/service.js'
import { createNativeServices } from '../src/native-services.js'

// 这些是 core 允许向宿主索取的全部能力。改动这里等于改 SDK 契约，
// 必须同步 docs/sdk-extraction.md。
const REQUIRED = ['runTool', 'catalog', 'resolveModelCredential']
// 可选成员：core 用 ?. 调用，缺了会降级而不是崩。releaseToolSession 缺了会漏
// agent（只能等 TTL 回收），所以适配器必须给——这里单独断言。
const OPTIONAL = ['status', 'configureModelCredential', 'generateFiller', 'resolveBailianProvider']

test('core 不依赖宿主包：只有 index.js 可以 import @deepseek-ai/*', async () => {
  const dir = new URL('../src/', import.meta.url)
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.js') || name === 'index.js') continue
    const text = await readFile(new URL(name, dir), 'utf8')
    assert.doesNotMatch(text, /@deepseek-ai\//, `${name} 不应 import 宿主包`)
  }
})

test('core 不反向依赖适配器：任何 import 都必须留在 core 目录内', async () => {
  const dir = new URL('../src/core/', import.meta.url)
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.js')) continue
    const text = await readFile(new URL(name, dir), 'utf8')
    assert.doesNotMatch(
      text,
      /from '\.\.\//,
      `${name} 引用了 core 之外的文件${''}`,
    )
  }
})

test('DSH 适配器覆盖 core 需要的依赖面', async () => {
  const ctx = {
    get() {
      return undefined
    },
  }
  const native = createNativeServices(ctx, {})
  for (const key of REQUIRED) {
    assert.equal(typeof native[key], 'function', `适配器缺少必需成员 ${key}`)
  }
  for (const key of OPTIONAL) {
    assert.ok(native[key] === undefined || typeof native[key] === 'function', `${key} 必须是函数或不存在`)
  }
  assert.equal(typeof native.releaseToolSession, 'function', '缺少 releaseToolSession 会漏掉复用的 agent')
  assert.equal(typeof await native.dispose, 'function')
  await native.dispose()
})

test('core 只靠注入依赖就能工作：没有工具也该能启动并自检', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'whale-core-contract-'))
  const service = createService({ stateDir: dir })
  try {
    const health = await service.handle('GET', '/api/health')
    assert.equal(health.body.ok, true)
    assert.equal(health.body.tools.enabled, 0)
    assert.equal(health.body.realtime.activeSessions, 0)
    const config = await service.handle('GET', '/api/config')
    assert.equal(config.status, undefined)
    assert.ok(config.body.settings)
  } finally {
    await service.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})