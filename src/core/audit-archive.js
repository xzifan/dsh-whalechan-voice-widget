import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const WEEK = 7 * 86400000
const FILE = /^\d{4}-W\d{2}\.jsonl$/

/** ISO-8601 week key in UTC ('2026-W44'): weeks start Monday, week 1 owns Jan 4. */
export function isoWeekKey(at) {
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return null
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7))
  const year = thursday.getUTCFullYear()
  const first = new Date(Date.UTC(year, 0, 4))
  first.setUTCDate(first.getUTCDate() + 3 - ((first.getUTCDay() + 6) % 7))
  return `${year}-W${String(1 + Math.round((thursday - first) / WEEK)).padStart(2, '0')}`
}

/** Append-only weekly archive: one file per ISO week, pruned to the newest `keepWeeks`.
 * Records are written verbatim (including `seq`) so main log + archive can be merged
 * later; nothing reads them back yet, so a torn tail line is tolerated for now. */
export function createAuditArchive({ dir, keepWeeks = 8, now = Date.now } = {}) {
  if (!dir) throw new TypeError('Audit archive directory is required')
  keepWeeks = Math.max(1, Math.floor(keepWeeks))
  let prunedThrough
  async function prune(key) {
    // One scan per newly written week, not per append.
    if (prunedThrough && key <= prunedThrough) return
    prunedThrough = key
    const cutoff = isoWeekKey(now() - (keepWeeks - 1) * WEEK)
    for (const name of await readdir(dir).catch(() => [])) {
      // Never prune the week just written: a backfilled or clock-skewed record must not be
      // deleted by the very call that created its file.
      if (FILE.test(name) && name < cutoff && name.slice(0, 8) !== key) await unlink(join(dir, name)).catch(() => {})
    }
  }
  async function write(batch) {
    const buckets = new Map()
    for (const record of batch) {
      const key = isoWeekKey(record.at)
      if (!key) continue
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key).push(record)
    }
    // Records without a usable timestamp are dropped rather than filed under "now".
    if (!buckets.size) return false
    await mkdir(dir, { recursive: true, mode: 0o700 })
    for (const key of [...buckets.keys()].sort()) {
      await appendFile(join(dir, `${key}.jsonl`), buckets.get(key).map(record => JSON.stringify(record) + '\n').join(''), { mode: 0o600 })
    }
    for (const key of buckets.keys()) await prune(key)
    return true
  }
  return { write }
}
