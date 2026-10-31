// CHANGELOG 解析：把 Markdown 变成控制台可以直接渲染的结构。
// 只认 ## [version] - date / ### 分类 / - 条目 这三种形状，其余内容忽略。

const ENTRY = /^##\s+\[?([^\]]+?)\]?\s*(?:[-–—]\s*(\d{4}-\d{2}-\d{2}))?\s*$/
const SECTION = /^###\s+(.+?)\s*$/
const ITEM = /^[-*]\s+(.*)$/

export function parseChangelog(text, { limit = 8, maxItemChars = 1200 } = {}) {
  const entries = []
  let current = null
  let section = null
  let item = null

  function closeItem() {
    if (!item || !section) return
    const value = item.join(' ').replace(/\s+/g, ' ').trim()
    if (value) section.items.push(value.slice(0, maxItemChars))
    item = null
  }

  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trimEnd()

    const entryMatch = line.match(ENTRY)
    if (entryMatch) {
      closeItem()
      current = { version: entryMatch[1].trim(), date: entryMatch[2] || null, sections: [] }
      entries.push(current)
      section = null
      continue
    }
    if (!current) continue

    const sectionMatch = line.match(SECTION)
    if (sectionMatch) {
      closeItem()
      section = { title: sectionMatch[1], items: [] }
      current.sections.push(section)
      continue
    }

    const itemMatch = line.match(ITEM)
    if (itemMatch) {
      closeItem()
      // 历史版本（0.5.0 / 0.3.0 / 0.2.0）没有 ### 分节，条目直接挂在版本标题下。
      // 惰性建一个默认分节把它们收进来，否则 closeItem() 因 section 为空而丢弃整条。
      if (!section) {
        section = { title: '变更', items: [] }
        current.sections.push(section)
      }
      item = [itemMatch[1]]
      continue
    }

    // 续行：接在当前条目后面；空行结束当前条目
    if (item) {
      if (line.trim() === '') closeItem()
      else item.push(line.trim())
    }
  }
  closeItem()

  return {
    // 只有标题、一条内容都没收到的版本仍然不进 entries（空版本会让前端渲染出空分节）；
    // total 记的是「有版本标题」的真实数量，所以两者在文件里存在空版本时会不相等。
    entries: entries.filter(entry => entry.sections.length > 0).slice(0, limit),
    total: entries.length,
  }
}