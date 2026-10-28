import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, writeFileSync, copyFileSync, readFileSync, rmSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HELPER = join(ROOT, 'scripts', 'release-rollback.sh')
const RELEASE = join(ROOT, 'scripts', 'release.sh')

const FILES = ['package.json', 'package-lock.json', 'CHANGELOG.md']

const git = (cwd, ...args) =>
  spawnSync('git', [
    '-c',
    'user.email=release@example.invalid',
    '-c',
    'user.name=Release Test',
    ...args,
  ], {cwd, encoding: 'utf8'})

// 造一个最小的「已提交仓库 + 发版快照」，然后模拟 release.sh 改完文件、git add 之后失败
const makeRepo = () => {
  const root = mkdtempSync(join(tmpdir(), 'rollback-repo-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({name: 'probe', version: '1.0.0'}, null, 2))
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({version: '1.0.0', packages: {'': {version: '1.0.0'}}}, null, 2))
  writeFileSync(join(root, 'CHANGELOG.md'), '# CHANGELOG\n\n## [Unreleased]\n\n- pending work\n')
  git(root, 'init', '-q')
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'init')

  const backup = mkdtempSync(join(tmpdir(), 'rollback-snap-'))
  for (const file of FILES) copyFileSync(join(root, file), join(backup, file))
  return {root, backup}
}

// release.sh step 7 + step 9 的效果：版本号已 bump、CHANGELOG 的 [Unreleased] 已改成版本段、已 git add
const mutateLikeRelease = root => {
  for (const file of ['package.json', 'package-lock.json']) {
    const data = JSON.parse(readFileSync(join(root, file), 'utf8'))
    data.version = '1.0.1'
    if (data.packages?.['']) data.packages[''].version = '1.0.1'
    writeFileSync(join(root, file), JSON.stringify(data, null, 2) + '\n')
  }
  const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').replace('## [Unreleased]', '## [1.0.1] - 2026-01-01')
  writeFileSync(join(root, 'CHANGELOG.md'), changelog)
  git(root, 'add', ...FILES)
}

const run = (backup, root) => spawnSync('bash', [HELPER, backup, root], {encoding: 'utf8'})

test('失败回滚把版本号与 CHANGELOG 还原，并把改动从暂存区撤下来', () => {
  const {root, backup} = makeRepo()
  try {
    mutateLikeRelease(root)
    // 前置：确实处于「已 bump + 已 add」的半成品状态
    assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '1.0.1')
    assert.equal(git(root, 'diff', '--cached', '--name-only').stdout.trim().split('\n').length, 3)

    const result = run(backup, root)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /restored.*package\.json/)

    assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '1.0.0')
    assert.equal(JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages[''].version, '1.0.0')
    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
    assert.match(changelog, /## \[Unreleased\]/)
    assert.doesNotMatch(changelog, /\[1\.0\.1\]/)
    // 还原工作区还不够：暂存区留着改动会让下一次发版的「工作区干净」检查一直红
    assert.equal(git(root, 'diff', '--cached', '--name-only').stdout.trim(), '')
    assert.equal(git(root, 'status', '--porcelain').stdout.trim(), '')
  } finally {
    rmSync(root, {recursive: true, force: true})
    rmSync(backup, {recursive: true, force: true})
  }
})

test('回滚是幂等的：文件已与快照一致时不做写入', () => {
  const {root, backup} = makeRepo()
  try {
    const before = readFileSync(join(root, 'package.json'), 'utf8')
    const result = run(backup, root)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /nothing to restore/)
    assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), before)
  } finally {
    rmSync(root, {recursive: true, force: true})
    rmSync(backup, {recursive: true, force: true})
  }
})

test('快照不可用时报错退出，绝不改文件', () => {
  const {root} = makeRepo()
  const empty = mkdtempSync(join(tmpdir(), 'rollback-empty-'))
  try {
    mutateLikeRelease(root)
    const result = run(empty, root)
    assert.equal(result.status, 5)
    assert.match(result.stdout + result.stderr, /snapshot is incomplete/)
    assert.equal(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, '1.0.1')

    const missing = run(join(empty, 'does-not-exist'), root)
    assert.equal(missing.status, 5)
    assert.match(missing.stdout + missing.stderr, /backup dir missing/)
  } finally {
    rmSync(root, {recursive: true, force: true})
    rmSync(empty, {recursive: true, force: true})
  }
})

test('release.sh 在改版本号前快照、提交后关掉回滚', () => {
  const script = readFileSync(RELEASE, 'utf8')
  assert.match(script, /trap cleanup EXIT/, 'release.sh 没有挂 cleanup 的 EXIT trap')
  assert.match(script, /release-rollback\.sh/, 'cleanup 没有调用回滚脚本')

  // 顺序即语义：快照必须在第一次改文件（step 6 changelog）之前，关掉回滚必须在 git commit 之后
  const snapshot = script.indexOf('ROLLBACK_STATE=1')
  const changelogWrite = script.indexOf('step "changelog"')
  const commit = script.indexOf('git commit -m "chore(release)')
  const disarm = script.indexOf('ROLLBACK_STATE=2')
  assert.ok(snapshot > 0 && changelogWrite > 0 && commit > 0 && disarm > 0)
  assert.ok(snapshot < changelogWrite, '快照晚于第一次改文件')
  assert.ok(disarm > commit, '回滚在提交后仍处于开启状态（会把已提交的版本号还原）')
  // 快照得覆盖三个文件，只备份 package.json 会漏掉 lock 与 CHANGELOG
  for (const file of FILES) assert.ok(script.includes(file), `快照列表缺少 ${file}`)
  // 回滚脚本自身缺失时不能静默放弃还原（被裁剪的产物会走到这里）
  assert.match(script, /falling back to inline restore/, 'cleanup 缺少 helper 缺失时的内联还原兜底')
})
