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
