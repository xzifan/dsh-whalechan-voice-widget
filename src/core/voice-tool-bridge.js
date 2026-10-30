// 语音工具桥接：把实时会话里的 8 个语音工具从 service.js 抽出来。
// 依赖全部注入。`getSettings` 必须是 live getter —— settings 是会被整体重赋值的
// 闭包变量，传值快照会打挂 voice-presets-cache 与 voice-settings-persistence；
// 本模块自身零可变态、不缓存任何 settings 读取。
import { BREEZE_PRESET_VOICES, BREEZE_ZH_VOICES, normalizeBreezeProfile } from './breeze-voices.js'
import { designVoice, deleteBailianVoice, voiceAlreadyGone, failureDetail, VOICE_PRESETS, DEFAULT_VOICE_ID, MODEL_TTS } from './voice-design.js'
import { spokenText } from './voice-candidate.js'
import { DEFAULT_TOOLS } from './realtime-protocol.js'

// Breeze design is paused. Its old persisted presets are neither read nor deleted.
export const breezeDisabled = 'Breeze 暂不支持提示词生成/复刻，请使用预设音色'
export const breezePresets = () => Object.entries(BREEZE_PRESET_VOICES).map(([language, voiceId]) => ({
  id: language, language, voiceId, name: {zh:'中文',ja:'日语',en:'英语'}[language],
  ...(language === 'zh' ? { options: BREEZE_ZH_VOICES.map(v => ({ ...v })) } : {}),
}))

// 准入集合与 realtime-protocol 的 DEFAULT_TOOLS 同源；原来是硬编码的 8 个字符串，
// 两条清单各自演化就会漂移（新增工具只在一边生效）。
export const voiceToolNames = new Set(DEFAULT_TOOLS)

export function createVoiceToolBridge({ getSettings, persistSettings, credential, synthVoiceLayer, voiceProfile, runSingleTool, fetcher, audit, requireValue, RequestError }) {
  const s = () => getSettings()

  async function runVoiceTool(name, args, rt, context, voiceState) {
    context.signal?.throwIfAborted()
    // Breeze has no design/replication lifecycle; never route its tools back to Bailian.
    const breeze = s().tts_voice_provider === 'breeze' && rt.use_tts_voice !== false
    if (breeze && ['design_voice', 'apply_voice', 'delete_voice', 'clone_voice', 'replicate_voice'].includes(name)) throw new RequestError(breezeDisabled, 400)
    if (breeze && name === 'list_voice_presets') return { provider: 'breeze', presets: breezePresets(), candidates: [], note: 'Breeze 按回复语言自动使用中文、日语、英语固定预设音色，不生成或复刻音色。' }
    // Voice settings assistant tools: read/adjust the TTS voice layer config.
    if (name === 'get_voice_config') {
      const provider = s().tts_voice_provider || 'qwen'
      const profile = provider === 'qwen' ? null : provider === 'breeze' ? normalizeBreezeProfile(s().tts_profiles?.breeze) : (s().tts_profiles?.[provider] || {})
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
      if (provider !== 'qwen' && !s().tts_profiles?.[provider]) patch.tts_profiles = { ...(s().tts_profiles || {}), [provider]: {} }
      const saved = await persistSettings(patch)
      return { provider, presetsAvailable: provider === 'qwen' || provider === 'breeze', note: `已切换到 ${provider}${provider === 'qwen' ? '（自带音色预设）' : provider === 'breeze' ? '（按语言自动使用三语固定预设，暂不支持生成/复刻）' : '，请再设置模型与音色'}。重新开始对话生效。`, __settingsChanged: true,
        __voiceSettingsPatch: { tts_voice_provider: provider, ...(saved.tts_profiles?.[provider] ? { tts_profiles: { [provider]: saved.tts_profiles[provider] } } : {}) } }
    }
    if (name === 'set_tts_profile') {
      const current = s().tts_voice_provider || 'qwen'
      const provider = String(args?.provider || current).trim()
      requireValue(provider !== 'qwen', 'qwen 为内置提供方，使用音色工具调整，无需设置合成参数', 400)
      requireValue(['openai', 'mimo', 'breeze', 'custom'].includes(provider), '不支持的提供方', 400)
      const prev = s().tts_profiles?.[provider] || {}
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
      const nextProfiles = { ...(s().tts_profiles || {}), [provider]: patch }
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
    const { key } = await credential()
    if (name === 'list_voice_presets') {
      if ((s().tts_voice_provider || 'qwen') !== 'qwen') return { presets: [], candidates: [], note: '当前提供方不是百炼，未提供内置音色预设，请直接设置该提供方的音色。' }
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
        ? { tts_voice_provider: 'qwen', tts_profiles: { ...s().tts_profiles, qwen: { ...s().tts_profiles?.qwen, voice: candidate.designVoiceId, model: MODEL_TTS } } }
        : { realtime: { ...s().realtime, voice: candidate.realtimeVoiceId } }, context.signal)
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
      // A candidate owns up to two upstream voices (design + realtime clone). Both
      // must be gone before we drop the candidate: a swallowed failure used to
      // forget the candidate first, so the quota stayed taken and a retry was
      // impossible. Collect per-id outcomes instead of one blanket try/catch.
      const deleted = [], alreadyGone = [], failed = []
      for (const candidateId of [candidate.designVoiceId, candidate.realtimeVoiceId].filter(Boolean)) {
        try {
          await deleteBailianVoice(key, candidateId, undefined, fetcher, context.signal); deleted.push(candidateId)
        } catch (error) {
          if (context.signal?.aborted || Number(error?.status) === 499) throw error
          if (voiceAlreadyGone(error)) alreadyGone.push(candidateId)
          else failed.push({ voiceId: candidateId, status: Number.isInteger(error?.status) ? error.status : 502, code: String(error?.safe?.code || '') })
        }
      }
      if (failed.length) {
        const detail = failed.map(f => `${f.voiceId || '(空 id)'}${f.code ? ` ${f.code}` : ''}（HTTP ${f.status}）`).join('、')
        // Carry the first failure's category/code so the audit line says which
        // upstream condition hit instead of only an HTTP status.
        throw Object.assign(new Error(`候选音色删除失败：${detail}。配额尚未释放，候选已保留，可以重试删除。`), {
          name: 'VoiceNativeError', status: failed[0].status, upstream: true, failed: failed.map(f => f.voiceId),
          safe: { status: failed[0].status, code: failed[0].code || '', category: 'upstream' },
        })
      }
      voiceState.forget(candidate)
      const ids = [...deleted, ...alreadyGone]
      return {
        deleted: true, voiceId, deletedIds: ids, alreadyGone,
        note: `候选音色已删除并释放配额${alreadyGone.length ? '（其中 ' + alreadyGone.join('、') + ' 此前已不存在）' : ''}。`,
      }
    }
    throw Object.assign(new Error('未知的音色工具'), { name: 'VoiceNativeError', status: 400 })
  }

  async function dispatchRealtimeTool(name, args, rt, allowedTools, workspace, context, voiceState) {
    if (voiceToolNames.has(name)) {
      try { return await runVoiceTool(name, args, rt, context, voiceState) } catch (error) {
        // The audit line must say *why* it failed: the model gets the same detail
        // in its output, and "only an HTTP code" is unactionable after the fact.
        if (name === 'design_voice' && s().tts_voice_provider !== 'breeze') await audit.append({ ...context, kind: 'error', provider: 'bailian', model: 'voice-enrollment', status: 'failed', text: `Voice design failed (${failureDetail(error)})`, usage: null })
        // Only upstream delete failures are audited: a local 400 (no such candidate)
        // is already visible as a failed tool call and is not a quota problem.
        if (name === 'delete_voice' && error.upstream) await audit.append({ ...context, kind: 'error', provider: 'bailian', model: 'voice-enrollment', status: 'failed', text: `Voice delete failed (${failureDetail(error)})`, usage: null })
        throw error
      }
    }
    requireValue(allowedTools.has(name), '该工具未在本次会话中启用。', 400)
    return runSingleTool(name, args, workspace, { sessionKey: context?.sessionId, allow: [...allowedTools] })
  }

  return { runVoiceTool, dispatchRealtimeTool }
}
