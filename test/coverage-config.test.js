import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const read=path=>readFile(new URL(path,import.meta.url),'utf8')

// 六个阈值里可能出小数（docs/prettier-migration-plan.md 排定 S7 把后端行阈值降到 93.5），
// 只认整数的正则会静默失效——那次 commit 之后守卫变成空转，所以解析必须吃小数。
const FLOORS=['lines','branches','functions']

function parseCoverageScript(script){
  const include=script.match(/--test-coverage-include="?([^"\s]+)"?/)
  const out={include:include?.[1]}
  for(const key of FLOORS){
    // 刻意不给默认值：缺一个 flag 就留 undefined，由调用方断言，避免「静默回落到某个数」也算过
    const found=script.match(new RegExp(`--test-coverage-${key}=(\\d+(?:\\.\\d+)?)`))
    out[key]=found?Number(found[1]):undefined
  }
  return out
}

// README 的现状表：从「覆盖率是 CI 里的独立门槛」那一段往下取第一张表
function parseReadmeFloors(readme){
  const lines=readme.split('\n')
  const start=lines.findIndex(line=>/覆盖率是 CI 里的独立门槛/.test(line))
  assert.notEqual(start,-1,'README 缺少覆盖率门槛说明段')
  const rows=[]
  let seenTable=false
  for(const line of lines.slice(start+1)){
    const isRow=line.trim().startsWith('|')
    if(!isRow){
      if(seenTable) break
      continue
    }
    seenTable=true
    rows.push(line.trim())
  }
  assert.ok(rows.length>=3,`README 覆盖率表格不完整，只读到 ${rows.length} 行`)
  // 丢掉表头与分隔行，剩下的每个数据行 = 一个范围
  const data=rows.slice(2).filter(row=>!FLOORS.some(key=>row.includes(key)))
  return data.map(row=>{
    const cells=row.split('|').slice(1,-1).map(cell=>cell.trim())
    const scope=cells[0].replace(/`/g,'')
    const [lines_,branches,functions]=cells.slice(1,4).map(cell=>{
      const found=/^(\d+(?:\.\d+)?)%$/.exec(cell)
      assert.ok(found,`README 表格单元格不是百分比：${JSON.stringify(cell)}`)
      return Number(found[1])
    })
    return {scope,lines:lines_,branches,functions}
  })
}

test('coverage thresholds in npm scripts and README agree',async()=>{
  const pkg=JSON.parse(await read('../package.json'))
  const backend=parseCoverageScript(pkg.scripts['test:coverage']??'')
  const web=parseCoverageScript(pkg.scripts['test:coverage:web']??'')

  for(const [name,parsed] of [['test:coverage',backend],['test:coverage:web',web]]){
    assert.ok(pkg.scripts[name],`package.json 缺少 ${name}`)
    for(const key of FLOORS){
      assert.equal(typeof parsed[key],'number',`${name} 缺少 --test-coverage-${key}`)
      assert.ok(parsed[key]>0&&parsed[key]<=100,`${name} 的 ${key} 阈值不合理：${parsed[key]}`)
    }
  }

  // 必须圈范围：不圈时后端报告会把 web/src/lib/* 一起聚合进来，等于把前端缺口记在后端账上
  assert.equal(backend.include,'src/**/*.js')
  assert.equal(web.include,'web/src/**/*.js')

  const rows=parseReadmeFloors(await read('../README.md'))
  assert.equal(rows.length,2,`README 覆盖率表应有后端/前端两行，实际 ${rows.length} 行`)
  const webRows=rows.filter(row=>row.scope.includes('web/src'))
  const backendRows=rows.filter(row=>!row.scope.includes('web/src'))
  assert.equal(webRows.length,1,`README 覆盖率表缺少唯一的前端「web/src」行，实际 ${webRows.length} 行`)
  assert.equal(backendRows.length,1,`README 覆盖率表缺少唯一的后端「src」行，实际 ${backendRows.length} 行`)
  const [readmeBackend]=backendRows
  const [readmeWeb]=webRows

  assert.deepEqual(
    {lines:readmeBackend.lines,branches:readmeBackend.branches,functions:readmeBackend.functions},
    {lines:backend.lines,branches:backend.branches,functions:backend.functions},
    `README 后端下限与 test:coverage 不一致：README ${JSON.stringify(readmeBackend)} / 脚本 ${JSON.stringify(backend)}`
  )
  assert.deepEqual(
    {lines:readmeWeb.lines,branches:readmeWeb.branches,functions:readmeWeb.functions},
    {lines:web.lines,branches:web.branches,functions:web.functions},
    `README 前端下限与 test:coverage:web 不一致：README ${JSON.stringify(readmeWeb)} / 脚本 ${JSON.stringify(web)}`
  )
})

test('coverage floors actually gate CI',async()=>{
  const ci=await read('../.github/workflows/ci.yml')
  const runs=ci
    .split('\n')
    .map(line=>line.trim())
    .filter(line=>line.startsWith('run: '))
    .map(line=>line.slice('run: '.length).trim())
  // 精确相等而不是 includes：'npm run test:coverage' 是 'npm run test:coverage:web' 的前缀，
  // 用 includes 的话只剩后者时前端那条会冒充两条都在
  for(const script of ['npm run test:coverage','npm run test:coverage:web']){
    assert.ok(runs.includes(script),`CI 缺少步骤 run: ${script}`)
  }
})

test('coverage parser handles decimals and does not invent defaults',()=>{
  // 反空转自检：合成串证明小数被解析、缺 flag 不会回落到某个默认值
  const parsed=parseCoverageScript(
    'node --test --experimental-test-coverage --test-coverage-include="src/**/*.js" '+
      '--test-coverage-lines=93.5 --test-coverage-branches=82.25 --test-coverage-functions=91 test/*.test.js'
  )
  assert.deepEqual(parsed,{include:'src/**/*.js',lines:93.5,branches:82.25,functions:91})

  const bare=parseCoverageScript('node --test test/*.test.js')
  for(const key of FLOORS) assert.equal(bare[key],undefined,`解析器给 ${key} 编了个默认值`)
  assert.equal(bare.include,undefined)
})
