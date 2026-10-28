import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'

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
  assert.ok(/\*\*\/\*\.jsx/.test(config),'eslint 配置没有覆盖 **/*.jsx')
  assert.ok(/node_modules/.test(config),'eslint 配置没有忽略 node_modules')
  // JSX 必须显式打开解析，否则 .jsx 直接是 parse error
  assert.ok(/ecmaFeatures: \{ ?jsx: true ?\}/.test(config),'eslint 配置没有打开 JSX 解析')
  const rc=JSON.parse(await read('../.prettierrc.json'))
  assert.equal(rc.semi,false)
  assert.equal(rc.singleQuote,true)
  const ignore=await read('../.prettierignore')
  // 只断言「永久忽略」项：`src/` 这类迁移账本条目会随迁移逐行删除，不能锁死
  for(const entry of ['node_modules/','dist/','package-lock.json']){
    assert.ok(ignore.includes(entry),`.prettierignore 缺少 ${entry}`)
  }
})

test('eslint counts JSX element names as references, so .jsx needs no react plugin',async()=>{
  // 这条盯的是「为什么不用 eslint-plugin-react」：它的 jsx-uses-vars 只解决
  // `no-unused-vars` 不把 `<Foo/>` 算作引用的问题，而 ESLint 10 的核心规则已经算了。
  // 若哪天升级又退回去，这里会先红，而不是让 33 个 .jsx 突然炸出几百条假错。
  const {ESLint}=await import('eslint')
  const root=fileURLToPath(new URL('..',import.meta.url))
  const eslint=new ESLint({cwd:root})
  const code=[
    "import {Used} from './used.js'",
    "import {Dead} from './dead.js'",
    'export default function Probe(){return <Used/>}',
  ].join('\n')
  const [result]=await eslint.lintText(code,{filePath:join(root,'web','src','__jsx-ref-probe.jsx')})
  const unused=result.messages.filter(message=>message.ruleId==='no-unused-vars')
  assert.equal(unused.length,1,`JSX 里的组件没被算作引用：${unused.map(m=>m.message).join(' / ')}`)
  assert.match(unused[0].message,/'Dead'/)
})

test('eslint wires prefer-const: single-assignment let is an error, reassigned let is not',async()=>{
  // 锁的是「prefer-const 这条门禁真的在跑」，不是配置文件里的字面量：用 ESLint API
  // 跑一段合成代码，断言恰好两条（`fixed` 一次赋值、`deferred` 先声明后一次性赋值），
  // 而 `growing` 真的被重新赋值所以不能报——规则开得太宽会把这条变成噪音来源。
  const {ESLint}=await import('eslint')
  const root=fileURLToPath(new URL('..',import.meta.url))
  const eslint=new ESLint({cwd:root})
  const code=[
    'export function probe(flag){',
    '  let fixed=1',
    '  let growing=1',
    '  let deferred',
    '  deferred=flag??0',
    '  if(flag) growing+=fixed+deferred',
    '  return growing',
    '}',
  ].join('\n')
  const [result]=await eslint.lintText(code,{filePath:join(root,'src','__prefer-const-probe.js')})
  const hits=result.messages.filter(message=>message.ruleId==='prefer-const')
  const reported=result.messages.map(message=>`${message.ruleId}: ${message.message}`).join(' | ')||'(无)'
  assert.equal(hits.length,2,`prefer-const 应恰好报 2 条，实际：${reported}`)
  for(const hit of hits) assert.equal(hit.severity,2,'prefer-const 必须是 error')
  const named=hits.map(hit=>(hit.message.match(/'([^']+)'/)||[])[1]).sort()
  assert.deepEqual(named,['deferred','fixed'],`prefer-const 点名的变量不对：${reported}`)
})

test('eslint wires react-hooks: conditional hook is an error, missing dep is a warning',async()=>{
  // 锁的是「hooks 门禁真的接上了」，不是配置文件里的字面量：用 ESLint API 跑一段
  // 必然违规的合成代码。哪天插件被移除/规则名写错，这里先红。
  const pkg=JSON.parse(await read('../package.json'))
  assert.ok(pkg.devDependencies?.['eslint-plugin-react-hooks'],'devDependencies 缺少 eslint-plugin-react-hooks')
  const {ESLint}=await import('eslint')
  const root=fileURLToPath(new URL('..',import.meta.url))
  const eslint=new ESLint({cwd:root})
  const code=[
    "import {useEffect,useState} from 'react'",
    'export default function Probe({flag}){',
    '  if(flag){const [flagState]=useState(0);void flagState}',
    '  const [value,setValue]=useState(0)',
    '  useEffect(()=>{setValue(flag?1:0)},[])',
    '  return <b>{value}</b>',
    '}',
  ].join('\n')
  const [result]=await eslint.lintText(code,{filePath:join(root,'web','src','__hooks-gate-probe.jsx')})
  const reported=result.messages.map(message=>`${message.ruleId}: ${message.message}`).join(' | ')||'(无)'
  const hooks=result.messages.filter(message=>message.ruleId==='react-hooks/rules-of-hooks')
  assert.equal(hooks.length,1,`条件调用 hook 没被抓到，实际报告：${reported}`)
  // error 而非 warn：hooks 调用顺序错了是运行时崩溃，必须挡住
  assert.equal(hooks[0].severity,2,'rules-of-hooks 必须是 error')
  const deps=result.messages.filter(message=>message.ruleId==='react-hooks/exhaustive-deps')
  assert.equal(deps.length,1,`缺失依赖没被抓到，实际报告：${reported}`)
  // warn 而非 error：存量 effect 依赖不全需要逐个确认意图，门禁先观不拦
  assert.equal(deps[0].severity,1,'exhaustive-deps 必须是 warn')
  assert.match(deps[0].message,/'flag'/,`依赖提示没点名 flag：${deps[0].message}`)
})

