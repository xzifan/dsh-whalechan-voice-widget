import {normalizeVoiceLayer,DEFAULT_TOOLS} from './voice-layer.js'
import {BREEZE_PRESET_VOICES} from '../../../src/core/breeze-voices.js'
// Generic largest-remainder allocation adapted from the permitted voice-mix.js.
export function redistributeWeights(entries, changedIndex, value) {
  if (entries.length < 2 || changedIndex < 0 || changedIndex >= entries.length) throw new RangeError('Invalid mix index')
  const selected = Math.max(0, Math.min(100, Math.round(Number(value) || 0)))
  const remaining = 100 - selected
  const others = entries.map((entry, index) => ({index, weight: Math.max(0, Number(entry.weight) || 0)})).filter(entry => entry.index !== changedIndex)
  const sum = others.reduce((total, entry) => total + entry.weight, 0)
  const allocations = others.map(entry => {
    const exact = remaining * (sum ? entry.weight / sum : 1 / others.length)
    return {...entry, weight: Math.floor(exact), remainder: exact - Math.floor(exact)}
  })
  const leftover = remaining - allocations.reduce((total, entry) => total + entry.weight, 0)
  const ranked = [...allocations].sort((a, b) => b.remainder - a.remainder || a.index - b.index)
  for (let i = 0; i < leftover; i++) ranked[i].weight++
  const weights = new Map(allocations.map(entry => [entry.index, entry.weight]))
  return entries.map((entry, index) => ({...entry, weight: index === changedIndex ? selected : weights.get(index)}))
}
export const DEFAULT_SETTINGS = {
  system_prompt: '', workspace: '', enabled_tools: [], tools_configured: false,
  tts_voice_provider: 'qwen', tts_profiles: {},
  realtime: {
    enabled: true, model: 'qwen-audio-3.1-realtime-plus', api_host: '', credential_source: 'provider',
    voice: '', language: 'zh', turn_mode: 'smart_turn', instructions: '', use_tts_voice: true,
    tools: [...DEFAULT_TOOLS],
  },
}
export function normalizeSettings(settings = {}) {
  const source = settings && typeof settings === 'object' ? settings : {}
  const profiles = source.tts_profiles && typeof source.tts_profiles === 'object' && !Array.isArray(source.tts_profiles) ? source.tts_profiles : {}
  return {
    ...DEFAULT_SETTINGS,
    system_prompt: typeof source.system_prompt === 'string' ? source.system_prompt : '',
    workspace: typeof source.workspace === 'string' ? source.workspace : '',
    enabled_tools: Array.isArray(source.enabled_tools) ? [...new Set(source.enabled_tools.filter(value => typeof value === 'string' && value.trim()))] : [],
    tools_configured: source.tools_configured === true,
    tts_voice_provider: typeof source.tts_voice_provider === 'string' ? source.tts_voice_provider : 'qwen',
    tts_profiles: Object.fromEntries(Object.entries(profiles).map(([id,profile])=>{
      if(!['breeze','qwen'].includes(id)||!profile||typeof profile!=='object')return [id,profile]
      const {key_file,api_key,...rest}=profile
      return [id,id==='breeze'?{...rest,voice:BREEZE_PRESET_VOICES.zh}:rest]
    })),
    realtime: {...DEFAULT_SETTINGS.realtime, ...normalizeVoiceLayer(source.realtime)},
  }
}
export function createRequestGate() {
  let generation = 0
  return { next: () => ++generation, current: token => token === generation, invalidate: () => ++generation }
}
export const ENDPOINT_METHODS = {
  '/api/voice-presets/save': ['POST'], '/api/voice-presets/generate': ['POST'],
  '/api/voice-presets/apply': ['POST'], '/api/voice-presets/greeting': ['POST'],
  '/api/history/sessions': ['POST'], '/api/history/messages': ['POST'],
  '/api/audit': ['POST'], '/api/statistics': ['POST'],
  '/api/credentials/status': ['POST'], '/api/credentials/save': ['POST'],
  '/api/config': ['GET', 'PUT'], '/api/config/check': ['POST'], '/api/catalog': ['POST'],
  '/api/realtime/playback': ['POST'], '/api/realtime/start': ['POST'], '/api/realtime/audio': ['POST'], '/api/realtime/commit': ['POST'],
  '/api/realtime/response': ['POST'], '/api/realtime/cancel': ['POST'], '/api/realtime/end': ['POST'], '/api/realtime/events': ['POST'],
}
const BRIDGE_TIMEOUT_MS = 180000
export function bridgeRequest(path, method, body, signal) {
  if (!ENDPOINT_METHODS[path]?.includes(method)) return Promise.reject(new Error('不支持的工作台操作'))
  return new Promise((resolve, reject) => {
    const id = newId()
    if (signal?.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
    const cleanup = () => {
      window.removeEventListener('message', receive)
      signal?.removeEventListener('abort', abort)
      clearTimeout(timer)
    }
    const abort = () => {
      cleanup()
      window.parent.postMessage({type: 'voice-workbench:abort', id}, window.location.origin)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const receive = event => {
      if (event.source !== window.parent || event.origin !== window.location.origin || event.data?.type !== 'voice-workbench:response' || event.data.id !== id) return
      cleanup()
      resolve({status: event.data.status, body: event.data.body})
    }
    window.addEventListener('message', receive)
    signal?.addEventListener('abort', abort, {once: true})
    // const 而非「let timer 后赋值」：本函数的引用方（cleanup/abort/receive）都是
    // 异步回调，setTimeout 之前不可能执行，所以提前到赋值处声明不会踩 TDZ。
    const timer = setTimeout(() => {
      cleanup()
      window.parent.postMessage({type: 'voice-workbench:abort', id}, window.location.origin)
      reject(new Error('请求超时，请检查插件连接后重试'))
    }, BRIDGE_TIMEOUT_MS)
    window.parent.postMessage({type: 'voice-workbench:request', id, method, path, body}, window.location.origin)
  })
}
export async function api(endpoint, {signal, ...body} = {}, method = 'POST') {
  let payload, status
  if (window.parent !== window) {
    const response = await bridgeRequest(`/api/${endpoint}`, method, method === 'GET' ? undefined : body, signal)
    payload = response.body; status = response.status
  } else {
    const response = await fetch(new URL(`./api/${endpoint}`, document.baseURI), {
      method, signal, headers: {'Content-Type': 'application/json'},
      ...(method === 'GET' ? {} : {body: JSON.stringify(body)}),
    })
    payload = await response.json().catch(() => null); status = response.status
  }
  if (!(status >= 200 && status < 300)) {
    const detail = payload?.error?.message || (typeof payload?.error === 'string' ? payload.error : null) || payload?.message
    const error = new Error(detail || `请求失败（${status}）`); error.status = status; error.fields = payload?.fieldErrors || payload?.fields; throw error
  }
  return payload || {}
}
// 服务端已经写明原因（例如「此模型正在使用账户授权，请在 DSH 模型设置中管理」）时
// 优先展示它：用通用文案会把人送进「重新输入再重试」的死循环，而这类失败重输无效。
export function errorText(error, fallback) {
  const detail = typeof error?.message === 'string' ? error.message.trim() : ''
  return detail || fallback
}
export function newId() { return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}` }