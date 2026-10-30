import { readFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { VOICE_PRESETS, MODEL_TTS, failureAdvice } from './voice-design.js'

export const PRESET_GREETING_TEXT = `哈喽，哈喽！这个声音怎么样？听着还舒服吗？
やっほー！こんな声はどうかな？気に入ってくれるとうれしいな。
Hey there! How do I sound? Hope you like this voice!`
export const PRESET_GREETING_INSTRUCTION = '用开心、自然、轻快的语气打招呼，亲切有活力，避免夸张表演。各段按中文、日语、英语自然发音，不要翻译或重复。'
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const MAX_DESIGNS = 24, MAX_AUDIOS = 12, MAX_AUDIO_BYTES = 24 * 1024 * 1024
// 状态文件写不进去与「音色生成/合成失败」是两件事：前者改磁盘或权限就好，
// 后者才该看百炼配置。用一个固定 code 让上游能分开这两类，同时把原始 fs 错误
// 挂在 cause 上（它的 message 会带状态目录路径，属于本机路径，不发给客户端）。
const STORE_FAILURE = { code: 'preset-store-failed', message: '音色预设状态写入失败，请检查状态目录的磁盘空间与权限' }

// Persist paid design results before attempting optional preview synthesis.
export function createVoicePresets({ stateDir, mutate, getSettings, persistSettings, credential, design, synthesize, error, provider = 'qwen', profileFor }) {
  const path = join(stateDir, provider === 'qwen' ? 'voice-presets.json' : 'breeze-voice-presets.json')
  let presets = VOICE_PRESETS.map(({ id, name, description }) => ({ id, name, prompt: description, candidate: null }))
  let designs = [], audios = [], disposed = false
  const flights = new Map(), designFlights = new Map(), audioFlights = new Map(), revisions = new Map()
  const validPrompt = value => typeof value === 'string' && value.trim().length >= 4 && value.trim().length <= 500
  const validCandidate = (c, prompt) => c && typeof c.voiceId === 'string' && /^[A-Za-z0-9_.-]{1,256}$/.test(c.voiceId) && c.designVoiceId === c.voiceId && c.prompt === prompt && (provider === 'qwen' ? c.model === MODEL_TTS && (!c.provider || c.provider === provider) : c.provider === provider && typeof c.model === 'string' && c.model.length > 0)
  const validKey = key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key)
  const ready = readFile(path, 'utf8').then(raw => {
    const stored = JSON.parse(raw), rows = Array.isArray(stored) ? stored : stored.version === 2 ? stored.presets : null
    if (!Array.isArray(rows) || rows.length !== presets.length) throw Error()
    presets = presets.map(p => {
      const value = rows.find(v => v.id === p.id)
      if (!value || !validPrompt(value.prompt) || (value.candidate !== null && !validCandidate(value.candidate, value.prompt))) throw Error()
      return { ...p, prompt: value.prompt, candidate: value.candidate ? { ...value.candidate, provider } : null }
    })
    designs = (stored.designs || []).filter(v => validKey(v.key) && validCandidate(v.candidate, v.candidate?.prompt)).slice(-MAX_DESIGNS)
    audios = (stored.audios || []).filter(v => validKey(v.key) && typeof v.greeting?.audio === 'string' && typeof v.greeting?.mime === 'string').slice(-MAX_AUDIOS)
    trimAudio()
  }).catch(e => { if (e.code !== 'ENOENT') throw error('音色预设无法读取，请检查预设状态文件', 500) })
  ready.catch(() => {})
  function trimAudio() { while (audios.reduce((n, v) => n + v.greeting.audio.length, 0) > MAX_AUDIO_BYTES) audios.shift() }
  async function store(next = presets) {
    try {
      await mkdir(stateDir, { recursive: true, mode: 0o700 })
      const tmp = join(stateDir, `voice-presets-${randomUUID()}.tmp`)
      await writeFile(tmp, JSON.stringify({ version: 2, presets: next, designs, audios }), { mode: 0o600 })
      await rename(tmp, path)
    } catch (e) {
      const failure = error(STORE_FAILURE.message, 500)
      failure.code = STORE_FAILURE.code
      failure.cause = e
      throw failure
    }
    presets = next
  }
  function profileIdentity(settings) {
    if (provider === 'qwen') {
      const rt = settings.realtime || {}
      return { host: rt.api_host || '', key_file: rt.key_file || '', credential_source: rt.credential_source, credential_ref: rt.credential_ref }
    }
    const { voice, instructions, ...profile } = profileFor(settings) || {}
    return profile
  }
  const modelFor = settings => provider === 'qwen' ? MODEL_TTS : profileFor(settings)?.model
  async function identity(settings, prompt) {
    const profile = provider === 'qwen' ? settings.realtime : profileFor(settings)
    const { key } = await credential(profile)
    const scope = digest({ provider, model: modelFor(settings), profile: profileIdentity(settings), credential: digest(key) })
    return { key, scope, cacheKey: digest({ scope, prompt }), profile }
  }
  function applied(p, settings) {
    return !!p.candidate && settings.tts_voice_provider === provider && settings.tts_profiles?.[provider]?.voice === p.candidate.voiceId && settings.tts_profiles?.[provider]?.model === p.candidate.model && settings.realtime?.use_tts_voice === true
  }
  function snapshot(settings = getSettings()) { return structuredClone(presets.map(p => ({ ...p, applied: applied(p, settings), generating: flights.has(p.id) }))) }
  function validate(body, action) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['presetId', 'provider', ...(action === 'save' ? ['prompt'] : [])].includes(k))) throw error('音色预设请求格式无效', 400)
    if ((body.provider ?? 'qwen') !== provider) throw error('音色提供方无效', 400)
    const preset = presets.find(p => p.id === body.presetId)
    if (!preset) throw error('音色预设不存在', 400)
    if (action === 'save' && !validPrompt(body.prompt)) throw error('请用 4 到 500 字描述期望音色', 400)
    return preset
  }
  function shared(map, key, work) {
    if (map.has(key)) return map.get(key).promise
    const controller = new AbortController(), entry = { controller }
    map.set(key, entry)
    entry.promise = Promise.resolve().then(() => { if (disposed) throw Error('disposed'); return work(AbortSignal.any([controller.signal, AbortSignal.timeout(120000)])) }).finally(() => map.delete(key))
    return entry.promise
  }
  async function greeting(preset, settings, auth, signal) {
    try {
      signal?.throwIfAborted()
      const instruction = PRESET_GREETING_INSTRUCTION
      const cacheKey = digest({ scope: auth.scope, voice: preset.candidate.voiceId, model: preset.candidate.model, text: PRESET_GREETING_TEXT, instruction, profile: provider === 'breeze' ? { ...profileFor(settings), voice: preset.candidate.voiceId, instructions: instruction } : null, language: '' })
      let cached = audios.find(v => v.key === cacheKey)?.greeting
      if (!cached) cached = await shared(audioFlights, cacheKey, async requestSignal => {
        const result = await synthesize({ key: auth.key, host: settings.realtime?.api_host || undefined, text: PRESET_GREETING_TEXT, instruction, voice: preset.candidate.voiceId, model: preset.candidate.model, profile: profileFor?.(settings), language: '', signal: requestSignal })
        if (!result?.audio || typeof result.audio !== 'string') throw Error('missing audio')
        const value = { audio: result.audio, mime: result.mime || 'audio/wav', text: PRESET_GREETING_TEXT }
        // 合成（付费调用）已经成功，落盘只是缓存：写盘失败不能让用户看到
        // 「试听合成失败」，也不能丢掉内存里这份可播放的结果——否则再点一次
        // 重试就会白付第二次合成费。
        await mutate(async () => {
          audios = [...audios.filter(v => v.key !== cacheKey), { key: cacheKey, greeting: value }].slice(-MAX_AUDIOS)
          trimAudio()
          try { await store() } catch (e) { console.warn(`[voice-workbench] 试听音频未写入状态目录（本次会话内仍可播放，重启后需重新合成）：${e?.cause?.code || e?.message || e}`) }
        })
        return value
      })
      signal?.throwIfAborted()
      return { greeting: structuredClone(cached) }
    } catch (e) {
      if (signal?.aborted) return { greetingError: '试听已取消，可重新播放试听' }
      const advice = failureAdvice(e)
      return { greetingError: advice ? `候选音色已保存，但试听合成失败：${advice}` : '候选音色已保存，但试听合成失败，请重试试听' }
    }
  }
  async function handle(action, body, signal) {
    await ready
    signal?.throwIfAborted()
    validate(body, action)
    if (action === 'save') return mutate(async () => {
      signal?.throwIfAborted()
      const p = validate(body, action), prompt = body.prompt.trim()
      if (p.prompt !== prompt) {
        if (p.candidate && !p.candidate.cacheKey && p.candidate.model === modelFor(getSettings())) {
          let entry
          try {
            const auth = await identity(structuredClone(getSettings()), p.prompt)
            entry = { key: auth.cacheKey, candidate: { ...p.candidate, cacheKey: auth.cacheKey } }
          } catch {
            const legacyProfile = digest(profileIdentity(getSettings()))
            entry = { key: digest({ legacyProfile, prompt: p.prompt, voice: p.candidate.voiceId }), legacyProfile, candidate: p.candidate }
          }
          designs = [...designs.filter(v => v.key !== entry.key), entry].slice(-MAX_DESIGNS)
        }
        await store(presets.map(v => v.id === p.id ? { ...v, prompt, candidate: null } : v))
        revisions.set(p.id, (revisions.get(p.id) || 0) + 1)
        flights.delete(p.id)
      }
      return { provider, voicePresets: snapshot() }
    })
    if (action === 'generate') {
      const p = structuredClone(validate(body, action)), revision = revisions.get(p.id) || 0
      if (flights.has(p.id)) return flights.get(p.id).promise
      const settings = structuredClone(getSettings()), flight = {}
      flights.set(p.id, flight)
      flight.promise = (async () => {
        const current = () => { if (disposed || (revisions.get(p.id) || 0) !== revision || presets.find(v => v.id === p.id).prompt !== p.prompt || digest(profileIdentity(getSettings())) !== digest(profileIdentity(settings))) throw error('提示词或音色配置已改变，请重新生成音色', 409) }
        try {
          const auth = await identity(settings, p.prompt)
          let candidate = designs.find(v => v.key === auth.cacheKey)?.candidate
          const legacy = designs.find(v => v.legacyProfile === digest(profileIdentity(settings)) && v.candidate.prompt === p.prompt && v.candidate.model === modelFor(settings))
          if (!candidate && legacy) candidate = { ...legacy.candidate, cacheKey: auth.cacheKey }
          if (!candidate && p.candidate && p.candidate.model === modelFor(settings) && (!p.candidate.cacheKey || p.candidate.cacheKey === auth.cacheKey)) candidate = { ...p.candidate, cacheKey: auth.cacheKey }
          if (!candidate) candidate = await shared(designFlights, auth.cacheKey, async requestSignal => {
            const result = await design({ key: auth.key, host: settings.realtime?.api_host || undefined, description: p.prompt, name: p.name, profile: provider === 'breeze' ? auth.profile : undefined, cloneToRealtime: false, prefix: 'v' + randomUUID().replaceAll('-', '').slice(0, 9), signal: requestSignal })
            const value = { provider, voiceId: result.designVoiceId, designVoiceId: result.designVoiceId, prompt: p.prompt, model: modelFor(settings), cacheKey: auth.cacheKey, createdAt: Date.now() }
            if (!validCandidate(value, p.prompt)) throw Error('invalid candidate')
            await mutate(async () => { designs = [...designs.filter(v => v.key !== auth.cacheKey), { key: auth.cacheKey, candidate: value }].slice(-MAX_DESIGNS); await store() })
            return value
          })
          await mutate(async () => { current(); designs = [...designs.filter(v => v.key !== auth.cacheKey && v !== legacy), { key: auth.cacheKey, candidate }].slice(-MAX_DESIGNS); await store(presets.map(v => v.id === p.id ? { ...v, candidate } : v)) })
          const audio = await greeting({ ...p, candidate }, settings, auth)
          current()
          if (flights.get(p.id) === flight) flights.delete(p.id)
          return { provider, voicePresets: snapshot(), candidate: structuredClone(candidate), ...audio }
        } catch (e) {
          if (e.status === 409) throw e
          // 状态文件写不进去时，百炼那边音色其实已经建好（真占了配额），只是本地
          // 记不下来。原样透出持久化文案，别改写成「请检查百炼配置」把用户引偏。
          if (e?.code === STORE_FAILURE.code) throw e
          const advice = failureAdvice(e)
          const base = provider === 'qwen' ? '音色生成失败，请检查百炼配置后重试' : '音色生成失败，请检查 Breeze 地址、模型和 DSH 凭据后重试'
          throw error(advice ? `音色生成失败：${advice}` : base, 502)
        } finally { if (flights.get(p.id) === flight) flights.delete(p.id) }
      })()
      return flight.promise
    }
    const before = structuredClone(validate(body, action)), revision = revisions.get(before.id) || 0, settingsBefore = structuredClone(getSettings())
    if (!validCandidate(before.candidate, before.prompt)) throw error('请先生成与已保存提示词匹配的候选音色', 409)
    const auth = await identity(settingsBefore, before.prompt)
    const result = await mutate(async () => {
      signal?.throwIfAborted()
      const p = validate(body, action)
      if ((revisions.get(p.id) || 0) !== revision || p.candidate?.voiceId !== before.candidate.voiceId || (p.candidate.cacheKey && p.candidate.cacheKey !== auth.cacheKey) || digest(profileIdentity(getSettings())) !== digest(profileIdentity(settingsBefore))) throw error('提示词或音色配置已改变，请重新生成音色', 409)
      if (action === 'apply') await persistSettings(current => ({ tts_voice_provider: provider, tts_profiles: { ...current.tts_profiles, [provider]: { ...current.tts_profiles?.[provider], voice: p.candidate.voiceId, model: p.candidate.model } }, realtime: { ...current.realtime, use_tts_voice: true } }), signal)
      const settings = structuredClone(getSettings())
      return { preset: structuredClone(p), settings, voicePresets: snapshot(settings) }
    })
    const audio = await greeting(result.preset, result.settings, auth, signal)
    const latest = presets.find(p => p.id === before.id)
    if ((revisions.get(before.id) || 0) !== revision || latest.candidate?.voiceId !== before.candidate.voiceId || digest(profileIdentity(getSettings())) !== digest(profileIdentity(settingsBefore))) throw error('提示词或音色配置已改变，已取消旧试听；请刷新查看当前音色', 409)
    if (action === 'apply' && !applied(result.preset, getSettings())) throw error('当前应用音色已改变，已取消旧试听；请刷新查看当前音色', 409)
    const currentSettings = structuredClone(getSettings())
    return { provider, ...(action === 'apply' ? { applied: true } : {}), settings: currentSettings, voicePresets: snapshot(currentSettings), ...audio }
  }
  // Startup initialization uses the same paid-design cache as the preset editor.
  // Saving/applying belongs to the caller, before any Realtime socket is opened.
  async function initialize(input, { native = false } = {}) {
    await ready
    if (disposed) throw error('音色服务已关闭', 503)
    const settings = structuredClone(input)
    const preset = VOICE_PRESETS.find(p => p.id === 'preset-warm')
    const prompt = preset.description
    const auth = await identity(settings, prompt)
    const cacheKey = native ? digest({ design: auth.cacheKey, native: true }) : auth.cacheKey
    let candidate = designs.find(v => v.key === cacheKey)?.candidate
    if (!candidate) {
      const saved = presets.find(p => p.id === preset.id)?.candidate
      if (!native && saved?.prompt === prompt && saved?.model === modelFor(settings) && (!saved.cacheKey || saved.cacheKey === cacheKey)) candidate = { ...saved, cacheKey }
    }
    if (!candidate || (native && !candidate.realtimeVoiceId)) candidate = await shared(designFlights, cacheKey, async signal => {
      const result = await design({ key: auth.key, host: settings.realtime?.api_host || undefined, description: prompt, name: preset.name, profile: provider === 'breeze' ? auth.profile : undefined, cloneToRealtime: native, prefix: 'v' + randomUUID().replaceAll('-', '').slice(0, 9), signal })
      const value = { provider, voiceId: result.designVoiceId, designVoiceId: result.designVoiceId, ...(result.realtimeVoiceId ? { realtimeVoiceId: result.realtimeVoiceId } : {}), prompt, model: modelFor(settings), cacheKey, createdAt: Date.now() }
      if (!validCandidate(value, prompt) || (native && !value.realtimeVoiceId)) throw error('默认音色初始化未返回可用声音', 502)
      await mutate(async () => { designs = [...designs.filter(v => v.key !== cacheKey), { key: cacheKey, candidate: value }].slice(-MAX_DESIGNS); await store() })
      return value
    })
    if (disposed) throw error('音色服务已关闭', 503)
    return structuredClone(candidate)
  }
  return { ready, snapshot, handle, initialize, async dispose() { disposed = true; for (const f of [...designFlights.values(), ...audioFlights.values()]) f.controller.abort(); await Promise.allSettled([...flights.values(), ...designFlights.values(), ...audioFlights.values()].map(f => f.promise)) } }
}
