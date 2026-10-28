import test from 'node:test'
import assert from 'node:assert/strict'
import { toolOutcome } from '../src/tool-outcome.js'

test('a non-zero exit code fails a call that itself completed', () => {
  assert.deepEqual(toolOutcome({ stdout: 'listing', stderr: 'ls: bad dir', exit_code: 2 }),
    { outcome: 'error', summary: 'ls: bad dir', exitCode: 2 })
  assert.deepEqual(toolOutcome({ stdout: 'ok', exitCode: 0 }), { outcome: 'ok', summary: 'ok', exitCode: 0 })
})

test('explicit failure fields win over any success-looking output', () => {
  for (const result of [{ error: 'boom', stdout: 'fine' }, { ok: false, stdout: 'fine' }, { success: false, text: 'fine' }, { isError: true }]) {
    assert.equal(toolOutcome(result).outcome, 'error', JSON.stringify(result))
  }
  assert.equal(toolOutcome({ error: { message: 'nested failure' } }).summary, 'nested failure')
})

test('successful results keep a one-line summary and ignore stderr chatter', () => {
  assert.deepEqual(toolOutcome({ stdout: 'line one\nline two', stderr: 'warning: noisy' }), { outcome: 'ok', summary: 'line one line two' })
  assert.deepEqual(toolOutcome({ content: [{ type: 'text', text: '文件内容' }] }), { outcome: 'ok', summary: '文件内容' })
  assert.deepEqual(toolOutcome('plain text\nsecond line'), { outcome: 'ok', summary: 'plain text second line' })
})

test('empty, null and non-object results carry no evidence but stay ok', () => {
  for (const result of [null, undefined, {}, [], { ok: true }]) {
    assert.deepEqual(toolOutcome(result), { outcome: 'ok' }, String(result))
  }
})

test('summaries are capped so one noisy tool cannot flood the audit line', () => {
  const { summary } = toolOutcome({ stdout: 'x'.repeat(900) })
  assert.equal(summary.length, 200)
  assert.equal(toolOutcome({ exit_code: 1, stderr: '   ' }).summary, undefined)
})
