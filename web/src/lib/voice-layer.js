// Voice layer data for the Realtime brain: a swappable TTS provider behind the
// synth_tts tool. Default is Qwen TTS; other providers carry a voice id and
// optional custom params. Voice-design presets mirror the backend design_voice
// / list_voice_presets tools (src/voice-design.js), so the settings page can
// expose them without depending on a running Realtime session.

export const REALTIME_PROVIDERS = [
  {value:'qwen',label:'百炼 · Qwen-Audio-Realtime'},
  {value:'volcengine',label:'火山引擎 · WorkInProgress',disabled:true},
]

export const REALTIME_BRAIN = {
  name: 'Qwen-Audio-Realtime',
  note: '当前由 Qwen 处理语音理解、回复、打断（smart_turn）与 Function Calling 工具调用。',
}

export const DEFAULT_TTS_MODEL = 'qwen-audio-3.1-tts-plus'
export const DEFAULT_VOICE_ID = 'qwen-audio-3.1-realtime-plus-whalebrt-86754649b8a14117ac9c0f9e1716ac2b'
export const DEFAULT_VOICE_NAME = '柔甜亲近'
export const DEFAULT_TOOLS = ['design_voice', 'list_voice_presets', 'apply_voice', 'delete_voice', 'synth_tts', 'get_voice_config', 'set_tts_provider', 'set_tts_profile']

// Swappable TTS providers for the Realtime "voice layer". `qwen` is the default;
// the rest are placeholders the backend can bind to `synth_tts`.
export const VOICE_PROVIDERS = [
  { value: 'qwen', label: 'Qwen TTS（默认）', model: DEFAULT_TTS_MODEL, voice: '' },
  { value: 'openai', label: 'OpenAI Speech', model: '', voice: '' },
  { value: 'breeze', label: 'Breeze Blue', model: '', voice: '' },
]

// Voice-design presets. Only the warm preset has a real pre-built voiceId
// (DEFAULT_VOICE_ID); the other two are design *references* — their description
// is what you'd say to design_voice in conversation to generate them. This keeps
// the settings page honest: it never pretends to switch to a voice that has no id.
export const VOICE_PRESETS = [
  { id: 'preset-bright', name: '清亮灵动', voiceId: '', description: '中高音区，清亮干净，咬字利落，节奏轻快。', designPrompt: '角色是一名十三至十五岁的初中女生，标准普通话，带自然的少年感。中高音区，音色清亮通透，发声集中、干净，声音轻巧但有实感。像课间和同学分享趣事，语速略快，咬字利落，短句轻快，重音与音高有自然起伏，句尾收得干脆。保持自然真声，不刻意夹嗓，不用明显气声、鼻音或夸张的动画配音腔。' },
  { id: 'preset-warm', name: '柔甜亲近', voiceId: DEFAULT_VOICE_ID, description: DEFAULT_VOICE_NAME + ' · 声线纤细轻盈，清透偏高，普通话自然。', designPrompt: '日本动漫中初中女生角色的配音风格。声线纤细、轻盈、清透，音区偏高，带天真活泼和一点傲娇感。声音柔软圆润，轻声说话也清楚，有自然灵动的语调。说中文时使用流利自然的标准普通话，遵循中文的声调、重音与停顿，像动画中文版的专业配音。避免日语口音、日式断句、刻意夹嗓、尖锐鼻音、过度气声和夸张撒娇。' },
  { id: 'preset-calm', name: '清冷知性', voiceId: '', description: '中低音区，清澈扎实，重音明确，从容知性。', designPrompt: '角色是一名二十五至三十五岁的女性白领上班族，标准普通话，声音成熟自然。中低音区，音色清澈、略带凉感，共鸣扎实，声音有适度厚度。像午休时与熟悉的同事平静交谈，语速适中略缓，吐字准确，停顿按语义划分，重音明确，句尾平稳下落。语气从容、有分寸，保留自然的情绪变化，不压嗓、不耳语、不用播音朗诵腔。' },
]

// Normalize the `realtime` voice-layer subset, keeping the required backward-
// compatible realtime keys intact.
export function normalizeVoiceLayer(realtime = {}) {
  const r = realtime && typeof realtime === 'object' ? realtime : {}
  return {
    enabled: r.enabled !== false,
    api_host: r.api_host || '',
    credential_source: 'provider',
    voice: r.voice || '',
    language: r.language || 'zh',
    turn_mode: r.turn_mode || 'smart_turn',
    instructions: r.instructions || '',
    use_tts_voice: r.use_tts_voice !== false,
    tools: Array.isArray(r.tools) ? r.tools : [...DEFAULT_TOOLS],
    model: r.model || 'qwen-audio-3.1-realtime-plus',
  }
}

// Normalize the top-level voice-layer subset: which TTS provider synth_tts
// uses, plus a per-provider profile map (model/voice/key_file/endpoint/extra).
export function normalizeVoiceLayerSettings(settings = {}) {
  const s = settings && typeof settings === 'object' ? settings : {}
  const profiles = s.tts_profiles && typeof s.tts_profiles === 'object' && !Array.isArray(s.tts_profiles) ? s.tts_profiles : {}
  return {
    tts_voice_provider: typeof s.tts_voice_provider === 'string' ? s.tts_voice_provider : 'qwen',
    tts_profiles: profiles,
  }
}