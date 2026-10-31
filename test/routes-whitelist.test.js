import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync, readdirSync} from 'node:fs'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {apply} from '../src/index.js'
import {ENDPOINT_METHODS} from '../web/src/lib/core.js'

// 三方接线：服务端路由（src/index.js）、iframe 侧白名单（ENDPOINT_METHODS）、宿主侧白名单
// （lib/client.js）。0.7.0 的 /api/changelog 只接了服务端：iframe 表缺 → 立刻 reject
// 「不支持的工作台操作」；只补 iframe 表 → 宿主静默不回、180 秒超时。
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const GAP = '协议不一致'

// 宿主侧表是 lib/client.js 里的对象字面量（'/api/x': ['POST']）。只按键+数组解析，不看排版。
export function parseMethodsTable(source, label = 'lib/client.js') {
  const table = {}
  for (const match of source.matchAll(/'(\/api\/[A-Za-z0-9/_-]+)'\s*:\s*\[([^\]]*)\]/g)) {
    const methods = match[2].split(',').map(value => value.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
    assert.ok(methods.length > 0, `${label} 里 ${match[1]} 没有方法`)
    assert.equal(table[match[1]], undefined, `${label} 里 ${match[1]} 重复声明`)
    table[match[1]] = methods
  }
  return table
}

// api( 的参数全文：括号配平、跳过字符串字面量，才能认出 api('x', {}, 'GET') 的第三参。
function argumentText(source, openIndex) {
  let depth = 0
  let quote = ''
  for (let index = openIndex; index < source.length; index++) {
    const char = source[index]
    if (quote) {
      if (char === '\\') index++
      else if (char === quote) quote = ''
    } else if (char === "'" || char === '"' || char === '`') quote = char
    else if (char === '(') depth++
    else if (char === ')' && --depth === 0) return source.slice(openIndex + 1, index)
  }
  return null
}

// web/src 里真正会发出的请求：字面量端点 + （目前只有一处的）模板串端点。
export function apiCallSites(source) {
  const sites = []
  for (const match of source.matchAll(/(?:^|[^\w.$])api\(\s*(?:'([A-Za-z0-9/_-]+)'|`([^`]+)`)/g)) {
    const args = argumentText(source, source.indexOf('(', match.index))
    assert.ok(args !== null, `api( 调用参数不闭合：${match[0]}`)
    const explicit = /,\s*'(GET|PUT|POST)'\s*$/.exec(args.trim())
    sites.push({endpoint: match[1] ? '/api/' + match[1] : null, template: match[2] || null, method: explicit ? explicit[1] : 'POST'})
  }
  return sites
}

function sourceFiles(dir) {
  return readdirSync(join(ROOT, dir), {withFileTypes: true}).flatMap(entry => {
    const relative = `${dir}/${entry.name}`
    if (entry.isDirectory()) return sourceFiles(relative)
    return /\.jsx?$/.test(entry.name) && !/\.test\.js$/.test(entry.name) ? [relative] : []
  })
}

// 用真实 apply() + 假 ctx 注册路由：解析源码会被排版变化带偏，这里拿到的是实际注册表。
async function serverRoutes() {
  const routes = new Map()
  const effects = []
  apply(
    {
      effect(fn) {
        const cleanup = fn()
        if (cleanup) effects.push(cleanup)
      },
      connection: {
        fetch: {
          register(route) {
            const path = route.path.replace('/api/voice-workbench/', '/api/')
            assert.ok(!routes.has(path), `服务端重复注册 ${path}`)
            routes.set(path, route.methods)
            return () => {}
          },
        },
        admit: () => ({rejection: 401}),
      },
      webServer: {register: () => () => {}},
    },
    {stateDir: await mkdtemp(join(tmpdir(), 'dsh-voice-routes-'))},
  )
  for (const cleanup of effects.reverse()) await cleanup()
  return routes
}

test('服务端路由与两张转发白名单逐键一致，前端调用点全部在表内', async () => {
  const server = await serverRoutes()
  const frontend = {...ENDPOINT_METHODS}
  const client = parseMethodsTable(readFileSync(join(ROOT, 'lib/client.js'), 'utf8'))
  const serverKeys = [...server.keys()].sort()
  const frontendKeys = Object.keys(frontend).sort()
  const clientKeys = Object.keys(client).sort()

  // 解析器自检：空集 == 空集会让下面所有断言空转。
  assert.ok(serverKeys.length >= 20, `服务端只解析出 ${serverKeys.length} 条路由`)
  assert.ok(frontendKeys.length >= 20, `iframe 白名单只解析出 ${frontendKeys.length} 条`)
  assert.ok(clientKeys.length >= 20, `宿主白名单只解析出 ${clientKeys.length} 条`)

  // 两张表必须同键同方法：只补一张时失败形态分别是「突然 reject」与「静默等到超时」。
  assert.deepEqual(clientKeys, frontendKeys, `${GAP}：iframe 白名单与宿主白名单的端点集合不同`)
  for (const path of frontendKeys) assert.deepEqual(client[path], frontend[path], `${GAP}：${path} 在两张表里的方法不同`)

  // 表里每条都得是真路由且方法一致（防幽灵条目）。
  for (const path of frontendKeys) {
    assert.ok(path.startsWith('/api/'), `${path} 不是 /api/ 路径`)
    assert.ok(serverKeys.includes(path), `${GAP}：白名单里的 ${path} 服务端没有注册`)
    assert.deepEqual(server.get(path), frontend[path], `${GAP}：${path} 的方法与服务端不一致`)
  }

  // 服务端有、两张表都没有的必须只剩这两条；新增服务端路由时被迫显式选择「接线」还是「登记例外」。
  // health：发布校验与适配器直连，网桥不转发。models/check：模型配置页下线后无前端消费方。
  assert.deepEqual(
    serverKeys.filter(path => !frontendKeys.includes(path)),
    ['/api/health', '/api/models/check'],
    `${GAP}：新增了前端未接线的服务端路由`,
  )

  // 真正的调用点必须发得出去。
  const sites = sourceFiles('web/src').flatMap(path => apiCallSites(readFileSync(join(ROOT, path), 'utf8')))
  const literal = sites.filter(site => site.endpoint)
  assert.ok(literal.length >= 12, `web/src 只解析出 ${literal.length} 处 api() 调用点`)
  for (const site of literal) {
    assert.ok(frontendKeys.includes(site.endpoint), `${GAP}：前端会调用 ${site.endpoint}，白名单里没有`)
    assert.ok(frontend[site.endpoint].includes(site.method), `${GAP}：前端用 ${site.method} 调 ${site.endpoint}`)
    assert.ok(clientKeys.includes(site.endpoint), `${GAP}：宿主白名单没有 ${site.endpoint}`)
  }

  // 唯一一处动态端点：voice-presets/${action}，action 的取值域由 hooks 的 run(id,action) 封闭。
  assert.deepEqual(sites.filter(site => site.template).map(site => site.template), ['voice-presets/${action}'], `${GAP}：出现未登记的动态端点`)
  const presets = readFileSync(join(ROOT, 'web/src/hooks/use-voice-presets.js'), 'utf8')
  const actions = [...new Set([...presets.matchAll(/run\([^,)]+,\s*'([a-z]+)'\)/g)].map(match => match[1]))].sort()
  assert.deepEqual(actions, ['apply', 'generate', 'greeting'])
  for (const action of actions) assert.ok(frontendKeys.includes('/api/voice-presets/' + action), `${GAP}：动态端点 voice-presets/${action} 不在白名单`)
})

test('白名单解析器对合成源码给出确定结果（防解析失效后空转过关）', () => {
  const table = parseMethodsTable("const methods = {\n  '/api/alpha': ['GET'],\n  '/api/beta': ['POST', 'PUT'],\n}")
  assert.deepEqual(table, {'/api/alpha': ['GET'], '/api/beta': ['POST', 'PUT']})
  const sites = apiCallSites("api('alpha', {}, 'GET'); await api('beta', {value: (1)}); api(`gamma/${which}`, {})")
  assert.deepEqual(
    sites.map(site => [site.endpoint || site.template, site.method]),
    [
      ['/api/alpha', 'GET'],
      ['/api/beta', 'POST'],
      ['gamma/${which}', 'POST'],
    ],
  )
  assert.deepEqual(parseMethodsTable('const nothing = {}'), {})
})