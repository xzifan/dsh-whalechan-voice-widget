import { ttsEndpointProblem } from './tts-config.js'

// Canonical docs: https://docs.breezeblue.ai/api-reference/voice-previews/create-design-previews
// https://docs.breezeblue.ai/api-reference/voice-previews/save-voice-preview
const LIMIT = 12 * 1024 * 1024
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,256}$/.test(value)
function check(ok, message, status = 502) { if (!ok) throw Object.assign(new Error(message), { status }) }
async function jsonResponse(response, signal) {
  check(response?.ok, `Breeze 返回 HTTP ${Number.isInteger(response?.status) ? response.status : 502}`)
  check(Number(response.headers?.get?.('content-length') || 0) <= LIMIT, 'Breeze 响应过大')
  const chunks = []; let size = 0
  if (response.body?.getReader) {
    const reader = response.body.getReader()
    try {
      while (true) {
        signal?.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > LIMIT) { await reader.cancel(); check(false, 'Breeze 响应过大') }
        chunks.push(Buffer.from(value))
      }
    } finally { reader.releaseLock() }
  } else {
    const data = Buffer.from(await response.arrayBuffer())
    check(data.length <= LIMIT, 'Breeze 响应过大'); chunks.push(data)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw Object.assign(new Error('Breeze 返回无效 JSON'), { status: 502 }) }
}

export async function designBreezeVoice({ profile, key, description, name, signal, fetcher = globalThis.fetch }) {
  check(profile?.protocol === 'breeze-tts' && profile.endpoint && !ttsEndpointProblem(profile.endpoint), '请先保存有效的 Breeze 服务配置', 400)
  const endpoint = new URL(profile.endpoint)
  // Derive routes from the configured, validated origin; never trust response URLs.
  check(typeof key === 'string' && key.trim() && !/[\r\n]/.test(key), '请配置 DSH Breeze 凭据', 503)
  check(profile.auth_type === 'bearer' || profile.auth_type === 'header' && profile.auth_header.toLowerCase() === 'xi-api-key', 'Breeze 设计须使用 xi-api-key 或 Bearer 鉴权', 400)
  const headers = { 'Content-Type': 'application/json', ...(profile.auth_type === 'bearer' ? { Authorization: `Bearer ${key}` } : { 'xi-api-key': key }) }
  async function post(path, body) {
    signal?.throwIfAborted()
    let response
    try { response = await fetcher(new URL(path, endpoint.origin).href, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal }) }
    catch { signal?.throwIfAborted(); check(false, 'Breeze 连接失败，请检查服务配置') }
    if (!response?.ok) { try { await response?.body?.cancel?.() } catch {} }
    return jsonResponse(response, signal)
  }
  const design = await post('/v1/voice-previews/design', { voice_description: description, text: '主人，我在呢。这个声音怎么样？你听听看。', preview_count: 1, model_id: profile.model, language_code: 'zh' })
  const preview = design.previews?.[0]
  check(Array.isArray(design.previews) && design.previews.length === 1 && validId(preview?.generated_voice_id), 'Breeze 未返回有效候选音色')
  const audio = preview.audio_base_64
  check(typeof audio === 'string' && audio.length > 0 && audio.length <= LIMIT && /^[A-Za-z0-9+/]*={0,2}$/.test(audio) && Buffer.from(audio, 'base64').toString('base64') === audio, 'Breeze 预览音频编码无效')
  check(['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav'].includes(preview.media_type), 'Breeze 预览音频类型无效')
  const saved = await post(`/v1/voice-previews/${encodeURIComponent(preview.generated_voice_id)}/save`, { voice_name: name || '工作台音色', voice_description: description, language_code: 'zh' })
  check(validId(saved.voice_id), 'Breeze 未返回已保存音色 ID')
  return { designVoiceId: saved.voice_id, previewData: audio, previewMime: preview.media_type }
}
