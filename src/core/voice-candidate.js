// A candidate belongs to one conversation and is never part of saved settings.
export const VOICE_CONFIRMATION_RULES = '设计音色后，试听并继续用候选声音自然询问「主人，要用这个声音吗？」。只有主人下一轮明确肯定才调用内部确认工具；否定、犹豫、转话题都恢复原音色，不保存。不要向主人说出任何内部工具名，尤其不要说 apply_voice；合成文本也必须遵守。只有确认工具明确返回成功后才能说已应用或已保存；等待用户最终转写期间不要抢先承诺，失败时说明尚未成功，不得谎称已经切换。原生实时声音不能在已出声连接中可靠热切换，候选阶段通过 TTS 说话，确认后再重连。'
const spokenNames = { apply_voice: '应用这个声音', design_voice: '设计声音', synth_tts: '合成语音', delete_voice: '放弃这个声音', list_voice_presets: '查看可选声音', get_voice_config: '查看声音设置', set_tts_provider: '调整语音服务', set_tts_profile: '调整声音设置' }
export const spokenText = text => String(text || '').replace(/(?:(?:调用|使用|用)\s*)?`?(apply_voice|design_voice|synth_tts|delete_voice|list_voice_presets|get_voice_config|set_tts_provider|set_tts_profile)`?(?:\s*(?:工具|函数))?/gi, (_match, name) => spokenNames[name.toLowerCase()])
export function createVoiceCandidateState({ now = Date.now, ttl = Infinity } = {}) {
  let pending = null
  const candidates = new Map()
  const userTurns = new Set()
  const get = () => { if (pending && now() >= pending.expiresAt) pending = null; return pending }
  return {
    get,
    clear() { pending = null },
    list() { return [...candidates.values()] },
    find(voiceId) { return [...candidates.values()].find(c => [c.designVoiceId, c.realtimeVoiceId].includes(voiceId)) },
    forget(candidate) { candidates.delete(candidate.designVoiceId); if (pending?.designVoiceId === candidate.designVoiceId) pending = null },
    set(candidate, turnId) { pending = { ...candidate, turnId, confirmedTurn: null, expiresAt: now() + ttl }; candidates.set(candidate.designVoiceId, pending); return pending },
    user(text, turnId) {
      if (userTurns.has(turnId)) return
      userTurns.add(turnId)
      if (userTurns.size > 256) userTurns.delete(userTurns.values().next().value)
      const value = get()
      if (!value || value.turnId === turnId) return
      value.confirmedTurn = null
      if (/[？?]|不要|不能|不想|不用|不是|别用|不应用|不保存|不保留|先别|暂不|算了|但是|不过|如果|要是|再说|考虑|能否|是否|吗|么/.test(text)) { pending = null; return }
      const normalized = String(text || '').trim().replace(/[\s，。！!,.、]/g, '').toLowerCase()
      const simple = /^(好|好的|好呀|好啊|可以|可以的|行|行的|是|是的|嗯好|确认|确认应用|应用|应用吧|yes|yesplease|ok|okay|applyit)$/
      const explicit = /^(?:(?:嗯|好|好的|好呀|好啊|可以|可以的|行|是的|确认|这个不错|这个声音不错|不错)[啊呀呢吧的]*)*(?:就)?(?:用|使用|应用|换成|保留|保存|选)(?:这个|这一个|这个声音|这个音色|这声音|这音色)(?:吧|好了|就好|就行|以后都用这个)?$/
      if (simple.test(normalized) || explicit.test(normalized) || /^(?:就这个|就用这个吧)$/.test(normalized)) value.confirmedTurn = turnId
      else pending = null
    },
    confirmed(voiceId, turnId) { const value = get(); return value && value.confirmedTurn === turnId && [value.designVoiceId, value.realtimeVoiceId].includes(voiceId) ? value : null },
  }
}
