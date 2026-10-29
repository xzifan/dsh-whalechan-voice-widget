// 纯常量 / 提示词 / 工具 Schema：无状态、无副作用，不 import 任何 src/ 模块，也不持有可变态。
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'

export const MODEL = 'qwen-audio-3.1-realtime-plus'
export const DEFAULT_HOST = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
export const SYSTEM_VOICE = 'longanqian_v3.1'
export const DEFAULT_TOOLS = ['design_voice', 'list_voice_presets', 'apply_voice', 'delete_voice', 'synth_tts', 'get_voice_config', 'set_tts_provider', 'set_tts_profile']
export const MAX_AUDIO_BYTES = 24 * 1024 * 1024

export const safeCode = value => String(value || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80)
export const redactText = value => String(value ?? '').slice(0, 1000)
  .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [已隐藏]')
  .replace(/\b(?:sk-|sk_|api_)[A-Za-z0-9_-]{16,}/g, '[已隐藏]')
  .replace(/((?:[A-Za-z0-9_-]*(?:api[_-]?key|secret|token|password|authorization|cookie|credential)[A-Za-z0-9_-]*)["']?\s*[:=]\s*)[^\r\n,;}]+/gi, '$1[已隐藏]')

/** Read DASHSCOPE_API_KEY from the configured key file. Never log or return it to the frontend. */
export async function readEnvKey(keyFile = '~/.dsh/secrets/bailian.env') {
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

export function realtimeDefaults() {
  return {
    enabled: true, model: MODEL, api_host: '', credential_source: 'provider',
    voice: '', language: 'zh', turn_mode: 'smart_turn', instructions: '', use_tts_voice: true, tools: [...DEFAULT_TOOLS],
  }
}

export function toolDefinitions(tools, nativeTools = []) {
  const schema = {
    design_voice: { description: '根据文字描述设计一个新音色（声音设计），生成候选并试听。', properties: { description: { type: 'string', description: '期望音色的文字描述（性别、年龄、音调、语速、情感等）' }, name: { type: 'string', description: '给这个音色起的简短名字' }, preview_language: { type: 'string', description: '试听语言 zh/ja/en，用于验证跨语种一致性', enum: ['zh', 'ja', 'en'] } }, required: ['description'] },
    list_voice_presets: { description: '列出可选的内置音色风格预设。', properties: {} },
    apply_voice: { description: '仅在主人试听后下一轮明确同意时保存当前候选音色。TTS立即生效，原生实时模式重连生效。', properties: { voice_id: { type: 'string', description: '要应用的音色 ID' } }, required: ['voice_id'] },
    delete_voice: { description: '删除一个不再需要的候选音色，释放音色配额。', properties: { voice_id: { type: 'string', description: '要删除的音色 ID' } }, required: ['voice_id'] },
    synth_tts: { description: '用更高音质的 TTS 模型合成指定文本并播放（用于需要更自然朗读的片段）。', properties: { text: { type: 'string', description: '要合成的文本' }, language: { type: 'string', description: '语言 zh/ja/en', enum: ['zh', 'ja', 'en'] } }, required: ['text'] },
    get_voice_config: { description: '读取当前的出声 TTS 提供方与音色配置（供语音设置助手查看后调整）。', properties: {} },
    set_tts_provider: { description: '切换出声 TTS 的提供方。qwen=百炼默认（支持提示词设计）；breeze=按语言使用中日英固定预设，暂不支持生成/复刻；openai/mimo/custom 需自行配置模型与音色。切换后重新开始对话生效。', properties: { provider: { type: 'string', description: '目标提供方', enum: ['qwen', 'openai', 'mimo', 'breeze', 'custom'] } }, required: ['provider'] },
    set_tts_profile: { description: '设置非百炼提供方的合成参数（模型、音色、自定义 extra 参数）。仅对当前非 qwen 提供方生效。', properties: { provider: { type: 'string', description: '提供方 id（省略则用当前提供方）' }, model: { type: 'string', description: '模型 ID' }, voice: { type: 'string', description: '音色 ID 或名称' }, extra: { type: 'object', description: '自定义合成参数对象' } }, required: [] },
  }
  const internal = (Array.isArray(tools) ? tools : DEFAULT_TOOLS)
    .filter(name => Object.hasOwn(schema, name))
    .map(name => ({ type: 'function', function: { name, description: schema[name].description, parameters: { type: 'object', properties: schema[name].properties || {}, required: schema[name].required || [] } } }))
  const names = new Set(internal.map(tool => tool.function.name))
  const native = nativeTools.filter(tool => tool && typeof tool.name === 'string' && !Object.hasOwn(schema, tool.name) && tool.parameters && typeof tool.parameters === 'object' && !Array.isArray(tool.parameters))
    .filter(tool => { if (names.has(tool.name)) return false; names.add(tool.name); return true })
    .map(tool => ({ type: 'function', function: { name: tool.name, description: String(tool.description || ''), parameters: structuredClone(tool.parameters) } }))
  return [...internal, ...native]
}

export const REALTIME_INSTRUCTIONS = '你是鲸鱼娘，人类女孩外形、有横向鲸鱼尾鳍。对话者是主人，称呼对方「主人」。聪明、稍懒，傲娇但体贴，爱吃白米饭。用自然口语回答，通常一至三句简短的话；不要Markdown、列表、代码、括号动作描写、旁白或解释内部配置。\n\n当主人想调整你的音色时，你可以用 design_voice 工具根据描述设计新音色，或先用 list_voice_presets 告诉主人有三种预设风格（清亮灵动、柔甜亲近、清冷知性）；设计出候选后让主人试听确认，再用 apply_voice 切换。默认音色是「柔甜亲近」。\n\n当主人想更换出声的 TTS 服务商或配置声音参数时，你可以作为语音设置助手：用 get_voice_config 先查看当前提供方与音色；用 set_tts_provider 切换提供方（qwen 自带音色预设，其他提供方需自行设置模型和音色）；对非 qwen 提供方用 set_tts_profile 设置模型、音色与参数。配置切换后会提示主人重新开始对话生效。\n\n调用工具后必须依据工具的返回说话：工具返回失败、为空或没给出结果时，就如实说没做成（可以说明原因并问主人要不要再试），绝不要假设成功、也不要编造文件内容或执行结果。只有在工具确实返回了内容时才复述结果。'

// When use_tts_voice is on, the model speaks through synth_tts (higher quality TTS)
// instead of its own Realtime voice.
export function realtimeInstructions(useTtsVoice) {
  const base = REALTIME_INSTRUCTIONS
  if (!useTtsVoice) return base
  return base.replace(/当主人想调整你的音色时/, '回复时，用 synth_tts 工具把你要说的话合成并播放（文字参数是你的完整回复，不要自己直接出声），这样音质更自然。\n\n当主人想调整你的音色时')
}
