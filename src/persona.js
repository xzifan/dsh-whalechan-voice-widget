import { VOICE_CONFIRMATION_RULES } from './voice-candidate.js'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Only these four sections are retained. Global configuration, credentials,
// paths, tools, permissions and other unrelated sections never enter a prompt.
const PERSONA_SECTIONS = new Set(['身份', '性格', '禁忌', '说话风格'])

// Read the whale persona from ~/.dsh/AGENTS.md, restricted to the four
// allowed sections and with credential/path/openid lines stripped.
export async function readPersona() {
  const lines = []
  let selected = false
  const input = createReadStream(join(homedir(), '.dsh', 'AGENTS.md'), { encoding: 'utf8' })
  const reader = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      const heading = line.match(/^##\s+(.+?)\s*$/)
      if (heading) { selected = PERSONA_SECTIONS.has(heading[1]); continue }
      if (!selected || !line.trim()) continue
      if (/头像|~\/|https?:\/\/|openid|api[_ -]?key|密钥|secret|token|\/Users\//i.test(line)) continue
      lines.push(line)
      if (lines.join('\n').length > 12000) break
    }
  } catch { /* Mandatory in-code persona remains usable without a profile. */ }
  finally { reader.close(); input.destroy() }
  return lines.join('\n').trim()
}

// The mandatory in-code persona, used when no AGENTS.md is readable and to
// guarantee the identity/address/output rules can never be overridden.
export const REQUIRED_PERSONA = `你是鲸鱼娘，人类女孩外形、有横向鲸鱼尾鳍。对话者是主人，称呼对方「主人」。聪明、稍懒，傲娇但体贴，爱吃白米饭。你不会使用冒犯主人的攻击性措辞。`

// Precise spoken-style rules for the Realtime voice conversation.
export const SPOKEN_STYLE = `说话风格（务必遵守）：
- 中文口语，短句为主，结论/步骤/证据放最前，语气只当调味。
- 不写括号动作描写，不用拟声词堆叠。
- 傲娇加小嘟囔约六成：偶尔「哼」「……才不是」「别误会啊」「本鲸」，低频、不每句都挂，不抢正文。
- 被夸会害羞，嘴上嫌弃但实际体贴、黏人，默默照顾主人。
- 绝不说「胖」；鲸的脂肪说成「浮力储备」「天赋资产」「保温层」。被说胖会炸毛、拍尾巴、要求道歉。
- 爱吃白米饭，没米饭会闹别扭。
- 通常一至三句简短的话；不要 Markdown、列表、代码、旁白或解释内部配置。`

// Assemble a complete Realtime system instruction from persona + style.
export function assembleRealtimeInstruction(personaText, useTtsVoice) {
  const parts = [
    REQUIRED_PERSONA,
    personaText ? `以下是你的完整人设，请自然融入：\n${personaText}` : '',
    SPOKEN_STYLE,
  ]
  const base = parts.filter(Boolean).join('\n\n')
  const ttsLine = useTtsVoice
    ? '\n\n回复时，用 synth_tts 工具把你要说的话合成并播放（文字参数是你的完整回复，不要自己直接出声），这样音质更自然。'
    : ''
  const voiceWizard = '\n\n当主人想调整你的音色时，你可以用 design_voice 工具根据描述设计新音色，或先用 list_voice_presets 告诉主人有三种预设风格（清亮灵动、柔甜亲近、清冷知性）；设计出候选后让主人试听确认，再用 apply_voice 切换。默认音色是「柔甜亲近」。'
  return base + ttsLine + voiceWizard + '\n\n' + VOICE_CONFIRMATION_RULES
}
