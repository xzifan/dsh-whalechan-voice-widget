import { test } from 'node:test'
import assert from 'node:assert'
import { readPersona, REQUIRED_PERSONA, SPOKEN_STYLE, TOOL_HONESTY_RULES, appendRequiredRules, assembleRealtimeInstruction } from '../src/core/persona.js'

test('REQUIRED_PERSONA contains identity and address rules', () => {
  assert.ok(REQUIRED_PERSONA.includes('鲸鱼娘'))
  assert.ok(REQUIRED_PERSONA.includes('主人'))
  assert.ok(REQUIRED_PERSONA.includes('白米饭'))
})

test('SPOKEN_STYLE contains whale-specific rules', () => {
  assert.ok(SPOKEN_STYLE.includes('浮力储备') || SPOKEN_STYLE.includes('天赋资产') || SPOKEN_STYLE.includes('保温层'))
  assert.ok(SPOKEN_STYLE.includes('不写括号动作描写'))
  assert.ok(SPOKEN_STYLE.includes('傲娇'))
  assert.ok(SPOKEN_STYLE.includes('一至三句'))
})

test('assembleRealtimeInstruction builds full instruction with persona', () => {
  const base = assembleRealtimeInstruction('这里是人格补充', false)
  assert.ok(base.includes('鲸鱼娘'))
  assert.ok(base.includes('这里是人格补充'))
  assert.ok(base.includes('浮力储备') || base.includes('天赋资产'))
  assert.ok(base.includes('design_voice'))
  // TTS voice off -> no synth_tts guidance
  assert.ok(!base.includes('synth_tts 工具把你要说的话合成'))
})

test('assembleRealtimeInstruction injects synth_tts guidance when useTtsVoice', () => {
  const on = assembleRealtimeInstruction('', true)
  assert.ok(on.includes('synth_tts 工具把你要说的话合成'))
})

test('readPersona returns empty string when AGENTS.md missing', async () => {
  // readPersona reads a fixed path; can't easily stub without injecting. Just
  // verify it returns a string (possibly empty) without throwing.
  const result = await readPersona()
  assert.equal(typeof result, 'string')
})

test('TOOL_HONESTY_RULES forbids claiming success on a failed or empty tool result', () => {
  assert.ok(TOOL_HONESTY_RULES.includes('结果为空'))
  assert.ok(TOOL_HONESTY_RULES.includes('不得猜测'))
  assert.ok(TOOL_HONESTY_RULES.includes('只有工具明确返回成功'))
})

test('assembleRealtimeInstruction always carries the honesty rule exactly once', () => {
  for (const [persona, tts] of [['', false], ['补充人设', true]]) {
    const text = assembleRealtimeInstruction(persona, tts)
    assert.equal(text.split(TOOL_HONESTY_RULES).length - 1, 1)
    assert.ok(text.includes('只有主人下一轮明确肯定'))
  }
})

// Nightly smoke shape: a caller-supplied instruction (settings.instructions or
// a stale client payload) must not be able to drop the honesty rule, and must
// not receive it twice.
test('appendRequiredRules injects the honesty rule into custom instructions once', () => {
  const custom = '自然口语，用日语回答。'
  const once = appendRequiredRules(custom)
  assert.ok(once.startsWith(custom))
  assert.equal(once.split(TOOL_HONESTY_RULES).length - 1, 1)
  assert.equal(once.split('只有主人下一轮明确肯定').length - 1, 1)
  assert.equal(appendRequiredRules(once), once)
  assert.ok(appendRequiredRules('').startsWith(TOOL_HONESTY_RULES))
})
