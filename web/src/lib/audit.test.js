import test from 'node:test'
import assert from 'node:assert/strict'
import {auditUsage, formatAuditNumber, summarizeAuditUsage, auditTimestamp, formatAuditTime, mergeAuditRecords, auditRangeStart} from './audit.js'

test('missing usage stays unknown while actual zero remains visible', () => {
  const unknown = {input: null, output: null, total: null}
  for (const record of [{}, {usage: null}, {usage: {}}, {usage: {total_tokens: null}}, {usageAvailable: false, usage: {total_tokens: 50}}]) {
    assert.deepEqual(auditUsage(record), unknown)
  }
  assert.deepEqual(auditUsage({usage: {input_tokens: 0, output_tokens: 0, total_tokens: 0}}), {input: 0, output: 0, total: 0})
  assert.equal(formatAuditNumber(null), '未返回')
  assert.equal(formatAuditNumber(undefined), '未返回')
  assert.equal(formatAuditNumber(0), '0')
})

test('provider aliases are alternatives and overlapping details never inflate tokens', () => {
  assert.deepEqual(auditUsage({usage: {prompt_tokens: 20, completion_tokens: 5}}), {input: 20, output: 5, total: 25})
  assert.deepEqual(auditUsage({usage: {input_tokens: 20, prompt_tokens: 20, output_tokens: 5, completion_tokens: 5, total_tokens: 25, input_token_details: {cached_tokens: 15, audio_tokens: 10}}}), {input: 20, output: 5, total: 25})
  assert.equal(auditUsage({usage: {input_tokens: 20, output_tokens: 5, total_tokens: 30}}).total, 30)
  assert.equal(auditUsage({usage: {input_tokens: 20}}).total, null)
})

test('invalid numbers and character or audio billing cannot fabricate token counts', () => {
  assert.deepEqual(auditUsage({usage: {input_tokens: '10', output_tokens: -1, total_tokens: Infinity}}), {input: null, output: null, total: null})
  assert.equal(auditUsage({kind: 'synthesis', usage: {characters: 300, audio_seconds: 2.5}}).total, null)
  assert.equal(auditUsage({usage: {input_tokens: null, prompt_tokens: 0, completion_tokens: 2}}).total, 2)
})

test('aggregate counts responses, orphan legacy usage and synthesis with known totals', () => {
  assert.deepEqual(summarizeAuditUsage([
    {kind: 'response', usage: {total_tokens: 100}},
    {kind: 'transcription', usage: {total_tokens: 100}},
    {kind: 'usage', usage: {input_tokens: 20, output_tokens: 5, total_tokens: 25}},
    {kind: 'synthesis', usage: {total_tokens: 0}},
    {kind: 'synthesis', usage: {characters: 300}},
  ]), {total: 125, known: 3, missing: 1})
  assert.deepEqual(summarizeAuditUsage([{kind: 'synthesis', usage: {characters: 5}}]), {total: null, known: 0, missing: 1})
})

test('timestamps handle ISO, Unix seconds, milliseconds, epoch and invalid values', () => {
  const iso = '2026-10-27T12:34:56.000Z'
  const milliseconds = Date.parse(iso)
  for (const input of [iso, milliseconds, milliseconds / 1000]) assert.equal(auditTimestamp(input).toISOString(), iso)
  assert.equal(auditTimestamp(0).toISOString(), '1970-01-01T00:00:00.000Z')
  for (const input of [null, undefined, '', 'not-a-date', NaN, Infinity]) {
    assert.equal(auditTimestamp(input), null)
    assert.equal(formatAuditTime(input), '时间未返回')
  }
})

test('cursor pages append older records without duplicating IDs or reordering rows', () => {
  const newest = {id: 'new', text: 'newest'}
  const middle = {id: 'mid', text: 'middle'}
  const oldest = {id: 'old', text: 'oldest'}
  assert.deepEqual(mergeAuditRecords([newest, middle], [{...middle, text: 'duplicate'}, oldest, oldest]), [newest, middle, oldest])
})

test('time range keys map to inclusive query starts and unknown keys stay unlimited', () => {
  const now = 1_700_000_000_000
  assert.equal(auditRangeStart('all', now), null)
  assert.equal(auditRangeStart('hour', now), now - 3600_000)
  assert.equal(auditRangeStart('day', now), now - 24 * 3600_000)
  assert.equal(auditRangeStart('week', now), now - 7 * 24 * 3600_000)
  assert.equal(auditRangeStart('nope', now), null)
  assert.equal(auditRangeStart('hour', 0), 0)
})
