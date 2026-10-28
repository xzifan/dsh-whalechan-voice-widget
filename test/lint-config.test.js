import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const read=path=>readFile(new URL(path,import.meta.url),'utf8')

test('lint and format gates are wired into scripts, prepack and devDependencies',async()=>{
  const pkg=JSON.parse(await read('../package.json'))
  assert.equal(pkg.scripts.lint,'eslint .')
  assert.equal(pkg.scripts['format:check'],'prettier --check .')
  // prepack 在 npm pack 与 npm pack --dry-run 上都会触发，正是「打包即校验」的位置
  assert.equal(pkg.scripts.prepack,'npm run lint')
  for(const dep of ['eslint','@eslint/js','globals','prettier']){
    assert.ok(pkg.devDependencies?.[dep],`devDependencies 缺少 ${dep}`)
  }
  // 纯工具不能混进运行时依赖：装进 dsh profile 时不会带上 devDependencies
  for(const dep of ['eslint','prettier']) assert.ok(!pkg.dependencies?.[dep],`${dep} 不应出现在 dependencies`)
  // 也不能被打进 tarball：files 白名单里没有配置文件的容身之处
  for(const entry of pkg.files) assert.ok(!/eslint|prettier/.test(entry),`files 里混进了 ${entry}`)
})

test('CI runs the lint and format jobs, not just the test matrix',async()=>{
  const ci=await read('../.github/workflows/ci.yml')
  assert.ok(ci.split('\n').some(line=>/^ {2}lint:/.test(line)),'CI 缺少独立 lint job')
  for(const script of ['npm run lint','npm run format:check']){
    assert.ok(ci.includes(`run: ${script}`),`CI 缺少 ${script}`)
  }
})

test('eslint covers js sources, prettier config matches the repo style',async()=>{
  const config=await read('../eslint.config.js')
  assert.ok(/\*\*\/\*\.js/.test(config),'eslint 配置没有覆盖 **/*.js')
  assert.ok(/node_modules/.test(config),'eslint 配置没有忽略 node_modules')
  const rc=JSON.parse(await read('../.prettierrc.json'))
  assert.equal(rc.semi,false)
  assert.equal(rc.singleQuote,true)
  const ignore=await read('../.prettierignore')
  // 只断言「永久忽略」项：`src/` 这类迁移账本条目会随迁移逐行删除，不能锁死
  for(const entry of ['node_modules/','dist/','package-lock.json']){
    assert.ok(ignore.includes(entry),`.prettierignore 缺少 ${entry}`)
  }
})
