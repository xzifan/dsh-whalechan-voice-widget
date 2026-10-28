import { BREEZE_PRESET_VOICES, resolveBreezeLanguage, normalizeBreezeProfile } from './breeze-voices.js'
import { createVoicePresets } from './voice-presets.js'
import { createVoiceCandidateState, spokenText } from './voice-candidate.js'
import { readFile, mkdir, writeFile, rename, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getTtsProfile } from './tts-config.js'
import { synthesizeHttpTts } from './tts-http.js'
import { configIssues } from './config-validation.js'
import { createRealtimeSession, realtimeDefaults } from './realtime-service.js'
import { audioDurationSeconds } from './audio-duration.js'
import { createAuditLog, sanitizeAuditRecord, numericUsage } from './audit-log.js'
import { designVoice, deleteBailianVoice, synthesizeTts, MODEL_TTS, MODEL_TTS_SYNTH, VOICE_PRESETS, DEFAULT_VOICE_ID } from './voice-design.js'
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
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || 'unknown' }
  catch { return 'unknown' }
})()

export function createService(config = {}, dependencies = {}) {
  const fetcher = dependencies.fetch || globalThis.fetch
  const stateDir = config.stateDir ? config.stateDir.replace(/^~(?=\/)/, homedir()) : join(homedir(), '.dsh', 'storages', 'voice-workbench')
  const settingsPath = join(stateDir, 'settings.json')
  const audit = createAuditLog({ path: join(stateDir, 'voice-audit.jsonl') })
  const startedAt = Date.now()
  let settings = structuredClone(defaults), disposed = false
  const realtimeSessions = new Map() // sessionId -> {session, events, cursor, closed, key}

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

  let settingsLoad = readFile(settingsPath, 'utf8').then(raw => { settings = validateSettings(JSON.parse(raw)) }).catch(e => { if (e.code !== 'ENOENT') throw new RequestError('工作台配置无法读取，请检查配置文件', 500) })

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

  async function runSingleTool(name, args, workspace) {
    requireValue(typeof dependencies.runTool === 'function', '当前 DSH 尚未提供原生工具服务，可先关闭工具继续聊天。', 503)
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 60000); timer.unref?.()
    try { return await dependencies.runTool(name, args, { workspace, signal: controller.signal }) }
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
        const result = await synthesizeTts({ ...options, fetcher })
        const duration = typeof result.audio === 'string' ? audioDurationSeconds(Buffer.from(result.audio, 'base64')) : null
        await audit.append({ ...record, status: 'completed', usage: numericUsage(result.usage), requestId: result.requestId, audioOutput: true, audioDurationSeconds: duration })
        return result
      } catch (error) {
        const cancelled = options.signal?.aborted || error.status === 499
        await audit.append({ ...record, status: cancelled ? 'cancelled' : 'failed', usage: null })
        if (!cancelled) await audit.append({ ...metadata, kind: 'error', status: 'failed', text: `Speech synthesis failed (HTTP ${Number.isInteger(error.status) ? error.status : 502})`, usage: null })
        throw error
      }
    },
    error: (message, status) => new RequestError(message, status),
  })

  // Breeze design is paused. Its old persisted presets are neither read nor deleted.
  const breezeDisabled = 'Breeze 暂不支持提示词生成/复刻，请使用预设音色'
  const breezePresets = () => Object.entries(BREEZE_PRESET_VOICES).map(([language, voiceId]) => ({ id: language, language, voiceId, name: {zh:'中文',ja:'日语',en:'英语'}[language] }))

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

  // A configured voice is already initialized; never replace an explicitly
  // selected voice merely because it was created outside this workbench.
  async function initializeSessionVoice(input, signal) {
    if (input.realtime.use_tts_voice === false) return null
    const provider = input.tts_voice_provider || 'qwen'
    const requestedVoice = String(input.tts_profiles?.[provider]?.voice || '').trim()
    const patchFor = profile => ({ tts_voice_provider: provider, tts_profiles: { [provider]: { voice: profile.voice, model: profile.model } } })
    const scope = input => {
      if (provider === 'qwen') return { host: input.realtime.api_host || '', key_file: input.realtime.key_file || '', source: input.realtime.credential_source || 'auto', ref: input.realtime.credential_ref }
      const { voice, ...profile } = getTtsProfile({ tts_provider: provider, tts_profiles: input.tts_profiles }) || {}
      return profile
    }
    const sameScope = () => JSON.stringify(scope(input)) === JSON.stringify(scope(settings))
    if (provider === 'breeze') {
      requireValue(sameScope() && settings.tts_voice_provider === provider, '请先保存声音设置，再开始对话', 409)
      await modelCredential('breeze')
      signal?.throwIfAborted()
      const profile = normalizeBreezeProfile(getTtsProfile({ tts_provider: provider, tts_profiles: settings.tts_profiles }))
      return patchFor(profile)
    }
    if (requestedVoice) {
      requireValue(sameScope() && settings.tts_voice_provider === provider && String(settings.tts_profiles?.[provider]?.voice || '').trim(), '请先保存声音设置，再开始对话', 409)
      return String(settings.tts_profiles[provider].voice).trim() === requestedVoice ? null : patchFor(settings.tts_profiles[provider])
    }
    if (sameScope() && settings.tts_voice_provider === provider && String(settings.tts_profiles?.[provider]?.voice || '').trim()) return patchFor(settings.tts_profiles[provider])
    requireValue(provider === 'qwen', '当前语音提供方不支持自动设计，请先配置可用音色', 409)
    const marker = () => JSON.stringify({ provider: settings.tts_voice_provider, profile: settings.tts_profiles?.[provider], realtime: { api_host: settings.realtime.api_host, key_file: settings.realtime.key_file, credential_source: settings.realtime.credential_source, credential_ref: settings.realtime.credential_ref, use_tts_voice: settings.realtime.use_tts_voice } })
    const before = marker()
    let candidate
    try { candidate = await voicePresets.initialize(input) }
    catch (error) { throw new RequestError(`默认音色初始化失败，请检查声音配置后重试（HTTP ${Number.isInteger(error.status) ? error.status : 502}）`, error.status === 409 ? 409 : 502) }
    signal?.throwIfAborted()
    return mutate(async () => {
      signal?.throwIfAborted()
      requireValue(!disposed, '工作台已关闭', 503)
      if (marker() !== before) {
        // Another simultaneous start may have initialized the same profile.
        // A settings edit must not be silently overwritten by a late design.
        requireValue(settings.realtime.use_tts_voice !== false && sameScope() && settings.tts_voice_provider === provider && String(settings.tts_profiles?.[provider]?.voice || '').trim(), '声音配置在初始化期间已改变，请重新开始对话', 409)
        return patchFor(settings.tts_profiles[provider])
      }
      const profile = { ...input.tts_profiles?.[provider], voice: candidate.voiceId, model: candidate.model }
      await commitSettings(current => ({ tts_voice_provider: provider, tts_profiles: { ...current.tts_profiles, [provider]: profile } }), signal)
      return patchFor(profile)
    })
  }

  // Minimal key-file reader for a provider profile (env-style KEY=value files).
  async function readProviderKey(profile) {
    if (!profile?.key_file) return ''
    const path = profile.key_file.replace(/^~(?=\/)/, homedir())
    try {
      const text = await readFile(path, 'utf8')
      const names = profile.protocol === 'openai-speech' ? ['OPENAI_API_KEY', 'TTS_API_KEY', 'API_KEY']
        : profile.protocol === 'mimo-chat' ? ['MIMO_API_KEY', 'XIAOMI_MIMO_API_KEY', 'TTS_API_KEY', 'API_KEY']
        : profile.protocol === 'breeze-tts' ? ['BREEZE_API_KEY', 'XI_API_KEY', 'TTS_API_KEY', 'API_KEY']
        : ['TTS_API_KEY', 'API_KEY']
      const values = {}
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/)
        if (m) values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
      }
      return names.map(n => values[n]).find(Boolean) || ''
    } catch { return '' }
  }

  // Snapshot the actual profile used for this request, including Qwen's independent voice.
  function voiceProfile(input = settings) {
    const provider = input.tts_voice_provider || 'qwen'
    if (provider === 'qwen') return { provider: 'bailian', model: input.tts_profiles?.qwen?.model === MODEL_TTS ? MODEL_TTS : MODEL_TTS_SYNTH, voice: typeof input.tts_profiles?.qwen?.voice === 'string' && input.tts_profiles.qwen.voice.trim() ? input.tts_profiles.qwen.voice.trim() : 'longanhuan_v3.1' }
    const rawProfile = getTtsProfile({ tts_provider: provider, tts_profiles: input.tts_profiles })
    const profile = provider === 'breeze' || rawProfile?.protocol === 'breeze-tts' ? normalizeBreezeProfile(rawProfile) : rawProfile
    return { provider, model: profile?.model || 'unknown', voice: profile?.voice, profile }
  }

  async function synthVoiceLayer(text, language, context = {}, rt, voiceState) {
    const candidate = settings.tts_voice_provider === 'breeze' && rt.use_tts_voice !== false ? null : voiceState?.get()
    const qwen = !!candidate || (settings.tts_voice_provider || 'qwen') === 'qwen'
    const selected = candidate ? { provider: 'bailian', model: MODEL_TTS, voice: candidate.designVoiceId } : voiceProfile()
    if (selected.provider === 'breeze' || selected.profile?.protocol === 'breeze-tts') {
      language = resolveBreezeLanguage(text, language)
      selected.profile = normalizeBreezeProfile(selected.profile, {text, language})
      selected.voice = selected.profile.voice
      selected.language = language
    }
    const { profile, ...metadata } = selected
    const record = { ...context, ...metadata, kind: 'synthesis', role: 'assistant', text }
    try {
      let result
      if (qwen) {
        const { key } = await bailianCredential(rt)
        result = await synthesizeTts({ key, text, voice: selected.voice, model: selected.model, language, fetcher, signal: context.signal })
      } else {
        requireValue(profile, '请选择有效的语音提供方', 400)
        const managedProvider = profile.protocol === 'breeze-tts' ? 'breeze' : ['breeze', 'volcengine'].includes(selected.provider) ? selected.provider : null
        const key = managedProvider ? (await modelCredential(managedProvider)).key : await readProviderKey(profile)
        audit.addSecret(key)
        requireValue(profile.auth_type === 'none' || key, '请配置所选语音提供方的凭据', 503)
        result = await synthesizeHttpTts({ profile, text, key, signal: context.signal, fetcher, language })
      }
      const usage = numericUsage(result.usage)
      const duration = typeof result.audio === 'string' ? audioDurationSeconds(Buffer.from(result.audio, 'base64')) : null
      await audit.append({ ...record, status: 'completed', usage, requestId: result.requestId, audioOutput: true, audioDurationSeconds: duration })
      return { ...result, ...metadata, usage, usageAvailable: usage !== null }
    } catch (error) {
      if (context.signal?.aborted) throw error
      await audit.append({ ...record, status: error.status === 499 ? 'cancelled' : 'failed', usage: null })
      await audit.append({ ...context, ...metadata, kind: 'error', status: 'failed', text: `Speech synthesis failed (HTTP ${Number.isInteger(error.status) ? error.status : 502})`, usage: null })
      throw error
    }
  }

  async function runVoiceTool(name, args, rt, context, voiceState) {
    context.signal?.throwIfAborted()
    // Breeze has no design/replication lifecycle; never route its tools back to Bailian.
    const breeze = settings.tts_voice_provider === 'breeze' && rt.use_tts_voice !== false
    if (breeze && ['design_voice', 'apply_voice', 'delete_voice', 'clone_voice', 'replicate_voice'].includes(name)) throw new RequestError(breezeDisabled, 400)
    if (breeze && name === 'list_voice_presets') return { provider: 'breeze', presets: breezePresets(), candidates: [], note: 'Breeze 按回复语言自动使用中文、日语、英语固定预设音色，不生成或复刻音色。' }
    // Voice settings assistant tools: read/adjust the TTS voice layer config.
    if (name === 'get_voice_config') {
      const provider = settings.tts_voice_provider || 'qwen'
      const profile = provider === 'qwen' ? null : provider === 'breeze' ? normalizeBreezeProfile(settings.tts_profiles?.breeze) : (settings.tts_profiles?.[provider] || {})
      return {
        provider,
        presetsAvailable: provider === 'qwen' || breeze,
        presets: breeze ? breezePresets() : provider === 'qwen' ? VOICE_PRESETS.map(p => ({ id: p.id, name: p.name, description: p.description })) : [],
        currentVoice: (breeze ? null : voiceState.get()?.designVoiceId) || voiceProfile().voice || '',
        profile,
        note: breeze ? 'Breeze 使用中、日、英固定预设音色，按回复语言自动切换；暂不支持提示词生成/复刻。' : provider === 'qwen' ? '当前为百炼默认，自带音色预设。' : `当前为 ${provider} 提供方，需自行配置模型与音色。`,
      }
    }
    if (name === 'set_tts_provider') {
      const provider = String(args?.provider || '').trim()
      requireValue(['qwen', 'openai', 'mimo', 'breeze', 'custom'].includes(provider), '不支持的提供方', 400)
      // Selecting a non-qwen provider requires a profile entry for validation to
      // pass; seed it from built-in defaults so the switch is never blocked.
      const patch = { tts_voice_provider: provider }
      if (provider !== 'qwen' && !settings.tts_profiles?.[provider]) patch.tts_profiles = { ...(settings.tts_profiles || {}), [provider]: {} }
      const saved = await persistSettings(patch)
      return { provider, presetsAvailable: provider === 'qwen' || provider === 'breeze', note: `已切换到 ${provider}${provider === 'qwen' ? '（自带音色预设）' : provider === 'breeze' ? '（按语言自动使用三语固定预设，暂不支持生成/复刻）' : '，请再设置模型与音色'}。重新开始对话生效。`, __settingsChanged: true,
        __voiceSettingsPatch: { tts_voice_provider: provider, ...(saved.tts_profiles?.[provider] ? { tts_profiles: { [provider]: saved.tts_profiles[provider] } } : {}) } }
    }
    if (name === 'set_tts_profile') {
      const current = settings.tts_voice_provider || 'qwen'
      const provider = String(args?.provider || current).trim()
      requireValue(provider !== 'qwen', 'qwen 为内置提供方，使用音色工具调整，无需设置合成参数', 400)
      requireValue(['openai', 'mimo', 'breeze', 'custom'].includes(provider), '不支持的提供方', 400)
      const prev = settings.tts_profiles?.[provider] || {}
      const patch = { ...prev }
      if (args?.model !== undefined) patch.model = String(args.model)
      if (args?.voice !== undefined) {
        requireValue(provider !== 'breeze' && prev.protocol !== 'breeze-tts', 'Breeze 使用固定三语预设音色，不能设置自定义音色', 400)
        patch.voice = String(args.voice)
      }
      if (args?.key_file !== undefined) {
        requireValue(provider !== 'breeze' && prev.protocol !== 'breeze-tts', 'Breeze 凭据由 DSH 统一管理，请在模型凭据配置中保存', 400)
        patch.key_file = String(args.key_file)
      }
      if (args?.extra !== undefined && args.extra && typeof args.extra === 'object' && !Array.isArray(args.extra)) patch.extra = args.extra
      const nextProfiles = { ...(settings.tts_profiles || {}), [provider]: patch }
      const saved = await persistSettings({ tts_voice_provider: provider, tts_profiles: nextProfiles })
      return { provider, profile: saved.tts_profiles[provider], note: `${provider} 的合成参数已更新。重新开始对话生效。`, __settingsChanged: true,
        __voiceSettingsPatch: { tts_voice_provider: provider, tts_profiles: { [provider]: provider === 'breeze' ? saved.tts_profiles[provider] : Object.fromEntries(['model', 'voice', 'key_file', 'extra'].filter(field => args?.[field] !== undefined).map(field => [field, patch[field]])) } } }
    }
    if (name === 'synth_tts') {
      const text = spokenText(args?.text).trim()
      requireValue(text.length >= 1 && text.length <= 2000, '请提供要合成的文本（1 到 2000 字）', 400)
      const language = ['zh', 'ja', 'en'].includes(args?.language) ? args.language : ''
      const result = await synthVoiceLayer(text, language, context, rt, voiceState)
      return { synth: true, provider: result.provider, model: result.model, voice: result.voice, ...(result.language ? { language: result.language } : {}), usage: result.usage, usageAvailable: result.usageAvailable, note: '已用高音质 TTS 合成该片段。', __previewData: result.audio, __previewMime: result.mime }
    }
    const { key } = await bailianCredential(rt)
    if (name === 'list_voice_presets') {
      if ((settings.tts_voice_provider || 'qwen') !== 'qwen') return { presets: [], candidates: [], note: '当前提供方不是百炼，未提供内置音色预设，请直接设置该提供方的音色。' }
      const presets = VOICE_PRESETS.map(p => ({ id: p.id, name: p.name, description: p.description }))
      const candidates = voiceState.list().map(c => ({ voiceId: c.realtimeVoiceId || c.designVoiceId, designVoiceId: c.designVoiceId, name: c.name }))
      return { presets, default: { id: DEFAULT_VOICE_ID, name: '柔甜亲近' }, candidates, note: '预设是声音风格描述；选择后按对应描述设计候选，试听并明确确认后保存。不能直接应用风格 ID 或历史音色 ID。' }
    }
    if (name === 'design_voice') {
      const description = String(args?.description || '').trim()
      const name = String(args?.name || '').trim().slice(0, 20) || '新音色'
      const previewLanguage = ['zh', 'ja', 'en'].includes(args?.preview_language) ? args.preview_language : 'zh'
      const previewTexts = { zh: '主人，我在呢。这个声音怎么样？你听听看。', ja: 'ご主人様、この声はどうですか？聞いてみてください。', en: 'Master, how does this voice sound? Please listen.' }
      requireValue(description.length >= 4 && description.length <= 500, '请用 4 到 500 字描述期望音色', 400)
      const result = await designVoice({ key, description, previewLanguage, previewText: previewTexts[previewLanguage], prefix: ('v' + Date.now().toString(36)).slice(0, 10), fetcher, signal: context.signal })
      context.signal?.throwIfAborted()
      requireValue(rt.use_tts_voice || result.realtimeVoiceId, '未返回可用于实时会话的候选声音，请重新设计。', 502)
      voiceState.set({ designVoiceId: result.designVoiceId, realtimeVoiceId: result.realtimeVoiceId, name, description }, context.turnId)
      return { candidate: { designVoiceId: result.designVoiceId, realtimeVoiceId: result.realtimeVoiceId, name }, previewLanguage, note: '候选已生成且仅在当前对话临时试用。现在用候选声音询问主人是否应用，明确肯定后才能保存；其他回答恢复原声音。', __previewData: result.previewData, __previewMime: result.previewMime }
    }
    if (name === 'apply_voice') {
      const voiceId = String(args?.voice_id || '').trim()
      requireValue(voiceId.length > 0, '请提供要应用的音色 ID', 400)
      const candidate = voiceState.confirmed(voiceId, context.turnId)
      requireValue(candidate, '请先试听，并等待主人明确同意使用当前候选声音。', 400)
      context.signal?.throwIfAborted()
      await persistSettings(rt.use_tts_voice
        ? { tts_voice_provider: 'qwen', tts_profiles: { ...settings.tts_profiles, qwen: { ...settings.tts_profiles?.qwen, voice: candidate.designVoiceId, model: MODEL_TTS } } }
        : { realtime: { ...settings.realtime, voice: candidate.realtimeVoiceId } }, context.signal)
      voiceState.forget(candidate)
      return { applied: true, voiceId: rt.use_tts_voice ? candidate.designVoiceId : candidate.realtimeVoiceId, note: '已保存这个声音。',
        __voiceSettingsPatch: rt.use_tts_voice
          ? { tts_voice_provider: 'qwen', tts_profiles: { qwen: { voice: candidate.designVoiceId, model: MODEL_TTS } } }
          : { realtime: { voice: candidate.realtimeVoiceId } },
        ...(rt.use_tts_voice ? { __settingsChanged: true } : { __applyVoiceId: candidate.realtimeVoiceId }) }
    }
    if (name === 'delete_voice') {
      const voiceId = String(args?.voice_id || '').trim()
      requireValue(voiceId.length > 0, '请提供要删除的音色 ID', 400)
      const candidate = voiceState.find(voiceId)
      requireValue(candidate, '未找到当前会话的候选音色。', 400)
      voiceState.forget(candidate)
      const existed = true
      for (const candidateId of [candidate.designVoiceId, candidate.realtimeVoiceId].filter(Boolean)) {
        try { await deleteBailianVoice(key, candidateId, undefined, fetcher, context.signal) } catch {}
      }
      return { deleted: existed, voiceId, note: existed ? '候选音色已删除并释放配额。' : '未找到该候选音色。' }
    }
    throw Object.assign(new Error('未知的音色工具'), { name: 'VoiceNativeError', status: 400 })
  }

  async function dispatchRealtimeTool(name, args, rt, allowedTools, workspace, context, voiceState) {
    if (['design_voice', 'list_voice_presets', 'apply_voice', 'delete_voice', 'synth_tts', 'get_voice_config', 'set_tts_provider', 'set_tts_profile'].includes(name)) {
      try { return await runVoiceTool(name, args, rt, context, voiceState) }
      catch (error) {
        if (name === 'design_voice' && settings.tts_voice_provider !== 'breeze') await audit.append({ ...context, kind: 'error', provider: 'bailian', model: 'voice-enrollment', status: 'failed', text: `Voice design failed (HTTP ${Number.isInteger(error.status) ? error.status : 502})`, usage: null })
        throw error
      }
    }
    requireValue(allowedTools.has(name), '该工具未在本次会话中启用。', 400)
    return runSingleTool(name, args, workspace)
  }

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
        realtime: { activeSessions: realtimeSessions.size },
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
      requireValue(typeof body.key === 'string' && body.key.trim().length > 0 && body.key.length <= 8192 && !/[\u0000-\u0020\u007f]/.test(body.key.trim()), '请输入有效的 API Key')
      requireValue(typeof dependencies.configureModelCredential === 'function', '当前宿主不支持保存凭据，请在 DSH 模型设置中配置', 503)
      audit.addSecret(body.key.trim())
      try { await dependencies.configureModelCredential(body.provider, body.key.trim()) }
      catch { throw new RequestError('DSH 凭据保存失败，请检查宿主凭据服务；原配置未在插件中另存', 503) }
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
      requireValue(realtimeSessions.size < 4, '实时语音会话过多，请稍后重试', 429)
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
      requireValue(realtimeSessions.size < 4, '实时语音会话过多，请稍后重试', 429)
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
        return { body: { ok: true } }
      }
      requireValue(record, '实时语音会话不存在或已结束', 404)
      if (path === '/api/realtime/events') {
        const after = body.after ?? 0
        requireValue(Number.isSafeInteger(after) && after >= 0, '事件游标格式无效')
        const events = record.events.filter(event => event.seq > after)
        return { body: { events, cursor: record.cursor(), done: record.closed } }
      }
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