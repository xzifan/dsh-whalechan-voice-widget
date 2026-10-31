import test from 'node:test'
import assert from 'node:assert/strict'
import { parseChangelog } from '../src/core/changelog.js'

const SAMPLE = `# Changelog

先导说明，不应出现在结果里。

## [Unreleased]

### 修复

- 第一条未发布修复。

## [0.6.5] - 2026-10-29

### 维护

- 发布流水线加固。

## [0.6.4] - 2026-10-28

### 新增

- 工具会话复用。
- 第二条新增。
`

test('解析版本号、日期与分类', () => {
  const { entries, total } = parseChangelog(SAMPLE)
  assert.equal(total, 3)
  assert.deepEqual(
    entries.map(e => [e.version, e.date]),
    [
      ['Unreleased', null],
      ['0.6.5', '2026-10-29'],
      ['0.6.4', '2026-10-28'],
    ],
  )
  assert.equal(entries[2].sections[0].title, '新增')
  assert.equal(entries[2].sections[0].items.length, 2)
})

test('导言区不计入任何版本', () => {
  const { entries } = parseChangelog(SAMPLE)
  assert.ok(entries.every(e => e.sections.length > 0))
  assert.ok(!JSON.stringify(entries).includes('先导说明'))
})

test('续行会并进上一条，空行结束条目', () => {
  const { entries } = parseChangelog(`## [1.0.0] - 2026-01-01

### 修复

- 第一行
  第二行继续

- 下一条
`)
  const items = entries[0].sections[0].items
  assert.equal(items.length, 2)
  assert.equal(items[0], '第一行 第二行继续')
  assert.equal(items[1], '下一条')
})

test('limit 只影响返回条数，total 仍是真实版本数', () => {
  const { entries, total } = parseChangelog(SAMPLE, { limit: 1 })
  assert.equal(entries.length, 1)
  assert.equal(total, 3)
})

test('超长条目被截断到 maxItemChars', () => {
  const long = 'x'.repeat(500)
  const { entries } = parseChangelog(`## [1.0.0] - 2026-01-01

### 修复

- ${long}
`, { maxItemChars: 100 })
  assert.equal(entries[0].sections[0].items[0].length, 100)
})

test('空内容与非法输入都返回空结果，不抛错', () => {
  assert.deepEqual(parseChangelog(''), { entries: [], total: 0 })
  assert.deepEqual(parseChangelog(null), { entries: [], total: 0 })
  assert.deepEqual(parseChangelog('随便写点什么，没有版本标题'), { entries: [], total: 0 })
})

test('无 ### 分节的版本条目收进默认分节，空版本仍不下发', () => {
  const { entries, total } = parseChangelog(`## [1.1.0] - 2026-01-02

- 裸条目一
  续行
- 裸条目二

## [1.0.0] - 2026-01-01

## [0.9.0] - 2025-12-31

### 修复

- 正常条目
`)
  // 三个版本都在 total 里，但「只有标题没有内容」的 1.0.0 不进 entries
  assert.equal(total, 3)
  assert.deepEqual(
    entries.map(e => e.version),
    ['1.1.0', '0.9.0'],
  )
  assert.deepEqual(
    entries[0].sections.map(s => s.title),
    ['变更'],
  )
  assert.deepEqual(entries[0].sections[0].items, ['裸条目一 续行', '裸条目二'])
})

test('真实 CHANGELOG 里没有 ### 分节的历史版本不再被丢弃', async () => {
  const { readFile } = await import('node:fs/promises')
  const text = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  // 期望条数从文件里的版本标题算，避免每发一个版本就要改这条断言。
  const headings = text.split('\n').filter(line => /^##\s/.test(line))
  const { entries, total } = parseChangelog(text, { limit: 50 })
  assert.equal(total, headings.length)
  assert.equal(entries.length, total)
  assert.deepEqual(
    entries.map(e => e.version),
    headings.map(line => line.replace(/^##\s+\[?/, '').replace(/\].*$/, '').trim()),
  )
  const legacy = { '0.5.0': 7, '0.3.0': 6, '0.2.0': 4 }
  for (const [version, count] of Object.entries(legacy)) {
    const entry = entries.find(e => e.version === version)
    assert.ok(entry, `${version} 必须出现在 entries 里`)
    assert.deepEqual(
      entry.sections.map(s => s.title),
      ['变更'],
    )
    assert.equal(entry.sections[0].items.length, count)
  }
})

test('真实 CHANGELOG 能被完整解析', async () => {
  const { readFile } = await import('node:fs/promises')
  const text = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  const { entries, total } = parseChangelog(text, { limit: 6 })
  assert.ok(total >= 5)
  assert.equal(entries.length, Math.min(6, total))
  assert.ok(entries.every(e => e.version && e.sections.length > 0))
})