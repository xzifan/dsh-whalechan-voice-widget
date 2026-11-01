// 语音合成层：provider/profile 快照、凭据选择与合成审计。从 src/service.js 抽出（拆分步骤 3）。
// getSettings 必须是 live getter：settings 会被 commitSettings 整体重赋值，传值快照会静默读到旧配置。
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { getTtsProfile } from './tts-config.js'
import { synthesizeHttpTts } from './tts-http.js'
import { audioDurationSeconds } from './audio-duration.js'
import { numericUsage } from './audit-log.js'
import { synthesizeTts, MODEL_TTS, MODEL_TTS_SYNTH, synthesisFailureText, failureCode } from './voice-design.js'
import { resolveBreezeLanguage, normalizeBreezeProfile } from './breeze-voices.js'

// Minimal key-file reader for a provider profile (env-style KEY=value files).
// 与 realtime-protocol.js 的 readEnvKey 语义不同（那个只认 DASHSCOPE_API_KEY），不要合并。
export async function readProviderKey(profile) {
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

// 托管凭据型提供方：合成时用宿主凭据而不是 profile 里的 key_file。
const MANAGED_TTS_CREDENTIAL = { breeze: 'breeze', volcengine: 'volcengine' }

// 与 synthVoiceLayer 的 503 判据同源（那里是 requireValue(profile.auth_type === 'none' || key)）：
// 两处分叉就又会「ready 说就绪、合成必然 503」。
// 注意不能只判断「profile 存不存在」——ttsProfiles() 无条件并进内置表、getTtsProfile() 对内置与
// 任何已保存的 id 恒返回对象，那样这个判据就是个常量 true。
export async function ttsProviderReady({ provider, profiles, credentialStatuses }) {
  const id = typeof provider === 'string' && provider ? provider : 'qwen'
  // qwen 的合成直接问 bailian 凭据，不经过任何 profile（voiceProfile() 也是这么归一成 bailian 的）。
  if (id === 'qwen' || id === 'bailian') return !!credentialStatuses?.bailian?.ready
  const profile = getTtsProfile({ tts_provider: id, tts_profiles: profiles })
  if (!profile) return false // id 不存在时合成会 400，不能报就绪
  // protocol 为 breeze-tts 的自定义 id 也走托管的 Breeze 凭据（与 synthVoiceLayer 同款）。
  const managed = Object.hasOwn(MANAGED_TTS_CREDENTIAL, id) ? MANAGED_TTS_CREDENTIAL[id] : profile.protocol === 'breeze-tts' ? 'breeze' : null
  if (managed) return !!credentialStatuses?.[managed]?.ready
  if (profile.auth_type === 'none') return true
  return !!(await readProviderKey(profile))
}

export function createVoiceSynthesis({ getSettings, credential, modelCredential, audit, fetcher = globalThis.fetch, requireValue }) {
  const s = () => getSettings()

  // Snapshot the actual profile used for this request, including Qwen's independent voice.
  function voiceProfile(input = s()) {
    const provider = input.tts_voice_provider || 'qwen'
    if (provider === 'qwen') return { provider: 'bailian', model: input.tts_profiles?.qwen?.model === MODEL_TTS ? MODEL_TTS : MODEL_TTS_SYNTH, voice: typeof input.tts_profiles?.qwen?.voice === 'string' && input.tts_profiles.qwen.voice.trim() ? input.tts_profiles.qwen.voice.trim() : 'longanhuan_v3.1' }
    const rawProfile = getTtsProfile({ tts_provider: provider, tts_profiles: input.tts_profiles })
    const profile = provider === 'breeze' || rawProfile?.protocol === 'breeze-tts' ? normalizeBreezeProfile(rawProfile) : rawProfile
    return { provider, model: profile?.model || 'unknown', voice: profile?.voice, profile }
  }

  async function synthVoiceLayer(text, language, context = {}, rt, voiceState) {
    // 两处 provider 读取都在第一个 await 之前，此处的局部快照与逐次读取等价（不跨 await）。
    const provider = s().tts_voice_provider
    const candidate = provider === 'breeze' && rt.use_tts_voice !== false ? null : voiceState?.get()
    const qwen = !!candidate || (provider || 'qwen') === 'qwen'
    const selected = candidate ? { provider: 'bailian', model: MODEL_TTS, voice: candidate.designVoiceId } : voiceProfile()
    if (selected.provider === 'breeze' || selected.profile?.protocol === 'breeze-tts') {
      language = resolveBreezeLanguage(text, language)
      selected.profile = normalizeBreezeProfile(selected.profile, {text, language})
      selected.voice = selected.profile.voice
      selected.language = language
    }
    const { profile, ...metadata } = selected
    const record = { ...context, ...metadata, kind: 'synthesis', role: 'assistant', text }
    // Wall-clock cost of the request, not the audio length: the audio duration
    // says nothing about how long the user waited.
    const startedAt = Date.now()
    try {
      let result
      if (qwen) {
        const { key } = await credential()
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
      await audit.append({ ...record, status: 'completed', usage, requestId: result.requestId, audioOutput: true, audioDurationSeconds: duration, durationMs: Date.now() - startedAt })
      return { ...result, ...metadata, usage, usageAvailable: usage !== null }
    } catch (error) {
      if (context.signal?.aborted) throw error
      await audit.append({ ...record, status: error.status === 499 ? 'cancelled' : 'failed', usage: null })
      await audit.append({ ...context, ...metadata, kind: 'error', status: 'failed', text: synthesisFailureText(error), code: failureCode(error), usage: null })
      throw error
    }
  }

  return { voiceProfile, synthVoiceLayer }
}
