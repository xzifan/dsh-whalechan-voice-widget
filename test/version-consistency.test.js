import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'

const ROOT = new URL('..', import.meta.url)
const read = path => readFile(new URL(path, import.meta.url), 'utf8')

// '0.6.1' / 'v0.6.1' → [0,6,1]；非三段式返回 null
const parse = raw => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(raw ?? '').trim())
  return m ? m.slice(1).map(Number) : null
}
const newer = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}
const inCI = Boolean(process.env.CI)

// CHANGELOG 里所有 `## [x.y.z] - 日期` 段落，按出现顺序（=从新到旧）
const sections = text => [...text.matchAll(/^##\s+\[([^\]]+)\][^\n]*$/gm)]
  .map(m => ({version: m[1].trim(), line: m[0]}))
  .filter(s => parse(s.version))

const tags = () => {
  try {
    return execFileSync('git', ['tag', '--list', 'v*'], {cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']})
      .split('\n').map(s => s.trim()).filter(Boolean)
      .map(name => ({name, semver: parse(name)}))
      .filter(t => t.semver)
  } catch {
    return null // 不是 git 仓库 / 没有 git：本地打包等场景
  }
}

test('package.json 版本是合法三段式 semver', async() => {
  const pkg = JSON.parse(await read('../package.json'))
  assert.ok(parse(pkg.version), `package.json version 不是三段式 semver：${pkg.version}`)
})

test('CHANGELOG 顶部版本段 == package.json 版本，且带日期', async() => {
  const pkg = JSON.parse(await read('../package.json'))
  const text = await read('../CHANGELOG.md')
  const list = sections(text)
  assert.ok(list.length > 0, 'CHANGELOG 里没有任何 `## [x.y.z]` 版本段落')
  assert.equal(list[0].version, pkg.version, `CHANGELOG 顶部是 ${list[0].version}，package.json 是 ${pkg.version}`)
  assert.match(list[0].line, /-\s*\d{4}-\d{2}-\d{2}\s*$/, `顶部版本段落缺少日期：${list[0].line}`)

  // 版本段必须严格递减且不重复，否则"顶部"失去意义
  for (let i = 1; i < list.length; i++) {
    const prev = parse(list[i - 1].version), cur = parse(list[i].version)
    assert.ok(newer(prev, cur) > 0, `CHANGELOG 版本顺序错误：${list[i - 1].version} 之后出现 ${list[i].version}`)
  }
})

test('package-lock.json 版本与 package.json 一致', async() => {
  const pkg = JSON.parse(await read('../package.json'))
  const lock = JSON.parse(await read('../package-lock.json'))
  assert.equal(lock.version, pkg.version, 'package-lock.json 顶层 version 落后于 package.json')
  assert.equal(lock.packages?.['']?.version, pkg.version, 'package-lock.json packages[""].version 落后于 package.json')
})

test('最新 git tag 与 package.json 版本一致', async t => {
  const pkg = JSON.parse(await read('../package.json'))
  const version = parse(pkg.version)
  const list = tags()

  if (list === null) {
    assert.ok(!inCI, 'CI 里读不到 git tag：checkout 需要 fetch-depth: 0')
    t.diagnostic('不在 git 仓库内，跳过 tag 断言')
    return
  }
  if (list.length === 0) {
    assert.ok(!inCI, 'CI 里没有任何 v* tag：checkout 需要 fetch-depth: 0 或 git fetch --tags')
    t.diagnostic('仓库还没有 v* tag，跳过 tag 断言')
    return
  }

  const latest = list.map(t => t.semver).reduce((a, b) => (newer(b, a) > 0 ? b : a))
  const latestName = 'v' + latest.join('.')
  const cmp = newer(version, latest)

  // 回退版本号（源码比已发布的 tag 还旧）是真漂移，必须挡住
  assert.ok(cmp >= 0, `package.json 是 ${pkg.version}，但最新 tag 已是 ${latestName}：版本号被回退了`)

  // tag 必须正好等于版本号；发布作业先提交、后推 tag，所以"源码领先一个未推送 tag"只提示不失败
  if (cmp === 0) {
    assert.ok(list.some(t => t.name === latestName), `最新 tag 应命名为 ${latestName}`)
  } else {
    t.diagnostic(`package.json ${pkg.version} 领先最新 tag ${latestName}（发布进行中或 tag 未推送），跳过相等断言`)
  }
})
