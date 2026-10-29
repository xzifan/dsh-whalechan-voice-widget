import { numericUsage } from './audit-log.js'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'

const MODEL_TTS = 'qwen-audio-3.1-tts-flash'
const MODEL_TTS_SYNTH = 'qwen-audio-3.1-tts-plus'
const MODEL_RT = 'qwen-audio-3.1-realtime-plus'
const DEFAULT_HOST = 'https://dashscope.aliyuncs.com'

const safeCode = value => String(value || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80)

/** Read DASHSCOPE_API_KEY from a key file. */
export async function readDashKey(keyFile = '~/.dsh/secrets/bailian.env') {
  const path = (keyFile || '~/.dsh/secrets/bailian.env').replace(/^~(?=\/)/, homedir())
  try {
    const text = await readFile(path, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?(DASHSCOPE_API_KEY)\s*=\s*(.*?)\s*$/)
      if (m) return m[2].replace(/^(['"])(.*)\1$/, '$2').trim()
    }
  } catch {}
  return ''
}

function problem(status, data) {
  const message = String(data?.message || data?.error?.message || '')
  const category = /model.*(?:not.*exist|invalid|not.*support)/i.test(message) ? 'model-unavailable'
    : /insufficient|quota|balance|credit/i.test(message) ? 'quota-or-balance'
    : /api.?key|auth|permission/i.test(message) ? 'authorization' : 'upstream'
  return Object.assign(new Error('百炼音色请求失败'), { name: 'VoiceNativeError', status, safe: { status, code: safeCode(data?.code || data?.error?.code), category } })
}

/** POST to Bailian customization endpoint. */
async function customization(key, host, body, fetcher, signal) {
  let response
  try { response = await fetcher(host + '/api/v1/services/audio/tts/customization', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal }) }
  catch (e) { if (signal?.aborted) throw Object.assign(new Error('音色设计已取消'), { name: 'VoiceNativeError', status: 499 }); throw Object.assign(new Error('百炼音色服务连接失败'), { name: 'VoiceNativeError', status: 502 }) }
  let data
  try { data = await response.json() } catch { throw problem(response.status, { code: 'NonJsonResponse' }) }
  if (!response.ok || (data.code && data.code !== 'Success')) throw problem(response.status, data)
  return data.output || {}
}

/**
 * Design a voice from a text description (提示词), returning a preview audio
 * (base64 WAV) and the designed TTS voice id. Optionally clone it into a
 * Realtime voice via the preview audio, returning a realtime voice id.
 */
export async function designVoice({ key, host = DEFAULT_HOST, description, previewText = '主人，我在呢。今天也想陪你聊一会儿。', previewLanguage = 'zh', prefix = 'voice', cloneToRealtime = true, fetcher = globalThis.fetch, signal }) {
  const prefixClean = prefix.replace(/[^A-Za-z0-9]/g, '').slice(0, 10) || 'voice'
  const langHints = { zh: 'zh', ja: 'ja', en: 'en' }[previewLanguage] || 'zh'
  // Step 1: voice design via TTS model -> voice_id + preview_audio.data (base64 WAV)
  const design = await customization(key, host, {
    model: 'voice-enrollment',
    input: {
      action: 'create_voice',
      target_model: MODEL_TTS,
      voice_prompt: String(description || '').slice(0, 500),
      preview_text: String(previewText || '').slice(0, 200),
      prefix: prefixClean,
      language_hints: [langHints],
    },
    parameters: { sample_rate: 24000, response_format: 'wav' },
  }, fetcher, signal)

  const designVoiceId = design.voice_id
  const previewData = design.preview_audio?.data
  if (!designVoiceId || !previewData) throw Object.assign(new Error('百炼未返回设计音色预览'), { name: 'VoiceNativeError', status: 502 })

  signal?.throwIfAborted()
  let realtimeVoiceId = ''
  if (cloneToRealtime) {
    // Step 2: clone the preview audio into a Realtime voice (design voice_id is not directly usable by Realtime).
    const clone = await customization(key, host, {
      model: 'voice-enrollment',
      input: {
        action: 'create_voice',
        target_model: MODEL_RT,
        prefix: prefixClean.slice(0, 8) + 'rt',
        audio: 'data:audio/wav;base64,' + previewData,
      },
    }, fetcher, signal)
    realtimeVoiceId = clone.voice_id || ''
  }

  return { designVoiceId, realtimeVoiceId, previewData, previewMime: 'audio/wav' }
}

/** Query a voice's status (DEPLOYING/OK/UNDEPLOYED). */
export async function queryVoice(key, voiceId, host = DEFAULT_HOST, fetcher = globalThis.fetch, signal) {
  const out = await customization(key, host, { model: 'voice-enrollment', input: { action: 'query_voice', voice_id: voiceId } }, fetcher, signal)
  return { status: out.status, voiceId, targetModel: out.target_model || out.targetModel || '' }
}

/**
 * Is this delete failure just "that voice is already gone"?
 * Measured against DashScope: deleting an unknown voice id answers HTTP 400 with
 * code `BadRequest.ResourceNotExist` (not 404), so the status alone is not enough.
 * Deleting an already-deleted id must count as success, otherwise a retry can
 * never succeed and the (real, account-level) quota stays silently unreleased.
 */
const GONE_CODE = /not.?exist|not.?found|gone|already.?delet/i
export function voiceAlreadyGone(error) {
  const status = Number(error?.status)
  if (status === 404 || status === 410) return true
  return GONE_CODE.test(String(error?.safe?.code || ''))
}

/** Delete a custom voice to free the shared 1000-voice quota. */
export async function deleteBailianVoice(key, voiceId, host = DEFAULT_HOST, fetcher = globalThis.fetch, signal) {
  await customization(key, host, { model: 'voice-enrollment', input: { action: 'delete_voice', voice_id: voiceId } }, fetcher, signal)
  return { deleted: true, voiceId }
}

/** Non-stream TTS synthesis (Qwen-Audio-TTS). Returns base64 audio + mime. */
export async function synthesizeTts({ key, host = DEFAULT_HOST, text, voice = 'longanhuan_v3.1', format = 'wav', sampleRate = 24000, instruction = '', language = '', model = MODEL_TTS_SYNTH, fetcher = globalThis.fetch, signal }) {
  const body = { model, input: { text: String(text || '').slice(0, 2000), voice, format, sample_rate: sampleRate } }
  if (instruction) body.input.instruction = String(instruction).slice(0, 1000)
  if (['zh', 'ja', 'en'].includes(language)) body.input.language_hints = [language]
  let response
  try { response = await fetcher(host + '/api/v1/services/audio/tts/SpeechSynthesizer', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal }) }
  catch (e) { if (signal?.aborted) throw Object.assign(new Error('语音合成已取消'), { name: 'VoiceNativeError', status: 499 }); throw Object.assign(new Error('百炼语音合成连接失败'), { name: 'VoiceNativeError', status: 502 }) }
  let data
  try { data = await response.json() } catch { throw problem(response.status, { code: 'NonJsonResponse' }) }
  if (!response.ok || (data.code && data.code !== 'Success')) throw problem(response.status, data)
  const audioUrl = data.output?.audio?.url
  if (!audioUrl) throw Object.assign(new Error('百炼未返回合成音频'), { name: 'VoiceNativeError', status: 502 })
  const audioRes = await fetcher(audioUrl, { redirect: 'error', signal })
  if (!audioRes.ok) throw Object.assign(new Error('合成音频下载失败'), { name: 'VoiceNativeError', status: 502 })
  const bytes = Buffer.from(await audioRes.arrayBuffer())
  if (bytes.length > 24 * 1024 * 1024) throw Object.assign(new Error('合成音频过大'), { name: 'VoiceNativeError', status: 502 })
  const usage = numericUsage(data.usage)
  const requestId = typeof data.request_id === 'string' ? safeCode(data.request_id) : undefined
  return { audio: bytes.toString('base64'), mime: format === 'mp3' ? 'audio/mpeg' : 'audio/wav', usage, usageAvailable: usage !== null, provider: 'bailian', model, voice, ...(requestId ? { requestId } : {}) }
}

export const VOICE_PRESETS = [
  { id: 'preset-bright', name: '清亮灵动', description: '角色是一名十三至十五岁的初中女生，标准普通话，带自然的少年感。中高音区，音色清亮通透，发声集中、干净，声音轻巧但有实感。像课间和同学分享趣事，语速略快，咬字利落，短句轻快，重音与音高有自然起伏，句尾收得干脆。保持自然真声，不刻意夹嗓，不用明显气声、鼻音或夸张的动画配音腔。' },
  { id: 'preset-warm', name: '柔甜亲近', description: '日本动漫中初中女生角色的配音风格。声线纤细、轻盈、清透，音区偏高，带天真活泼和一点傲娇感。声音柔软圆润，轻声说话也清楚，有自然灵动的语调。说中文时使用流利自然的标准普通话，遵循中文的声调、重音与停顿，像动画中文版的专业配音。避免日语口音、日式断句、刻意夹嗓、尖锐鼻音、过度气声和夸张撒娇。' },
  { id: 'preset-calm', name: '清冷知性', description: '角色是一名二十五至三十五岁的女性白领上班族，标准普通话，声音成熟自然。中低音区，音色清澈、略带凉感，共鸣扎实，声音有适度厚度。像午休时与熟悉的同事平静交谈，语速适中略缓，吐字准确，停顿按语义划分，重音明确，句尾平稳下落。语气从容、有分寸，保留自然的情绪变化，不压嗓、不耳语、不用播音朗诵腔。' },
]

export const DEFAULT_VOICE_NAME = '柔甜亲近'
export const DEFAULT_VOICE_ID = 'qwen-audio-3.1-realtime-plus-whalebrt-86754649b8a14117ac9c0f9e1716ac2b'
export { MODEL_TTS, MODEL_TTS_SYNTH, MODEL_RT, DEFAULT_HOST }
