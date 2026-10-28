import { ttsIssues, validTtsProfileId } from './tts-config.js'
// Shared browser/server validation for the Realtime + voice-layer schema.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function configSection(field) {
  if (field === 'workspace') return 'workspace'
  if (field === 'enabled_tools') return 'tools'
  if (field === 'tts_voice_provider' || field.startsWith('tts_profiles')) return 'models'
  return 'prompt'
}

// Validate the retained settings schema. The voice layer selects a TTS provider:
// 'qwen' (default, Bailian Qwen TTS via synthesizeTts) or a named profile in
// tts_profiles (via synthesizeHttpTts). Segmented MiniMax mix triangles, ASR,
// chat_model, speed, emotion, language_mode and voice_habits no longer exist.
export function configIssues(settings, context = {}) {
  const errors = {}
  const fail = (field, message) => { if (!errors[field]) errors[field] = message }
  if (!object(settings)) return { settings: '配置格式不正确' }
  const s = settings

  function path(field, value, label) {
    // eslint-disable-next-line no-control-regex -- 路径校验需要拒绝控制字符
    if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f]/.test(value)) { fail(field, `${label}路径格式无效`); return }
    const text = value.trim(); if (!text || text.startsWith('~/')) return
    const windows = /^[A-Za-z]:[\\/]/.test(text) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(text) || /^[\\/](?![\\/])/.test(text)
    const posix = text.startsWith('/')
    if (!(context.platform === 'win32' ? windows : context.platform ? posix : windows || posix)) fail(field, `${label}须为服务端绝对路径或以 ~/ 开头`)
  }

  // Voice-layer provider selection. 'qwen' (default) uses Bailian Qwen TTS via
  // synthesizeTts; any other id must name a valid profile in tts_profiles.
  const provider = (s.tts_voice_provider === undefined || typeof s.tts_voice_provider === 'string') ? (s.tts_voice_provider || 'qwen') : s.tts_voice_provider
  if (provider !== 'qwen') {
    if (!validTtsProfileId(provider)) fail('tts_voice_provider', '请选择有效的语音提供方')
    else if (!object(s.tts_profiles) || !Object.hasOwn(s.tts_profiles, provider)) fail('tts_voice_provider', '所选语音提供方不存在，请重新选择')
    Object.assign(errors, ttsIssues({ tts_provider: provider, tts_profiles: object(s.tts_profiles) ? s.tts_profiles : {} }, context, { allProfiles: true }))
  } else if (object(s.tts_profiles)) {
    // Qwen is active, but stale provider profiles are still validated lightly.
    Object.assign(errors, ttsIssues({ tts_provider: 'minimax', tts_profiles: s.tts_profiles }, context, { allProfiles: true }))
  }

  if (s.realtime !== undefined) {
    if (!object(s.realtime)) fail('realtime', '实时语音配置格式无效')
    else {
      if (s.realtime.credential_source !== undefined && !['auto', 'provider', 'file'].includes(s.realtime.credential_source)) fail('realtime.credential_source', '请选择有效的百炼凭据来源')
      if (s.realtime.key_file !== undefined) path('realtime.key_file', s.realtime.key_file, '百炼凭据文件')
    }
  }

  path('workspace', s.workspace, '工作区')
  if (!Array.isArray(s.enabled_tools) || s.enabled_tools.length > 128 || s.enabled_tools.some(name => typeof name !== 'string' || !(/^[\w./:@-]{1,180}$/.test(name)))) fail('enabled_tools', '可选工具列表格式无效，最多选择128个')
  if (typeof s.system_prompt !== 'string' || s.system_prompt.length > 8000) fail('system_prompt', '补充提示词须为不超过8000字的文本')

  return errors
}