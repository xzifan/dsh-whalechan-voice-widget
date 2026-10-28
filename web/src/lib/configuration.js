// Frontend-only configuration validation and field routing for the Realtime
// architecture. The segmented TTS/ASR/voice/habits validation that lived in
// src/config-validation.js is no longer referenced here.
const TOOL_NAME = /^[\w./:@-]{1,180}$/

export function configIssues(settings = {}, _context = {}, target = 'all') {
  const errors = {}
  const fail = (field, message) => { if (!errors[field]) errors[field] = message }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { settings: '配置格式不正确' }
  const s = settings
  if (target === 'all') {
    if (typeof s.system_prompt !== 'string' || s.system_prompt.length > 8000) fail('system_prompt', '补充提示词须为不超过8000字的文本')
    // eslint-disable-next-line no-control-regex -- 工作区路径校验需要拒绝控制字符
    if (typeof s.workspace === 'string' && (s.workspace.length > 2048 || /[\u0000-\u001f]/.test(s.workspace))) fail('workspace', '工作区路径格式无效')
    if (!Array.isArray(s.enabled_tools) || s.enabled_tools.length > 128 || s.enabled_tools.some(name => typeof name !== 'string' || !TOOL_NAME.test(name))) fail('enabled_tools', '可选工具列表格式无效，最多选择128个')
  }
  const rt = s.realtime
  if (rt !== undefined && (rt === null || typeof rt !== 'object' || Array.isArray(rt))) fail('realtime', '实时语音配置格式无效')

  return errors
}

export function configurationContext(models = {}, capabilities = {}) {
  return { platform: models.asr?.platform || capabilities.localAsr?.platform }
}

export function fieldDestination(field) {
  if(field==='tts_parameters')return {section:'voice',id:'tts-params'}
  if(field==='tts_profiles.breeze.key_file'||field==='credentials.breeze')return {section:'voice',id:'breeze-credentials'}
  if(field==='tts_profiles.breeze.endpoint')return {section:'voice',id:'breeze-endpoint'}
  if(field==='tts_profiles.breeze.model')return {section:'voice',id:'tts-model'}
  if(field.startsWith('tts_profiles.')||field==='tts_voice_provider')return {section:'voice',id:'voice-provider'}
  if (field === 'realtime.credential_source'||field==='credentials.bailian') return { section: 'voice', id: 'bailian-credentials' }
  if (field === 'realtime.key_file') return { section: 'voice', id: 'bailian-credentials' }
  if (field.startsWith('realtime.')) return { section: 'voice', id: 'realtime' }
  const map = {
    workspace: { section: 'tools', id: 'workspace' },
    system_prompt: { section: 'prompt', id: 'system-prompt' },
    enabled_tools: { section: 'tools', id: 'tools-heading' },
  }
  return map[field] || { section: 'prompt', id: 'system-prompt' }
}

export function fieldForControl(id) {
  const map = { 'breeze-endpoint':'tts_profiles.breeze.endpoint', workspace: 'workspace', 'system-prompt': 'system_prompt', 'tools-heading': 'enabled_tools' }
  return map[id]
}

export function errorsForField(errors, field) {
  return field ? Object.entries(errors).filter(([key]) => key === field || key.startsWith(field + '.')).map(([, message]) => message) : []
}

export function mergeConfigurationErrors(local, server, snapshot) {
  return { ...local, ...(server?.snapshot === snapshot ? server.errors : {}) }
}