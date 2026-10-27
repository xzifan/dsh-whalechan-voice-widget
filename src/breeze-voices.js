// Fixed Breeze voices are shared with the UI. Breeze prompt design/replication
// is paused; neither a saved custom voice nor a model-supplied voice may replace
// the voice selected for the utterance's language.
export const BREEZE_PRESET_VOICES = Object.freeze({
  zh: 'voc_47j4uzfyuxqc',
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
  return {...profile, voice: BREEZE_PRESET_VOICES[resolveBreezeLanguage(text, language, fallback)]}
}
