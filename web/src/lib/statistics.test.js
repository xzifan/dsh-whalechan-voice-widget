import test from 'node:test'
import assert from 'node:assert/strict'
import {formatDuration, formatLatency} from './statistics.js'
import {ENDPOINT_METHODS} from './core.js'
test('latency keeps unknown apart from zero and switches to seconds past one second', () => {
  for (const value of [null, undefined, NaN, Infinity, -1, '812']) assert.equal(formatLatency(value), '—')
  assert.equal(formatLatency(0), '0 ms')
  assert.equal(formatLatency(999), '999 ms')
  assert.equal(formatLatency(1180), '1.18 s')
  assert.equal(formatLatency(1200), '1.2 s')
})
test('duration distinguishes unknown, zero, subsecond and long audio', () => {
  for (const value of [null, undefined, NaN, Infinity, -1, '12']) assert.equal(formatDuration(value), '未知')
  assert.equal(formatDuration(0), '0 秒')
  assert.equal(formatDuration(0.01), '< 0.1 秒')
  assert.equal(formatDuration(59.99), '1 分')
  assert.equal(formatDuration(3661.2), '1 小时 1 分 1.2 秒')
  assert.equal(formatDuration(90000), '25 小时')
})
test('statistics endpoint is available through the authenticated bridge', () => {
  assert.deepEqual(ENDPOINT_METHODS['/api/statistics'], ['POST'])
})
