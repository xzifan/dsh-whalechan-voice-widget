import { normalizeBreezeProfile } from './breeze-voices.js'
import { createVoicePresets } from './voice-presets.js'
import { createVoiceCandidateState } from './voice-candidate.js'
import { readFile, mkdir, writeFile, rename, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getTtsProfile } from './tts-config.js'
import { configIssues } from './config-validation.js'
import { createRealtimeSession, realtimeDefaults } from './realtime-service.js'
import { audioDurationSeconds } from './audio-duration.js'
import { createAuditLog, sanitizeAuditRecord, numericUsage } from './audit-log.js'
import { designVoice, synthesizeTts, synthesisFailureText } from './voice-design.js'
import { createVoiceToolBridge, breezeDisabled } from './voice-tool-bridge.js'
import { createVoiceSynthesis } from './voice-synthesis.js'
import { createVoiceInitialization } from './voice-initialization.js'
import { readPersona, assembleRealtimeInstruction } from './persona.js'
import { randomUUID } from 'node:crypto'

export const defaults = {
  workspace: '', enabled_tools: [], tools_configured: false, system_prompt: '请用简短自然的中文回答。',
  // Voice layer: which TTS provider synth_tts uses. 'qwen' -> Bailian Qwen TTS
  // (qwen-audio-3.1-tts-plus via synthesizeTts). Any other id selects a named
  // profile from tts_profiles, synthesized via synthesizeHttpTts.
  tts_voice_provider: 'qwen',
  tts_profiles: {},
  realtime: realtimeDefaults(),
}

export class RequestError extends Error { constructor(message, status = 400, fields) { super(message); this.status = status; if (fields) this.fields = fields } }
function requireValue(ok, message, status = 400) { if (!ok) throw new RequestError(message, status) }
function id(value) { requireValue(typeof value === 'string' && /^[\w-]{1,100}$/.test(value), '会话或请求标识无效'); return value }

const PLUGIN_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version || 'unknown' }
  catch { return 'unknown' }
})()

export function createService(config = {}, dependencies = {}) {
  const fetcher = dependencies.fetch || globalThis.fetch
  const stateDir = config.stateDir ? config.stateDir.replace(/^~(?=\/)/, homedir()) : join(homedir(), '.dsh', 'storages', 'voice-workbench')
  const settingsPath = join(stateDir, 'settings.json')
  const audit = createAuditLog({ path: join(stateDir, 'voice-audit.jsonl'), archiveDir: join(stateDir, 'audit-archive') })
  const startedAt = Date.now()
  let settings = structuredClone(defaults), disposed = false
  const realtimeSessions = new Map() // sessionId -> {session, events, cursor, closed, key}
  // 上游断连后只留只读墓碑（够客户端取完末尾事件），超过上限按插入顺序淘汰。
  const MAX_CLOSED_REALTIME_SESSIONS = 8
  // 并发额度只数活会话：墓碑还占着额度等于断连后仍然 429。
  function liveRealtimeSessionCount() {
    let live = 0
    for (const record of realtimeSessions.values()) if (!record.closed) live += 1
    return live
  }
  // 服务端权威收尾：上游 socket 关闭后会话不可再用，不等客户端再来一次请求。
  function settleRealtimeSession(sid) {
    const record = realtimeSessions.get(sid)
    if (!record || record.closed) return
    record.closed = true
    record.session.dispose() // disposed 后二次 socket.close 不再 emit，重入安全
    void dependencies.releaseToolSession?.(sid)
    const closed = [...realtimeSessions].filter(([, r]) => r.closed)
    for (const [old] of closed.slice(0, Math.max(0, closed.length - MAX_CLOSED_REALTIME_SESSIONS))) realtimeSessions.delete(old)
  }

  // Normalize + validate a settings-like object against the retained schema.
  function validateSettings(input) {
    requireValue(input && typeof input === 'object' && !Array.isArray(input), '配置格式不正确')
    const s = { ...structuredClone(defaults), ...Object.fromEntries(Object.keys(defaults).filter(k => k in input).map(k => [k, input[k]])) }
    const issues = configIssues(s, { platform: process.platform })
    if (Object.keys(issues).length) throw new RequestError(Object.values(issues)[0], 400, issues)
    s.workspace = (typeof s.workspace === 'string' ? s.workspace : '').trim().replace(/^~(?=\/)/, homedir())
    s.tools_configured = s.tools_configured === true
    s.enabled_tools = [...new Set((Array.isArray(s.enabled_tools) ? s.enabled_tools : []).filter(t => typeof t === 'string'))]
    s.tts_profiles = Object.fromEntries(Object.entries(s.tts_profiles && typeof s.tts_profiles === 'object' ? s.tts_profiles : {})
      .filter(([, p]) => p && typeof p === 'object' && !Array.isArray(p)))
    s.realtime = { ...realtimeDefaults(), ...(s.realtime && typeof s.realtime === 'object' ? s.realtime : {}), credential_source: 'provider' }
    delete s.realtime.key_file
    delete s.realtime.credential_ref
    for (const [provider, profile] of Object.entries(s.tts_profiles)) {
      if (['breeze', 'volcengine'].includes(provider) || profile.protocol === 'breeze-tts') {
        const { key_file, credential_source, credential_ref, ...retained } = profile
        s.tts_profiles[provider] = provider === 'breeze' || profile.protocol === 'breeze-tts' ? normalizeBreezeProfile(retained) : retained
      }
    }
    return s
  }

  async function catalog() {
    const raw = dependencies.catalog ? await dependencies.catalog() : {}
    return {
      tools: (Array.isArray(raw.tools) ? raw.tools : []).filter(tool => typeof tool.name === 'string').map(tool => ({ name: tool.name.slice(0, 180), description: String(tool.description || '').slice(0, 1000), ...(tool.parameters && typeof tool.parameters === 'object' && !Array.isArray(tool.parameters) ? { parameters: structuredClone(tool.parameters) } : {}) })),
      currentWorkspace: raw.currentWorkspace || raw.workspace || process.cwd(),
      toolExecutionAvailable: !config.chatBaseUrl && !!raw.toolExecutionAvailable,
      interruption: { manual: true, voice: false },
    }
  }

  async function runtimeIssues(next) {
    const errors = {}
    if (next.workspace) { let info; try { info = await stat(next.workspace) } catch { errors.workspace = '工作区不存在或不可访问' }; if (info && !info.isDirectory()) errors.workspace = '工作区必须是目录' }
    if (next.enabled_tools.length) {
      try { const available = await catalog(); if (!available.toolExecutionAvailable) errors.enabled_tools = '当前模型环境未接通工具执行'; else { const names = new Set(available.tools.map(t => t.name)); if (!next.enabled_tools.every(name => names.has(name))) errors.enabled_tools = '包含不可用的工具，请重新选择' } }
      catch { errors.enabled_tools = '无法读取当前可用工具，请刷新后重试' }
    }
    return errors
  }

  async function checkConfiguration(input) {
    let next; const warnings = {}
    try { next = validateSettings(input) } catch (error) { return { valid: false, errors: error.fields || { settings: error.message }, warnings, checked: 'configuration', networkTested: false } }
    const errors = await runtimeIssues(next)
    return { valid: Object.keys(errors).length === 0, errors, warnings, checked: 'configuration', networkTested: false, next }
  }

  const settingsLoad = readFile(settingsPath, 'utf8').then(raw => { settings = validateSettings(JSON.parse(raw)) }).catch(e => { if (e.code !== 'ENOENT') throw new RequestError('工作台配置无法读取，请检查配置文件', 500) })

  function realtimeSettings(input = settings) {
    const s = input && typeof input === 'object' ? input : settings
    return { ...realtimeDefaults(), ...(s.realtime && typeof s.realtime === 'object' ? s.realtime : {}) }
  }

  const credentialLabels = { bailian: '百炼', breeze: 'Breeze', volcengine: '火山引擎' }
  async function resolveModelCredential(provider) {
    try {
      const result = dependencies.resolveModelCredential
        ? await dependencies.resolveModelCredential(provider)
        : provider === 'bailian' ? await dependencies.resolveBailianProvider?.() : null
      return result || { provider, source: 'provider', configured: false, routeAvailable: false }
    } catch {
      throw new RequestError(`DSH ${credentialLabels[provider] || provider}凭据读取失败，请检查宿主凭据配置`, 503)
    }
  }
  async function modelCredential(provider) {
    const result = await resolveModelCredential(provider)
    requireValue(result.key, `未配置 DSH ${credentialLabels[provider] || provider}凭据，请在对应模型下选择「配置凭据」并保存到 DSH`, 503)
    audit.addSecret(result.key)
    return result
  }
  const bailianCredential = () => modelCredential('bailian')
  async function credentialStatus(provider) {
    try {
      const result = await resolveModelCredential(provider)
      return { provider, ready: !!result.key, source: 'provider', routeAvailable: !!result.routeAvailable,
        ...(result.credentialRef ? { credentialRef: result.credentialRef } : {}),
        ...(result.recordKey ? { recordKey: result.recordKey } : {}),
        writable: !!dependencies.configureModelCredential && result.writable !== false,
        ...(!result.key ? { error: `请配置 DSH ${credentialLabels[provider]}凭据` } : {}),
        checked: 'readable', networkTested: false }
    } catch (error) { return { provider, ready: false, source: 'provider', writable: false, error: error.message, checked: 'readable', networkTested: false } }
  }
  async function credentialStatuses() {
    const providers = ['bailian', 'breeze', 'volcengine']
    return Object.fromEntries(await Promise.all(providers.map(async provider => [provider, await credentialStatus(provider)])))
  }

  async function runSingleTool(name, args, workspace, context = {}) {
    requireValue(typeof dependencies.runTool === 'function', '当前 DSH 尚未提供原生工具服务，可先关闭工具继续聊天。', 503)
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 60000); timer.unref?.()
    // sessionKey 让同一场语音会话复用同一个 DSH 工具 agent，否则 read→edit 这类跨步骤组合会丢状态。
    try { return await dependencies.runTool(name, args, { workspace, signal: controller.signal, sessionKey: context.sessionKey, allow: context.allow }) }
    finally { clearTimeout(timer) }
  }

  let mutationTail = Promise.resolve()
  function mutate(work) {
    const result = mutationTail.then(work)
    mutationTail = result.catch(() => {})
    return result
  }
  const voicePresets = createVoicePresets({ stateDir, mutate, getSettings: () => settings,
    persistSettings: commitSettings, credential: bailianCredential,
    design: options => designVoice({ ...options, fetcher }),
    synthesize: async options => {
      const metadata = { provider: 'bailian', model: options.model, voice: options.voice }
      const record = { ...metadata, kind: 'synthesis', role: 'assistant', text: options.text }
      try {
        const startedAt = Date.now()
        const result = await synthesizeTts({ ...options, fetcher })
        const duration = typeof result.audio === 'string' ? audioDurationSeconds(Buffer.from(result.audio, 'base64')) : null
        await audit.append({ ...record, status: 'completed', usage: numericUsage(result.usage), requestId: result.requestId, audioOutput: true, audioDurationSeconds: duration, durationMs: Date.now() - startedAt })
        return result
      } catch (error) {
        const cancelled = options.signal?.aborted || error.status === 499
        await audit.append({ ...record, status: cancelled ? 'cancelled' : 'failed', usage: null })
        if (!cancelled) await audit.append({ ...metadata, kind: 'error', status: 'failed', text: synthesisFailureText(error), usage: null })
        throw error
      }
    },
    error: (message, status) => new RequestError(message, status),
  })

  // All settings writers share a queue; callbacks merge against the latest state.
  function persistSettings(patch, signal) {
    return mutate(() => commitSettings(patch, signal))
  }
  async function commitSettings(patch, signal) {
    signal?.throwIfAborted()
    const next = validateSettings({ ...settings, ...(typeof patch === 'function' ? patch(settings) : patch) })
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    const tmp = join(stateDir, `settings-${randomUUID()}.tmp`)
    await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600, signal })
    signal?.throwIfAborted()
    await rename(tmp, settingsPath)
    settings = next
    return next
  }

  // 会话启动的音色初始化已抽出到 src/voice-initialization.js；这里只做注入。
  // 注入 raw mutate + commitSettings（不能传 persistSettings：mutate 不可重入，套一层会死锁）
  // 与 live getter：settings 会被 commitSettings 整体重赋值，disposed 也是活标志。
  const { initializeSessionVoice } = createVoiceInitialization({
    getSettings: () => settings, mutate, commitSettings, voicePresets, modelCredential,
    isDisposed: () => disposed, requireValue, RequestError,
  })

  // 合成层（provider/profile 快照、凭据选择、合成审计）已抽出到 src/voice-synthesis.js。
  // getSettings 必须是 live getter：settings 会被 commitSettings 整体重赋值。
  const { voiceProfile, synthVoiceLayer } = createVoiceSynthesis({
    getSettings: () => settings, credential: () => bailianCredential(), modelCredential, audit, fetcher, requireValue,
  })

  // 语音工具（8 个）与原生工具分派已抽出到 src/voice-tool-bridge.js；这里只做注入。
  // getSettings 必须是 live getter：settings 会被 commitSettings 整体重赋值。
  const { dispatchRealtimeTool } = createVoiceToolBridge({
    getSettings: () => settings, persistSettings, credential: () => bailianCredential(),
    synthVoiceLayer, voiceProfile: () => voiceProfile(), runSingleTool, fetcher, audit, requireValue, RequestError,
  })

  async function handle(method, path, body = {}, externalSignal) {
    await Promise.all([settingsLoad, voicePresets.ready])
    requireValue(!disposed, '插件已停止', 503)
    if (method === 'GET' && path === '/api/config') {
      const snapshot = structuredClone(settings)
      const presetSnapshot = voicePresets.snapshot(snapshot)
      const native = dependencies.status?.() || {}
      const providers = await credentialStatuses(), bailian = providers.bailian
      const voiceReady = snapshot.tts_voice_provider === 'qwen' ? bailian.ready : snapshot.tts_voice_provider === 'breeze' ? providers.breeze.ready : !!getTtsProfile({ tts_provider: snapshot.tts_voice_provider || 'qwen', tts_profiles: snapshot.tts_profiles })
      const { provider, model, voice } = sanitizeAuditRecord({ kind: 'synthesis', ...voiceProfile(snapshot) })
      return { body: { settings: snapshot, voicePresets: presetSnapshot, breezeVoicePresets: [], credentials: { tts: voiceReady, bailian, providers, asr: false, chat: !!native.chat }, models: { tts: { provider, model, voice, ready: voiceReady } }, capabilities: { ...native } } }
    }
    if (method === 'PUT' && path === '/api/config') {
      const input = structuredClone(body?.settings)
      return mutate(async () => {
        const checked = await checkConfiguration(input)
        if (!checked.valid) throw new RequestError(Object.values(checked.errors)[0], 400, checked.errors)
        await commitSettings(checked.next, externalSignal)
        return { body: { settings: structuredClone(settings), voicePresets: voicePresets.snapshot(), breezeVoicePresets: [] } }
      })
    }
    if (method === 'GET' && path === '/api/health') {
      // 轻量自检：只读本地状态，不发起上游请求、不返回凭据值。
      const providers = await credentialStatuses()
      const { provider, model, voice } = sanitizeAuditRecord({ kind: 'synthesis', ...voiceProfile(settings) })
      const ttsReady = provider === 'qwen' ? !!providers.bailian?.ready
        : provider === 'breeze' ? !!providers.breeze?.ready
        : !!getTtsProfile({ tts_provider: provider, tts_profiles: settings.tts_profiles })
      return { body: {
        ok: !disposed,
        version: PLUGIN_VERSION,
        uptimeMs: Date.now() - startedAt,
        tts: { provider, model, voice, ready: ttsReady },
        realtime: { activeSessions: liveRealtimeSessionCount() },
        tools: { enabled: Array.isArray(settings.enabled_tools) ? settings.enabled_tools.length : 0 },
        credentials: { bailian: !!providers.bailian?.ready, breeze: !!providers.breeze?.ready },
        capabilities: { ...(dependencies.status?.() || {}) },
      } }
    }
    requireValue(method === 'POST', '不支持的请求方法', 405)
    if (path === '/api/credentials/status') {
      requireValue(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0, '凭据检查请求格式无效')
      return { body: { providers: await credentialStatuses() } }
    }
    if (path === '/api/credentials/save') {
      requireValue(body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).every(key => ['provider', 'key'].includes(key)), '凭据保存请求格式无效')
      requireValue(Object.hasOwn(credentialLabels, body.provider), '不支持的凭据提供方')
      /* eslint-disable no-control-regex -- API Key 校验需要拒绝控制字符 */
      requireValue(typeof body.key === 'string' && body.key.trim().length > 0 && body.key.length <= 8192 && !/[\u0000-\u0020\u007f]/.test(body.key.trim()), '请输入有效的 API Key')
      /* eslint-enable no-control-regex */
      requireValue(typeof dependencies.configureModelCredential === 'function', '当前宿主不支持保存凭据，请在 DSH 模型设置中配置', 503)
      audit.addSecret(body.key.trim())
      try { await dependencies.configureModelCredential(body.provider, body.key.trim()) }
      // 宿主拒绝保存时给的是可执行指令（「请在 DSH 模型设置中配置」），原样透传它的
      // message 与状态码；否则前端只能提示「重新输入后重试」，而账户授权型提供方重输
      // 永远不会成功。未知异常可能带宿主内部细节（甚至密钥），必须继续掩成常量 503。
      catch(error) {
        if(error?.name==='VoiceNativeError'&&typeof error.message==='string')throw new RequestError(error.message,Number.isInteger(error.status)?error.status:503)
        throw new RequestError('DSH 凭据保存失败，请检查宿主凭据服务；原配置未在插件中另存', 503)
      }
      return { body: { providers: await credentialStatuses() } }
    }
    const presetAction = path.match(/^\/api\/voice-presets\/(save|generate|apply|greeting)$/)?.[1]
    if (presetAction) {
      requireValue(body?.provider === undefined || ['qwen', 'breeze'].includes(body.provider), '音色提供方无效')
      requireValue(body?.provider !== 'breeze', breezeDisabled, 400)
      return { body: await voicePresets.handle(presetAction, body, externalSignal) }
    }
    if (path === '/api/history/sessions' || path === '/api/history/messages') {
      requireValue(body !== null && typeof body === 'object' && (Object.getPrototypeOf(body) === Object.prototype || Object.getPrototypeOf(body) === null), '历史查询格式无效')
      const sessions = path === '/api/history/sessions'
      const allowed = new Set(sessions ? ['search'] : ['sessionId'])
      requireValue(Reflect.ownKeys(body).every(key => allowed.has(key)), '历史查询字段无效')
      if (sessions) {
        if (Object.hasOwn(body, 'search')) requireValue(typeof body.search === 'string' && body.search.length <= 200, '历史搜索文本须为不超过 200 字符的字符串')
        return { body: await audit.historySessions(body) }
      }
      requireValue(Object.hasOwn(body, 'sessionId'), '请提供会话标识')
      id(body.sessionId)
      return { body: await audit.historyMessages(body) }
    }
    if (path === '/api/statistics') {
      requireValue(body && typeof body === 'object' && !Array.isArray(body), '统计查询格式无效')
      for (const key of ['since', 'until']) if (body[key] !== undefined) requireValue(Number.isSafeInteger(body[key]) && body[key] >= 0, '统计时间范围须为非负整数毫秒')
      requireValue(body.since === undefined || body.until === undefined || body.since <= body.until, '统计开始时间不能晚于结束时间')
      return { body: await audit.statistics(body) }
    }
    if (path === '/api/audit') {
      requireValue(body && typeof body === 'object' && !Array.isArray(body), '审计查询格式无效')
      if (body.limit !== undefined) requireValue(Number.isSafeInteger(body.limit) && body.limit >= 1 && body.limit <= 200, '审计页大小须为 1 到 200')
      if (body.before !== undefined) requireValue(Number.isSafeInteger(body.before) && body.before > 0, '审计游标须为正整数')
      if (body.search !== undefined) requireValue(typeof body.search === 'string' && body.search.length <= 500, '审计搜索文本过长')
      if (body.columnFilters !== undefined) {
        const filters = body.columnFilters
        requireValue(filters !== null && typeof filters === 'object' && (Object.getPrototypeOf(filters) === Object.prototype || Object.getPrototypeOf(filters) === null), '审计列筛选格式无效')
        const keys = new Set(['text', 'provider', 'model', 'status', 'sessionId', 'messageId'])
        requireValue(Reflect.ownKeys(filters).every(key => keys.has(key) && typeof filters[key] === 'string' && filters[key].length <= 200), '审计列筛选字段或值无效')
      }
      if (body.kind !== undefined) requireValue(['transcription', 'response', 'synthesis', 'usage', 'tool', 'error'].includes(body.kind), '审计类别无效')
      if (body.sessionId !== undefined) id(body.sessionId)
      for (const key of ['since', 'until']) if (body[key] !== undefined) requireValue(Number.isSafeInteger(body[key]) && body[key] >= 0, '审计时间范围无效')
      if (body.failed !== undefined) requireValue(body.failed === true, '审计失败筛选无效')
      return { body: await audit.query(body) }
    }
    if (path === '/api/config/check') {
      const { next, ...result } = await checkConfiguration(body.settings)
      const providers = next ? await credentialStatuses() : undefined, bailian = providers?.bailian
      if (bailian && !bailian.ready) result.warnings.bailian = bailian.error
      if (next?.tts_voice_provider === 'breeze' && !providers.breeze.ready) result.warnings.breeze = providers.breeze.error
      return { body: { ...result, ...(providers ? { bailian, providers } : {}) } }
    }
    if (path === '/api/models/check') {
      requireValue(body.target === 'tts', '请选择需要检查的语音模型')
      const next = body.settings ? validateSettings(body.settings) : settings
      if (next.tts_voice_provider !== 'qwen') requireValue(!!getTtsProfile({ tts_provider: next.tts_voice_provider, tts_profiles: next.tts_profiles }), '所选语音提供方不存在，请重新选择', 503)
      return { body: { ok: true, checked: 'configuration', networkTested: false, target: 'tts' } }
    }
    if (path === '/api/catalog') return { body: await catalog() }
    if (path === '/api/realtime/start') {
      requireValue(method === 'POST', '不支持的请求方法', 405)
      const sessionSettings = validateSettings({ ...settings, ...(body.settings || {}) })
      const rt = { ...realtimeSettings(sessionSettings), tts_provider: sessionSettings.tts_voice_provider || 'qwen' }
      const selected = new Set(sessionSettings.enabled_tools)
      let nativeTools = []
      if (selected.size) {
        const available = await catalog()
        requireValue(available.toolExecutionAvailable, '当前模型环境未接通工具执行', 503)
        nativeTools = available.tools.filter(tool => selected.has(tool.name))
        requireValue(nativeTools.length === selected.size && nativeTools.every(tool => tool.parameters), '包含不可用的工具或工具参数，请刷新工具列表重新选择', 400)
      }
      const workspace = sessionSettings.workspace
      requireValue(liveRealtimeSessionCount() < 4, '实时语音会话过多，请稍后重试', 429)
      const { key } = await bailianCredential(rt)
      const voiceSettingsPatch = await initializeSessionVoice(sessionSettings, externalSignal)
      externalSignal?.throwIfAborted()
      if (voiceSettingsPatch) {
        for (const [provider, profile] of Object.entries(voiceSettingsPatch.tts_profiles || {})) sessionSettings.tts_profiles[provider] = { ...sessionSettings.tts_profiles[provider], ...profile }
      }
      if (!rt.instructions?.trim()) {
        const personaText = await readPersona()
        rt.instructions = assembleRealtimeInstruction(personaText, !!rt.use_tts_voice)
      }
      if (rt.tts_provider === 'breeze' && rt.use_tts_voice !== false) rt.instructions += '\n当前出声提供方为 Breeze，按回复文字的中文、日语、英语自动使用固定预设。Breeze 暂不支持提示词生成或复刻，不调用 design_voice、apply_voice、delete_voice；需要时用 list_voice_presets 查看三语音色。'
      externalSignal?.throwIfAborted()
      requireValue(!disposed, '工作台已关闭', 503)
      requireValue(liveRealtimeSessionCount() < 4, '实时语音会话过多，请稍后重试', 429)
      audit.addSecret(key)
      const sessionId = randomUUID()
      const events = []; let cursor = 0
      const emit = event => {
        if (event.type === 'audit') {
          const record = sanitizeAuditRecord({ ...event.record, sessionId })
          if (record) {
            void audit.append(record)
            // Polling only needs a refresh hint; retrieve content through /api/audit.
            const item = { type: 'audit', sessionId, id: record.id, messageId: record.messageId, turnId: record.turnId, kind: record.kind, seq: ++cursor, at: Date.now() }
            events.push(item)
          }
        } else events.push({ ...event, sessionId, seq: ++cursor, at: Date.now() })
        if (events.length > 256) events.shift()
        // 上游断连时客户端可能再也不来轮询，服务端必须自己收尾（必须在 push 之后，客户端要拿到 closed）
        if (event.type === 'closed') settleRealtimeSession(sessionId)
      }
      const voiceState = createVoiceCandidateState()
      const session = createRealtimeSession({ voiceState, settings: rt, key,
        generateFiller: dependencies.generateFiller,
        synthesizeFiller: (text, context) => synthVoiceLayer(text, '', { ...context, sessionId }, rt, voiceState),
        executeTool: async (name, args, context) => await dispatchRealtimeTool(name, args, rt, selected, workspace, { ...context, sessionId }, voiceState), nativeTools, emit, WebSocketCtor: dependencies.realtimeWebSocket })
      realtimeSessions.set(sessionId, { session, events, cursor: () => cursor, closed: false, key: undefined })
      session.connect()
      return { body: { sessionId, ...(voiceSettingsPatch ? { voiceSettingsPatch } : {}) } }
    }
    if (path === '/api/realtime/audio' || path === '/api/realtime/commit' || path === '/api/realtime/response' || path === '/api/realtime/cancel' || path === '/api/realtime/end' || path === '/api/realtime/events' || path === '/api/realtime/playback') {
      requireValue(method === 'POST', '不支持的请求方法', 405)
      const sid = id(body.sessionId)
      const record = realtimeSessions.get(sid)
      if (path === '/api/realtime/end') {
        if (record) { record.session.dispose(); record.closed = true; realtimeSessions.delete(sid) }
        await dependencies.releaseToolSession?.(sid)
        return { body: { ok: true } }
      }
      requireValue(record, '实时语音会话不存在或已结束', 404)
      if (path === '/api/realtime/events') {
        const after = body.after ?? 0
        requireValue(Number.isSafeInteger(after) && after >= 0, '事件游标格式无效')
        const events = record.events.filter(event => event.seq > after)
        return { body: { events, cursor: record.cursor(), done: record.closed } }
      }
      // 已结束（含上游断连）的会话只许读事件：写接口一律 404，避免对已 dispose 的会话空转
      requireValue(!record.closed, '实时语音会话不存在或已结束', 404)
      if (path === '/api/realtime/playback') {
        requireValue(['main', 'filler'].includes(body.kind) && typeof body.active === 'boolean', '播放状态无效')
        record.session.playback({ kind: body.kind, active: body.active })
      } else if (path === '/api/realtime/audio') {
        const audio = body.audio
        requireValue(typeof audio === 'string' && audio.length <= 3 * 1024 * 1024 && /^[A-Za-z0-9+/]*={0,2}$/.test(audio), '录音格式或大小无效')
        record.session.appendAudio(audio)
      } else if (path === '/api/realtime/commit') record.session.commit()
      else if (path === '/api/realtime/response') record.session.createResponse()
      else if (path === '/api/realtime/cancel') record.session.cancel()
      return { body: { ok: true } }
    }
    // Removed segmented-chain routes (preview/debug/prepare/tune/events/filler*/cancel/reset) 404 gracefully.
    requireValue(false, '接口不存在', 404)
  }

  return { handle, async dispose() { disposed = true; await voicePresets.dispose(); await mutationTail; for (const r of realtimeSessions.values()) { r.closed = true; r.session.dispose() } realtimeSessions.clear(); await audit.flush() } }
}