import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// 「模型配置 / 本地 ASR」是产品刻意移除的入口（见 BACKLOG「删除 browser-platform.py」）。
// 旧脚本 7/7 断言全部打在它上面，所以直接删；这里锁住「别为通过断言把它复活」。
const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const REMOVED_LABELS = ['模型配置', '准备本地识别模型', '语音识别方式']

test('browser-platform.py 已删除，且没有浏览器脚本重新断言被移除的本地 ASR 入口', () => {
  assert.equal(
    existsSync(join(TEST_DIR, 'browser-platform.py')),
    false,
    'test/browser-platform.py 已按 BACKLOG 删除：它断言的是产品刻意下架的「模型配置」tab 与本地 ASR',
  )

  const scripts = readdirSync(TEST_DIR).filter((name) => name.endsWith('.py'))
  assert.ok(scripts.length > 0, '应当还有其它浏览器脚本，避免删空后本断言变成空转')

  for (const name of scripts) {
    const source = readFileSync(join(TEST_DIR, name), 'utf8')
    for (const label of REMOVED_LABELS) {
      assert.equal(
        source.includes(label),
        false,
        `${name} 出现了已被移除的 UI 入口「${label}」；断言要跟着现 UI 走，不要去恢复旧 tab`,
      )
    }
  }
})

// 会话记录页（BACKLOG「浏览器页断言 S3」）已并入 browser-pages.py。留一份独立脚本 = 两份
// bootstrap 各改各的 mock，改一处另一处静默失真，所以这里锁住「并进来了、别再分叉」。
test('会话记录断言已并入 browser-pages.py，没有独立的 browser-history.py', () => {
  assert.equal(
    existsSync(join(TEST_DIR, 'browser-history.py')),
    false,
    'test/browser-history.py 已按 BACKLOG 并入 browser-pages.py；要加会话记录断言请改那一处',
  )
  const pages = readFileSync(join(TEST_DIR, 'browser-pages.py'), 'utf8')
  for (const signal of ['历史会话列表', '搜索会话记录', '查看审计', '搜索审计记录']) {
    assert.ok(pages.includes(signal), `browser-pages.py 缺少「${signal}」断言，会话记录页的回归就没人看了`)
  }
  assert.ok(
    pages.includes('from browser_harness import Harness'),
    'browser-pages.py 必须走 browser_harness.Harness（宿主页 -> client.js -> iframe），不能直连 dist/web',
  )
})

// Breeze 语音脚本（BACKLOG「浏览器脚本 S5」）里那个 `voc_47j4uzfyuxqc` 是硬编码的旧中文预设，
// 产品换成 `voc_u3nxkd5578wc` 后脚本照样"绿"。这里锁住两条：ID 只能从 `src/breeze-voices.js`
// 读回来，脚本必须走 `Harness`（直连 dist/web 就绕过了宿主页 -> client.js 的生产路径）。
test('Breeze 脚本从源码读固定音色 ID，且走 browser_harness.Harness', () => {
  const breeze = readFileSync(join(TEST_DIR, 'browser-breeze-voice.py'), 'utf8')
  const hardcoded = breeze.match(/voc_[0-9a-zA-Z]+/g)
  assert.equal(
    hardcoded,
    null,
    `browser-breeze-voice.py 硬编码了固定音色 ID ${hardcoded}；请从 src/breeze-voices.js 读，否则换音色后断言仍是旧的`,
  )
  assert.ok(
    breeze.includes('from browser_harness import'),
    'browser-breeze-voice.py 必须走 browser_harness.Harness，不能直连 dist/web',
  )
  for (const signal of ['Breeze 预设音色', '中文音色', '合成接口']) {
    assert.ok(breeze.includes(signal), `browser-breeze-voice.py 缺少「${signal}」断言，Breeze 设置的回归就没人看了`)
  }

  const pkg = JSON.parse(readFileSync(join(TEST_DIR, '..', 'package.json'), 'utf8'))
  assert.equal(
    pkg.scripts['test:browser:breeze'],
    'python3 test/browser-breeze-voice.py',
    'Breeze 脚本要能被 npm 驱动，否则重写完还是没人跑',
  )
  const ci = readFileSync(join(TEST_DIR, '..', '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.ok(ci.includes('npm run test:browser:breeze'), 'CI 必须真的跑 Breeze 脚本，否则等于没有这条断言')
})

// 音色预设编辑器（BACKLOG「浏览器脚本 S6」）重写后必须走 Harness：旧脚本自己分发
// `dist/web` 静态资源、在仓库里落截图，等于绕开「宿主页 -> client.js -> iframe」这条唯一生产路径。
test('音色预设脚本走 browser_harness.Harness，且已被 npm / CI 驱动', () => {
  const presets = readFileSync(join(TEST_DIR, 'browser-voice-presets.py'), 'utf8')
  assert.ok(
    presets.includes('from browser_harness import'),
    'browser-voice-presets.py 必须走 browser_harness.Harness，不能直连 dist/web',
  )
  assert.equal(
    presets.includes('dist/web'),
    false,
    'browser-voice-presets.py 不该自己分发 dist/web：那会绕过宿主页 -> client.js -> iframe 这条生产路径',
  )
  assert.equal(presets.includes('screenshot('), false, '浏览器脚本不该把截图写进仓库树')
  for (const signal of ['保存并生成音色', '重试播放', '重试试听', '正在播放新音色…']) {
    assert.ok(presets.includes(signal), `browser-voice-presets.py 缺少「${signal}」断言，预设编辑器的回归就没人看了`)
  }

  const pkg = JSON.parse(readFileSync(join(TEST_DIR, '..', 'package.json'), 'utf8'))
  assert.equal(
    pkg.scripts['test:browser:presets'],
    'python3 test/browser-voice-presets.py',
    '音色预设脚本要能被 npm 驱动，否则重写完还是没人跑',
  )
  const ci = readFileSync(join(TEST_DIR, '..', '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.ok(ci.includes('npm run test:browser:presets'), 'CI 必须真的跑音色预设脚本，否则等于没有这条断言')
})

// 实时对话启动竞态（BACKLOG「浏览器脚本 S7」）：旧脚本自己分发 `dist/web` 并在宿主页数
// `window.__micCalls`——真实 getUserMedia 在插件 iframe 里，宿主页那个计数恒为 0，等于
// 「不得开麦」的断言一直在假通过。这里锁住走 Harness、从 iframe 读麦克风、且被 npm/CI 驱动。
test('实时启动脚本走 browser_harness.Harness，并被 npm / CI 驱动', () => {
  const startup = readFileSync(join(TEST_DIR, 'browser-startup-initialization.py'), 'utf8')
  assert.ok(
    startup.includes('from browser_harness import'),
    'browser-startup-initialization.py 必须走 browser_harness.Harness，不能直连 dist/web',
  )
  assert.equal(startup.includes('dist/web'), false, '实时启动脚本不该自己分发 dist/web：那会绕过宿主页 -> client.js -> iframe 这条生产路径')
  assert.ok(
    startup.includes('harness.child.evaluate') && startup.includes('__micCalls'),
    '麦克风计数必须在插件 iframe 里读（宿主页的 window 没有真实 getUserMedia）',
  )
  for (const signal of ['准备声音并连接', '取消连接', '再次开始', 'voiceSettingsPatch', 'realtime/end']) {
    assert.ok(startup.includes(signal), `browser-startup-initialization.py 缺少「${signal}」断言，启动竞态/迟到 session 的回归就没人看了`)
  }

  const pkg = JSON.parse(readFileSync(join(TEST_DIR, '..', 'package.json'), 'utf8'))
  assert.equal(
    pkg.scripts['test:browser:startup'],
    'python3 test/browser-startup-initialization.py',
    '实时启动脚本要能被 npm 驱动，否则重写完还是没人跑',
  )
  const ci = readFileSync(join(TEST_DIR, '..', '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.ok(ci.includes('npm run test:browser:startup'), 'CI 必须真的跑实时启动脚本，否则等于没有这条断言')
})

// 日志审计页（BACKLOG「浏览器页断言 S4」）同样并入 browser-pages.py；旧脚本里的列标题点击循环
// 恒真、3080 探活只是读线上状态，都随文件一起删掉。
test('日志审计断言已并入 browser-pages.py，没有独立的 browser-audit-table.py', () => {
  assert.equal(
    existsSync(join(TEST_DIR, 'browser-audit-table.py')),
    false,
    'test/browser-audit-table.py 已按 BACKLOG 并入 browser-pages.py；要加审计页断言请改那一处',
  )
  const pages = readFileSync(join(TEST_DIR, 'browser-pages.py'), 'utf8')
  for (const signal of ['加载更早记录', '重置筛选', '审计记录详情', 'before', 'columnFilters']) {
    assert.ok(pages.includes(signal), `browser-pages.py 缺少「${signal}」断言，审计页分页/筛选的回归就没人看了`)
  }
  assert.equal(
    pages.includes('127.0.0.1:3080'),
    false,
    '审计页断言不该去探 3080 线上实例：那是环境状态，不是构建产物',
  )
})
