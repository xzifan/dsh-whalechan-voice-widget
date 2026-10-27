// Tool-side writes are patches, never whole editor snapshots. Merge them into
// both the live draft and saved baseline so unrelated local edits stay dirty.
export function mergeVoiceSettingsPatch(settings, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return settings
  const next = { ...settings }
  if (typeof patch.tts_voice_provider === 'string') next.tts_voice_provider = patch.tts_voice_provider
  if (patch.realtime && typeof patch.realtime === 'object') next.realtime = { ...settings.realtime, ...patch.realtime }
  if (patch.tts_profiles && typeof patch.tts_profiles === 'object') {
    next.tts_profiles = { ...settings.tts_profiles }
    for (const [provider, profile] of Object.entries(patch.tts_profiles)) {
      if (['qwen', 'openai', 'mimo', 'breeze', 'custom'].includes(provider) && profile && typeof profile === 'object' && !Array.isArray(profile)) {
        next.tts_profiles[provider] = { ...settings.tts_profiles?.[provider], ...profile }
      }
    }
  }
  return next
}
