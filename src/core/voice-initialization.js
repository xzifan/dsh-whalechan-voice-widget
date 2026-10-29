import { normalizeBreezeProfile } from './breeze-voices.js'
import { getTtsProfile } from './tts-config.js'

/**
 * 会话启动时的音色初始化（由 `/api/realtime/start` 调用）。
 *
 * `input` 是请求级设置快照，**必须保持为参数**：全部 409 语义来自「input 快照
 * vs live settings」的对比，改成 live 就会让 stale / unsaved 两条用例假通过。
 * `getSettings` 必须是 live getter——settings 会被 commitSettings 整体重赋值；
 * `mutate` 必须是原始队列（不能传 persistSettings，mutate 套 mutate 会死锁，
 * 表现是测试挂起而不是失败），`isDisposed` 同理必须是 getter。
 */
export function createVoiceInitialization({ getSettings, mutate, commitSettings, voicePresets, modelCredential, isDisposed, requireValue, RequestError }) {
  const s = () => getSettings()

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
    const sameScope = () => JSON.stringify(scope(input)) === JSON.stringify(scope(s()))
    if (provider === 'breeze') {
      requireValue(sameScope() && s().tts_voice_provider === provider, '请先保存声音设置，再开始对话', 409)
      await modelCredential('breeze')
      signal?.throwIfAborted()
      const profile = normalizeBreezeProfile(getTtsProfile({ tts_provider: provider, tts_profiles: s().tts_profiles }))
      return patchFor(profile)
    }
    if (requestedVoice) {
      requireValue(sameScope() && s().tts_voice_provider === provider && String(s().tts_profiles?.[provider]?.voice || '').trim(), '请先保存声音设置，再开始对话', 409)
      return String(s().tts_profiles[provider].voice).trim() === requestedVoice ? null : patchFor(s().tts_profiles[provider])
    }
    if (sameScope() && s().tts_voice_provider === provider && String(s().tts_profiles?.[provider]?.voice || '').trim()) return patchFor(s().tts_profiles[provider])
    requireValue(provider === 'qwen', '当前语音提供方不支持自动设计，请先配置可用音色', 409)
    const marker = () => JSON.stringify({ provider: s().tts_voice_provider, profile: s().tts_profiles?.[provider], realtime: { api_host: s().realtime.api_host, key_file: s().realtime.key_file, credential_source: s().realtime.credential_source, credential_ref: s().realtime.credential_ref, use_tts_voice: s().realtime.use_tts_voice } })
    const before = marker()
    let candidate
    try { candidate = await voicePresets.initialize(input) }
    catch (error) { throw new RequestError(`默认音色初始化失败，请检查声音配置后重试（HTTP ${Number.isInteger(error.status) ? error.status : 502}）`, error.status === 409 ? 409 : 502) }
    signal?.throwIfAborted()
    return mutate(async () => {
      signal?.throwIfAborted()
      requireValue(!isDisposed(), '工作台已关闭', 503)
      if (marker() !== before) {
        // Another simultaneous start may have initialized the same profile.
        // A settings edit must not be silently overwritten by a late design.
        requireValue(s().realtime.use_tts_voice !== false && sameScope() && s().tts_voice_provider === provider && String(s().tts_profiles?.[provider]?.voice || '').trim(), '声音配置在初始化期间已改变，请重新开始对话', 409)
        return patchFor(s().tts_profiles[provider])
      }
      const profile = { ...input.tts_profiles?.[provider], voice: candidate.voiceId, model: candidate.model }
      await commitSettings(current => ({ tts_voice_provider: provider, tts_profiles: { ...current.tts_profiles, [provider]: profile } }), signal)
      return patchFor(profile)
    })
  }

  return { initializeSessionVoice }
}
