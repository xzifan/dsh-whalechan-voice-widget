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
