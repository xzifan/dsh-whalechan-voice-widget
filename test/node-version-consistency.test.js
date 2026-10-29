import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const read=path=>readFile(new URL(path,import.meta.url),'utf8')
// '^20.19.0 || >=22.12.0' → 有界下限（^ / ~）与开放下限（>=）
const entries=range=>[...range.matchAll(/(\^|~|>=)?(\d+)\.(\d+)\.(\d+)/g)].map(m=>({op:m[1]??'',major:Number(m[2]),minor:Number(m[3])}))
const floors=range=>entries(range).map(e=>e.major+'.'+e.minor)
const closedMajors=range=>entries(range).filter(e=>e.op==='^'||e.op==='~').map(e=>e.major)
const openFloor=range=>Math.max(...entries(range).filter(e=>e.op==='>=').map(e=>e.major))

test('Node requirement is consistent across engines, README and CI matrix',async()=>{
  const root=JSON.parse(await read('../package.json'))
  const web=JSON.parse(await read('../web/package.json'))
  const range=root.engines?.node
  assert.equal(typeof range,'string')
  // 前端构建工具 Vite 的范围就是真实下限，根包不能比它更宽松
  assert.equal(range,web.engines.node)
  assert.deepEqual(floors(range),['20.19','22.12'])

  const readme=await read('../README.md')
  const line=readme.split('\n').find(l=>/需要 Node\.js/.test(l))
  assert.ok(line,'README 缺少 Node.js 版本要求')
  assert.deepEqual([...line.matchAll(/(\d+\.\d+)(?=\+)/g)].map(m=>m[1]),floors(range))
  assert.ok(!/Node\.js\s*1\d/.test(readme),'README 仍写明已 EOL 的 Node 1x')

  const ci=await read('../.github/workflows/ci.yml')
  const matrix=ci.match(/node-version:\s*\[([^\]]+)\]/)
  assert.ok(matrix,'CI 缺少 node-version matrix')
  const majors=matrix[1].split(',').map(s=>Number(s.trim().replace(/['"]/g,'')))
  assert.ok(majors.every(Number.isInteger),'CI matrix 只能写主版本号数字串')

  const closed=closedMajors(range),open=openFloor(range)
  for(const major of majors){
    assert.ok(closed.includes(major)||major>=open,`CI 测试的 Node ${major} 不满足 engines 范围 ${range}`)
  }
  for(const major of [...closed,open]){
    assert.ok(majors.includes(major),`CI matrix 缺少 engines 范围下的 Node ${major}`)
  }
})

// Node 下限曾只改 package.json/README/CI 三处，lockfile 的 packages[""] 各改各的
// （根包 74ea1bd 才补上，前端那份碰巧初版就对）。npm install 会顺手重写这一行，
// 但只要有人只改 package.json 而没重装，两处就会再次分叉，所以在这里锁死。
test('lockfile engines stay aligned with package.json engines',async()=>{
  const packs=[
    ['根包','../package.json','../package-lock.json'],
    ['前端','../web/package.json','../web/package-lock.json'],
  ]
  for(const [label,pkgPath,lockPath] of packs){
    const pkg=JSON.parse(await read(pkgPath))
    const lock=JSON.parse(await read(lockPath))
    assert.equal(lock.lockfileVersion,3,`${label} lockfile 不是 v3，packages[""] 结构不成立`)
    const self=lock.packages?.['']
    assert.ok(self,`${label} lockfile 缺少 packages[""]`)
    assert.equal(self.name,pkg.name,`${label} lockfile 的 name 与 package.json 不一致`)
    assert.equal(
      self.engines?.node,
      pkg.engines?.node,
      `${label} lockfile 的 packages[""].engines.node 与 package.json 不一致（改 Node 下限时必须同步 lockfile）`,
    )
  }
})
