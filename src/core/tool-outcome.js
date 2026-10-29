// Tool calls finish, but their result may still be a failure. `status` only
// describes the call lifecycle (`completed` / `failed` / `cancelled`), so the
// audit needs an explicit `ok|error` outcome plus a sanitized first line of
// evidence. Native DSH tools return their raw value (often `{stdout, stderr,
// exit_code}`), voice tools return `{ok}` / `{error}`, and some return text.

const SUMMARY_LIMIT = 200

/** Collapse to a single line so the summary survives search and table cells. */
function firstLine(value) {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim()
}

function errorText(result) {
  const error = result.error
  if (typeof error === 'string') return firstLine(error)
  if (error && typeof error === 'object') return firstLine(error.message || error.error || error.text)
  return ''
}

function contentText(result) {
  const content = result.content
  if (typeof content === 'string') return firstLine(content)
  if (!Array.isArray(content)) return ''
  return firstLine(content.map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').filter(Boolean).join(' '))
}

function exitCodeOf(result) {
  for (const key of ['exitCode', 'exit_code']) {
    const value = result[key]
    if (Number.isInteger(value) && Math.abs(value) <= 255) return value
  }
  return undefined
}

/**
 * Read success from the result itself, never from the call status.
 * Only explicit signals count as failure: an `error` field, `ok: false`,
 * `success: false`, `isError`, or a non-zero exit code.
 * @returns {{outcome: 'ok'|'error', summary?: string, exitCode?: number}}
 */
export function toolOutcome(result) {
  const summary = text => { const line = firstLine(text); return line ? line.slice(0, SUMMARY_LIMIT) : undefined }
  if (result === null || result === undefined) return { outcome: 'ok' }
  if (typeof result === 'string') return { outcome: 'ok', ...(summary(result) ? { summary: summary(result) } : {}) }
  if (typeof result !== 'object' || Array.isArray(result)) return { outcome: 'ok' }
  const exitCode = exitCodeOf(result)
  const error = errorText(result)
  const failed = !!error || result.ok === false || result.success === false ||
    result.isError === true || (exitCode !== undefined && exitCode !== 0)
  // Successful runs report stdout; stderr only matters when the call failed.
  const evidence = failed
    ? error || summary(result.stderr)
    : summary(result.text) || contentText(result) || summary(result.stdout)
  return { outcome: failed ? 'error' : 'ok', ...(evidence ? { summary: evidence } : {}), ...(exitCode !== undefined ? { exitCode } : {}) }
}
