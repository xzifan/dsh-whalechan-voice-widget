// Fixed Breeze voices are shared with the UI. Breeze prompt design/replication
// is paused; neither a saved custom voice nor a model-supplied voice may replace
// the voice selected for the utterance's language.
// 中文可选两种情绪，机灵版是默认值；日语/英语仍用固定预设。
export const BREEZE_ZH_VOICES = Object.freeze([
  { voiceId: 'voc_u3nxkd5578wc', name: '大肥鱼（机灵版）' },
  { voiceId: 'voc_8yud7hz7c9q2', name: '大肥鱼（迷糊版）' },
])
export const BREEZE_PRESET_VOICES = Object.freeze({
  zh: BREEZE_ZH_VOICES[0].voiceId,
  ja: 'voc_2qzsatyfq3fg',
  en: 'voc_7va7papsrurz',
})
const validLanguage = language => typeof language === 'string' && Object.hasOwn(BREEZE_PRESET_VOICES, language)

// An explicit supported language wins. Otherwise kana wins over shared Han
// characters, then Han, then Latin. Punctuation/numbers use a supported fallback
// (Chinese by default). This is deterministic script detection, not translation.
export function resolveBreezeLanguage(text, language = '', fallback = 'zh') {
  if (validLanguage(language)) return language
  const value = typeof text === 'string' ? text : ''
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(value)) return 'ja'
  if (/\p{Script=Han}/u.test(value)) return 'zh'
  if (/\p{Script=Latin}/u.test(value)) return 'en'
  return validLanguage(fallback) ? fallback : 'zh'
}

// With no utterance this produces the canonical Chinese profile for persisted
// settings and config metadata. At synthesis time pass the actual text/language
// to choose a fixed voice without changing model, endpoint or transport options.
export function normalizeBreezeProfile(profile = {}, {text = '', language = '', fallback = 'zh'} = {}) {
  const lang = resolveBreezeLanguage(text, language, fallback)
  // 只有中文允许选情绪变体；其它语言仍是固定预设，未知的 zhVoice 直接丢弃。
  const picked = BREEZE_ZH_VOICES.some(v => v.voiceId === profile.zhVoice) ? profile.zhVoice : undefined
  const next = {...profile}
  if (picked) next.zhVoice = picked
  else delete next.zhVoice
  return {...next, voice: lang === 'zh' && picked ? picked : BREEZE_PRESET_VOICES[lang]}
}
