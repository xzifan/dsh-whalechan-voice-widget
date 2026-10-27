// Apply only the voice settings changed by the preset action. Other settings
// can still be unsaved drafts in the editor.
export function mergeAppliedVoice(settings, applied) {
  return {
    ...settings,
    tts_voice_provider: applied.tts_voice_provider,
    tts_profiles: { ...settings.tts_profiles, [applied.tts_voice_provider]: { ...applied.tts_profiles?.[applied.tts_voice_provider] } },
    realtime: { ...settings.realtime, use_tts_voice: applied.realtime?.use_tts_voice },
  }
}

export function selectVoicePreset(rows = []) {
  return rows.find(row => row.applied)
    || [...rows].filter(row => row.candidate).sort((a,b) => (b.candidate.createdAt || 0) - (a.candidate.createdAt || 0))[0]
    || rows.find(row => row.id === 'preset-warm')
    || rows[0]
}

export function presetPromptIssue(prompt) {
  const length = String(prompt || '').trim().length
  return length < 4 || length > 500 ? '请用 4 到 500 字描述期望音色。' : ''
}
