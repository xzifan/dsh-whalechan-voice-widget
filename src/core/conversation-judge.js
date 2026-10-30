// 会话质量评估：确定性规则 + 可选 LLM 复核。
//
// 为什么需要：现有 e2e 只验证"能加载、能出声"（browser-smoke），
// 无法断言"说了 A 应该回 B 并调用 C 工具"。这里把审计日志还原成回合，
// 先跑零成本的确定性规则，再用 LLM 复核语义是否达标。

const CLAIM_PATTERN = /(已经|帮你|改好|改到|写进|写到|删除|删掉|创建|保存|打开|执行|运行|查到了一?下)/
const CJK_PATTERN = /[\u4e00-\u9fa5]/

/** @typedef {{code: string, severity: 'error'|'warn', detail: string}} Finding */

export function groupBySession(records) {
  const sessions = new Map()
  for (const record of records) {
    if (!record || !record.sessionId) continue
    if (!sessions.has(record.sessionId)) sessions.set(record.sessionId, [])
    sessions.get(record.sessionId).push(record)
  }
  return sessions
}

/** 把同一 session 的审计记录还原成按轮次聚合的结构。 */
export function extractTurns(records) {
  const turns = new Map()
  const order = []
  for (const record of records) {
    const key = record.turnId || record.messageId || record.id
    if (!turns.has(key)) {
      turns.set(key, {
        turnId: key,
        sessionId: record.sessionId,
        at: Number(record.at) || 0,
        userText: '',
        assistantText: '',
        tools: [],
        synthesis: null,
        errors: [],
      })
      order.push(key)
    }
    const turn = turns.get(key)
    if (record.at && Number(record.at) > turn.at) turn.at = Number(record.at)
    if (record.kind === 'transcription') turn.userText += record.text || ''
    else if (record.kind === 'response') turn.assistantText += record.text || ''
    else if (record.kind === 'tool') {
      turn.tools.push({
        name: record.text || record.tool || 'unknown',
        outcome: record.outcome || record.status || 'unknown',
        status: record.status || 'unknown',
      })
    } else if (record.kind === 'synthesis') turn.synthesis = { text: record.text || '', voice: record.voice }
    else if (record.kind === 'error') turn.errors.push(record.text || record.message || 'error')
  }
  return order.map(key => turns.get(key)).sort((a, b) => a.at - b.at)
}

/**
 * 确定性检查：不调用任何模型，可离线跑，适合当 CI 门禁。
 * @returns {Finding[]}
 */
export function heuristicChecks(turn) {
  const findings = []
  const response = (turn.assistantText || '').trim()
  const user = (turn.userText || '').trim()

  if (user && !response && turn.errors.length === 0) {
    findings.push({ code: 'EMPTY_RESPONSE', severity: 'error', detail: `用户说了「${user.slice(0, 24)}」但没有回复` })
  }
  if (turn.errors.length) {
    findings.push({ code: 'SESSION_ERROR', severity: 'error', detail: turn.errors.join('; ').slice(0, 120) })
  }
  const failed = turn.tools.filter(t => !['ok', 'completed'].includes(t.outcome))
  for (const tool of failed) {
    findings.push({ code: 'TOOL_FAILED', severity: 'error', detail: `${tool.name} 返回 ${tool.outcome}` })
  }
  // 短 token（如 read 工具原样念出的 "QXVB"）是正确的行为，不算语言漂移：
  // 只有出现 3 个以上英文单词才判为整句英文。
  const englishWords = (response.match(/[A-Za-z]{2,}/g) || []).length
  if (response && englishWords >= 3 && !CJK_PATTERN.test(response) && CJK_PATTERN.test(user)) {
    findings.push({ code: 'LANGUAGE_DRIFT', severity: 'warn', detail: `用户说中文，回复无中文：${response.slice(0, 40)}` })
  }
  if (response && CLAIM_PATTERN.test(response) && turn.tools.length === 0) {
    findings.push({
      code: 'CLAIM_WITHOUT_TOOL',
      severity: 'warn',
      detail: `声称执行了操作但本回合没有任何工具调用：${response.slice(0, 40)}`,
    })
  }
  if (response && !turn.synthesis) {
    findings.push({ code: 'TTS_MISSING', severity: 'warn', detail: '有文字回复但没有合成记录' })
  }
  return findings
}

export function collectFindings(turns) {
  const findings = []
  for (const turn of turns) {
    for (const finding of heuristicChecks(turn)) findings.push({ ...finding, turnId: turn.turnId, sessionId: turn.sessionId })
  }
  const errors = findings.filter(f => f.severity === 'error').length
  const warns = findings.filter(f => f.severity === 'warn').length
  return { findings, summary: { turns: turns.length, errors, warns } }
}

export const JUDGE_RUBRIC = [
  '默认判定为通过。只有命中下面任意一条失败条件，才判 false。',
  '失败条件 A：回复与用户这句话的意图无关（答非所问、自说自话）。',
  '失败条件 B：回复声称已经完成某个操作（改文件、发消息、创建、删除、下单等），但 tools_called 为空，或全部不是成功状态。',
  '失败条件 C：用户问的是需要事实核查的问题，回复给出了具体数字或结论，但 tools_called 里没有任何成功的工具调用。',
  '不要引入对话之外的额外要求：不要因为"没有使用某个特定工具""没有提到某个字段""人格化措辞"而判失败；web_search / web_fetch 的成功结果同样算事实依据。',
  '简单问候、寒暄、情绪表达，有自然回应即通过。',
  'payload 里的 tools_called 只有名称与 ok 布尔：ok=true 表示该工具已成功执行并返回结果；工具返回值本身按隐私设计不落审计，不要因为缺少 result 字段而判失败。',
]

export function buildJudgePrompt({ turn, rubric = JUDGE_RUBRIC, scenario }) {
  const payload = {
    scenario: scenario || null,
    user_said: turn.userText,
    assistant_replied: turn.assistantText,
    // 归一成布尔：不同 provider 的 outcome 词表（ok / completed / success）不一样，
    // 让模型去猜"completed 算不算成功"会引出无谓的误判。
    tools_called: turn.tools.map(t => ({ name: t.name, ok: ['ok', 'completed', 'success'].includes(t.outcome) })),
  }
  return [
    '你是语音助手的质量评审。根据下面的对话回合与评分标准，判断这次回复是否达标。',
    '评分标准：',
    ...rubric.map((line, i) => `${i + 1}. ${line}`),
    '逐条核对失败条件，未命中即 pass=true。只输出 JSON，格式：{"pass": true|false, "score": 0-100, "reasons": ["..."]}',
    '对话回合：',
    JSON.stringify(payload, null, 2),
  ].join('\n')
}

/** 容错解析：模型常把 JSON 包在 ```json 里或前后带解释。 */
export function parseJudgeResponse(raw) {
  if (typeof raw !== 'string') return { pass: null, score: null, reasons: ['empty judge response'] }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced ? fenced[1] : raw).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return { pass: null, score: null, reasons: ['no JSON object in judge response'] }
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1))
    const score = Number(parsed.score)
    return {
      pass: typeof parsed.pass === 'boolean' ? parsed.pass : null,
      score: Number.isFinite(score) ? score : null,
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : [],
    }
  } catch (error) {
    return { pass: null, score: null, reasons: [`judge JSON parse failed: ${error.message}`] }
  }
}

/**
 * 对选中的回合跑一遍 LLM 复核。judge 是注入的异步函数，便于测试与换模型。
 * @param {{turns: Array, judge: (prompt: string) => Promise<string>, limit?: number, rubric?: string[], scenarios?: Object}} options
 */
export async function judgeTurns({ turns, judge, limit = 10, rubric = JUDGE_RUBRIC, scenarios = {} }) {
  const results = []
  // 复核最近的回合：老回合的问题多半已经修过，重复报警只会制造噪声。
  for (const turn of turns.slice(-limit)) {
    if (!(turn.userText || '').trim()) continue
    const prompt = buildJudgePrompt({ turn, rubric, scenario: scenarios[turn.turnId] })
    let verdict
    try {
      verdict = parseJudgeResponse(await judge(prompt))
    } catch (error) {
      verdict = { pass: null, score: null, reasons: [`judge call failed: ${error.message}`] }
    }
    results.push({ turnId: turn.turnId, sessionId: turn.sessionId, userText: turn.userText, assistantText: turn.assistantText, ...verdict })
  }
  return results
}
