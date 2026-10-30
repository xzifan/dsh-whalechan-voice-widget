#!/usr/bin/env node
// 会话质量评估 CLI：把审计日志还原成回合，跑确定性规则（必跑）+ LLM 复核（可选）。
//
// 用法：
//   node scripts/judge-conversation.mjs                          # 默认读线上审计，最近 24h
//   node scripts/judge-conversation.mjs --audit ./voice-audit.jsonl --since 7d --limit 20
//   node scripts/judge-conversation.mjs --llm                    # 额外跑 LLM 复核（需 DASHSCOPE_API_KEY）
//   node scripts/judge-conversation.mjs --llm --out report.json
//
// 退出码：0 = 无 error 级发现；1 = 有 error；2 = 参数/文件错误。

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { collectFindings, extractTurns, groupBySession, judgeTurns } from '../src/core/conversation-judge.js'

const DEFAULT_AUDIT = join(homedir(), '.dsh/storages/voice-workbench-preview/voice-audit.jsonl')

function parseArgs(argv) {
  const args = { audit: DEFAULT_AUDIT, since: '24h', limit: 10, llm: false, strictLlm: false, out: null, session: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--llm') args.llm = true
    else if (arg === '--strict-llm') args.strictLlm = true
    else if (arg === '--audit') args.audit = argv[++i]
    else if (arg === '--since') args.since = argv[++i]
    else if (arg === '--limit') args.limit = Number(argv[++i])
    else if (arg === '--out') args.out = argv[++i]
    else if (arg === '--session') args.session = argv[++i]
    else if (arg === '--help' || arg === '-h') args.help = true
  }
  return args
}

function sinceMs(value) {
  const match = String(value).match(/^(\d+)([smhd])$/)
  if (!match) return 0
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]]
  return Date.now() - Number(match[1]) * unit
}

async function readKey() {
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY
  const envFile = join(homedir(), '.dsh/secrets/bailian.env')
  if (!existsSync(envFile)) return null
  const text = await readFile(envFile, 'utf8')
  const line = text.split('\n').find(l => l.trim().startsWith('DASHSCOPE_API_KEY='))
  return line ? line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '') : null
}

function makeJudge(key) {
  return async prompt => {
    const response = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.JUDGE_MODEL || 'qwen-plus',
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!response.ok) throw new Error(`judge HTTP ${response.status}: ${(await response.text()).slice(0, 160)}`)
    const data = await response.json()
    return data?.choices?.[0]?.message?.content || ''
  }
}

function render({ turns, heuristics, judged }) {
  const lines = []
  lines.push(`回合 ${heuristics.summary.turns} 个 | error ${heuristics.summary.errors} | warn ${heuristics.summary.warns}`)
  const byTurn = new Map()
  for (const finding of heuristics.findings) {
    if (!byTurn.has(finding.turnId)) byTurn.set(finding.turnId, [])
    byTurn.get(finding.turnId).push(finding)
  }
  for (const turn of turns.slice(-10)) {
    const mark = (byTurn.get(turn.turnId) || []).some(f => f.severity === 'error') ? '✖' : '✓'
    lines.push(`${mark} ${turn.userText.slice(0, 30) || '(空)'} → ${turn.assistantText.slice(0, 40) || '(无回复)'}`)
    for (const finding of byTurn.get(turn.turnId) || []) lines.push(`    [${finding.severity}] ${finding.code}: ${finding.detail}`)
  }
  if (judged?.length) {
    const pass = judged.filter(j => j.pass === true).length
    lines.push(`LLM 复核 ${judged.length} 个回合，通过 ${pass} 个（仅供参考，未计入退出码）`)
    for (const item of judged.filter(j => j.pass !== true)) {
      lines.push(`  ✖ ${item.userText.slice(0, 24)} → ${item.reasons.slice(0, 2).join(' / ') || '未给出理由'}`)
    }
  }
  return lines.join('\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法: node scripts/judge-conversation.mjs [--audit file] [--since 24h] [--limit 10] [--llm] [--out report.json]')
    return 0
  }
  if (!existsSync(args.audit)) {
    console.error(`审计文件不存在: ${args.audit}`)
    return 2
  }
  const raw = await readFile(args.audit, 'utf8')
  const records = raw
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)

  const cutoff = sinceMs(args.since)
  const filtered = records.filter(r => !cutoff || Number(r.at) >= cutoff)
  const sessions = groupBySession(filtered)
  const selected = args.session ? [[args.session, sessions.get(args.session) || []]] : [...sessions.entries()]
  const turns = selected.flatMap(([, list]) => extractTurns(list))

  if (!turns.length) {
    console.log(`最近 ${args.since} 没有可用回合（文件 ${args.audit}）`)
    return 0
  }

  const heuristics = collectFindings(turns)
  let judged = null
  if (args.llm) {
    const key = await readKey()
    if (!key) {
      console.error('--llm 需要 DASHSCOPE_API_KEY（或 ~/.dsh/secrets/bailian.env）')
      return 2
    }
    judged = await judgeTurns({ turns: turns.filter(t => t.userText.trim()), judge: makeJudge(key), limit: args.limit })
  }

  const report = { generatedAt: new Date().toISOString(), audit: args.audit, since: args.since, ...heuristics, judged }
  console.log(render({ turns, heuristics, judged }))
  if (args.out) {
    await writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    console.log(`报告已写入 ${args.out}`)
  }
  // 退出码只由确定性规则决定。LLM 复核受提示词影响大、同一回合多次判定可能不一致，
  // 只有显式 --strict-llm 才让它参与门禁。
  const llmFailed = args.strictLlm && (judged || []).some(j => j.pass === false)
  return heuristics.summary.errors > 0 || llmFailed ? 1 : 0
}

main().then(
  code => process.exit(code),
  error => {
    console.error(error?.stack || String(error))
    process.exit(2)
  },
)
