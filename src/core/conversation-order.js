// ASR can arrive after a response/tool. Move only the correlated user input
// before the first output of that turn; preserve output and unrelated row order.
export function orderConversationRows(rows) {
  const users = new Map()
  for (const row of rows) {
    if (row.turnId && (row.role === 'user' || row.kind === 'transcription')) {
      if (!users.has(row.turnId)) users.set(row.turnId, [])
      users.get(row.turnId).push(row)
    }
  }
  const emitted = new Set(), result = []
  for (const row of rows) {
    if (row.turnId && users.has(row.turnId) && !emitted.has(row.turnId)) {
      result.push(...users.get(row.turnId))
      emitted.add(row.turnId)
    }
    if (!users.get(row.turnId)?.includes(row)) result.push(row)
  }
  return result
}
