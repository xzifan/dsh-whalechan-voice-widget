export function formatLatency(ms) {
  // Unknown latency is not zero latency: a missing sample must not read "0 ms".
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
  return ms < 1000 ? `${Math.round(ms)} ms` : `${+(ms / 1000).toFixed(2)} s`
}

export function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '未知'
  if (seconds > 0 && seconds < 0.1) return '< 0.1 秒'
  const tenths = Math.round(seconds * 10)
  const hours = Math.floor(tenths / 36000)
  const minutes = Math.floor(tenths % 36000 / 600)
  const rest = tenths % 600 / 10
  return [hours ? `${hours} 小时` : '', minutes ? `${minutes} 分` : '', rest || (!hours && !minutes) ? `${rest} 秒` : ''].filter(Boolean).join(' ')
}
